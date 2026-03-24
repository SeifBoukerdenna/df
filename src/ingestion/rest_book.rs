use std::time::Duration;

use rust_decimal::Decimal;
use serde::Deserialize;
use tracing::debug;

use crate::core::types::{BookLevel, TokenId};

const CLOB_API_BASE: &str = "https://clob.polymarket.com";

/// Result of a REST book fetch.
#[derive(Debug, Clone)]
pub struct RestBookSnapshot {
    pub token_id: TokenId,
    pub bids: Vec<BookLevel>,
    pub asks: Vec<BookLevel>,
}

/// Raw CLOB book response.
///
/// The /book endpoint returns flat JSON with bids/asks arrays alongside
/// metadata fields (market, asset_id, hash, neg_risk, tick_size, etc.).
/// Error responses return `{"error": "..."}` with HTTP 200.
#[derive(Debug, Deserialize)]
struct ClobBookResponse {
    #[serde(default)]
    bids: Option<Vec<ClobBookLevel>>,
    #[serde(default)]
    asks: Option<Vec<ClobBookLevel>>,
    /// Present on error responses (e.g. "No orderbook exists for the requested token id")
    #[serde(default)]
    error: Option<String>,
    // Ignore all other fields: market (string), asset_id, hash, neg_risk,
    // tick_size, min_order_size, last_trade_price, timestamp
}

#[derive(Debug, Clone, Deserialize)]
struct ClobBookLevel {
    price: String,
    size: String,
}

/// Fetch the current orderbook for a token via CLOB REST API.
///
/// Uses the `/book` endpoint which has a generous 1500 req/10s limit.
/// This is the fast-path for warming up a book before the WebSocket
/// delivers its first snapshot.
pub async fn fetch_book(
    client: &reqwest::Client,
    token_id: &TokenId,
) -> Result<RestBookSnapshot, Box<dyn std::error::Error + Send + Sync>> {
    let url = format!("{CLOB_API_BASE}/book?token_id={token_id}");
    let resp = client
        .get(&url)
        .timeout(Duration::from_secs(5))
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(format!("CLOB book HTTP {}", resp.status()).into());
    }

    let text = resp.text().await?;
    let body: ClobBookResponse = serde_json::from_str(&text).map_err(|e| {
        format!("CLOB JSON parse error: {e} (body starts with: {})", &text[..text.len().min(120)])
    })?;

    // Error responses come back as HTTP 200 with {"error": "..."}
    if let Some(err_msg) = body.error {
        return Err(format!("CLOB book error: {err_msg}").into());
    }

    let raw_bids = body.bids.unwrap_or_default();
    let raw_asks = body.asks.unwrap_or_default();

    let bids = parse_levels(&raw_bids);
    let asks = parse_levels(&raw_asks);

    debug!(
        token_id = %token_id,
        bids = bids.len(),
        asks = asks.len(),
        "REST book fetched"
    );

    Ok(RestBookSnapshot {
        token_id: token_id.clone(),
        bids,
        asks,
    })
}

/// Fetch books for multiple tokens concurrently.
/// Returns successfully fetched books; logs errors for failures.
pub async fn fetch_books_batch(
    client: &reqwest::Client,
    token_ids: &[TokenId],
) -> Vec<RestBookSnapshot> {
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(10));
    let mut handles = Vec::with_capacity(token_ids.len());

    for tid in token_ids {
        let client = client.clone();
        let token_id = tid.clone();
        let sem = semaphore.clone();
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            fetch_book(&client, &token_id).await
        }));
    }

    let mut results = Vec::new();
    let mut failures = 0usize;
    for handle in handles {
        match handle.await {
            Ok(Ok(snapshot)) => results.push(snapshot),
            Ok(Err(_)) => {
                // Expected for closed/resolved markets — don't spam logs during batch warmup
                failures += 1;
            }
            Err(_) => {
                failures += 1;
            }
        }
    }
    if failures > 0 {
        debug!(failures, "some batch book fetches failed (expected for closed markets)");
    }

    debug!(
        requested = token_ids.len(),
        fetched = results.len(),
        "batch book fetch complete"
    );
    results
}

fn parse_levels(raw: &[ClobBookLevel]) -> Vec<BookLevel> {
    raw.iter()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_levels_filters_zero_size() {
        let raw = vec![
            ClobBookLevel {
                price: "0.50".into(),
                size: "100".into(),
            },
            ClobBookLevel {
                price: "0.49".into(),
                size: "0".into(),
            },
            ClobBookLevel {
                price: "0.48".into(),
                size: "50".into(),
            },
        ];
        let levels = parse_levels(&raw);
        assert_eq!(levels.len(), 2);
        assert_eq!(levels[0].price, Decimal::new(50, 2));
        assert_eq!(levels[1].price, Decimal::new(48, 2));
    }

    #[test]
    fn parse_levels_handles_bad_input() {
        let raw = vec![
            ClobBookLevel {
                price: "not_a_number".into(),
                size: "100".into(),
            },
            ClobBookLevel {
                price: "0.50".into(),
                size: "valid".into(),
            },
        ];
        let levels = parse_levels(&raw);
        assert!(levels.is_empty());
    }

    #[test]
    fn deserialize_real_clob_response() {
        // Real response format from CLOB /book endpoint
        let json = r#"{
            "market":"0x2d429de90b306726d64125dd93a632710cc8d376",
            "asset_id":"88880538160054803170694248740611409585042586136919230840822633337213652798324",
            "timestamp":"1774330500699",
            "hash":"894c3440f67fa98aaf3fc04f6253ae41ba2cc7e2",
            "bids":[{"price":"0.43","size":"7964"},{"price":"0.42","size":"548"}],
            "asks":[{"price":"0.55","size":"713"},{"price":"0.56","size":"32"}],
            "min_order_size":"5",
            "tick_size":"0.01",
            "neg_risk":false,
            "last_trade_price":"0.490"
        }"#;
        let resp: ClobBookResponse = serde_json::from_str(json).unwrap();
        assert!(resp.error.is_none());
        assert_eq!(resp.bids.as_ref().unwrap().len(), 2);
        assert_eq!(resp.asks.as_ref().unwrap().len(), 2);
        assert_eq!(resp.bids.as_ref().unwrap()[0].price, "0.43");
    }

    #[test]
    fn deserialize_error_response() {
        let json = r#"{"error":"No orderbook exists for the requested token id"}"#;
        let resp: ClobBookResponse = serde_json::from_str(json).unwrap();
        assert!(resp.error.is_some());
        assert!(resp.bids.is_none());
        assert!(resp.asks.is_none());
    }
}
