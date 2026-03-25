use std::collections::HashMap;

use rust_decimal::Decimal;
use tracing::{info, warn};

use crate::config::schema::AppConfig;
use crate::core::book::OrderBook;
use crate::core::event::NormalizedEvent;
use crate::core::types::*;
use crate::sim::portfolio::Portfolio;
use crate::storage::db::Store;

/// Summary produced after replaying a session.
#[derive(Debug)]
pub struct ReplaySummary {
    pub session_id: String,
    pub event_count: usize,
    pub fill_count: u64,
    pub partial_fill_count: u64,
    pub miss_count: u64,
    pub degraded_fill_count: u64,
    pub realized_pnl_gross: Decimal,
    pub realized_fees: Decimal,
    pub realized_pnl_net: Decimal,
    pub final_cash: Decimal,
    pub open_positions: usize,
    pub turnover: Decimal,
}

/// Replay a stored session deterministically from the event log.
///
/// This rebuilds the portfolio by re-applying every SimulatedFill event
/// in order. Book state is rebuilt from BookUpdate events so unrealized
/// PnL can be computed at the end.
pub fn replay_session(
    store: &Store,
    session_id: &str,
    config: &AppConfig,
) -> Result<ReplaySummary, Box<dyn std::error::Error>> {
    let events = store.load_events_after(session_id, 0)?;
    info!(
        session_id,
        events = events.len(),
        "replaying session from event log"
    );

    let mut portfolio = Portfolio::new(config.session.starting_capital);
    let mut books: HashMap<TokenId, OrderBook> = HashMap::new();
    let mut event_count = 0usize;

    // Track wallet trade context for applying fills
    let mut pending_wallet_trades: HashMap<String, WalletTradeContext> = HashMap::new();

    for (_id, event) in &events {
        event_count += 1;
        match event {
            NormalizedEvent::BookUpdate {
                token_id,
                bids,
                asks,
                ..
            } => {
                let book = books
                    .entry(token_id.clone())
                    .or_insert_with(|| OrderBook::new(token_id.clone()));
                book.apply_snapshot(bids, asks);
            }

            NormalizedEvent::WalletTrade {
                wallet,
                category,
                token_id,
                market_id,
                side,
                tx_hash,
                ..
            } => {
                pending_wallet_trades.insert(
                    tx_hash.clone(),
                    WalletTradeContext {
                        wallet: wallet.clone(),
                        category: *category,
                        token_id: token_id.clone(),
                        market_id: market_id.clone(),
                        _side: *side,
                    },
                );
            }

            NormalizedEvent::SimulatedFill {
                wallet_trade_ref,
                our_side,
                fill_result,
                avg_price,
                filled_qty,
                fee_rate,
                fee_amount,
                fee_source,
                ..
            } => {
                let ctx = pending_wallet_trades.remove(wallet_trade_ref);

                match fill_result {
                    FillResult::Full | FillResult::Partial { .. } => {
                        if *filled_qty == Decimal::ZERO {
                            continue;
                        }
                        let cost = *filled_qty * avg_price.unwrap_or(Decimal::ZERO);
                        let fill_output = crate::sim::fill::FillOutput {
                            result: fill_result.clone(),
                            avg_price: *avg_price,
                            filled_qty: *filled_qty,
                            cost,
                            fee_amount: *fee_amount,
                            fee_rate_bps: *fee_rate,
                            fee_source: *fee_source,
                            slippage_bps: None,
                            book_quality: DataQuality::Good,
                            exit_actionability: None,
                            latency: LatencyComponents {
                                detection_delay_ms: None,
                                processing_delay_ms: None,
                                arrival_delay_ms: 0,
                            },
                        };

                        let (token_id, market_id, wallet, category) = match &ctx {
                            Some(c) => (
                                c.token_id.clone(),
                                c.market_id.clone(),
                                c.wallet.clone(),
                                c.category,
                            ),
                            None => {
                                warn!(
                                    tx_ref = wallet_trade_ref,
                                    "no wallet trade context for fill, skipping"
                                );
                                continue;
                            }
                        };

                        let result = match our_side {
                            Side::Buy => portfolio.apply_buy(
                                &token_id,
                                &market_id,
                                &fill_output,
                                &wallet,
                                category,
                            ),
                            Side::Sell => portfolio.apply_sell(&token_id, &wallet, &fill_output),
                        };

                        if let Err(e) = result {
                            warn!(error = %e, "replay portfolio error");
                        }

                        match fill_result {
                            FillResult::Full => portfolio.record_full(),
                            FillResult::Partial { .. } => portfolio.record_partial(),
                            _ => {}
                        }
                    }
                    FillResult::Miss { .. } => {
                        portfolio.record_miss();
                    }
                }
            }

            _ => {} // QualityChange, HealthEvent — skip during replay
        }
    }

    let summary = ReplaySummary {
        session_id: session_id.to_string(),
        event_count,
        fill_count: portfolio.fill_count,
        partial_fill_count: portfolio.partial_fill_count,
        miss_count: portfolio.miss_count,
        degraded_fill_count: portfolio.degraded_fill_count,
        realized_pnl_gross: portfolio.realized_pnl_gross,
        realized_fees: portfolio.realized_fees,
        realized_pnl_net: portfolio.realized_pnl_net(),
        final_cash: portfolio.cash,
        open_positions: portfolio.positions.len(),
        turnover: portfolio.turnover,
    };

    info!(
        fills = summary.fill_count,
        partials = summary.partial_fill_count,
        misses = summary.miss_count,
        realized_net = %summary.realized_pnl_net,
        "replay complete"
    );

    Ok(summary)
}

