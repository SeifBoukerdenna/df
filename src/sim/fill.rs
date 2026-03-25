use rust_decimal::Decimal;

use crate::core::book::OrderBook;
use crate::core::fees;
use crate::core::types::{
    BookLevel, DataQuality, ExitActionability, FeeSource, FillResult, LatencyComponents,
    MissReason, Side,
};

/// Input to the fill simulator.
#[derive(Debug, Clone)]
pub struct FillRequest {
    /// Side we want to execute (Buy or Sell).
    pub side: Side,
    /// Desired number of shares.
    pub desired_qty: Decimal,
    /// The price the tracked wallet got (for slippage comparison).
    pub reference_price: Decimal,
    /// Maximum slippage in bps before we skip.
    pub max_slippage_bps: Decimal,
    /// Maximum capital available for this trade.
    pub available_capital: Decimal,
    /// Fee rate in bps (None = unavailable).
    pub fee_rate_bps: Option<Decimal>,
    /// Fee data source.
    pub fee_source: FeeSource,
    /// Current position qty in this token (for sell validation).
    pub current_position_qty: Decimal,
    /// Latency breakdown for this fill.
    pub latency: LatencyComponents,
}

/// Output of the fill simulator.
#[derive(Debug, Clone)]
pub struct FillOutput {
    pub result: FillResult,
    /// Weighted average fill price (None if miss).
    pub avg_price: Option<Decimal>,
    /// Quantity actually filled.
    pub filled_qty: Decimal,
    /// Total cost of the fill (filled_qty * avg_price).
    pub cost: Decimal,
    /// Fee amount in USDC.
    pub fee_amount: Decimal,
    /// Fee rate used.
    pub fee_rate_bps: Option<Decimal>,
    /// Where fee data came from.
    pub fee_source: FeeSource,
    /// Slippage vs reference price in bps.
    pub slippage_bps: Option<Decimal>,
    /// Book quality at time of fill.
    pub book_quality: DataQuality,
    /// For sells: was this exit actionable?
    pub exit_actionability: Option<ExitActionability>,
    /// Latency components.
    pub latency: LatencyComponents,
}

