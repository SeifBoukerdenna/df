use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use rust_decimal::Decimal;
use tokio::sync::{mpsc, watch, Mutex};
use tracing::{debug, error, info, warn};

use crate::config::schema::AppConfig;
use crate::config::wallets::TrackedWallet;
use crate::core::book::OrderBook;
use crate::core::event::NormalizedEvent;
use crate::core::fees;
use crate::core::trade_time_books::TradeTimeBooks;
use crate::core::types::*;
use crate::ingestion::onchain;
use crate::ingestion::rest_book;
use crate::ingestion::rest_metadata;
use crate::ingestion::rest_wallets::{self, DetectedWalletTrade, PollCycleMetrics};
use crate::ingestion::ws_market::{self, WsMarketEvent};
use crate::report::analytics::{self, LivePortfolioState};
use crate::report::html;
use crate::sim::fill::{self, FillRequest};
use crate::sim::portfolio::{Portfolio, PositionKey};
use crate::sim::tui::{self, RenderSnapshot};
use crate::storage::db::Store;

/// Session state managed by the engine.
pub struct EngineState {
    pub session_id: String,
    pub portfolio: Portfolio,
    pub books: HashMap<TokenId, OrderBook>,
    pub config: AppConfig,
    pub last_event_id: i64,
    pub started_at: std::time::Instant,
    pub wallet_trades_seen: u64,
    pub first_trade_captures: u64,
    pub first_trade_misses: u64,
    pub book_warmups: u64,
    warmed_tokens: HashSet<TokenId>,
    pub latest_dir_cycle: Option<PollCycleMetrics>,
    pub latest_arb_cycle: Option<PollCycleMetrics>,
    /// Wallet display name map.
    pub wallet_names: HashMap<String, String>,
    /// Per-category counters for better reporting.
    pub category_stats: HashMap<WalletCategory, CategoryStats>,
    /// Trade-time book snapshots for temporal correctness.
    /// When the CLOB WS fires `last_trade_price`, we snapshot the book.
    /// When REST detects a wallet trade, we simulate against that snapshot
    /// instead of the current (potentially post-trade) book.
    pub trade_time_books: TradeTimeBooks,
    /// Count of fills that used a trade-time snapshot instead of the live book.
    pub trade_time_hits: u64,
    /// Per-wallet PnL history (wallet -> last few unrealized snapshots) for trend display.
    pub wallet_pnl_history: HashMap<WalletAddr, Vec<Decimal>>,
    /// Time-series PnL snapshots for the report chart. Recorded every 30s.
    pub pnl_timeline: Vec<PnlSnapshot>,
}

/// A point-in-time snapshot of portfolio PnL for time series display.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PnlSnapshot {
    pub elapsed_secs: u64,
    pub net_pnl: Decimal,
    pub realized_net: Decimal,
    pub unrealized: Decimal,
    pub positions: usize,
    pub fills: u64,
    pub misses: u64,
    /// Per-wallet unrealized at this point.
    pub wallet_unrealized: HashMap<WalletAddr, Decimal>,
}

#[derive(Debug, Clone, Default)]
pub struct CategoryStats {
    pub trades_seen: u64,
    pub fills: u64,
    pub partials: u64,
    pub misses: u64,
    pub total_detection_delay_ms: u64,
    pub detection_delay_count: u64,
    /// Realized PnL attributed to this category (from closed positions).
    pub realized_pnl_gross: Decimal,
    pub realized_fees: Decimal,
}

impl CategoryStats {
    pub fn avg_detection_ms(&self) -> Option<f64> {
        if self.detection_delay_count > 0 {
            Some(self.total_detection_delay_ms as f64 / self.detection_delay_count as f64)
        } else {
            None
        }
    }
}

impl EngineState {
    fn render_snapshot(&self) -> RenderSnapshot {
        let p = &self.portfolio;
        let mode = self.config.session.marking_mode;
        let unrealized = p.unrealized_pnl(&self.books, mode);
        let realized_net = p.realized_pnl_net();
        let total_attempts = p.fill_count + p.partial_fill_count + p.miss_count;
        let fill_rate = if total_attempts > 0 {
            ((p.fill_count + p.partial_fill_count) as f64 / total_attempts as f64) * 100.0
        } else { 0.0 };

        let dir = self.category_stats.get(&WalletCategory::Directional);
        let arb = self.category_stats.get(&WalletCategory::Arbitrage);

        // Per-category unrealized: sum unrealized PnL for positions by source_category
        let mut dir_unrealized = Decimal::ZERO;
        let mut arb_unrealized = Decimal::ZERO;
        for (_key, pos) in &p.positions {
            let token_id = &pos.token_id;
            let mark_price = match self.books.get(token_id) {
                Some(book) => match mode {
                    MarkingMode::Conservative => book.best_bid().unwrap_or(Decimal::ZERO),
                    MarkingMode::Midpoint => book.midpoint().unwrap_or(Decimal::ZERO),
                    MarkingMode::LastTrade => book.last_trade_price.unwrap_or(Decimal::ZERO),
                },
                None => Decimal::ZERO,
            };
            let pos_unrealized = pos.qty * mark_price - pos.cost_basis;
            match pos.source_category {
                WalletCategory::Directional => dir_unrealized += pos_unrealized,
                WalletCategory::Arbitrage => arb_unrealized += pos_unrealized,
            }
        }

        let dir_realized = dir.map(|s| s.realized_pnl_gross - s.realized_fees).unwrap_or(Decimal::ZERO);
        let arb_realized = arb.map(|s| s.realized_pnl_gross - s.realized_fees).unwrap_or(Decimal::ZERO);

        let account_value = p.account_value(&self.books, mode);

        RenderSnapshot {
            elapsed: format_elapsed(self.started_at.elapsed()),
            net_pnl: realized_net + unrealized,
            realized_net,
            unrealized,
            fees: p.realized_fees,
            cash: p.cash,
            account_value,
            fill_rate,
            positions: p.positions.len(),
            books: self.books.len(),
            dir_fills: dir.map(|s| s.fills + s.partials).unwrap_or(0),
            dir_misses: dir.map(|s| s.misses).unwrap_or(0),
            dir_lag: dir.and_then(|s| s.avg_detection_ms()),
            dir_realized_net: dir_realized,
            dir_unrealized,
            arb_fills: arb.map(|s| s.fills + s.partials).unwrap_or(0),
            arb_misses: arb.map(|s| s.misses).unwrap_or(0),
            arb_lag: arb.and_then(|s| s.avg_detection_ms()),
            arb_realized_net: arb_realized,
            arb_unrealized,
            trades_seen: self.wallet_trades_seen,
        }
    }
}

