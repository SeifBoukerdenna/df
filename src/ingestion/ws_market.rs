use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use rust_decimal::Decimal;
use serde::Deserialize;
use tokio::sync::mpsc;
use tokio::time::{interval, timeout};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

use crate::core::types::{BookLevel, TokenId};

const WS_URL: &str = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// Events produced by the WebSocket market feed.
#[derive(Debug, Clone)]
pub enum WsMarketEvent {
    BookSnapshot {
        token_id: TokenId,
        bids: Vec<BookLevel>,
        asks: Vec<BookLevel>,
        #[allow(dead_code)]
        timestamp: String,
    },
    LastTradePrice {
        token_id: TokenId,
        price: Decimal,
        size: Option<Decimal>,
        #[allow(dead_code)]
        side: Option<String>,
        #[allow(dead_code)]
        timestamp: String,
    },
    Connected,
    Disconnected {
        reason: String,
    },
}

/// Raw WebSocket message types from Polymarket.
#[derive(Debug, Deserialize)]
struct WsRawMessage {
    #[serde(default)]
    event_type: Option<String>,
    // For book events
    #[serde(default)]
    asset_id: Option<String>,
    #[serde(default)]
    _market: Option<String>,
    #[serde(default)]
    bids: Option<Vec<WsBookLevel>>,
    #[serde(default)]
    asks: Option<Vec<WsBookLevel>>,
    #[serde(default)]
    timestamp: Option<String>,
    // For last_trade_price events
    #[serde(default)]
    price: Option<String>,
    #[serde(default)]
    size: Option<String>,
    #[serde(default)]
    side: Option<String>,
}

#[derive(Debug, Deserialize)]
struct WsBookLevel {
    price: String,
    size: String,
}

fn parse_book_levels(levels: &[WsBookLevel]) -> Vec<BookLevel> {
    levels
        .iter()
        .filter_map(|l| {
            let price = l.price.parse::<Decimal>().ok()?;
            let size = l.size.parse::<Decimal>().ok()?;
            if size > Decimal::ZERO {
                Some(BookLevel { price, size })
            } else {
                None
            }
        })
        .collect()
}

/// Run the WebSocket market data connection. Reconnects on failure.
///
/// `token_ids`: initial set of token IDs to subscribe to.
/// `event_tx`: channel to send parsed events.
/// `subscribe_rx`: channel to receive new token IDs to subscribe to dynamically.
pub async fn run_ws_market(
    initial_token_ids: Vec<TokenId>,
    event_tx: mpsc::Sender<WsMarketEvent>,
    mut subscribe_rx: mpsc::Receiver<TokenId>,
) {
    let mut subscribed: Vec<TokenId> = initial_token_ids;
    let mut backoff_secs = 1u64;

    // Don't connect until we have at least one token to subscribe to.
    // Polymarket closes idle WS connections with no subscriptions.
    if subscribed.is_empty() {
        info!("WebSocket waiting for first token subscription...");
        match subscribe_rx.recv().await {
            Some(token_id) => {
                subscribed.push(token_id);
            }
            None => {
                info!("subscribe channel closed before any subscriptions");
                return;
            }
        }
    }

    loop {
        match connect_and_stream(&subscribed, &event_tx, &mut subscribe_rx).await {
            Ok(updated_subs) => {
                subscribed = updated_subs;
                backoff_secs = 1;
            }
            Err(e) => {
                warn!(error = %e, backoff_secs, "WebSocket disconnected, reconnecting");
            }
        }

        let _ = event_tx
            .send(WsMarketEvent::Disconnected {
                reason: "connection lost".into(),
            })
            .await;

        tokio::time::sleep(Duration::from_secs(backoff_secs)).await;
        backoff_secs = (backoff_secs * 2).min(30);
    }
}