/// Simulate a fill against the local orderbook.
pub fn simulate_fill(book: &OrderBook, request: &FillRequest) -> FillOutput {
    let base_output = FillOutput {
        result: FillResult::Miss {
            reason: MissReason::Degraded,
        },
        avg_price: None,
        filled_qty: Decimal::ZERO,
        cost: Decimal::ZERO,
        fee_amount: Decimal::ZERO,
        fee_rate_bps: request.fee_rate_bps,
        fee_source: request.fee_source,
        slippage_bps: None,
        book_quality: book.quality,
        exit_actionability: None,
        latency: request.latency.clone(),
    };

    // Pre-check 1: Book quality
    if book.quality == DataQuality::Stale || book.quality == DataQuality::Rebuilding {
        return FillOutput {
            result: FillResult::Miss {
                reason: MissReason::StaleBook,
            },
            ..base_output
        };
    }

    // Pre-check 2: Sells require existing session position
    if request.side == Side::Sell {
        if request.current_position_qty <= Decimal::ZERO {
            return FillOutput {
                result: FillResult::Miss {
                    reason: MissReason::NoSessionPosition,
                },
                exit_actionability: Some(ExitActionability::NonActionable),
                ..base_output
            };
        }
    }

    // Determine effective quantity
    let effective_qty = if request.side == Side::Sell {
        // Can only sell what we have
        request.desired_qty.min(request.current_position_qty)
    } else {
        request.desired_qty
    };

    // Get book levels to walk
    let levels = match request.side {
        Side::Buy => book.ask_levels(),  // buying: walk the asks
        Side::Sell => book.bid_levels(), // selling: walk the bids
    };

    if levels.is_empty() {
        return FillOutput {
            result: FillResult::Miss {
                reason: MissReason::InsufficientDepth,
            },
            exit_actionability: sell_actionability(request),
            ..base_output
        };
    }

    // Depth-walk to simulate fill
    let walk = depth_walk(&levels, effective_qty);

    if walk.filled_qty == Decimal::ZERO {
        return FillOutput {
            result: FillResult::Miss {
                reason: MissReason::InsufficientDepth,
            },
            exit_actionability: sell_actionability(request),
            ..base_output
        };
    }

    // Slippage check
    let slippage = compute_slippage_bps(walk.avg_price, request.reference_price, request.side);
    if slippage > request.max_slippage_bps {
        return FillOutput {
            result: FillResult::Miss {
                reason: MissReason::MaxSlippageExceeded,
            },
            avg_price: Some(walk.avg_price),
            slippage_bps: Some(slippage),
            exit_actionability: sell_actionability(request),
            ..base_output
        };
    }

    // Capital check (for buys)
    let mut final_qty = walk.filled_qty;
    let mut final_cost = walk.total_cost;
    let mut final_avg = walk.avg_price;

    if request.side == Side::Buy {
        if final_cost > request.available_capital {
            // Reduce to what we can afford
            let affordable = capital_limited_fill(&levels, request.available_capital);
            if affordable.filled_qty == Decimal::ZERO {
                return FillOutput {
                    result: FillResult::Miss {
                        reason: MissReason::InsufficientCapital,
                    },
                    avg_price: Some(walk.avg_price),
                    slippage_bps: Some(slippage),
                    exit_actionability: sell_actionability(request),
                    ..base_output
                };
            }
            final_qty = affordable.filled_qty;
            final_cost = affordable.total_cost;
            final_avg = affordable.avg_price;
        }
    }

    // Calculate fee
    let fee_amount = match request.fee_rate_bps {
        Some(rate) => fees::calculate_fee(final_qty, final_avg, rate),
        None => Decimal::ZERO, // Unavailable — zero fee, but marked degraded
    };

    // For buys: check if cost + fee exceeds capital
    if request.side == Side::Buy && (final_cost + fee_amount) > request.available_capital {
        // Reduce slightly to account for fees
        let available_for_shares = request.available_capital - fee_amount;
        if available_for_shares <= Decimal::ZERO {
            return FillOutput {
                result: FillResult::Miss {
                    reason: MissReason::InsufficientCapital,
                },
                exit_actionability: sell_actionability(request),
                ..base_output
            };
        }
        let adjusted = capital_limited_fill(&levels, available_for_shares);
        if adjusted.filled_qty == Decimal::ZERO {
            return FillOutput {
                result: FillResult::Miss {
                    reason: MissReason::InsufficientCapital,
                },
                exit_actionability: sell_actionability(request),
                ..base_output
            };
        }
        final_qty = adjusted.filled_qty;
        final_cost = adjusted.total_cost;
        final_avg = adjusted.avg_price;
    }

    // Determine fill result — compared against desired_qty, not effective_qty,
    // because from the copy-trading perspective we want to know if we fully replicated the trade.
    let result = if final_qty >= request.desired_qty {
        FillResult::Full
    } else {
        FillResult::Partial {
            filled_qty: final_qty,
        }
    };

    // Recalculate fee on final amounts
    let fee_amount = match request.fee_rate_bps {
        Some(rate) => fees::calculate_fee(final_qty, final_avg, rate),
        None => Decimal::ZERO,
    };

    let exit_actionability = if request.side == Side::Sell {
        if final_qty >= request.desired_qty {
            Some(ExitActionability::Actionable)
        } else if final_qty > Decimal::ZERO {
            Some(ExitActionability::PartiallyActionable)
        } else {
            Some(ExitActionability::NonActionable)
        }
    } else {
        None
    };

    FillOutput {
        result,
        avg_price: Some(final_avg),
        filled_qty: final_qty,
        cost: final_cost,
        fee_amount,
        fee_rate_bps: request.fee_rate_bps,
        fee_source: request.fee_source,
        slippage_bps: Some(slippage),
        book_quality: book.quality,
        exit_actionability,
        latency: request.latency.clone(),
    }
}

struct WalkResult {
    filled_qty: Decimal,
    total_cost: Decimal,
    avg_price: Decimal,
}