/// Run the full engine loop. Main entry point for `df run`.
pub async fn run_session(
    config: AppConfig,
    wallets: Vec<TrackedWallet>,
    store: Arc<Store>,
) -> Result<(), Box<dyn std::error::Error>> {
    let session_id = Utc::now().format("%Y-%m-%d-%H%M%S").to_string();
    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?;

    // Build wallet name map for display
    let wallet_names = crate::config::wallets::build_wallet_name_map(&wallets);

    info!(session_id = %session_id, "starting session");

    // Log session start event
    {
        let start_event = NormalizedEvent::HealthEvent {
            kind: "session_start".into(),
            message: format!(
                "Session started: capital=${}, wallets={}, polling={}, fee_policy={}",
                config.session.starting_capital,
                wallets.len(),
                config.latency.polling_mode,
                config.fees.unavailable_policy,
            ),
            ts: Utc::now(),
        };
        if let Err(e) = store.append_event(&session_id, &start_event) {
            warn!(error = %e, "failed to log session start");
        }
    }

    // === Phase 1: Proactive market discovery ===
    info!("discovering active markets from tracked wallets...");
    let discovered_tokens = rest_wallets::discover_active_tokens(&http_client, &wallets).await;

    // Pre-warm books via REST CLOB API (concurrent)
    let mut warmed_tokens = HashSet::new();
    let mut initial_books: HashMap<TokenId, OrderBook> = HashMap::new();
    let token_list: Vec<TokenId> = discovered_tokens.into_iter().collect();
    if !token_list.is_empty() {
        info!(tokens = token_list.len(), "pre-warming books via CLOB REST API");
        let snapshots = rest_book::fetch_books_batch(&http_client, &token_list).await;
        for snap in snapshots {
            let mut book = OrderBook::new(snap.token_id.clone());
            book.apply_snapshot(&snap.bids, &snap.asks);
            warmed_tokens.insert(snap.token_id.clone());
            initial_books.insert(snap.token_id, book);
        }
        info!(warmed = initial_books.len(), total = token_list.len(), "books pre-warmed");
    }

    // Pre-cache fees for all discovered tokens (off hot path)
    if !token_list.is_empty() {
        info!(tokens = token_list.len(), "pre-caching fee rates...");
        fees::precache_fees(&http_client, &store, &token_list).await;
    }

    // Fetch market metadata
    match rest_metadata::refresh_markets(&http_client, &store).await {
        Ok(count) => info!(markets = count, "market metadata loaded"),
        Err(e) => warn!(error = %e, "failed to load market metadata"),
    }

    let portfolio = Portfolio::new(config.session.starting_capital);

    let mut category_stats = HashMap::new();
    category_stats.insert(WalletCategory::Directional, CategoryStats::default());
    category_stats.insert(WalletCategory::Arbitrage, CategoryStats::default());

    let mut state = EngineState {
        session_id: session_id.clone(),
        portfolio,
        books: initial_books,
        config: config.clone(),
        last_event_id: 0,
        started_at: std::time::Instant::now(),
        wallet_trades_seen: 0,
        first_trade_captures: 0,
        first_trade_misses: 0,
        book_warmups: warmed_tokens.len() as u64,
        warmed_tokens,
        latest_dir_cycle: None,
        latest_arb_cycle: None,
        wallet_names,
        category_stats,
        // Ring buffer: 10k snapshots, 120s max age. Enough for ~30 wallets at
        // typical Polymarket trade frequency without excessive memory.
        trade_time_books: TradeTimeBooks::new(10_000, 120),
        trade_time_hits: 0,
        wallet_pnl_history: HashMap::new(),
        pnl_timeline: Vec::new(),
    };

    // Shutdown signal
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let shutdown_tx_clone = shutdown_tx.clone();
    tokio::spawn(async move {
        tokio::signal::ctrl_c().await.ok();
        info!("received shutdown signal");
        let _ = shutdown_tx_clone.send(true);
    });

    // Channels — wallet_event_tx is shared by REST poller and on-chain listener
    let (ws_event_tx, mut ws_event_rx) = mpsc::channel::<WsMarketEvent>(2000);
    let (wallet_event_tx, mut wallet_event_rx) = mpsc::channel::<DetectedWalletTrade>(1000);
    let (ws_subscribe_tx, ws_subscribe_rx) = mpsc::channel::<TokenId>(200);
    let (metrics_tx, mut metrics_rx) = mpsc::channel::<PollCycleMetrics>(50);
    let seen_tokens: Arc<Mutex<HashSet<TokenId>>> = Arc::new(Mutex::new(HashSet::new()));

    // Pre-populate seen_tokens
    {
        let mut seen = seen_tokens.lock().await;
        for tid in state.warmed_tokens.iter() {
            seen.insert(tid.clone());
        }
    }

    // Start WebSocket market data
    let initial_ws_tokens: Vec<TokenId> = state.warmed_tokens.iter().cloned().collect();
    let ws_event_tx_for_ws = ws_event_tx.clone();
    tokio::spawn(async move {
        ws_market::run_ws_market(initial_ws_tokens, ws_event_tx_for_ws, ws_subscribe_rx).await;
    });
    drop(ws_event_tx);

    // === Phase 2: Start parallel wallet poller ===
    let dir_interval = Duration::from_millis(
        config.latency.directional_interval_ms.unwrap_or(match config.latency.polling_mode {
            PollingMode::Baseline => 3000,
            PollingMode::Aggressive => 1500,
        }),
    );
    let arb_interval = Duration::from_millis(
        config.latency.arbitrage_interval_ms.unwrap_or(match config.latency.polling_mode {
            PollingMode::Baseline => 5000,
            PollingMode::Aggressive => 3000,
        }),
    );

    let poller_client = http_client.clone();
    let poller_wallets = wallets.clone();
    let poller_shutdown = shutdown_rx.clone();
    let poller_seen = seen_tokens.clone();
    let poller_sub_tx = ws_subscribe_tx;
    let poller_event_tx = wallet_event_tx.clone();
    tokio::spawn(async move {
        rest_wallets::run_wallet_poller(
            poller_client,
            poller_wallets,
            dir_interval,
            arb_interval,
            poller_event_tx,
            poller_sub_tx,
            poller_seen,
            metrics_tx,
            poller_shutdown,
        )
        .await;
    });

    // === Phase 3: Start on-chain listener (if configured) ===
    // This provides ~2-4s detection latency vs ~30s from REST polling.
    // Both sources feed into the same wallet_event_tx channel; dedup
    // happens via the existing tx_hash deduplication in the poller.
    let onchain_tx = wallet_event_tx;
    let onchain_wallets = wallets.clone();
    let onchain_shutdown = shutdown_rx.clone();
    let polygon_rpc = config.ingestion.polygon_rpc_ws.clone();
    tokio::spawn(async move {
        onchain::run_onchain_listener(
            polygon_rpc,
            onchain_wallets,
            onchain_tx,
            onchain_shutdown,
        )
        .await;
    });

    // Timers
    let snapshot_interval = Duration::from_secs(config.storage.snapshot_interval_secs);
    let mut snapshot_timer = tokio::time::interval(snapshot_interval);
    snapshot_timer.tick().await;

    let stale_threshold = Duration::from_secs(config.ingestion.stale_threshold_secs);
    let mut stale_timer = tokio::time::interval(Duration::from_secs(10));
    stale_timer.tick().await;

    // Header refreshes every 5s (redraws in place), full status every 30s
    let mut header_timer = tokio::time::interval(Duration::from_secs(5));
    header_timer.tick().await;

    let mut leaderboard_timer = tokio::time::interval(Duration::from_secs(300));
    leaderboard_timer.tick().await;

    let mut header_printed = false;

    let mut metadata_timer = tokio::time::interval(Duration::from_secs(config.ingestion.metadata_refresh_secs));
    metadata_timer.tick().await;

    // Background fee refresh timer (every 10 minutes)
    let mut fee_refresh_timer = tokio::time::interval(Duration::from_secs(600));
    fee_refresh_timer.tick().await;

    let metadata_client = http_client.clone();
    let fee_client = http_client.clone();
    let fee_seen = seen_tokens.clone();

    let mut shutdown_watch = shutdown_rx.clone();

    let dir_count = wallets.iter().filter(|w| w.category == WalletCategory::Directional).count();
    let arb_count = wallets.iter().filter(|w| w.category == WalletCategory::Arbitrage).count();

    println!();
    println!("  {BOLD}{CYAN}df{RESET} — live session {BOLD}{}{RESET}", session_id);
    println!("  {DIM}─────────────────────────────────────────────────────────────────{RESET}");
    println!("  {DIM}capital={RESET}{BOLD}${:.0}{RESET}  {DIM}wallets={RESET}{BOLD}{dir_count}{RESET}{DIM}dir+{RESET}{BOLD}{arb_count}{RESET}{DIM}arb  books={RESET}{}  {DIM}marking={RESET}{}",
        config.session.starting_capital, state.warmed_tokens.len(), config.session.marking_mode);
    println!("  {DIM}polling={RESET}dir/{}ms arb/{}ms  {DIM}arrival={RESET}{}ms  {DIM}fee_policy={RESET}{}",
        dir_interval.as_millis(), arb_interval.as_millis(),
        config.latency.arrival_delay_ms, config.fees.unavailable_policy);
    if config.ingestion.polygon_rpc_ws.is_some() {
        println!("  {GREEN}on-chain detection: ENABLED{RESET} (Polygon WS)");
    }
    println!("  {DIM}─────────────────────────────────────────────────────────────────{RESET}");
    println!();

    loop {
        tokio::select! {
            // WebSocket events (book updates, trade prices)
            ws_event = ws_event_rx.recv() => {
                let Some(event) = ws_event else { break };
                handle_ws_event(&mut state, &store, event);
            }

            // Wallet trade detections
            wallet_trade = wallet_event_rx.recv() => {
                let Some(trade) = wallet_trade else { break };
                handle_wallet_trade(&mut state, &store, &http_client, trade).await;
            }

            // Poll cycle metrics
            metrics = metrics_rx.recv() => {
                if let Some(m) = metrics {
                    match m.category {
                        WalletCategory::Directional => state.latest_dir_cycle = Some(m),
                        WalletCategory::Arbitrage => state.latest_arb_cycle = Some(m),
                    }
                }
            }

            // Periodic snapshot
            _ = snapshot_timer.tick() => {
                save_snapshot(&state, &store);
            }

            // Stale book check
            _ = stale_timer.tick() => {
                for book in state.books.values_mut() {
                    book.check_staleness(stale_threshold);
                }
            }

            // Periodic header refresh (redraws stats in place) + record PnL timeline
            _ = header_timer.tick() => {
                let snap = state.render_snapshot();
                if !header_printed {
                    tui::print_header(&snap);
                    header_printed = true;
                } else {
                    tui::update_header(&snap);
                }

                // Record PnL snapshot for time series (every tick = 5s)
                let mode = state.config.session.marking_mode;
                let wallet_unrealized = state.portfolio.unrealized_by_wallet(&state.books, mode);
                state.pnl_timeline.push(PnlSnapshot {
                    elapsed_secs: state.started_at.elapsed().as_secs(),
                    net_pnl: snap.net_pnl,
                    realized_net: snap.realized_net,
                    unrealized: snap.unrealized,
                    positions: snap.positions,
                    fills: state.portfolio.fill_count + state.portfolio.partial_fill_count,
                    misses: state.portfolio.miss_count,
                    wallet_unrealized,
                });
            }

            // Periodic wallet leaderboard (every 5 min)
            _ = leaderboard_timer.tick() => {
                print_wallet_leaderboard(&mut state);
            }

            // Metadata refresh (runs on main task since Store isn't Send)
            _ = metadata_timer.tick() => {
                if let Err(e) = rest_metadata::refresh_markets(&metadata_client, &store).await {
                    debug!(error = %e, "metadata refresh failed");
                }

                // Check for resolved markets and settle positions
                check_market_resolutions(&mut state, &store);
            }

            // Background fee refresh for tracked tokens
            _ = fee_refresh_timer.tick() => {
                let tokens: Vec<TokenId> = fee_seen.lock().await.iter().cloned().collect();
                if !tokens.is_empty() {
                    fees::precache_fees(&fee_client, &store, &tokens).await;
                }
            }

            // Shutdown
            _ = shutdown_watch.changed() => {
                if *shutdown_watch.borrow() {
                    println!();
                    println!("  {DIM}Shutting down...{RESET}");
                    break;
                }
            }
        }
    }

    // Final snapshot
    save_snapshot(&state, &store);

    // Print final summary
    print_final_summary(&state);

    // Generate end-of-session HTML report with live unrealized PnL
    generate_session_report(&state, &store, &wallets);

    Ok(())
}