struct WalletTradeContext {
    wallet: WalletAddr,
    category: WalletCategory,
    token_id: TokenId,
    market_id: MarketId,
    _side: Side,
}

/// Print a human-readable replay summary.
pub fn print_replay_summary(summary: &ReplaySummary) {
    println!();
    println!("=== Replay Complete: {} ===", summary.session_id);
    println!();
    println!("Events replayed:     {}", summary.event_count);
    println!();
    println!("Portfolio:");
    println!("  Cash:              ${:.2}", summary.final_cash);
    println!("  Open positions:    {}", summary.open_positions);
    println!();
    println!("PnL:");
    println!("  Realized gross:    ${:.4}", summary.realized_pnl_gross);
    println!("  Realized fees:     ${:.4}", summary.realized_fees);
    println!("  Realized net:      ${:.4}", summary.realized_pnl_net);
    println!();
    println!("Stats:");
    println!("  Full fills:        {}", summary.fill_count);
    println!("  Partial fills:     {}", summary.partial_fill_count);
    println!("  Misses:            {}", summary.miss_count);
    println!("  Degraded fills:    {}", summary.degraded_fill_count);
    println!("  Turnover:          ${:.2}", summary.turnover);
    println!();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::event::NormalizedEvent;
    use crate::storage::db::Store;
    use chrono::Utc;
    use rust_decimal_macros::dec;

    #[test]
    fn replay_empty_session() {
        let store = Store::open_memory().unwrap();
        let config = AppConfig::default();
        let summary = replay_session(&store, "test-session", &config).unwrap();
        assert_eq!(summary.event_count, 0);
        assert_eq!(summary.fill_count, 0);
        assert_eq!(summary.final_cash, dec!(10000));
    }

    #[test]
    fn replay_buy_and_sell() {
        let store = Store::open_memory().unwrap();
        let config = AppConfig::default();
        let now = Utc::now();

        // Wallet trade event (buy)
        let wallet_trade = NormalizedEvent::WalletTrade {
            wallet: "0xabc".into(),
            category: WalletCategory::Directional,
            token_id: "t1".into(),
            market_id: "m1".into(),
            side: Side::Buy,
            price: dec!(0.50),
            size: dec!(100),
            tx_hash: "tx1".into(),
            detected_at: now,
            source_ts: now,
        };
        store.append_event("s1", &wallet_trade).unwrap();

        // Simulated fill (buy)
        let fill_event = NormalizedEvent::SimulatedFill {
            wallet_trade_ref: "tx1".into(),
            our_side: Side::Buy,
            fill_result: FillResult::Full,
            avg_price: Some(dec!(0.50)),
            filled_qty: dec!(100),
            fee_rate: Some(dec!(25)),
            fee_amount: dec!(0.03),
            fee_source: FeeSource::Live,
            slippage_bps: Some(Decimal::ZERO),
            latency: LatencyComponents {
                detection_delay_ms: Some(3000),
                processing_delay_ms: Some(1),
                arrival_delay_ms: 500,
            },
            book_quality: DataQuality::Good,
            exit_actionability: None,
        };
        store.append_event("s1", &fill_event).unwrap();

        // Wallet trade event (sell)
        let wallet_sell = NormalizedEvent::WalletTrade {
            wallet: "0xabc".into(),
            category: WalletCategory::Directional,
            token_id: "t1".into(),
            market_id: "m1".into(),
            side: Side::Sell,
            price: dec!(0.60),
            size: dec!(100),
            tx_hash: "tx2".into(),
            detected_at: now,
            source_ts: now,
        };
        store.append_event("s1", &wallet_sell).unwrap();

        // Simulated fill (sell)
        let sell_fill = NormalizedEvent::SimulatedFill {
            wallet_trade_ref: "tx2".into(),
            our_side: Side::Sell,
            fill_result: FillResult::Full,
            avg_price: Some(dec!(0.60)),
            filled_qty: dec!(100),
            fee_rate: Some(dec!(25)),
            fee_amount: dec!(0.02),
            fee_source: FeeSource::Live,
            slippage_bps: Some(Decimal::ZERO),
            latency: LatencyComponents {
                detection_delay_ms: Some(2000),
                processing_delay_ms: Some(1),
                arrival_delay_ms: 500,
            },
            book_quality: DataQuality::Good,
            exit_actionability: Some(ExitActionability::Actionable),
        };
        store.append_event("s1", &sell_fill).unwrap();

        let summary = replay_session(&store, "s1", &config).unwrap();
        assert_eq!(summary.event_count, 4);
        assert_eq!(summary.fill_count, 2);
        assert_eq!(summary.miss_count, 0);
        assert_eq!(summary.open_positions, 0);
        // Gross PnL: sold at 0.60 * 100 - bought at 0.50 * 100 = 10
        assert_eq!(summary.realized_pnl_gross, dec!(10));
        assert_eq!(summary.realized_fees, dec!(0.05));
    }

    #[test]
    fn replay_miss_counted() {
        let store = Store::open_memory().unwrap();
        let config = AppConfig::default();
        let now = Utc::now();

        let wallet_trade = NormalizedEvent::WalletTrade {
            wallet: "0xabc".into(),
            category: WalletCategory::Directional,
            token_id: "t1".into(),
            market_id: "m1".into(),
            side: Side::Buy,
            price: dec!(0.50),
            size: dec!(100),
            tx_hash: "tx1".into(),
            detected_at: now,
            source_ts: now,
        };
        store.append_event("s1", &wallet_trade).unwrap();

        let miss_event = NormalizedEvent::SimulatedFill {
            wallet_trade_ref: "tx1".into(),
            our_side: Side::Buy,
            fill_result: FillResult::Miss {
                reason: MissReason::StaleBook,
            },
            avg_price: None,
            filled_qty: Decimal::ZERO,
            fee_rate: None,
            fee_amount: Decimal::ZERO,
            fee_source: FeeSource::Unavailable,
            slippage_bps: None,
            latency: LatencyComponents {
                detection_delay_ms: Some(3000),
                processing_delay_ms: Some(1),
                arrival_delay_ms: 500,
            },
            book_quality: DataQuality::Stale,
            exit_actionability: None,
        };
        store.append_event("s1", &miss_event).unwrap();

        let summary = replay_session(&store, "s1", &config).unwrap();
        assert_eq!(summary.fill_count, 0);
        assert_eq!(summary.miss_count, 1);
    }
}