async fn connect_and_stream(
    token_ids: &[TokenId],
    event_tx: &mpsc::Sender<WsMarketEvent>,
    subscribe_rx: &mut mpsc::Receiver<TokenId>,
) -> Result<Vec<TokenId>, Box<dyn std::error::Error + Send + Sync>> {
    let (ws_stream, _) = connect_async(WS_URL).await?;
    let (mut write, mut read) = ws_stream.split();

    info!("WebSocket connected to {WS_URL}");
    let _ = event_tx.send(WsMarketEvent::Connected).await;

    // Subscribe to initial tokens
    let mut all_tokens: Vec<TokenId> = token_ids.to_vec();
    if !all_tokens.is_empty() {
        let sub_msg = build_subscribe_message(&all_tokens);
        write.send(Message::Text(sub_msg.into())).await?;
        debug!(count = all_tokens.len(), "subscribed to initial tokens");
    }

    let mut heartbeat = interval(HEARTBEAT_INTERVAL);

    loop {
        tokio::select! {
            // Heartbeat
            _ = heartbeat.tick() => {
                write.send(Message::Text("PING".into())).await?;
            }
            // New subscription requests
            new_token = subscribe_rx.recv() => {
                match new_token {
                    Some(token_id) => {
                        if !all_tokens.contains(&token_id) {
                            let sub_msg = build_subscribe_message(&[token_id.clone()]);
                            write.send(Message::Text(sub_msg.into())).await?;
                            all_tokens.push(token_id);
                            debug!(count = all_tokens.len(), "added subscription");
                        }
                    }
                    None => {
                        // Channel closed, shut down
                        return Ok(all_tokens);
                    }
                }
            }
            // Incoming messages
            msg = timeout(READ_TIMEOUT, read.next()) => {
                match msg {
                    Ok(Some(Ok(Message::Text(text)))) => {
                        let text_str: &str = &text;
                        if text_str == "PONG" {
                            continue;
                        }
                        for event in parse_ws_message(text_str) {
                            let _ = event_tx.send(event).await;
                        }
                    }
                    Ok(Some(Ok(Message::Close(_)))) => {
                        info!("WebSocket received close frame");
                        return Ok(all_tokens);
                    }
                    Ok(Some(Err(e))) => {
                        return Err(Box::new(e));
                    }
                    Ok(None) => {
                        // Stream ended
                        return Ok(all_tokens);
                    }
                    Err(_) => {
                        // Read timeout
                        warn!("WebSocket read timeout, assuming disconnected");
                        return Ok(all_tokens);
                    }
                    _ => {}
                }
            }
        }
    }
}

fn build_subscribe_message(token_ids: &[TokenId]) -> String {
    serde_json::json!({
        "assets_ids": token_ids,
        "type": "market"
    })
    .to_string()
}

/// Parse a WS message into all contained events.
/// Polymarket sends arrays — we must process ALL events, not just the first.
fn parse_ws_message(text: &str) -> Vec<WsMarketEvent> {
    // Polymarket sends arrays of events
    if let Ok(messages) = serde_json::from_str::<Vec<WsRawMessage>>(text) {
        return messages.iter().filter_map(parse_single_message).collect();
    }

    // Try single message
    if let Ok(msg) = serde_json::from_str::<WsRawMessage>(text) {
        return parse_single_message(&msg).into_iter().collect();
    }

    debug!(raw = text, "unparseable WebSocket message");
    Vec::new()
}