fn handle_ws_event(state: &mut EngineState, store: &Store, event: WsMarketEvent) {
    match event {
        WsMarketEvent::BookSnapshot {
            token_id,
            bids,
            asks,
            ..
        } => {
            let book = state
                .books
                .entry(token_id.clone())
                .or_insert_with(|| OrderBook::new(token_id.clone()));
            book.apply_snapshot(&bids, &asks);
        }
        WsMarketEvent::LastTradePrice {
            token_id, price, size, ..
        } => {
            if let Some(book) = state.books.get_mut(&token_id) {
                book.last_trade_price = Some(price);

                // === TRADE-TIME BOOK SNAPSHOT ===
                // The WS fires last_trade_price at CLOB match time (sub-second).
                // We snapshot the book NOW — this is the closest approximation
                // of what the book looked like when the trade actually happened.
                // When REST later detects a tracked wallet was the trader, we
                // simulate against THIS snapshot instead of the current book.
                state.trade_time_books.record(&token_id, price, size, book);
            }
        }
        WsMarketEvent::Connected => {
            debug!("WebSocket connected");
            let event = NormalizedEvent::HealthEvent {
                kind: "ws_connected".into(),
                message: "WebSocket connected".into(),
                ts: Utc::now(),
            };
            if let Ok(id) = store.append_event(&state.session_id, &event) {
                state.last_event_id = id;
            }
        }
        WsMarketEvent::Disconnected { reason } => {
            // Only mark books as rebuilding once per disconnect (not on every reconnect attempt).
            // Check if books are already in rebuilding state to avoid log spam.
            let already_rebuilding = state.books.values().all(|b| b.quality == DataQuality::Rebuilding);
            if !already_rebuilding {
                debug!(reason, "WebSocket disconnected — marking books as rebuilding");
                for book in state.books.values_mut() {
                    book.mark_rebuilding();
                }
                let event = NormalizedEvent::HealthEvent {
                    kind: "ws_disconnected".into(),
                    message: format!("WebSocket disconnected: {reason}"),
                    ts: Utc::now(),
                };
                if let Ok(id) = store.append_event(&state.session_id, &event) {
                    state.last_event_id = id;
                }
            }
        }
    }
}

