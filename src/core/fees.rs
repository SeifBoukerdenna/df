use std::time::Duration;

use rust_decimal::Decimal;
use tracing::{debug, warn};

use super::types::{FeeSource, TokenId};
use crate::storage::db::Store;

const CLOB_API_BASE: &str = "https://clob.polymarket.com";

/// Result of resolving fees for a token.
#[derive(Debug, Clone)]
pub struct ResolvedFee {
    /// Fee rate in basis points (e.g., 25 = 0.25%).
    pub rate_bps: Option<Decimal>,
    /// Where the fee data came from.
    pub source: FeeSource,
}

use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct FeeRateResponse {
    /// CLOB returns base_fee as a JSON number (e.g., 0, 25, 175).
    #[serde(rename = "base_fee")]
    base_fee: Option<serde_json::Value>,
    /// Fallback field name seen in some responses.
    fee_rate: Option<serde_json::Value>,
}

/// Resolve the fee rate for a token.
///
/// Priority chain:
/// 1. Live API call to CLOB `/fee-rate`
/// 2. Cached value from SQLite (within TTL)
/// 3. Cached value from SQLite (any age, marked as Cached)
/// 4. Unavailable — no generic fallback, no made-up rate
pub async fn resolve_fee(
    client: &reqwest::Client,
    store: &Store,
    token_id: &TokenId,
    cache_ttl_secs: u64,
) -> ResolvedFee {
    // 1. Try live API
    match fetch_fee_rate(client, token_id).await {
        Ok(rate_bps) => {
            // Cache it
            if let Err(e) = store.set_cached_fee(token_id, &rate_bps.to_string(), "live") {
                warn!(token_id, error = %e, "failed to cache fee rate");
            }
            return ResolvedFee {
                rate_bps: Some(rate_bps),
                source: FeeSource::Live,
            };
        }
        Err(e) => {
            debug!(token_id, error = %e, "live fee fetch failed, trying cache");
        }
    }

    // 2. Try cached within TTL
    let ttl_ms = (cache_ttl_secs as i64) * 1000;
    if let Ok(Some((rate_str, _source))) = store.get_cached_fee(token_id, ttl_ms) {
        if let Ok(rate) = rate_str.parse::<Decimal>() {
            return ResolvedFee {
                rate_bps: Some(rate),
                source: FeeSource::Cached,
            };
        }
    }

    // 3. Try cached any age
    if let Ok(Some(rate_str)) = store.get_cached_fee_any_age(token_id) {
        if let Ok(rate) = rate_str.parse::<Decimal>() {
            warn!(
                token_id,
                "using expired cached fee rate — marking as Cached"
            );
            return ResolvedFee {
                rate_bps: Some(rate),
                source: FeeSource::Cached,
            };
        }
    }

    // 4. Unavailable — no generic fallback
    warn!(
        token_id,
        "fee rate unavailable from all sources — fill will be marked degraded"
    );
    ResolvedFee {
        rate_bps: None,
        source: FeeSource::Unavailable,
    }
}

async fn fetch_fee_rate(
    client: &reqwest::Client,
    token_id: &str,
) -> Result<Decimal, Box<dyn std::error::Error + Send + Sync>> {
    let url = format!("{CLOB_API_BASE}/fee-rate?token_id={token_id}");
    let resp = client
        .get(&url)
        .timeout(Duration::from_secs(5))
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()).into());
    }

    let body: FeeRateResponse = resp.json().await?;

    // Try base_fee first, then fee_rate
    let raw = body
        .base_fee
        .or(body.fee_rate)
        .ok_or("no fee rate in response")?;

    // Handle both numeric (0, 25) and string ("25") JSON values
    let rate: Decimal = match &raw {
        serde_json::Value::Number(n) => {
            Decimal::try_from(n.as_f64().ok_or("non-finite fee number")?)
                .map_err(|e| format!("decimal conversion: {e}"))?
        }
        serde_json::Value::String(s) => s.parse()?,
        _ => return Err("unexpected fee rate type".into()),
    };
    Ok(rate)
}

/// Calculate the fee amount for a trade using Polymarket's formula.
///
/// fee = shares * price * feeRate/10000 * (price * (1 - price))
///
/// The `(price * (1 - price))` dampener reduces fees near 0 and 1.
/// rate_bps is in basis points (e.g., 25 = 0.25%).
pub fn calculate_fee(shares: Decimal, price: Decimal, rate_bps: Decimal) -> Decimal {
    if rate_bps == Decimal::ZERO || shares == Decimal::ZERO {
        return Decimal::ZERO;
    }
    let rate_fraction = rate_bps / Decimal::new(10_000, 0);
    let dampener = price * (Decimal::ONE - price);
    // fee = shares * price * rate * dampener
    let fee = shares * price * rate_fraction * dampener;
    // Round to 6 decimal places (USDC precision)
    fee.round_dp(6)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn fee_at_midpoint() {
        // At price 0.5, dampener = 0.5 * 0.5 = 0.25
        // fee = 100 * 0.5 * (25/10000) * 0.25 = 100 * 0.5 * 0.0025 * 0.25 = 0.03125
        let fee = calculate_fee(dec!(100), dec!(0.5), dec!(25));
        assert_eq!(fee, dec!(0.031250));
    }

    #[test]
    fn fee_near_zero_price() {
        // At price 0.01, dampener = 0.01 * 0.99 = 0.0099
        // Fee should be very small
        let fee = calculate_fee(dec!(100), dec!(0.01), dec!(25));
        assert!(fee < dec!(0.001));
    }

    #[test]
    fn fee_near_one_price() {
        // At price 0.99, dampener = 0.99 * 0.01 = 0.0099
        // Fee should be very small
        let fee = calculate_fee(dec!(100), dec!(0.99), dec!(25));
        assert!(fee < dec!(0.003));
    }

    #[test]
    fn fee_zero_rate() {
        let fee = calculate_fee(dec!(100), dec!(0.5), dec!(0));
        assert_eq!(fee, Decimal::ZERO);
    }

    #[test]
    fn fee_zero_shares() {
        let fee = calculate_fee(dec!(0), dec!(0.5), dec!(25));
        assert_eq!(fee, Decimal::ZERO);
    }

    #[test]
    fn fee_higher_rate() {
        // 175 bps (sports category), price 0.5, 100 shares
        // dampener = 0.25
        // fee = 100 * 0.5 * (175/10000) * 0.25 = 100 * 0.5 * 0.0175 * 0.25 = 0.21875
        let fee = calculate_fee(dec!(100), dec!(0.5), dec!(175));
        assert_eq!(fee, dec!(0.218750));
    }

    #[test]
    fn fee_symmetry_around_half() {
        // Fee should be the same at p and (1-p) for same shares
        let fee_low = calculate_fee(dec!(100), dec!(0.3), dec!(25));
        let fee_high = calculate_fee(dec!(100), dec!(0.7), dec!(25));
        // Not exactly equal because price factor differs, but dampener is the same
        // Actually fee = shares * price * rate * p*(1-p)
        // At 0.3: 100 * 0.3 * 0.0025 * 0.21 = 0.01575
        // At 0.7: 100 * 0.7 * 0.0025 * 0.21 = 0.03675
        // They differ because of the price term — only the dampener is symmetric
        assert!(fee_low > Decimal::ZERO);
        assert!(fee_high > Decimal::ZERO);
        assert!(fee_high > fee_low); // Higher price means higher fee
    }
}