fn parse_single_message(msg: &WsRawMessage) -> Option<WsMarketEvent> {
    let event_type = msg.event_type.as_deref()?;
    let asset_id = msg.asset_id.clone()?;

    match event_type {
        "book" => {
            let bids = msg.bids.as_ref().map(|b| parse_book_levels(b)).unwrap_or_default();
            let asks = msg.asks.as_ref().map(|a| parse_book_levels(a)).unwrap_or_default();
            Some(WsMarketEvent::BookSnapshot {
                token_id: asset_id,
                bids,
                asks,
                timestamp: msg.timestamp.clone().unwrap_or_default(),
            })
        }
        "last_trade_price" => {
            let price = msg.price.as_ref()?.parse::<Decimal>().ok()?;
            let size = msg
                .size
                .as_ref()
                .and_then(|s| s.parse::<Decimal>().ok());
            Some(WsMarketEvent::LastTradePrice {
                token_id: asset_id,
                price,
                size,
                side: msg.side.clone(),
                timestamp: msg.timestamp.clone().unwrap_or_default(),
            })
        }
        "price_change" => {
            // price_change carries updated book — treat like a book snapshot
            let bids = msg.bids.as_ref().map(|b| parse_book_levels(b)).unwrap_or_default();
            let asks = msg.asks.as_ref().map(|a| parse_book_levels(a)).unwrap_or_default();
            if bids.is_empty() && asks.is_empty() {
                None
            } else {
                Some(WsMarketEvent::BookSnapshot {
                    token_id: asset_id,
                    bids,
                    asks,
                    timestamp: msg.timestamp.clone().unwrap_or_default(),
                })
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_book_snapshot() {
        let json = r#"[{
            "event_type": "book",
            "asset_id": "12345",
            "market": "0xabc",
            "bids": [{"price": "0.45", "size": "100"}, {"price": "0.44", "size": "200"}],
            "asks": [{"price": "0.55", "size": "150"}],
            "timestamp": "1234567890"
        }]"#;
        let events = parse_ws_message(json);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WsMarketEvent::BookSnapshot {
                token_id,
                bids,
                asks,
                ..
            } => {
                assert_eq!(token_id, "12345");
                assert_eq!(bids.len(), 2);
                assert_eq!(asks.len(), 1);
                assert_eq!(bids[0].price, Decimal::new(45, 2));
            }
            _ => panic!("expected BookSnapshot"),
        }
    }

    #[test]
    fn parse_last_trade_price() {
        let json = r#"[{
            "event_type": "last_trade_price",
            "asset_id": "12345",
            "price": "0.50",
            "size": "25",
            "side": "BUY",
            "timestamp": "1234567890"
        }]"#;
        let events = parse_ws_message(json);
        assert_eq!(events.len(), 1);
        match &events[0] {
            WsMarketEvent::LastTradePrice {
                token_id,
                price,
                size,
                ..
            } => {
                assert_eq!(token_id, "12345");
                assert_eq!(price, &Decimal::new(50, 2));
                assert_eq!(size, &Some(Decimal::new(25, 0)));
            }
            _ => panic!("expected LastTradePrice"),
        }
    }

    #[test]
    fn parse_pong_ignored() {
        let events = parse_ws_message("PONG");
        assert!(events.is_empty());
    }

    #[test]
    fn parse_empty_array() {
        let events = parse_ws_message("[]");
        assert!(events.is_empty());
    }

    #[test]
    fn parse_multi_event_array() {
        // Polymarket can send multiple events in a single array.
        // Previously only the first was processed — this test ensures ALL are parsed.
        let json = r#"[
            {
                "event_type": "book",
                "asset_id": "token_a",
                "bids": [{"price": "0.40", "size": "50"}],
                "asks": [{"price": "0.60", "size": "50"}],
                "timestamp": "100"
            },
            {
                "event_type": "book",
                "asset_id": "token_b",
                "bids": [{"price": "0.30", "size": "80"}],
                "asks": [{"price": "0.70", "size": "80"}],
                "timestamp": "101"
            },
            {
                "event_type": "last_trade_price",
                "asset_id": "token_c",
                "price": "0.55",
                "timestamp": "102"
            }
        ]"#;
        let events = parse_ws_message(json);
        assert_eq!(events.len(), 3, "all 3 events in the array must be parsed");
        assert!(matches!(&events[0], WsMarketEvent::BookSnapshot { token_id, .. } if token_id == "token_a"));
        assert!(matches!(&events[1], WsMarketEvent::BookSnapshot { token_id, .. } if token_id == "token_b"));
        assert!(matches!(&events[2], WsMarketEvent::LastTradePrice { token_id, .. } if token_id == "token_c"));
    }

    #[test]
    fn build_subscribe_msg() {
        let msg = build_subscribe_message(&["t1".into(), "t2".into()]);
        let v: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(v["type"], "market");
        assert_eq!(v["assets_ids"].as_array().unwrap().len(), 2);
    }
}