async fn handle_wallet_trade(
    state: &mut EngineState,
    store: &Store,
    http_client: &reqwest::Client,
    trade: DetectedWalletTrade,
) {
    state.wallet_trades_seen += 1;
    let cat_stats = state.category_stats.entry(trade.category).or_default();
    cat_stats.trades_seen += 1;

    let raw_detection_delay_ms = (trade.detected_at - trade.source_ts)
        .num_milliseconds()
        .max(0) as u64;

    // Trades older than 60s are from discovery/warmup, not real-time detection.
    let is_stale_detection = raw_detection_delay_ms > 60_000;
    let detection_delay_ms = if is_stale_detection {
        None
    } else {
        Some(raw_detection_delay_ms)
    };

    // Track detection delay stats per category
    if let Some(d) = detection_delay_ms {
        cat_stats.total_detection_delay_ms += d;
        cat_stats.detection_delay_count += 1;
    }

    // Category-specific detection age check.
    // This is NOT strategy filtering — it's realism: if a trade is too old to plausibly copy,
    // we record it as a miss with an honest reason rather than simulating an impossible fill.
    if let Some(max_age) = state.config.max_detection_age_for(trade.category) {
        if let Some(delay) = detection_delay_ms {
            if delay > max_age {
                // Record as miss — too old to realistically act on.
                // This is a realism guard, not a strategy filter.
                state.portfolio.record_miss();
                cat_stats.misses += 1;

                let wallet_event = NormalizedEvent::WalletTrade {
                    wallet: trade.wallet.clone(),
                    category: trade.category,
                    token_id: trade.token_id.clone(),
                    market_id: trade.market_id.clone(),
                    side: trade.side,
                    price: trade.price,
                    size: trade.size,
                    tx_hash: trade.tx_hash.clone(),
                    detected_at: trade.detected_at,
                    source_ts: trade.source_ts,
                };
                let _ = store.append_event(&state.session_id, &wallet_event);

                let fill_event = NormalizedEvent::SimulatedFill {
                    wallet_trade_ref: trade.tx_hash,
                    our_side: trade.side,
                    fill_result: FillResult::Miss {
                        reason: MissReason::DetectionTooOld,
                    },
                    avg_price: None,
                    filled_qty: Decimal::ZERO,
                    fee_rate: None,
                    fee_amount: Decimal::ZERO,
                    fee_source: FeeSource::Unavailable,
                    slippage_bps: None,
                    latency: LatencyComponents {
                        detection_delay_ms,
                        processing_delay_ms: Some(0),
                        arrival_delay_ms: state.config.arrival_delay_for(trade.category),
                    },
                    book_quality: DataQuality::Stale,
                    exit_actionability: None,
                };
                let _ = store.append_event(&state.session_id, &fill_event);
                return;
            }
        }
    }

    let is_first_trade = !state.warmed_tokens.contains(&trade.token_id);

    // === TEMPORAL CORRECTNESS: Capture the detection-time book state ===
    // We simulate against the book as it exists NOW (at detection time).
    // We do NOT fetch a new book after the tracked wallet traded — that would
    // be hindsight. If the book is missing/stale, we do a REST warmup, but this
    // represents what we would realistically see, not a post-trade book.
    let book_needs_warmup = match state.books.get(&trade.token_id) {
        None => true,
        Some(b) => b.quality == DataQuality::Rebuilding || b.quality == DataQuality::Stale,
    };

    if book_needs_warmup {
        debug!(
            token = %trade.token_id,
            is_first = is_first_trade,
            "attempting REST book warmup for trade"
        );
        match rest_book::fetch_book(http_client, &trade.token_id).await {
            Ok(snapshot) => {
                let book = state
                    .books
                    .entry(trade.token_id.clone())
                    .or_insert_with(|| OrderBook::new(trade.token_id.clone()));
                book.apply_snapshot(&snapshot.bids, &snapshot.asks);
                state.warmed_tokens.insert(trade.token_id.clone());
                state.book_warmups += 1;
            }
            Err(e) => {
                warn!(
                    token = %trade.token_id,
                    error = %e,
                    "REST book warmup failed"
                );
            }
        }
    }

    // Log the wallet trade event
    let wallet_event = NormalizedEvent::WalletTrade {
        wallet: trade.wallet.clone(),
        category: trade.category,
        token_id: trade.token_id.clone(),
        market_id: trade.market_id.clone(),
        side: trade.side,
        price: trade.price,
        size: trade.size,
        tx_hash: trade.tx_hash.clone(),
        detected_at: trade.detected_at,
        source_ts: trade.source_ts,
    };
    if let Ok(id) = store.append_event(&state.session_id, &wallet_event) {
        state.last_event_id = id;
    }

    // Resolve fees from cache (pre-cached, no network call on hot path)
    let resolved = fees::resolve_from_cache(
        store,
        &trade.token_id,
        state.config.fees.cache_ttl_secs,
    );

    // If cache miss, try live as fallback (but we expect this to be rare after precaching)
    let resolved = if resolved.source == FeeSource::Unavailable {
        fees::resolve_fee(
            http_client,
            store,
            &trade.token_id,
            state.config.fees.cache_ttl_secs,
        )
        .await
    } else {
        resolved
    };

    // Fee-unavailable policy check (category-specific)
    let fee_policy = state.config.fee_policy_for(trade.category);
    if resolved.source == FeeSource::Unavailable && fee_policy == FeeUnavailablePolicy::Skip {
        state.portfolio.record_miss();
        cat_stats.misses += 1;
        if is_first_trade {
            state.first_trade_misses += 1;
        }

        let fill_event = NormalizedEvent::SimulatedFill {
            wallet_trade_ref: trade.tx_hash,
            our_side: trade.side,
            fill_result: FillResult::Miss {
                reason: MissReason::Degraded,
            },
            avg_price: None,
            filled_qty: Decimal::ZERO,
            fee_rate: None,
            fee_amount: Decimal::ZERO,
            fee_source: FeeSource::Unavailable,
            slippage_bps: None,
            latency: LatencyComponents {
                detection_delay_ms,
                processing_delay_ms: Some(0),
                arrival_delay_ms: state.config.arrival_delay_for(trade.category),
            },
            book_quality: state
                .books
                .get(&trade.token_id)
                .map(|b| b.quality)
                .unwrap_or(DataQuality::Rebuilding),
            exit_actionability: None,
        };
        if let Ok(id) = store.append_event(&state.session_id, &fill_event) {
            state.last_event_id = id;
        }
        return;
    }

    // Get current position qty for sell validation
    let current_qty = state.portfolio.position_qty(&trade.token_id, &trade.wallet);

    // Category-specific position sizing
    let max_fraction = state.config.max_position_fraction_for(trade.category);
    let max_for_trade = max_fraction * state.portfolio.starting_capital;
    let available = state.portfolio.cash.min(max_for_trade);

    // Category-specific slippage
    let max_slippage = state.config.max_slippage_for(trade.category);

    let processing_start = std::time::Instant::now();

    // === TEMPORAL CORRECTNESS: Use trade-time book snapshot if available ===
    // The WS `last_trade_price` event fires at CLOB match time (sub-second).
    // We recorded the book state at that moment. If we can match this detected
    // trade to a WS trade event, we simulate against THAT book — not the
    // current book which may have changed in the 10-30s since the trade.
    let trade_time_snapshot = state.trade_time_books.lookup(&trade.token_id, trade.price, Some(trade.size));

    let mut book = if let Some(snapshot_book) = trade_time_snapshot {
        state.trade_time_hits += 1;
        snapshot_book.clone()
    } else {
        state
            .books
            .entry(trade.token_id.clone())
            .or_insert_with(|| OrderBook::new(trade.token_id.clone()))
            .clone()
    };

    // === LIQUIDITY DECAY: subtract the tracked wallet's fill from the book ===
    // The tracked wallet already consumed liquidity on the relevant side.
    // We must simulate our fill against what's LEFT, not the full pre-trade book.
    // For a BUY by the tracked wallet: they consumed asks. Remove trade.size from asks.
    // For a SELL by the tracked wallet: they consumed bids. Remove trade.size from bids.
    book.consume_liquidity(trade.side, trade.size);

    let request = FillRequest {
        side: trade.side,
        desired_qty: trade.size,
        reference_price: trade.price,
        max_slippage_bps: max_slippage,
        available_capital: available,
        fee_rate_bps: resolved.rate_bps,
        fee_source: resolved.source,
        current_position_qty: current_qty,
        latency: LatencyComponents {
            detection_delay_ms,
            processing_delay_ms: None,
            arrival_delay_ms: state.config.arrival_delay_for(trade.category),
        },
    };

    let mut output = fill::simulate_fill(&book, &request);
    output.latency.processing_delay_ms = Some(processing_start.elapsed().as_millis() as u64);

    // Track first-trade capture rate
    if is_first_trade {
        match &output.result {
            FillResult::Full | FillResult::Partial { .. } => {
                state.first_trade_captures += 1;
            }
            FillResult::Miss { .. } => {
                state.first_trade_misses += 1;
            }
        }
    }

    // Snapshot PnL before applying, so we can compute the delta for category tracking
    let pnl_before = state.portfolio.realized_pnl_gross;
    let fees_before = state.portfolio.realized_fees;

    // Apply to portfolio
    match &output.result {
        FillResult::Full => {
            let apply_result = match trade.side {
                Side::Buy => state.portfolio.apply_buy(
                    &trade.token_id,
                    &trade.market_id,
                    &output,
                    &trade.wallet,
                    trade.category,
                ),
                Side::Sell => state.portfolio.apply_sell(&trade.token_id, &trade.wallet, &output),
            };
            if let Err(e) = apply_result {
                error!(error = %e, "portfolio error on full fill");
                state.portfolio.record_miss();
                cat_stats.misses += 1;
            } else {
                state.portfolio.record_full();
                cat_stats.fills += 1;
            }
        }
        FillResult::Partial { .. } => {
            let apply_result = match trade.side {
                Side::Buy => state.portfolio.apply_buy(
                    &trade.token_id,
                    &trade.market_id,
                    &output,
                    &trade.wallet,
                    trade.category,
                ),
                Side::Sell => state.portfolio.apply_sell(&trade.token_id, &trade.wallet, &output),
            };
            if let Err(e) = apply_result {
                error!(error = %e, "portfolio error on partial fill");
                state.portfolio.record_miss();
                cat_stats.misses += 1;
            } else {
                state.portfolio.record_partial();
                cat_stats.partials += 1;
            }
        }
        FillResult::Miss { .. } => {
            state.portfolio.record_miss();
            cat_stats.misses += 1;
        }
    }

    // Track realized PnL/fees delta per category
    let pnl_delta = state.portfolio.realized_pnl_gross - pnl_before;
    let fees_delta = state.portfolio.realized_fees - fees_before;
    // Re-borrow cat_stats (was dropped by match above)
    let cat_stats = state.category_stats.entry(trade.category).or_default();
    cat_stats.realized_pnl_gross += pnl_delta;
    cat_stats.realized_fees += fees_delta;

    // === LIVE TRADE FEED ===
    let wallet_name = state.wallet_names.get(&trade.wallet)
        .cloned()
        .unwrap_or_else(|| abbreviate_addr(&trade.wallet));
    let market_name = store.lookup_token_market(&trade.token_id)
        .map(|(q, outcome)| {
            let short_q = if q.len() > 40 { format!("{}...", &q[..40]) } else { q };
            format!("{short_q} ({outcome})")
        })
        .unwrap_or_else(|| {
            if trade.token_id.len() > 16 { format!("{}...", &trade.token_id[..16]) }
            else { trade.token_id.clone() }
        });

    let line = tui::format_trade_line(
        &output.result,
        trade.side,
        &wallet_name,
        &market_name,
        output.avg_price,
        output.filled_qty,
        output.fee_amount,
        detection_delay_ms,
    );
    println!("{line}");

    // Log the simulated fill event
    let fill_event = NormalizedEvent::SimulatedFill {
        wallet_trade_ref: trade.tx_hash,
        our_side: trade.side,
        fill_result: output.result,
        avg_price: output.avg_price,
        filled_qty: output.filled_qty,
        fee_rate: output.fee_rate_bps,
        fee_amount: output.fee_amount,
        fee_source: output.fee_source,
        slippage_bps: output.slippage_bps,
        latency: output.latency,
        book_quality: output.book_quality,
        exit_actionability: output.exit_actionability,
    };
    if let Ok(id) = store.append_event(&state.session_id, &fill_event) {
        state.last_event_id = id;
    }
}

