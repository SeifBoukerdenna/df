use std::collections::HashMap;

use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use serde::Serialize;

use crate::core::event::NormalizedEvent;
use crate::core::types::*;
use crate::storage::db::Store;

/// Full analytics computed from a session's event log.
#[derive(Debug, Serialize)]
pub struct SessionAnalytics {
    pub session_id: String,
    pub starting_capital: Decimal,
    pub total_events: usize,

    // Trade stats
    pub total_wallet_trades: usize,
    pub total_fills: usize,
    pub total_partials: usize,
    pub total_misses: usize,
    pub fill_rate_pct: Decimal,

    // PnL
    pub realized_pnl_gross: Decimal,
    pub realized_fees: Decimal,
    pub realized_pnl_net: Decimal,
    pub turnover: Decimal,
    /// Unrealized PnL from open positions (mark-to-market).
    pub unrealized_pnl: Option<Decimal>,
    /// Unrealized PnL after estimated exit fees.
    pub unrealized_pnl_after_fees: Option<Decimal>,
    /// Net PnL = realized_net + unrealized_after_fees.
    pub net_pnl: Option<Decimal>,

    // Per-wallet breakdown (now with PnL)
    pub wallet_stats: Vec<WalletStats>,

    // Per-category aggregates
    pub category_stats: Vec<CategoryAggregateStats>,

    // Per-token breakdown
    pub token_stats: Vec<TokenStats>,

    // Miss reasons
    pub miss_reasons: HashMap<String, usize>,

    // Latency
    pub avg_detection_delay_ms: Option<f64>,
    pub avg_processing_delay_ms: Option<f64>,
    pub median_detection_delay_ms: Option<u64>,
    /// Per-category latency
    pub category_detection_delays: HashMap<String, Vec<u64>>,

    // Fee breakdown
    pub fee_source_counts: HashMap<String, usize>,
    pub degraded_fill_count: usize,

    // Book quality at fill time
    pub book_quality_counts: HashMap<String, usize>,

    // Timeline
    pub trades: Vec<TradeRecord>,

