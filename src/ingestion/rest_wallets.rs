use std::collections::{HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::Deserialize;
use tokio::sync::{mpsc, Mutex, Semaphore};
use tracing::{debug, info, warn};

use crate::config::wallets::TrackedWallet;
use crate::core::types::{Side, TokenId, WalletAddr, WalletCategory};

const DATA_API_BASE: &str = "https://data-api.polymarket.com";

/// Max concurrent in-flight HTTP requests to Data API.
/// Data API allows 200 req/10s = 20 req/s. We cap at 15 concurrent to leave headroom.
const MAX_CONCURRENT_REQUESTS: usize = 15;

/// A detected wallet trade, emitted to the engine.
#[derive(Debug, Clone)]
pub struct DetectedWalletTrade {
    pub wallet: WalletAddr,
    pub category: WalletCategory,
    pub token_id: TokenId,
    pub market_id: String,
    pub side: Side,
    pub price: Decimal,
    pub size: Decimal,
    pub tx_hash: String,
    pub source_ts: DateTime<Utc>,
    pub detected_at: DateTime<Utc>,
}

/// Metrics for a single poll cycle.
#[derive(Debug, Clone)]
pub struct PollCycleMetrics {
    pub category: WalletCategory,
    pub wallet_count: usize,
    pub cycle_duration: Duration,
    pub new_trades_found: usize,
    pub errors: usize,
}

/// Raw trade response from Polymarket Data API.
#[derive(Debug, Deserialize)]
struct DataApiTrade {
    #[serde(rename = "proxyWallet")]
    proxy_wallet: Option<String>,
    #[serde(rename = "conditionId")]
    condition_id: Option<String>,
    asset: Option<String>, // token_id
    side: Option<String>,
    price: Option<f64>,
    size: Option<f64>,
    #[serde(rename = "transactionHash")]
    transaction_hash: Option<String>,
    timestamp: Option<i64>,
}

/// Shared state for deduplication across all wallet pollers.
struct DeduplicationState {
    seen_tx_hashes: HashSet<String>,
    seen_tx_order: VecDeque<String>,
}

impl DeduplicationState {
    fn new() -> Self {
        Self {
            seen_tx_hashes: HashSet::new(),
            seen_tx_order: VecDeque::new(),
        }
    }

    fn is_seen(&self, tx_hash: &str) -> bool {
        self.seen_tx_hashes.contains(tx_hash)
    }

    fn mark_seen(&mut self, tx_hash: String) {
        const MAX_SEEN: usize = 10_000;
        while self.seen_tx_hashes.len() >= MAX_SEEN {
            if let Some(old) = self.seen_tx_order.pop_front() {
                self.seen_tx_hashes.remove(&old);
            } else {
                break;
            }
        }
        if self.seen_tx_hashes.insert(tx_hash.clone()) {
            self.seen_tx_order.push_back(tx_hash);
        }
    }
}

/// Per-wallet watermark state.
struct WalletWatermark {
    address: WalletAddr,
    category: WalletCategory,
    last_seen_tx: Option<String>,
    consecutive_errors: u32,
}

/// Run the parallel wallet trade poller.
///
/// Spawns two independent polling loops — one for directional wallets (fast cadence)
/// and one for arbitrage wallets (slower cadence). Within each loop, all wallets are
/// polled concurrently using a shared rate-limiting semaphore.
pub async fn run_wallet_poller(
    client: reqwest::Client,
    wallets: Vec<TrackedWallet>,
    directional_interval: Duration,
    arbitrage_interval: Duration,
    event_tx: mpsc::Sender<DetectedWalletTrade>,
    new_market_tx: mpsc::Sender<TokenId>,
    seen_tokens: Arc<tokio::sync::Mutex<HashSet<TokenId>>>,
    metrics_tx: mpsc::Sender<PollCycleMetrics>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    let directional: Vec<_> = wallets
        .iter()
        .filter(|w| w.category == WalletCategory::Directional)
        .cloned()
        .collect();
    let arbitrage: Vec<_> = wallets
        .iter()
        .filter(|w| w.category == WalletCategory::Arbitrage)
        .cloned()
        .collect();

    // Shared rate limiter — 15 concurrent requests max across both loops
    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS));
    let dedup = Arc::new(Mutex::new(DeduplicationState::new()));

    info!(
        directional = directional.len(),
        arbitrage = arbitrage.len(),
        directional_interval_ms = directional_interval.as_millis() as u64,
        arbitrage_interval_ms = arbitrage_interval.as_millis() as u64,
        "parallel wallet poller starting"
    );

    let mut shutdown_dir = shutdown.clone();
    let mut shutdown_arb = shutdown.clone();

    // Spawn directional polling loop
    let dir_handle = if !directional.is_empty() {
        let client = client.clone();
        let event_tx = event_tx.clone();
        let new_market_tx = new_market_tx.clone();
        let seen_tokens = seen_tokens.clone();
        let semaphore = semaphore.clone();
        let dedup = dedup.clone();
        let metrics_tx = metrics_tx.clone();
        Some(tokio::spawn(async move {
            poll_category_loop(
                client,
                directional,
                WalletCategory::Directional,
                directional_interval,
                event_tx,
                new_market_tx,
                seen_tokens,
                semaphore,
                dedup,
                metrics_tx,
                &mut shutdown_dir,
            )
            .await;
        }))
    } else {
        None
    };

    // Spawn arbitrage polling loop
    let arb_handle = if !arbitrage.is_empty() {
        let client = client.clone();
        let event_tx = event_tx.clone();
        let new_market_tx = new_market_tx.clone();
        let seen_tokens = seen_tokens.clone();
        let metrics_tx = metrics_tx.clone();
        Some(tokio::spawn(async move {
            poll_category_loop(
                client,
                arbitrage,
                WalletCategory::Arbitrage,
                arbitrage_interval,
                event_tx,
                new_market_tx,
                seen_tokens,
                semaphore,
                dedup,
                metrics_tx,
                &mut shutdown_arb,
            )
            .await;
        }))
    } else {
        None
    };

    // Wait for shutdown or task completion
    tokio::select! {
        _ = async { if let Some(h) = dir_handle { h.await.ok(); } } => {}
        _ = async { if let Some(h) = arb_handle { h.await.ok(); } } => {}
        _ = shutdown.changed() => {
            info!("wallet poller received shutdown");
        }
    }
}