fn save_snapshot(state: &EngineState, store: &Store) {
    match state.portfolio.to_json() {
        Ok(json) => {
            if let Err(e) =
                store.save_snapshot(&state.session_id, state.last_event_id, &json)
            {
                warn!(error = %e, "failed to save snapshot");
            }
        }
        Err(e) => {
            warn!(error = %e, "failed to serialize portfolio for snapshot");
        }
    }
}

// ── ANSI color helpers ──
const GREEN: &str = "\x1b[32m";
const RED: &str = "\x1b[31m";
const YELLOW: &str = "\x1b[33m";
const CYAN: &str = "\x1b[36m";
const DIM: &str = "\x1b[2m";
const BOLD: &str = "\x1b[1m";
const RESET: &str = "\x1b[0m";

fn color_pnl(v: Decimal) -> String {
    if v > Decimal::ZERO {
        format!("{GREEN}+${v:.2}{RESET}")
    } else if v < Decimal::ZERO {
        format!("{RED}-${:.2}{RESET}", v.abs())
    } else {
        format!("{DIM}$0.00{RESET}")
    }
}

fn format_elapsed(d: std::time::Duration) -> String {
    let secs = d.as_secs();
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    if h > 0 {
        format!("{h}h{m:02}m{s:02}s")
    } else if m > 0 {
        format!("{m}m{s:02}s")
    } else {
        format!("{s}s")
    }
}

