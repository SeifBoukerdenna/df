//! On-chain trade detection via Polygon WebSocket RPC.
//!
//! Subscribes to `OrderFilled` events on Polymarket's CTF Exchange contracts
//! filtered by tracked wallet addresses in topic2 (maker) and topic3 (taker).
//! This provides ~2-4 second detection latency vs ~30 seconds via REST polling.
//!
//! # CU cost (Alchemy)
//! Alchemy charges ~40 CU per log notification pushed via eth_subscribe.
//! By filtering subscriptions to only our tracked wallets (not all events),
//! we receive only ~100-1000 events/day instead of ~30,000-50,000/hour.
//! Estimated cost: ~500-2000 CU/hour for 50 wallets. Free tier (30M CU/month)
//! is sufficient for months of continuous operation.
//!
//! # Subscription strategy
//! We create 4 subscriptions:
//! - CTF Exchange, topic2 (maker) = [wallet1, wallet2, ...]
//! - CTF Exchange, topic3 (taker) = [wallet1, wallet2, ...]
//! - NegRisk CTF Exchange, topic2 (maker) = [wallet1, wallet2, ...]
//! - NegRisk CTF Exchange, topic3 (taker) = [wallet1, wallet2, ...]
//!
//! eth_subscribe supports OR within a single topic position, so we can pass
//! all 50 wallet addresses as alternatives for topic2 or topic3.

use std::time::Duration;

use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use rust_decimal::Decimal;
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

use crate::config::wallets::TrackedWallet;
use crate::core::types::{Side, WalletCategory};
use crate::ingestion::rest_wallets::DetectedWalletTrade;

/// Polymarket CTF Exchange contract on Polygon.
const CTF_EXCHANGE: &str = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
/// Polymarket Neg Risk CTF Exchange contract on Polygon.
const NEG_RISK_CTF_EXCHANGE: &str = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

/// OrderFilled event signature.
const ORDER_FILLED_TOPIC: &str =
    "0xd0a08e8c493f9c94f29311571544f2711c12c40b001e53b1b8c622794e705e00";

pub async fn run_onchain_listener(
    rpc_url: Option<String>,
    wallets: Vec<TrackedWallet>,
    event_tx: mpsc::Sender<DetectedWalletTrade>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    let Some(url) = rpc_url else {
        info!("on-chain detection disabled (no polygon_rpc_ws configured) — using REST polling only");
        return;
    };

    let mut wallet_map: std::collections::HashMap<String, (WalletCategory, Option<String>)> =
        std::collections::HashMap::new();
    let mut padded_addresses: Vec<String> = Vec::new();

    for w in &wallets {
        let addr_lower = w.address.to_lowercase();
        wallet_map.insert(addr_lower.clone(), (w.category, w.name.clone()));
        // Pad address to 32 bytes for topic filter
        let addr_no_prefix = addr_lower.trim_start_matches("0x");
        padded_addresses.push(format!("0x000000000000000000000000{addr_no_prefix}"));
    }

    info!(
        wallets = wallets.len(),
        subscriptions = 4,
        "starting on-chain OrderFilled listener (wallet-filtered)"
    );

    let mut backoff_secs = 1u64;

    loop {
        if *shutdown.borrow() {
            return;
        }

        match connect_and_listen(&url, &padded_addresses, &wallet_map, &event_tx).await {
            Ok(()) => {
                backoff_secs = 1;
            }
            Err(e) => {
                warn!(error = %e, backoff_secs, "on-chain listener disconnected");
            }
        }

        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(backoff_secs)) => {}
            _ = shutdown.changed() => {
                if *shutdown.borrow() { return; }
            }
        }

        backoff_secs = (backoff_secs * 2).min(30);
    }
}