/// Poll all wallets in a category concurrently on a fixed interval.
async fn poll_category_loop(
    client: reqwest::Client,
    wallets: Vec<TrackedWallet>,
    category: WalletCategory,
    interval: Duration,
    event_tx: mpsc::Sender<DetectedWalletTrade>,
    new_market_tx: mpsc::Sender<TokenId>,
    seen_tokens: Arc<tokio::sync::Mutex<HashSet<TokenId>>>,
    semaphore: Arc<Semaphore>,
    dedup: Arc<Mutex<DeduplicationState>>,
    metrics_tx: mpsc::Sender<PollCycleMetrics>,
    shutdown: &mut tokio::sync::watch::Receiver<bool>,
) {
    let mut watermarks: Vec<WalletWatermark> = wallets
        .iter()
        .map(|w| WalletWatermark {
            address: w.address.clone(),
            category: w.category,
            last_seen_tx: None,
            consecutive_errors: 0,
        })
        .collect();

    // Initialize watermarks: poll once to set baselines (concurrent)
    initialize_watermarks_parallel(&client, &mut watermarks, &semaphore).await;

    info!(
        category = %category,
        wallets = watermarks.len(),
        "category polling loop started"
    );

    loop {
        if *shutdown.borrow() {
            return;
        }

        let cycle_start = Instant::now();
        let mut cycle_new_trades = 0usize;
        let mut cycle_errors = 0usize;

        // Fire all wallet polls concurrently
        let mut handles = Vec::with_capacity(watermarks.len());

        for wm in &watermarks {
            let client = client.clone();
            let address = wm.address.clone();
            let sem = semaphore.clone();

            handles.push(tokio::spawn(async move {
                let _permit = sem.acquire().await.unwrap();
                poll_wallet(&client, &address).await
            }));
        }

        // Collect results
        for (i, handle) in handles.into_iter().enumerate() {
            let result = match handle.await {
                Ok(r) => r,
                Err(_) => {
                    cycle_errors += 1;
                    continue;
                }
            };

            let wm = &mut watermarks[i];

            match result {
                Ok(trades) => {
                    wm.consecutive_errors = 0;

                    // Find new trades
                    let new_trades = find_new_trades(&trades, &wm.last_seen_tx);

                    // Update watermark
                    if let Some(newest_tx) =
                        trades.first().and_then(|t| t.transaction_hash.clone())
                    {
                        wm.last_seen_tx = Some(newest_tx);
                    }

                    for raw in new_trades {
                        let Some(tx_hash) = &raw.transaction_hash else {
                            continue;
                        };

                        // Dedup
                        {
                            let mut dd = dedup.lock().await;
                            if dd.is_seen(tx_hash) {
                                continue;
                            }
                            dd.mark_seen(tx_hash.clone());
                        }

                        let wallet_info = TrackedWallet {
                            address: wm.address.clone(),
                            category: wm.category,
                        };
                        let Some(detected) = parse_raw_trade(raw, &wallet_info) else {
                            continue;
                        };

                        // Notify about new market/token if not already tracking
                        {
                            let mut seen = seen_tokens.lock().await;
                            if seen.insert(detected.token_id.clone()) {
                                let _ = new_market_tx
                                    .send(detected.token_id.clone())
                                    .await;
                            }
                        }

                        cycle_new_trades += 1;

                        if event_tx.send(detected).await.is_err() {
                            warn!("event channel closed, stopping category poller");
                            return;
                        }
                    }
                }
                Err(e) => {
                    wm.consecutive_errors += 1;
                    cycle_errors += 1;
                    warn!(
                        wallet = %wm.address,
                        error = %e,
                        consecutive_errors = wm.consecutive_errors,
                        "failed to poll wallet trades"
                    );
                }
            }
        }

        let cycle_duration = cycle_start.elapsed();

        // Emit cycle metrics
        let _ = metrics_tx
            .send(PollCycleMetrics {
                category,
                wallet_count: watermarks.len(),
                cycle_duration,
                new_trades_found: cycle_new_trades,
                errors: cycle_errors,
            })
            .await;

        if cycle_new_trades > 0 {
            debug!(
                category = %category,
                new_trades = cycle_new_trades,
                cycle_ms = cycle_duration.as_millis() as u64,
                "poll cycle complete"
            );
        }

        // Sleep for the remaining interval (subtract cycle time)
        let sleep_duration = interval.saturating_sub(cycle_duration);
        tokio::select! {
            _ = tokio::time::sleep(sleep_duration) => {}
            _ = shutdown.changed() => {
                info!(category = %category, "category poller shutting down");
                return;
            }
        }
    }
}