#[allow(dead_code)]
fn fmt_pnl_short(v: Decimal) -> String {
    if v >= Decimal::ZERO { format!("+${v:.2}") } else { format!("-${:.2}", v.abs()) }
}

/// Legacy status line (kept for non-TUI fallback).
#[allow(dead_code)]
fn print_status(state: &EngineState) {
    let p = &state.portfolio;
    let mode = state.config.session.marking_mode;
    let unrealized = p.unrealized_pnl(&state.books, mode);
    let realized_net = p.realized_pnl_net();
    let net = realized_net + unrealized;
    let elapsed = format_elapsed(state.started_at.elapsed());

    let total_attempts = p.fill_count + p.partial_fill_count + p.miss_count;
    let fill_rate = if total_attempts > 0 {
        ((p.fill_count + p.partial_fill_count) as f64 / total_attempts as f64) * 100.0
    } else { 0.0 };

    // Honesty flag
    let flag = if realized_net < Decimal::ZERO && net > Decimal::ZERO {
        format!(" {YELLOW}UNREALIZED{RESET}")
    } else if net > Decimal::ZERO {
        format!(" {GREEN}PROFIT{RESET}")
    } else if net < Decimal::ZERO {
        format!(" {RED}LOSS{RESET}")
    } else {
        String::new()
    };

    // Category summaries
    let dir = state.category_stats.get(&WalletCategory::Directional);
    let arb = state.category_stats.get(&WalletCategory::Arbitrage);

    let dir_str = dir.map(|s| {
        let lag = s.avg_detection_ms().map(|v| format!(" {DIM}lag={:.0}s{RESET}", v / 1000.0)).unwrap_or_default();
        format!("{CYAN}dir{RESET}:{GREEN}{}{RESET}f/{RED}{}{RESET}m{lag}", s.fills, s.misses)
    }).unwrap_or_default();

    let arb_str = arb.map(|s| {
        let lag = s.avg_detection_ms().map(|v| format!(" {DIM}lag={:.0}s{RESET}", v / 1000.0)).unwrap_or_default();
        format!("{YELLOW}arb{RESET}:{GREEN}{}{RESET}f/{RED}{}{RESET}m{lag}", s.fills, s.misses)
    }).unwrap_or_default();

    let fill_color = if fill_rate >= 50.0 { GREEN } else if fill_rate >= 25.0 { YELLOW } else { RED };

    println!(
        "  {DIM}[{elapsed}]{RESET}  {net}  {DIM}real={RESET}{real}  {DIM}unreal={RESET}{unreal}  {DIM}fees={RESET}${fees:.2}  {DIM}fill={RESET}{fill_color}{fill_rate:.0}%{RESET}  {DIM}pos={RESET}{pos}{flag}  {DIM}|{RESET}  {dir_str}  {arb_str}",
        net = color_pnl(net),
        real = color_pnl(realized_net),
        unreal = color_pnl(unrealized),
        fees = p.realized_fees,
        pos = p.positions.len(),
    );
}