async fn connect_and_listen(
    rpc_url: &str,
    padded_addresses: &[String],
    wallet_map: &std::collections::HashMap<String, (WalletCategory, Option<String>)>,
    event_tx: &mpsc::Sender<DetectedWalletTrade>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (ws_stream, _) = connect_async(rpc_url).await?;
    let (mut write, mut read) = ws_stream.split();

    info!("connected to Polygon RPC WebSocket");

    // Create 4 wallet-filtered subscriptions to minimize CU cost.
    // eth_subscribe topics: [topic0, topic1, topic2, topic3]
    // - topic0 = OrderFilled event sig
    // - topic1 = null (any orderHash)
    // - topic2 = maker address (OR list)
    // - topic3 = taker address (OR list)
    //
    // We need separate subscriptions for maker vs taker because we can't OR
    // across different topic positions in a single subscription.
    let contracts = [CTF_EXCHANGE, NEG_RISK_CTF_EXCHANGE];
    let mut sub_id = 1u64;

    for contract in &contracts {
        // Subscription 1: wallet as maker (topic index 2)
        let maker_sub = serde_json::json!({
            "jsonrpc": "2.0",
            "id": sub_id,
            "method": "eth_subscribe",
            "params": [
                "logs",
                {
                    "address": [contract],
                    "topics": [
                        [ORDER_FILLED_TOPIC],
                        null,
                        padded_addresses
                    ]
                }
            ]
        });
        write.send(Message::Text(maker_sub.to_string().into())).await?;
        sub_id += 1;

        // Read confirmation
        if let Some(Ok(Message::Text(text))) = read.next().await {
            debug!(response = %text, "maker subscription response");
        }

        // Subscription 2: wallet as taker (topic index 3)
        let taker_sub = serde_json::json!({
            "jsonrpc": "2.0",
            "id": sub_id,
            "method": "eth_subscribe",
            "params": [
                "logs",
                {
                    "address": [contract],
                    "topics": [
                        [ORDER_FILLED_TOPIC],
                        null,
                        null,
                        padded_addresses
                    ]
                }
            ]
        });
        write.send(Message::Text(taker_sub.to_string().into())).await?;
        sub_id += 1;

        if let Some(Ok(Message::Text(text))) = read.next().await {
            debug!(response = %text, "taker subscription response");
        }
    }

    info!(
        subscriptions = sub_id - 1,
        wallets = padded_addresses.len(),
        "on-chain subscriptions active (wallet-filtered, low CU)"
    );

    loop {
        match tokio::time::timeout(Duration::from_secs(120), read.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                let text_str: &str = &text;
                if let Some(trade) = parse_order_filled_event(text_str, wallet_map) {
                    let _ = event_tx.send(trade).await;
                }
            }
            Ok(Some(Ok(Message::Close(_)))) => {
                info!("Polygon RPC WebSocket closed");
                return Ok(());
            }
            Ok(Some(Err(e))) => {
                return Err(Box::new(e));
            }
            Ok(None) => {
                return Ok(());
            }
            Err(_) => {
                // 120s timeout — no events for our wallets is normal during quiet periods
                debug!("on-chain listener: no events for 120s (normal)");
                continue;
            }
            _ => {}
        }
    }
}