    // Session time range
    pub first_event_ts: Option<DateTime<Utc>>,
    pub last_event_ts: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WalletStats {
    pub wallet: WalletAddr,
    pub display_name: String,
    pub profile_url: Option<String>,
    pub category: WalletCategory,
    pub trade_count: usize,
    pub fill_count: usize,
    pub miss_count: usize,
    pub fill_rate_pct: Decimal,
    pub realized_pnl: Decimal,
    pub unrealized_pnl: Decimal,
    pub volume: Decimal,
    pub fees_paid: Decimal,
    pub open_exposure: Decimal,
}

#[derive(Debug, Clone, Serialize)]
pub struct CategoryAggregateStats {
    pub category: WalletCategory,
    pub trade_count: usize,
    pub fill_count: usize,
    pub miss_count: usize,
    pub fill_rate_pct: Decimal,
    pub realized_pnl_gross: Decimal,
    pub realized_fees: Decimal,
    pub realized_pnl_net: Decimal,
    pub volume: Decimal,
    pub avg_detection_delay_ms: Option<f64>,
    pub median_detection_delay_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TokenStats {
    pub token_id: TokenId,
    pub market_question: Option<String>,
    pub outcome_label: Option<String>,
    pub buy_count: usize,
    pub sell_count: usize,
    pub total_volume: Decimal,
    pub realized_pnl: Decimal,
}

#[derive(Debug, Serialize)]
pub struct TradeRecord {
    pub ts: DateTime<Utc>,
    pub wallet: WalletAddr,
    pub wallet_display_name: String,
    pub category: WalletCategory,
    pub token_id: TokenId,
    pub market_question: Option<String>,
    pub outcome_label: Option<String>,
    pub side: Side,
    pub wallet_price: Decimal,
    pub wallet_size: Decimal,
    pub fill_result: String,
    pub our_price: Option<Decimal>,
    pub our_qty: Decimal,
    pub fee_amount: Decimal,
    pub fee_source: FeeSource,
    pub slippage_bps: Option<Decimal>,
    pub detection_delay_ms: Option<u64>,
}

/// Live portfolio state for injecting unrealized PnL into analytics.
/// Pass `None` if computing from a cold session (no live book state).
pub struct LivePortfolioState<'a> {
    pub portfolio: &'a crate::sim::portfolio::Portfolio,
    pub books: &'a HashMap<TokenId, crate::core::book::OrderBook>,
    pub marking_mode: MarkingMode,
    pub store: &'a Store,
}

/// Compute full session analytics from the event log.
pub fn compute_analytics(
    store: &Store,
    session_id: &str,
    starting_capital: Decimal,
    wallet_names: &HashMap<String, String>,
    wallet_profiles: &HashMap<String, Option<String>>,
    live_state: Option<&LivePortfolioState<'_>>,
) -> Result<SessionAnalytics, Box<dyn std::error::Error>> {
    let events = store.load_events_after(session_id, 0)?;
    let token_names = store.build_token_name_map();

    let mut total_wallet_trades = 0usize;
    let mut total_fills = 0usize;
    let mut total_partials = 0usize;
    let mut total_misses = 0usize;

    let mut realized_pnl_gross = Decimal::ZERO;
    let mut realized_fees = Decimal::ZERO;
    let mut turnover = Decimal::ZERO;

    let mut wallet_map: HashMap<WalletAddr, WalletStatsBuilder> = HashMap::new();
    let mut token_map: HashMap<TokenId, TokenStatsBuilder> = HashMap::new();
    let mut miss_reasons: HashMap<String, usize> = HashMap::new();
    let mut fee_source_counts: HashMap<String, usize> = HashMap::new();
    let mut degraded_fill_count = 0usize;

    let mut detection_delays: Vec<u64> = Vec::new();
    let mut processing_delays: Vec<u64> = Vec::new();
    let mut book_quality_counts: HashMap<String, usize> = HashMap::new();
    let mut category_detection_delays: HashMap<String, Vec<u64>> = HashMap::new();

    let mut trades: Vec<TradeRecord> = Vec::new();
    let mut pending_trades: HashMap<String, PendingTrade> = HashMap::new();

    let mut first_ts: Option<DateTime<Utc>> = None;
    let mut last_ts: Option<DateTime<Utc>> = None;

    let mut position_avg_entry: HashMap<TokenId, Decimal> = HashMap::new();
    let mut position_qty: HashMap<TokenId, Decimal> = HashMap::new();

    for (_id, event) in &events {
        match event {
            NormalizedEvent::WalletTrade {
                wallet, category, token_id, side, price, size, tx_hash,
                detected_at, source_ts, ..
            } => {
                total_wallet_trades += 1;

                if first_ts.is_none() {
                    first_ts = Some(*source_ts);
                }
                last_ts = Some(*source_ts);

                let ws = wallet_map
                    .entry(wallet.clone())
                    .or_insert_with(|| WalletStatsBuilder {
                        category: *category,
                        trade_count: 0,
                        fill_count: 0,
                        miss_count: 0,
                        realized_pnl: Decimal::ZERO,
                        volume: Decimal::ZERO,
                        fees_paid: Decimal::ZERO,
                    });
                ws.trade_count += 1;

                pending_trades.insert(
                    tx_hash.clone(),
                    PendingTrade {
                        wallet: wallet.clone(),
                        category: *category,
                        token_id: token_id.clone(),
                        side: *side,
                        price: *price,
                        size: *size,
                        detected_at: *detected_at,
                        source_ts: *source_ts,
                    },
                );
            }

            NormalizedEvent::SimulatedFill {
                wallet_trade_ref, fill_result, avg_price, filled_qty,
                fee_amount, fee_source, slippage_bps, latency, book_quality, ..
            } => {
                let pt = pending_trades.remove(wallet_trade_ref);

                *book_quality_counts.entry(format!("{book_quality}")).or_default() += 1;
                *fee_source_counts.entry(format!("{fee_source}")).or_default() += 1;

                if *fee_source == FeeSource::Unavailable && *filled_qty > Decimal::ZERO {
                    degraded_fill_count += 1;
                }

                if let Some(d) = latency.detection_delay_ms {
                    detection_delays.push(d);
                    if let Some(ref pt) = pt {
                        category_detection_delays
                            .entry(format!("{}", pt.category))
                            .or_default()
                            .push(d);
                    }
                }
                if let Some(d) = latency.processing_delay_ms {
                    processing_delays.push(d);
                }

                let fill_result_str = match fill_result {
                    FillResult::Full => "full",
                    FillResult::Partial { .. } => "partial",
                    FillResult::Miss { .. } => "miss",
                };

                match fill_result {
                    FillResult::Full => {
                        total_fills += 1;
                        if let Some(ref pt) = pt {
                            if let Some(ws) = wallet_map.get_mut(&pt.wallet) {
                                ws.fill_count += 1;
                            }
                        }
                    }
                    FillResult::Partial { .. } => {
                        total_partials += 1;
                        if let Some(ref pt) = pt {
                            if let Some(ws) = wallet_map.get_mut(&pt.wallet) {
                                ws.fill_count += 1;
                            }
                        }
                    }
                    FillResult::Miss { reason } => {
                        total_misses += 1;
                        *miss_reasons.entry(format!("{reason:?}")).or_default() += 1;
                        if let Some(ref pt) = pt {
                            if let Some(ws) = wallet_map.get_mut(&pt.wallet) {
                                ws.miss_count += 1;
                            }
                        }
                    }
                }

                if let Some(ref pt) = pt {
                    let ts = token_map
                        .entry(pt.token_id.clone())
                        .or_insert_with(|| TokenStatsBuilder {
                            buy_count: 0,
                            sell_count: 0,
                            total_volume: Decimal::ZERO,
                            realized_pnl: Decimal::ZERO,
                        });

                    let cost = *filled_qty * avg_price.unwrap_or(Decimal::ZERO);
                    realized_fees += fee_amount;
                    turnover += cost;

                    // Per-wallet volume and fees
                    if let Some(ws) = wallet_map.get_mut(&pt.wallet) {
                        ws.volume += cost;
                        ws.fees_paid += *fee_amount;
                    }

                    match pt.side {
                        Side::Buy => {
                            ts.buy_count += 1;
                            ts.total_volume += cost;
                            let qty = position_qty.entry(pt.token_id.clone()).or_default();
                            let avg = position_avg_entry.entry(pt.token_id.clone()).or_default();
                            let old_cost = *avg * *qty;
                            *qty += filled_qty;
                            if *qty > Decimal::ZERO {
                                *avg = ((old_cost + cost) / *qty).round_dp(6);
                            }
                        }
                        Side::Sell => {
                            ts.sell_count += 1;
                            ts.total_volume += cost;
                            let entry_price = position_avg_entry
                                .get(&pt.token_id)
                                .copied()
                                .unwrap_or(Decimal::ZERO);
                            let pnl = (avg_price.unwrap_or(Decimal::ZERO) - entry_price) * filled_qty;
                            ts.realized_pnl += pnl;
                            realized_pnl_gross += pnl;

                            // Per-wallet realized PnL
                            if let Some(ws) = wallet_map.get_mut(&pt.wallet) {
                                ws.realized_pnl += pnl;
                            }

                            if let Some(qty) = position_qty.get_mut(&pt.token_id) {
                                *qty -= filled_qty;
                            }
                        }
                    }

                    let (mq, ol) = token_names
                        .get(&pt.token_id)
                        .map(|(q, o)| (Some(q.clone()), Some(o.clone())))
                        .unwrap_or((None, None));

                    let wallet_display = wallet_names
                        .get(&pt.wallet)
                        .cloned()
                        .unwrap_or_else(|| abbreviate_address(&pt.wallet));

                    trades.push(TradeRecord {
                        ts: pt.source_ts,
                        wallet: pt.wallet.clone(),
                        wallet_display_name: wallet_display,
                        category: pt.category,
                        token_id: pt.token_id.clone(),
                        market_question: mq,
                        outcome_label: ol,
                        side: pt.side,
                        wallet_price: pt.price,
                        wallet_size: pt.size,
                        fill_result: fill_result_str.to_string(),
                        our_price: *avg_price,
                        our_qty: *filled_qty,
                        fee_amount: *fee_amount,
                        fee_source: *fee_source,
                        slippage_bps: *slippage_bps,
                        detection_delay_ms: latency.detection_delay_ms,
                    });
                }
            }

            _ => {}
        }
    }

    let total_attempts = total_fills + total_partials + total_misses;
    let fill_rate_pct = if total_attempts > 0 {
        Decimal::new((total_fills + total_partials) as i64, 0)
            / Decimal::new(total_attempts as i64, 0)
            * Decimal::new(100, 0)
    } else {
        Decimal::ZERO
    };

    let avg_detection = if detection_delays.is_empty() {
        None
    } else {
        Some(detection_delays.iter().sum::<u64>() as f64 / detection_delays.len() as f64)
    };

    let avg_processing = if processing_delays.is_empty() {
        None
    } else {
        Some(processing_delays.iter().sum::<u64>() as f64 / processing_delays.len() as f64)
    };

    let median_detection = if detection_delays.is_empty() {
        None
    } else {
        let mut sorted = detection_delays.clone();
        sorted.sort();
        Some(sorted[sorted.len() / 2])
    };

    // Get per-wallet unrealized + exposure from live portfolio state
    let (unrealized_by_wallet, exposure_by_wallet) = match live_state {
        Some(ls) => (
            ls.portfolio.unrealized_by_wallet(ls.books, ls.marking_mode),
            ls.portfolio.exposure_by_wallet(ls.books, ls.marking_mode),
        ),
        None => (HashMap::new(), HashMap::new()),
    };

    // Build per-wallet stats with names
    let wallet_stats: Vec<WalletStats> = wallet_map
        .into_iter()
        .map(|(wallet, b)| {
            let display_name = wallet_names
                .get(&wallet)
                .cloned()
                .unwrap_or_else(|| abbreviate_address(&wallet));
            let profile_url = wallet_profiles.get(&wallet).cloned().flatten();
            let total_attempts = b.fill_count + b.miss_count;
            let fill_rate = if total_attempts > 0 {
                Decimal::new(b.fill_count as i64, 0)
                    / Decimal::new(total_attempts as i64, 0)
                    * Decimal::new(100, 0)
            } else {
                Decimal::ZERO
            };
            let unrealized = unrealized_by_wallet.get(&wallet).copied().unwrap_or(Decimal::ZERO);
            let exposure = exposure_by_wallet.get(&wallet).copied().unwrap_or(Decimal::ZERO);
            WalletStats {
                wallet,
                display_name,
                profile_url,
                category: b.category,
                trade_count: b.trade_count,
                fill_count: b.fill_count,
                miss_count: b.miss_count,
                fill_rate_pct: fill_rate.round_dp(1),
                realized_pnl: b.realized_pnl,
                unrealized_pnl: unrealized,
                volume: b.volume,
                fees_paid: b.fees_paid,
                open_exposure: exposure,
            }
        })
        .collect();

    // Build per-category aggregates
    let mut cat_agg: HashMap<WalletCategory, CatAggBuilder> = HashMap::new();
    for ws in &wallet_stats {
        let agg = cat_agg.entry(ws.category).or_default();
        agg.trade_count += ws.trade_count;
        agg.fill_count += ws.fill_count;
        agg.miss_count += ws.miss_count;
        agg.realized_pnl_gross += ws.realized_pnl;
        agg.fees += ws.fees_paid;
        agg.volume += ws.volume;
    }

    let category_stats: Vec<CategoryAggregateStats> = cat_agg
        .into_iter()
        .map(|(cat, agg)| {
            let total = agg.fill_count + agg.miss_count;
            let fill_rate = if total > 0 {
                Decimal::new(agg.fill_count as i64, 0)
                    / Decimal::new(total as i64, 0)
                    * Decimal::new(100, 0)
            } else {
                Decimal::ZERO
            };

            let cat_delays = category_detection_delays.get(&format!("{cat}"));
            let avg_det = cat_delays
                .filter(|d| !d.is_empty())
                .map(|d| d.iter().sum::<u64>() as f64 / d.len() as f64);
            let median_det = cat_delays
                .filter(|d| !d.is_empty())
                .map(|d| {
                    let mut s = d.clone();
                    s.sort();
                    s[s.len() / 2]
                });

            CategoryAggregateStats {
                category: cat,
                trade_count: agg.trade_count,
                fill_count: agg.fill_count,
                miss_count: agg.miss_count,
                fill_rate_pct: fill_rate.round_dp(1),
                realized_pnl_gross: agg.realized_pnl_gross,
                realized_fees: agg.fees,
                realized_pnl_net: agg.realized_pnl_gross - agg.fees,
                volume: agg.volume,
                avg_detection_delay_ms: avg_det,
                median_detection_delay_ms: median_det,
            }
        })
        .collect();

    let token_stats: Vec<TokenStats> = token_map
        .into_iter()
        .map(|(token_id, b)| {
            let (mq, ol) = token_names
                .get(&token_id)
                .map(|(q, o)| (Some(q.clone()), Some(o.clone())))
                .unwrap_or((None, None));
            TokenStats {
                token_id,
                market_question: mq,
                outcome_label: ol,
                buy_count: b.buy_count,
                sell_count: b.sell_count,
                total_volume: b.total_volume,
                realized_pnl: b.realized_pnl,
            }
        })
        .collect();

    // Compute unrealized PnL from live state if available
    let realized_net = realized_pnl_gross - realized_fees;
    let (unrealized, unrealized_after_fees, net_pnl) = match live_state {
        Some(ls) => {
            let raw = ls.portfolio.unrealized_pnl(ls.books, ls.marking_mode);
            let after_fees = ls.portfolio.unrealized_pnl_after_fees(ls.books, ls.marking_mode, Some(ls.store));
            (Some(raw), Some(after_fees), Some(realized_net + after_fees))
        }
        None => (None, None, None),
    };

    Ok(SessionAnalytics {
        session_id: session_id.to_string(),
        starting_capital,
        total_events: events.len(),
        total_wallet_trades,
        total_fills,
        total_partials,
        total_misses,
        fill_rate_pct: fill_rate_pct.round_dp(1),
        realized_pnl_gross,
        realized_fees,
        realized_pnl_net: realized_net,
        turnover,
        unrealized_pnl: unrealized,
        unrealized_pnl_after_fees: unrealized_after_fees,
        net_pnl,
        wallet_stats,
        category_stats,
        token_stats,
        miss_reasons,
        avg_detection_delay_ms: avg_detection,
        avg_processing_delay_ms: avg_processing,
        median_detection_delay_ms: median_detection,
        category_detection_delays,
        fee_source_counts,
        degraded_fill_count,
        book_quality_counts,
        trades,
        first_event_ts: first_ts,
        last_event_ts: last_ts,
    })
}

fn abbreviate_address(addr: &str) -> String {
    if addr.len() > 10 {
        format!("{}…{}", &addr[..6], &addr[addr.len() - 4..])
    } else {
        addr.to_string()
    }
}

struct WalletStatsBuilder {
    category: WalletCategory,
    trade_count: usize,
    fill_count: usize,
    miss_count: usize,
    realized_pnl: Decimal,
    volume: Decimal,
    fees_paid: Decimal,
}

#[derive(Default)]
struct CatAggBuilder {
    trade_count: usize,
    fill_count: usize,
    miss_count: usize,
    realized_pnl_gross: Decimal,
    fees: Decimal,
    volume: Decimal,
}

struct TokenStatsBuilder {
    buy_count: usize,
    sell_count: usize,
    total_volume: Decimal,
    realized_pnl: Decimal,
}

struct PendingTrade {
    wallet: WalletAddr,
    category: WalletCategory,
    token_id: TokenId,
    side: Side,
    price: Decimal,
    #[allow(dead_code)]
    size: Decimal,
    #[allow(dead_code)]
    detected_at: DateTime<Utc>,
    source_ts: DateTime<Utc>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::event::NormalizedEvent;
    use crate::storage::db::Store;
    use chrono::Utc;
    use rust_decimal_macros::dec;