fn print_final_summary(state: &EngineState) {
    let p = &state.portfolio;
    let mode = state.config.session.marking_mode;
    let unrealized = p.unrealized_pnl(&state.books, mode);
    let account_val = p.account_value(&state.books, mode);
    let net = p.net_pnl(&state.books, mode);
    let realized_net = p.realized_pnl_net();
    let elapsed = format_elapsed(state.started_at.elapsed());

    let total_attempts = p.fill_count + p.partial_fill_count + p.miss_count;
    let fill_rate = if total_attempts > 0 {
        ((p.fill_count + p.partial_fill_count) as f64 / total_attempts as f64) * 100.0
    } else { 0.0 };

    let first_total = state.first_trade_captures + state.first_trade_misses;
    let first_capture_pct = if first_total > 0 {
        (state.first_trade_captures as f64 / first_total as f64) * 100.0
    } else { 0.0 };

    let total_fills = p.fill_count + p.partial_fill_count;
    let ttb_pct = if total_fills > 0 {
        (state.trade_time_hits as f64 / total_fills as f64) * 100.0
    } else { 0.0 };

    println!();
    println!("  {BOLD}{CYAN}═══════════════════════════════════════════════════════════════════{RESET}");
    println!("  {BOLD}SESSION COMPLETE{RESET}: {} {DIM}({}){RESET}", state.session_id, elapsed);
    println!("  {BOLD}{CYAN}═══════════════════════════════════════════════════════════════════{RESET}");

    // === VERDICT ===
    println!();
    if realized_net < Decimal::ZERO && net > Decimal::ZERO {
        println!("  {BOLD}{YELLOW}VERDICT:  UNREALIZED PROFIT{RESET}  {}", color_pnl(net));
        println!("  {DIM}         Realized is {} — the {} requires exiting {} positions.{RESET}",
            color_pnl(realized_net), color_pnl(unrealized), p.positions.len());
        println!("  {YELLOW}         This is NOT confirmed profit.{RESET}");
    } else if realized_net > Decimal::ZERO && net > Decimal::ZERO {
        println!("  {BOLD}{GREEN}VERDICT:  REAL PROFIT{RESET}  {}", color_pnl(net));
        println!("  {DIM}         Realized {}  |  Unrealized {}{RESET}", color_pnl(realized_net), color_pnl(unrealized));
    } else if net < Decimal::ZERO {
        println!("  {BOLD}{RED}VERDICT:  LOSS{RESET}  {}", color_pnl(net));
        println!("  {DIM}         Realized {}  |  Unrealized {}{RESET}", color_pnl(realized_net), color_pnl(unrealized));
    } else {
        println!("  {BOLD}VERDICT:  FLAT{RESET}");
    }

    // === PnL ===
    println!();
    println!("  {BOLD}PnL{RESET} {DIM}(marking: {mode}){RESET}");
    println!("    {DIM}Realized gross{RESET}     {}", color_pnl(p.realized_pnl_gross));
    println!("    {DIM}Realized fees{RESET}     {RED}-${:.2}{RESET}", p.realized_fees);
    println!("    {DIM}Realized net{RESET}       {}", color_pnl(realized_net));
    println!("    {DIM}Unrealized{RESET}         {}", color_pnl(unrealized));
    println!("    {DIM}─────────────────────{RESET}");
    println!("    {BOLD}Net PnL{RESET}            {}", color_pnl(net));
    if p.realized_fees > Decimal::ZERO && p.realized_pnl_gross != Decimal::ZERO {
        let fee_pct = (p.realized_fees / p.realized_pnl_gross.abs() * Decimal::new(100, 0)).round_dp(0);
        if fee_pct > Decimal::new(50, 0) {
            println!("    {YELLOW}(!) Fees are {}% of gross PnL{RESET}", fee_pct);
        }
    }

    // === PORTFOLIO ===
    println!();
    println!("  {BOLD}Portfolio{RESET}");
    println!("    Capital {BOLD}${:.0}{RESET}  ->  Account {BOLD}${:.0}{RESET}  |  Cash ${:.0}  |  {BOLD}{}{RESET} open positions",
        p.starting_capital, account_val, p.cash, p.positions.len());

    // === FILLS ===
    println!();
    println!("  {BOLD}Fills{RESET}");
    println!("    {BOLD}{}{RESET} detected  |  {GREEN}{}{RESET} filled ({} full + {} partial)  |  {RED}{}{RESET} missed  |  {fill_rate:.0}% fill rate",
        state.wallet_trades_seen, total_fills, p.fill_count, p.partial_fill_count, p.miss_count);
    println!("    {DIM}Turnover ${:.0}  |  First-trade capture {first_capture_pct:.0}%  |  Book snapshots used {ttb_pct:.0}%{RESET}",
        p.turnover);

    // === PER-CATEGORY ===
    println!();
    let cat_order = [WalletCategory::Directional, WalletCategory::Arbitrage];
    for cat in &cat_order {
        let Some(stats) = state.category_stats.get(cat) else { continue };
        let total = stats.fills + stats.partials + stats.misses;
        let cat_fill = if total > 0 {
            ((stats.fills + stats.partials) as f64 / total as f64) * 100.0
        } else { 0.0 };
        let lag = stats.avg_detection_ms()
            .map(|v| format!("{:.1}s", v / 1000.0))
            .unwrap_or_else(|| "n/a".into());
        let cat_color = match cat {
            WalletCategory::Directional => CYAN,
            WalletCategory::Arbitrage => YELLOW,
        };
        println!("  {cat_color}{BOLD}{cat}{RESET}:  {total} trades  {GREEN}{fills}f{RESET}/{RED}{misses}m{RESET}  {cat_fill:.0}% fill  {DIM}avg lag {lag}{RESET}",
            fills = stats.fills + stats.partials,
            misses = stats.misses);
    }

    // === DETECTION ===
    println!();
    println!("  {BOLD}Detection{RESET}");
    if let Some(ref m) = state.latest_dir_cycle {
        println!("    {CYAN}Directional{RESET}: {}ms cycle, {} wallets, {} new/cycle, {} errors",
            m.cycle_duration.as_millis(), m.wallet_count, m.new_trades_found, m.errors);
    }
    if let Some(ref m) = state.latest_arb_cycle {
        println!("    {YELLOW}Arbitrage{RESET}:   {}ms cycle, {} wallets, {} new/cycle, {} errors",
            m.cycle_duration.as_millis(), m.wallet_count, m.new_trades_found, m.errors);
    }
    println!("    {DIM}Books tracked: {}  |  Pre-warmed: {}  |  Snapshots buffered: {}{RESET}",
        state.books.len(), state.book_warmups, state.trade_time_books.len());

    println!();
}