/// Walk orderbook levels to fill a quantity.
fn depth_walk(levels: &[BookLevel], desired_qty: Decimal) -> WalkResult {
    let mut remaining = desired_qty;
    let mut total_cost = Decimal::ZERO;
    let mut total_qty = Decimal::ZERO;

    for level in levels {
        if remaining <= Decimal::ZERO {
            break;
        }
        let fill_at_level = remaining.min(level.size);
        total_cost += fill_at_level * level.price;
        total_qty += fill_at_level;
        remaining -= fill_at_level;
    }

    let avg_price = if total_qty > Decimal::ZERO {
        (total_cost / total_qty).round_dp(6)
    } else {
        Decimal::ZERO
    };

    WalkResult {
        filled_qty: total_qty,
        total_cost,
        avg_price,
    }
}

/// Walk orderbook levels with a capital constraint.
fn capital_limited_fill(levels: &[BookLevel], max_cost: Decimal) -> WalkResult {
    let mut remaining_cost = max_cost;
    let mut total_cost = Decimal::ZERO;
    let mut total_qty = Decimal::ZERO;

    for level in levels {
        if remaining_cost <= Decimal::ZERO {
            break;
        }
        let max_qty_at_level = (remaining_cost / level.price).round_dp(6);
        let fill_at_level = max_qty_at_level.min(level.size);
        let cost = fill_at_level * level.price;
        total_cost += cost;
        total_qty += fill_at_level;
        remaining_cost -= cost;
    }

    let avg_price = if total_qty > Decimal::ZERO {
        (total_cost / total_qty).round_dp(6)
    } else {
        Decimal::ZERO
    };

    WalkResult {
        filled_qty: total_qty,
        total_cost,
        avg_price,
    }
}

/// Compute slippage in basis points between our avg price and the reference price.
/// Positive = we got worse price than source wallet (cost of latency/liquidity).
/// Negative = we got better price than source wallet (price improvement).
/// Both are reported honestly. The fill check at line 139 rejects only positive > max.
fn compute_slippage_bps(our_price: Decimal, reference_price: Decimal, side: Side) -> Decimal {
    if reference_price == Decimal::ZERO {
        return Decimal::ZERO;
    }
    let diff = match side {
        Side::Buy => our_price - reference_price,  // we paid more = positive slippage
        Side::Sell => reference_price - our_price,  // we got less = positive slippage
    };
    ((diff / reference_price) * Decimal::new(10_000, 0))
        .round_dp(2)
    // No .max(0) — negative slippage (price improvement) is real and should be visible.
}