    #[test]
    fn analytics_empty_session() {
        let store = Store::open_memory().unwrap();
        let names = HashMap::new();
        let profiles = HashMap::new();
        let a = compute_analytics(&store, "s1", dec!(10000), &names, &profiles, None).unwrap();
        assert_eq!(a.total_events, 0);
        assert_eq!(a.total_wallet_trades, 0);
        assert_eq!(a.fill_rate_pct, dec!(0));
        assert!(a.unrealized_pnl.is_none()); // no live state
    }

    #[test]
    fn analytics_one_trade() {
        let store = Store::open_memory().unwrap();
        let names = HashMap::new();
        let profiles = HashMap::new();
        let now = Utc::now();

        let wt = NormalizedEvent::WalletTrade {
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
        store.append_event("s1", &wt).unwrap();

        let fill = NormalizedEvent::SimulatedFill {
            wallet_trade_ref: "tx1".into(),
            our_side: Side::Buy,
            fill_result: FillResult::Full,
            avg_price: Some(dec!(0.51)),
            filled_qty: dec!(100),
            fee_rate: Some(dec!(25)),
            fee_amount: dec!(0.03),
            fee_source: FeeSource::Live,
            slippage_bps: Some(dec!(200)),
            latency: LatencyComponents {
                detection_delay_ms: Some(3000),
                processing_delay_ms: Some(1),
                arrival_delay_ms: 500,
            },
            book_quality: DataQuality::Good,
            exit_actionability: None,
        };
        store.append_event("s1", &fill).unwrap();

        let a = compute_analytics(&store, "s1", dec!(10000), &names, &profiles, None).unwrap();
        assert_eq!(a.total_wallet_trades, 1);
        assert_eq!(a.total_fills, 1);
        assert_eq!(a.total_misses, 0);
        assert_eq!(a.fill_rate_pct, dec!(100.0));
        assert_eq!(a.trades.len(), 1);
        assert_eq!(a.wallet_stats.len(), 1);
        assert_eq!(a.avg_detection_delay_ms, Some(3000.0));
        // Category stats should be populated
        assert!(!a.category_stats.is_empty());
    }

    #[test]
    fn detection_too_old_classified_correctly() {
        let store = Store::open_memory().unwrap();
        let names = HashMap::new();
        let profiles = HashMap::new();
        let now = Utc::now();

        let wt = NormalizedEvent::WalletTrade {
            wallet: "0xabc".into(),
            category: WalletCategory::Arbitrage,
            token_id: "t1".into(),
            market_id: "m1".into(),
            side: Side::Buy,
            price: dec!(0.50),
            size: dec!(100),
            tx_hash: "tx1".into(),
            detected_at: now,
            source_ts: now,
        };
        store.append_event("s1", &wt).unwrap();

        let miss = NormalizedEvent::SimulatedFill {
            wallet_trade_ref: "tx1".into(),
            our_side: Side::Buy,
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
                detection_delay_ms: Some(20000),
                processing_delay_ms: Some(0),
                arrival_delay_ms: 500,
            },
            book_quality: DataQuality::Stale,
            exit_actionability: None,
        };
        store.append_event("s1", &miss).unwrap();

        let a = compute_analytics(&store, "s1", dec!(10000), &names, &profiles, None).unwrap();
        assert_eq!(a.total_misses, 1);
        assert_eq!(a.miss_reasons.get("DetectionTooOld"), Some(&1));
        // Must NOT be classified as StaleBook
        assert_eq!(a.miss_reasons.get("StaleBook"), None);
    }