/// Print top/bottom wallets by unrealized PnL with trend. Shown every 5 minutes.
fn print_wallet_leaderboard(state: &mut EngineState) {
    let mode = state.config.session.marking_mode;
    let unrealized_map = state.portfolio.unrealized_by_wallet(&state.books, mode);
    let exposure_map = state.portfolio.exposure_by_wallet(&state.books, mode);

    if unrealized_map.is_empty() {
        return;
    }

    // Record current snapshot in history and compute trend
    for (wallet, pnl) in &unrealized_map {
        let history = state.wallet_pnl_history.entry(wallet.clone()).or_default();
        history.push(*pnl);
        // Keep last 12 snapshots (= 1 hour at 5-min intervals)
        if history.len() > 12 {
            history.remove(0);
        }
    }

    let mut sorted: Vec<_> = unrealized_map.iter().collect();
    sorted.sort_by(|a, b| b.1.partial_cmp(a.1).unwrap_or(std::cmp::Ordering::Equal));

    let show = sorted.len().min(6);

    println!();
    println!("  {DIM}┌─{RESET} {BOLD}Wallet Snapshot{RESET} {DIM}(unrealized PnL, trend, exposure){RESET}");

    for (wallet, pnl) in &sorted[..show] {
        let name = state.wallet_names.get(*wallet)
            .cloned()
            .unwrap_or_else(|| abbreviate_addr(wallet));
        let exp = exposure_map.get(*wallet).copied().unwrap_or(Decimal::ZERO);

        // Trend: compare to previous snapshot
        let trend = state.wallet_pnl_history.get(*wallet)
            .and_then(|h| if h.len() >= 2 {
                let prev = h[h.len() - 2];
                let curr = h[h.len() - 1];
                if curr > prev { Some(format!("{GREEN}{RESET}")) }
                else if curr < prev { Some(format!("{RED}{RESET}")) }
                else { Some(format!("{DIM}={RESET}")) }
            } else { None })
            .unwrap_or_default();

        println!("  {DIM}│{RESET}  {:<12} {:>14} {trend}  {DIM}exp=${:.0}{RESET}", name, color_pnl(**pnl), exp);
    }

    if sorted.len() > show {
        let (worst_addr, worst_pnl) = sorted.last().unwrap();
        let worst_name = state.wallet_names.get(*worst_addr)
            .cloned()
            .unwrap_or_else(|| abbreviate_addr(worst_addr));
        let worst_exp = exposure_map.get(*worst_addr).copied().unwrap_or(Decimal::ZERO);
        println!("  {DIM}│  ...  ({} more wallets){RESET}", sorted.len() - show);
        println!("  {DIM}│{RESET}  {:<12} {:>14}    {DIM}exp=${:.0}{RESET}", worst_name, color_pnl(**worst_pnl), worst_exp);
    }

    println!("  {DIM}└─{RESET}");
    println!();
}

fn abbreviate_addr(addr: &str) -> String {
    if addr.len() > 10 {
        format!("{}…{}", &addr[..6], &addr[addr.len() - 4..])
    } else {
        addr.to_string()
    }
}

/// Check for resolved markets and settle any open positions at 0 or 1.
/// Markets that have closed/resolved are settled at their resolution price.
fn check_market_resolutions(state: &mut EngineState, store: &Store) {
    // Get token -> market mapping to check resolution status
    let _token_map = store.build_token_name_map();

    // Collect positions that need settlement (can't mutate while iterating)
    let mut to_settle: Vec<(PositionKey, Decimal)> = Vec::new();

    for (key, pos) in &state.portfolio.positions {
        // Check if this token's market is resolved by looking at the markets table
        // A resolved market will have active=0 in the DB after metadata refresh
        if let Some(book) = state.books.get(&pos.token_id) {
            // If the book has a last_trade_price of exactly 0 or 1, the market likely resolved
            if let Some(ltp) = book.last_trade_price {
                if ltp == Decimal::ZERO || ltp == Decimal::ONE {
                    to_settle.push((key.clone(), ltp));
                }
            }
        }
    }

    // Settle resolved positions
    for (key, resolution_price) in to_settle {
        if let Some(pos) = state.portfolio.positions.get(&key) {
            let proceeds = pos.qty * resolution_price;
            let cost_of_sold = pos.cost_basis;
            let gross_pnl = proceeds - cost_of_sold;

            state.portfolio.cash += proceeds;
            state.portfolio.realized_pnl_gross += gross_pnl;
            state.portfolio.turnover += proceeds;

            let wallet = pos.source_wallet.clone();
            let token = pos.token_id.clone();
            let cat = pos.source_category;
            let qty = pos.qty;

            info!(
                token = %token,
                wallet = %wallet,
                qty = %qty,
                resolution_price = %resolution_price,
                pnl = %gross_pnl,
                "market resolved — position settled"
            );

            // Track in category stats
            if let Some(cs) = state.category_stats.get_mut(&cat) {
                cs.realized_pnl_gross += gross_pnl;
            }

            // Log settlement event
            let event = NormalizedEvent::HealthEvent {
                kind: "market_resolution".into(),
                message: format!(
                    "Settled position: {} qty={} @ {} pnl={}",
                    token, qty, resolution_price, gross_pnl
                ),
                ts: Utc::now(),
            };
            let _ = store.append_event(&state.session_id, &event);
        }
        state.portfolio.positions.remove(&key);
    }
}

/// Generate an HTML report at session end with live unrealized PnL.
fn generate_session_report(state: &EngineState, store: &Store, wallets: &[TrackedWallet]) {
    let wallet_names = crate::config::wallets::build_wallet_name_map(wallets);
    let wallet_profiles = crate::config::wallets::build_wallet_profile_map(wallets);

    let live = LivePortfolioState {
        portfolio: &state.portfolio,
        books: &state.books,
        marking_mode: state.config.session.marking_mode,
        store,
    };

    let a = match analytics::compute_analytics(
        store,
        &state.session_id,
        state.config.session.starting_capital,
        &wallet_names,
        &wallet_profiles,
        Some(&live),
        state.pnl_timeline.clone(),
    ) {
        Ok(a) => a,
        Err(e) => {
            warn!(error = %e, "failed to compute session analytics");
            return;
        }
    };

    let output_path = state
        .config
        .storage
        .sessions_dir
        .join(format!("{}.html", state.session_id));

    match html::generate_html_report(&a, &output_path) {
        Ok(()) => {
            println!("  {BOLD}Report:{RESET} {CYAN}{}{RESET}", output_path.display());
        }
        Err(e) => {
            warn!(error = %e, "failed to generate session report");
        }
    }
}