fn sell_actionability(request: &FillRequest) -> Option<ExitActionability> {
    if request.side == Side::Sell {
        if request.current_position_qty >= request.desired_qty {
            Some(ExitActionability::Actionable)
        } else if request.current_position_qty > Decimal::ZERO {
            Some(ExitActionability::PartiallyActionable)
        } else {
            Some(ExitActionability::NonActionable)
        }
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::book::OrderBook;
    use rust_decimal_macros::dec;

    fn make_book(bids: &[(&str, &str)], asks: &[(&str, &str)]) -> OrderBook {
        let mut book = OrderBook::new("t1".into());
        let b: Vec<BookLevel> = bids
            .iter()
            .map(|(p, s)| BookLevel {
                price: p.parse().unwrap(),
                size: s.parse().unwrap(),
            })
            .collect();
        let a: Vec<BookLevel> = asks
            .iter()
            .map(|(p, s)| BookLevel {
                price: p.parse().unwrap(),
                size: s.parse().unwrap(),
            })
            .collect();
        book.apply_snapshot(&b, &a);
        book
    }

    fn base_request(side: Side, qty: Decimal) -> FillRequest {
        FillRequest {
            side,
            desired_qty: qty,
            reference_price: dec!(0.5),
            max_slippage_bps: dec!(5000),
            available_capital: dec!(10000),
            fee_rate_bps: Some(dec!(25)),
            fee_source: FeeSource::Live,
            current_position_qty: Decimal::ZERO,
            latency: LatencyComponents {
                detection_delay_ms: Some(3000),
                processing_delay_ms: Some(1),
                arrival_delay_ms: 500,
            },
        }
    }

    #[test]
    fn full_fill_single_level() {
        let book = make_book(&[("0.45", "1000")], &[("0.55", "1000")]);
        let req = base_request(Side::Buy, dec!(100));
        let out = simulate_fill(&book, &req);

        assert!(matches!(out.result, FillResult::Full));
        assert_eq!(out.filled_qty, dec!(100));
        assert_eq!(out.avg_price, Some(dec!(0.55)));
        assert!(out.fee_amount > Decimal::ZERO);
        assert_eq!(out.book_quality, DataQuality::Good);
    }

    #[test]
    fn full_fill_multi_level() {
        let book = make_book(&[], &[("0.50", "50"), ("0.52", "50"), ("0.55", "100")]);
        let req = base_request(Side::Buy, dec!(80));
        let out = simulate_fill(&book, &req);

        assert!(matches!(out.result, FillResult::Full));
        assert_eq!(out.filled_qty, dec!(80));
        // 50 @ 0.50 + 30 @ 0.52 = 25 + 15.6 = 40.6 / 80 = 0.5075
        assert_eq!(out.avg_price, Some(dec!(0.507500)));
    }

    #[test]
    fn partial_fill_depth_exhausted() {
        let book = make_book(&[], &[("0.55", "50")]);
        let req = base_request(Side::Buy, dec!(100));
        let out = simulate_fill(&book, &req);

        assert!(matches!(out.result, FillResult::Partial { filled_qty } if filled_qty == dec!(50)));
        assert_eq!(out.filled_qty, dec!(50));
    }

    #[test]
    fn miss_empty_book() {
        let book = make_book(&[], &[]);
        let req = base_request(Side::Buy, dec!(100));
        let out = simulate_fill(&book, &req);

        assert!(matches!(
            out.result,
            FillResult::Miss {
                reason: MissReason::InsufficientDepth
            }
        ));
    }

    #[test]
    fn miss_stale_book() {
        let mut book = make_book(&[], &[("0.55", "1000")]);
        book.quality = DataQuality::Stale;
        let req = base_request(Side::Buy, dec!(100));
        let out = simulate_fill(&book, &req);

        assert!(matches!(
            out.result,
            FillResult::Miss {
                reason: MissReason::StaleBook
            }
        ));
    }

    #[test]
    fn miss_max_slippage_exceeded() {
        let book = make_book(&[], &[("0.60", "1000")]);
        let mut req = base_request(Side::Buy, dec!(100));
        req.reference_price = dec!(0.50);
        req.max_slippage_bps = dec!(100); // 1% max
        // Our fill would be at 0.60, slippage = (0.60 - 0.50) / 0.50 * 10000 = 2000 bps
        let out = simulate_fill(&book, &req);

        assert!(matches!(
            out.result,
            FillResult::Miss {
                reason: MissReason::MaxSlippageExceeded
            }
        ));
        assert!(out.slippage_bps.unwrap() > dec!(100));
    }

    #[test]
    fn sell_without_position_is_miss() {
        let book = make_book(&[("0.45", "1000")], &[]);
        let mut req = base_request(Side::Sell, dec!(100));
        req.current_position_qty = Decimal::ZERO;
        let out = simulate_fill(&book, &req);

        assert!(matches!(
            out.result,
            FillResult::Miss {
                reason: MissReason::NoSessionPosition
            }
        ));
        assert_eq!(
            out.exit_actionability,
            Some(ExitActionability::NonActionable)
        );
    }

    #[test]
    fn sell_partial_position() {
        let book = make_book(&[("0.55", "1000")], &[]);
        let mut req = base_request(Side::Sell, dec!(100));
        req.current_position_qty = dec!(50); // only have 50
        let out = simulate_fill(&book, &req);

        // Should fill 50 (our position), not 100 (desired)
        assert!(matches!(out.result, FillResult::Partial { .. }));
        assert_eq!(out.filled_qty, dec!(50));
        assert_eq!(
            out.exit_actionability,
            Some(ExitActionability::PartiallyActionable)
        );
    }

    #[test]
    fn sell_full_position() {
        let book = make_book(&[("0.55", "1000")], &[]);
        let mut req = base_request(Side::Sell, dec!(100));
        req.current_position_qty = dec!(100);
        let out = simulate_fill(&book, &req);

        assert!(matches!(out.result, FillResult::Full));
        assert_eq!(out.filled_qty, dec!(100));
        assert_eq!(out.avg_price, Some(dec!(0.55)));
        assert_eq!(
            out.exit_actionability,
            Some(ExitActionability::Actionable)
        );
    }

    #[test]
    fn capital_limited_buy() {
        let book = make_book(&[], &[("0.50", "1000")]);
        let mut req = base_request(Side::Buy, dec!(1000));
        req.available_capital = dec!(100); // can only afford ~200 shares at 0.50
        let out = simulate_fill(&book, &req);

        assert!(matches!(out.result, FillResult::Partial { .. }));
        assert!(out.filled_qty <= dec!(200));
        assert!(out.cost <= dec!(100));
    }

    #[test]
    fn fee_unavailable_still_fills() {
        let book = make_book(&[], &[("0.55", "1000")]);
        let mut req = base_request(Side::Buy, dec!(100));
        req.fee_rate_bps = None;
        req.fee_source = FeeSource::Unavailable;
        let out = simulate_fill(&book, &req);

        assert!(matches!(out.result, FillResult::Full));
        assert_eq!(out.fee_amount, Decimal::ZERO);
        assert_eq!(out.fee_source, FeeSource::Unavailable);
    }

    #[test]
    fn slippage_bps_calculation() {
        // Buy at 0.55, reference 0.50 → (0.55-0.50)/0.50 * 10000 = 1000 bps
        let bps = compute_slippage_bps(dec!(0.55), dec!(0.50), Side::Buy);
        assert_eq!(bps, dec!(1000.00));

        // Sell at 0.45, reference 0.50 → (0.50-0.45)/0.50 * 10000 = 1000 bps
        let bps = compute_slippage_bps(dec!(0.45), dec!(0.50), Side::Sell);
        assert_eq!(bps, dec!(1000.00));

        // No slippage
        let bps = compute_slippage_bps(dec!(0.50), dec!(0.50), Side::Buy);
        assert_eq!(bps, dec!(0.00));

        // Negative slippage (price improvement): we bought cheaper than source wallet
        let bps = compute_slippage_bps(dec!(0.48), dec!(0.50), Side::Buy);
        assert_eq!(bps, dec!(-400.00));

        // Negative slippage on sell: we sold higher than source wallet
        let bps = compute_slippage_bps(dec!(0.55), dec!(0.50), Side::Sell);
        assert_eq!(bps, dec!(-1000.00));
    }

    #[test]
    fn depth_walk_exact_size() {
        let levels = vec![
            BookLevel {
                price: dec!(0.50),
                size: dec!(100),
            },
            BookLevel {
                price: dec!(0.52),
                size: dec!(100),
            },
        ];
        let walk = depth_walk(&levels, dec!(100));
        assert_eq!(walk.filled_qty, dec!(100));
        assert_eq!(walk.avg_price, dec!(0.500000));
        assert_eq!(walk.total_cost, dec!(50));
    }

    #[test]
    fn depth_walk_spans_levels() {
        let levels = vec![
            BookLevel {
                price: dec!(0.50),
                size: dec!(60),
            },
            BookLevel {
                price: dec!(0.52),
                size: dec!(60),
            },
        ];
        let walk = depth_walk(&levels, dec!(100));
        assert_eq!(walk.filled_qty, dec!(100));
        // 60 * 0.50 + 40 * 0.52 = 30 + 20.8 = 50.8
        assert_eq!(walk.total_cost, dec!(50.8));
        assert_eq!(walk.avg_price, dec!(0.508000));
    }
}