/// Initialize watermarks by polling all wallets concurrently.
async fn initialize_watermarks_parallel(
    client: &reqwest::Client,
    watermarks: &mut [WalletWatermark],
    semaphore: &Arc<Semaphore>,
) {
    let mut handles = Vec::with_capacity(watermarks.len());

    for wm in watermarks.iter() {
        let client = client.clone();
        let address = wm.address.clone();
        let sem = semaphore.clone();

        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            poll_wallet(&client, &address).await
        }));
    }

    for (i, handle) in handles.into_iter().enumerate() {
        match handle.await {
            Ok(Ok(trades)) => {
                if let Some(newest) = trades.first().and_then(|t| t.transaction_hash.clone()) {
                    watermarks[i].last_seen_tx = Some(newest);
                    debug!(
                        wallet = %watermarks[i].address,
                        "initialized watermark"
                    );
                }
            }
            Ok(Err(e)) => {
                warn!(
                    wallet = %watermarks[i].address,
                    error = %e,
                    "failed to initialize watermark"
                );
            }
            Err(_) => {
                warn!(
                    wallet = %watermarks[i].address,
                    "watermark init task panicked"
                );
            }
        }
    }
}

/// Discover token_ids that tracked wallets are currently active in.
/// Returns a deduplicated set of token_ids from recent trades.
pub async fn discover_active_tokens(
    client: &reqwest::Client,
    wallets: &[TrackedWallet],
) -> HashSet<TokenId> {
    let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_REQUESTS));
    let mut handles = Vec::with_capacity(wallets.len());

    for w in wallets {
        let client = client.clone();
        let address = w.address.clone();
        let sem = semaphore.clone();

        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            poll_wallet(&client, &address).await
        }));
    }

    let mut tokens = HashSet::new();
    for handle in handles {
        if let Ok(Ok(trades)) = handle.await {
            for t in &trades {
                if let Some(token_id) = &t.asset {
                    if !token_id.is_empty() {
                        tokens.insert(token_id.clone());
                    }
                }
            }
        }
    }

    info!(
        wallets = wallets.len(),
        tokens_discovered = tokens.len(),
        "proactive market discovery complete"
    );
    tokens
}

async fn poll_wallet(
    client: &reqwest::Client,
    address: &str,
) -> Result<Vec<DataApiTrade>, reqwest::Error> {
    let url = format!("{DATA_API_BASE}/trades?user={address}&limit=25");
    let trades: Vec<DataApiTrade> = client
        .get(&url)
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .json()
        .await?;
    Ok(trades)
}

fn find_new_trades<'a>(
    trades: &'a [DataApiTrade],
    last_seen_tx: &Option<String>,
) -> Vec<&'a DataApiTrade> {
    let Some(last_tx) = last_seen_tx else {
        // First poll — don't emit historical trades, just set the watermark.
        return Vec::new();
    };

    // Trades are returned newest first. Collect all trades newer than last_seen_tx.
    let mut new_trades = Vec::new();
    for t in trades {
        if t.transaction_hash.as_deref() == Some(last_tx.as_str()) {
            break;
        }
        new_trades.push(t);
    }
    new_trades
}