    #[test]
    fn per_wallet_unrealized_present_with_live_state() {
        use crate::core::book::OrderBook;
        use crate::core::types::BookLevel;
        use crate::sim::portfolio::Portfolio;

        let store = Store::open_memory().unwrap();
        let names = HashMap::new();
        let profiles = HashMap::new();
        let now = Utc::now();

        // Record a wallet trade + fill
        let wt = NormalizedEvent::WalletTrade {
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
        store.append_event("s1", &wt).unwrap();

        let fill = NormalizedEvent::SimulatedFill {
            wallet_trade_ref: "tx1".into(),
            our_side: Side::Buy,
            fill_result: FillResult::Full,
            avg_price: Some(dec!(0.50)),
            filled_qty: dec!(100),
            fee_rate: Some(dec!(25)),
            fee_amount: dec!(0.03),
            fee_source: FeeSource::Live,
            slippage_bps: Some(dec!(0)),
            latency: LatencyComponents {
                detection_delay_ms: Some(3000),
                processing_delay_ms: Some(1),
                arrival_delay_ms: 500,
            },
            book_quality: DataQuality::Good,
            exit_actionability: None,
        };
        store.append_event("s1", &fill).unwrap();

        // Build live state with a book that shows the position is up
        let mut portfolio = Portfolio::new(dec!(10000));
        let fill_output = crate::sim::fill::FillOutput {
            result: FillResult::Full,
            avg_price: Some(dec!(0.50)),
            filled_qty: dec!(100),
            cost: dec!(50),
            fee_amount: dec!(0.03),
            fee_rate_bps: Some(dec!(25)),
            fee_source: FeeSource::Live,
            slippage_bps: Some(dec!(0)),
            book_quality: DataQuality::Good,
            exit_actionability: None,
            latency: LatencyComponents {
                detection_delay_ms: Some(3000),
                processing_delay_ms: Some(1),
                arrival_delay_ms: 500,
            },
        };
        portfolio.apply_buy(&"t1".into(), "m1", &fill_output, &"0xabc".into(), WalletCategory::Directional).unwrap();
        portfolio.record_full();

        let mut books = HashMap::new();
        let mut book = OrderBook::new("t1".into());
        book.apply_snapshot(
            &[BookLevel { price: dec!(0.55), size: dec!(10000) }],
            &[BookLevel { price: dec!(0.60), size: dec!(10000) }],
        );
        books.insert("t1".to_string(), book);

        let live = LivePortfolioState {
            portfolio: &portfolio,
            books: &books,
            marking_mode: MarkingMode::Conservative,
            store: &store,
        };

        let a = compute_analytics(&store, "s1", dec!(10000), &names, &profiles, Some(&live)).unwrap();

        // Unrealized should be present
        assert!(a.unrealized_pnl.is_some());
        let unrealized = a.unrealized_pnl.unwrap();
        // 100 shares * 0.55 (best bid) - 50 cost = 5
        assert_eq!(unrealized, dec!(5));

        // Per-wallet unrealized should exist
        assert_eq!(a.wallet_stats.len(), 1);
        assert_eq!(a.wallet_stats[0].unrealized_pnl, dec!(5));
        assert!(a.wallet_stats[0].open_exposure > Decimal::ZERO);
    }
}