fn parse_order_filled_event(
    raw: &str,
    wallet_map: &std::collections::HashMap<String, (WalletCategory, Option<String>)>,
) -> Option<DetectedWalletTrade> {
    let msg: serde_json::Value = serde_json::from_str(raw).ok()?;

    let params = msg.get("params")?;
    let result = params.get("result")?;
    let topics = result.get("topics")?.as_array()?;

    if topics.len() < 4 {
        return None;
    }

    let topic0 = topics[0].as_str()?;
    if topic0 != ORDER_FILLED_TOPIC {
        return None;
    }

    let maker_topic = topics[2].as_str()?;
    let taker_topic = topics[3].as_str()?;

    let maker_addr = format!("0x{}", &maker_topic[maker_topic.len() - 40..]);
    let taker_addr = format!("0x{}", &taker_topic[taker_topic.len() - 40..]);

    let (wallet_addr, category, _name) =
        if let Some((cat, name)) = wallet_map.get(&maker_addr) {
            (maker_addr.clone(), *cat, name.clone())
        } else if let Some((cat, name)) = wallet_map.get(&taker_addr) {
            (taker_addr.clone(), *cat, name.clone())
        } else {
            return None;
        };

    let data_hex = result.get("data")?.as_str()?;
    let data = data_hex.trim_start_matches("0x");

    if data.len() < 320 {
        return None;
    }

    let maker_asset_id = &data[0..64];
    let _taker_asset_id = &data[64..128];
    let maker_amount_hex = &data[128..192];
    let taker_amount_hex = &data[192..256];

    let maker_amount = u128::from_str_radix(maker_amount_hex.trim_start_matches('0'), 16).unwrap_or(0);
    let taker_amount = u128::from_str_radix(taker_amount_hex.trim_start_matches('0'), 16).unwrap_or(0);

    let token_id = u128::from_str_radix(maker_asset_id.trim_start_matches('0'), 16)
        .map(|v| v.to_string())
        .unwrap_or_default();

    if token_id.is_empty() || maker_amount == 0 {
        return None;
    }

    // Side heuristic: tracked wallet as taker is typically buying (taking liquidity).
    // Tracked wallet as maker is typically selling (providing liquidity).
    // This is a simplification — REST detection provides accurate side from the API.
    let side = if wallet_addr == taker_addr {
        Side::Buy
    } else {
        Side::Sell
    };

    let price = if maker_amount > 0 {
        Decimal::new(taker_amount as i64, 6) / Decimal::new(maker_amount as i64, 0)
    } else {
        Decimal::ZERO
    };

    let size = Decimal::new(maker_amount as i64, 6);

    let tx_hash = result
        .get("transactionHash")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    let detected_at = Utc::now();

    debug!(
        wallet = %wallet_addr,
        token = %token_id,
        side = %side,
        tx = %tx_hash,
        "on-chain OrderFilled detected"
    );

    Some(DetectedWalletTrade {
        wallet: wallet_addr,
        category,
        token_id,
        market_id: String::new(),
        side,
        price,
        size,
        tx_hash,
        source_ts: detected_at,
        detected_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_order_filled_basic() {
        let mut wallet_map = std::collections::HashMap::new();
        wallet_map.insert(
            "0x1234567890abcdef1234567890abcdef12345678".to_string(),
            (WalletCategory::Directional, Some("test-wallet".to_string())),
        );

        let maker_padded = "0x0000000000000000000000001234567890abcdef1234567890abcdef12345678";
        let taker_padded = "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "eth_subscription",
            "params": {
                "subscription": "0x1",
                "result": {
                    "address": CTF_EXCHANGE,
                    "topics": [
                        ORDER_FILLED_TOPIC,
                        "0x0000000000000000000000000000000000000000000000000000000000000001",
                        maker_padded,
                        taker_padded
                    ],
                    "data": format!("0x{}{}{}{}{}",
                        "0000000000000000000000000000000000000000000000000000000000000064",
                        "0000000000000000000000000000000000000000000000000000000000000001",
                        "00000000000000000000000000000000000000000000000000000000000f4240",
                        "00000000000000000000000000000000000000000000000000000000000f4240",
                        "0000000000000000000000000000000000000000000000000000000000000000"
                    ),
                    "transactionHash": "0xdeadbeef"
                }
            }
        });

        let result = parse_order_filled_event(&notification.to_string(), &wallet_map);
        assert!(result.is_some(), "should detect tracked wallet as maker");
        let trade = result.unwrap();
        assert_eq!(trade.wallet, "0x1234567890abcdef1234567890abcdef12345678");
        assert_eq!(trade.category, WalletCategory::Directional);
        assert_eq!(trade.tx_hash, "0xdeadbeef");
    }

    #[test]
    fn parse_untracked_wallet_returns_none() {
        let wallet_map = std::collections::HashMap::new();
        let notification = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "eth_subscription",
            "params": {
                "subscription": "0x1",
                "result": {
                    "topics": [
                        ORDER_FILLED_TOPIC,
                        "0x0000000000000000000000000000000000000000000000000000000000000001",
                        "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                        "0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                    ],
                    "data": format!("0x{}", "00".repeat(160)),
                    "transactionHash": "0xabc"
                }
            }
        });
        let result = parse_order_filled_event(&notification.to_string(), &wallet_map);
        assert!(result.is_none());
    }
}