fn parse_raw_trade(raw: &DataApiTrade, wallet: &TrackedWallet) -> Option<DetectedWalletTrade> {
    let token_id = raw.asset.clone()?;
    let market_id = raw.condition_id.clone().unwrap_or_default();
    let side = match raw.side.as_deref() {
        Some("BUY") | Some("buy") => Side::Buy,
        Some("SELL") | Some("sell") => Side::Sell,
        _ => return None,
    };
    let price = Decimal::try_from(raw.price?).ok()?;
    let size = Decimal::try_from(raw.size?).ok()?;
    let tx_hash = raw.transaction_hash.clone()?;

    let source_ts = raw
        .timestamp
        .and_then(|ts| DateTime::from_timestamp(ts, 0))
        .unwrap_or_else(Utc::now);

    Some(DetectedWalletTrade {
        wallet: wallet.address.clone(),
        category: wallet.category,
        token_id,
        market_id,
        side,
        price,
        size,
        tx_hash,
        source_ts,
        detected_at: Utc::now(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_trade(tx_hash: Option<&str>) -> DataApiTrade {
        DataApiTrade {
            proxy_wallet: None,
            condition_id: None,
            asset: None,
            side: None,
            price: None,
            size: None,
            transaction_hash: tx_hash.map(String::from),
            timestamp: None,
        }
    }

    #[test]
    fn find_new_trades_first_poll() {
        let trades = vec![make_trade(Some("0xaaa"))];
        let new = find_new_trades(&trades, &None);
        assert!(new.is_empty(), "first poll should not emit trades");
    }

    #[test]
    fn find_new_trades_with_watermark() {
        let trades = vec![
            DataApiTrade {
                proxy_wallet: None,
                condition_id: None,
                asset: Some("token".into()),
                side: Some("BUY".into()),
                price: Some(0.5),
                size: Some(10.0),
                transaction_hash: Some("0xnew".into()),
                timestamp: Some(1700000000),
            },
            make_trade(Some("0xold")),
            make_trade(Some("0xolder")),
        ];
        let new = find_new_trades(&trades, &Some("0xold".into()));
        assert_eq!(new.len(), 1);
        assert_eq!(new[0].transaction_hash.as_deref(), Some("0xnew"));
    }

    #[test]
    fn find_new_trades_no_change() {
        let trades = vec![make_trade(Some("0xaaa"))];
        let new = find_new_trades(&trades, &Some("0xaaa".into()));
        assert!(new.is_empty());
    }

    #[test]
    fn parse_raw_trade_valid() {
        let raw = DataApiTrade {
            proxy_wallet: Some("0xproxy".into()),
            condition_id: Some("0xcond".into()),
            asset: Some("token123".into()),
            side: Some("SELL".into()),
            price: Some(0.55),
            size: Some(100.0),
            transaction_hash: Some("0xtx".into()),
            timestamp: Some(1700000000),
        };
        let wallet = TrackedWallet {
            address: "0xwallet".into(),
            category: WalletCategory::Directional,
        };
        let detected = parse_raw_trade(&raw, &wallet).unwrap();
        assert_eq!(detected.wallet, "0xwallet");
        assert_eq!(detected.token_id, "token123");
        assert_eq!(detected.side, Side::Sell);
        assert_eq!(detected.size, Decimal::new(100, 0));
    }

    #[test]
    fn parse_raw_trade_missing_fields() {
        let raw = DataApiTrade {
            proxy_wallet: None,
            condition_id: None,
            asset: None, // missing
            side: Some("BUY".into()),
            price: Some(0.5),
            size: Some(10.0),
            transaction_hash: Some("0x".into()),
            timestamp: None,
        };
        let wallet = TrackedWallet {
            address: "0x".into(),
            category: WalletCategory::Arbitrage,
        };
        assert!(parse_raw_trade(&raw, &wallet).is_none());
    }

    #[test]
    fn dedup_state_bounded() {
        let mut dd = DeduplicationState::new();
        // Insert 10001 entries, should evict oldest
        for i in 0..10_001 {
            dd.mark_seen(format!("tx_{i}"));
        }
        assert!(dd.seen_tx_hashes.len() <= 10_000);
        // Oldest should be evicted
        assert!(!dd.is_seen("tx_0"));
        // Newest should be present
        assert!(dd.is_seen("tx_10000"));
    }
}
