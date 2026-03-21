// ---------------------------------------------------------------------------
// Position Reconciliation
//
// Tracks open paper positions, computes unrealized PnL, generates position
// reports, and detects position closes (market resolution or manual exit).
// ---------------------------------------------------------------------------

import { now } from '../utils/time.js';
import { getLogger } from '../utils/logger.js';
import { mean, tTest } from '../utils/statistics.js';
import type { Ledger } from '../ledger/ledger.js';
import type { ExecutionRecord, PositionClose } from '../ledger/types.js';
import type { PositionState, OrderBook } from '../state/types.js';
import type { WorldState } from '../state/world_state.js';

const log = getLogger('reconciliation');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PaperPosition {
  position_id: string;
  market_id: string;
  token_id: string;
  strategy_id: string;
  direction: 'BUY' | 'SELL';
  size: number;
  avg_entry_price: number;
  fill_price: number;
  fee_paid: number;
  opened_at: number;
  signal_ev_at_entry: number;
  current_mark: number;
  unrealized_pnl: number;
  max_favorable_excursion: number;
  max_adverse_excursion: number;
}

export interface PositionReportEntry {
  position_id: string;
  market_id: string;
  token_id: string;
  strategy_id: string;
  direction: string;
  size: number;
  avg_entry_price: number;
  current_mark: number;
  unrealized_pnl: number;
  time_in_position_ms: number;
  signal_ev_at_entry: number;
  mfe: number;
  mae: number;
}

export interface PnLByStrategy {
  strategy_id: string;
  realized_pnl: number;
  unrealized_pnl: number;
  total_pnl: number;
  trade_count: number;
  win_count: number;
  loss_count: number;
  win_rate: number;
  avg_pnl_per_trade: number;
  t_stat: number;
  p_value: number;
  significant: boolean;
}

export interface PnLReport {
  timestamp: number;
  period_label: string;
  period_start: number;
  period_end: number;
  total_realized_pnl: number;
  total_unrealized_pnl: number;
  total_fees_paid: number;
  positions_open: number;
  positions_closed: number;
  by_strategy: PnLByStrategy[];
}

export interface PositionsReport {
  timestamp: number;
  positions_open: number;
  total_unrealized_pnl: number;
  positions: PositionReportEntry[];
}

// ---------------------------------------------------------------------------
// Reconciliation Engine
// ---------------------------------------------------------------------------

export class Reconciliation {
  private readonly ledger: Ledger;
  private readonly positions: Map<string, PaperPosition> = new Map();
  private readonly closedTrades: PositionClose[] = [];
  private totalFeesPaid = 0;

  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  /**
   * Open a new position from a filled execution record.
   */
  openPosition(exec: ExecutionRecord, signalEv: number): PaperPosition | null {
    if (exec.status === 'failed' || exec.size_filled === 0) return null;

    const posId = `pos_${exec.execution_id}`;

    // Check for existing position in same market/token/strategy — aggregate
    const existingKey = this.findExistingPositionKey(
      exec.market_id, exec.token_id, exec.strategy_id, exec.direction,
    );

    if (existingKey) {
      const existing = this.positions.get(existingKey)!;
      // Aggregate: weighted average entry price
      const totalSize = existing.size + exec.size_filled;
      const newAvg = (existing.avg_entry_price * existing.size + exec.fill_price * exec.size_filled) / totalSize;
      existing.size = totalSize;
      existing.avg_entry_price = newAvg;
      existing.fee_paid += exec.fee_paid;
      this.totalFeesPaid += exec.fee_paid;

      log.info({
        position_id: existingKey,
        added_size: exec.size_filled,
        total_size: totalSize,
        new_avg_price: newAvg.toFixed(4),
      }, 'Position aggregated');

      return existing;
    }

    const pos: PaperPosition = {
      position_id: posId,
      market_id: exec.market_id,
      token_id: exec.token_id,
      strategy_id: exec.strategy_id,
      direction: exec.direction,
      size: exec.size_filled,
      avg_entry_price: exec.fill_price,
      fill_price: exec.fill_price,
      fee_paid: exec.fee_paid,
      opened_at: exec.t4_first_fill,
      signal_ev_at_entry: signalEv,
      current_mark: exec.fill_price,
      unrealized_pnl: 0,
      max_favorable_excursion: 0,
      max_adverse_excursion: 0,
    };

    this.positions.set(posId, pos);
    this.totalFeesPaid += exec.fee_paid;

    // Record position_opened to ledger
    const posState: PositionState = {
      market_id: pos.market_id,
      token_id: pos.token_id,
      side: pos.direction === 'BUY' ? 'YES' : 'NO',
      size: pos.size,
      avg_entry_price: pos.avg_entry_price,
      current_mark: pos.current_mark,
      unrealized_pnl: 0,
      opened_at: pos.opened_at,
      strategy_id: pos.strategy_id,
      signal_ev_at_entry: pos.signal_ev_at_entry,
      current_ev_estimate: pos.signal_ev_at_entry,
      time_in_position_ms: 0,
      max_favorable_excursion: 0,
      max_adverse_excursion: 0,
    };

    this.ledger.append({ type: 'position_opened', data: posState });

    log.info({
      position_id: posId,
      strategy: exec.strategy_id,
      market: exec.market_id,
      direction: exec.direction,
      size: exec.size_filled,
      fill_price: exec.fill_price.toFixed(4),
      ev: signalEv.toFixed(4),
    }, 'Position opened');

    return pos;
  }

  /**
   * Update marks on all open positions using current world state.
   */
  markToMarket(world: WorldState): void {
    const t = now();
    for (const pos of this.positions.values()) {
      const market = world.markets.get(pos.market_id);
      if (!market) continue;

      const isYes = market.tokens.yes_id === pos.token_id;
      const book: OrderBook = isYes ? market.book.yes : market.book.no;

      // Mark at mid price
      pos.current_mark = book.mid;

      // Compute unrealized PnL
      const priceDelta = pos.direction === 'BUY'
        ? pos.current_mark - pos.avg_entry_price
        : pos.avg_entry_price - pos.current_mark;
      pos.unrealized_pnl = priceDelta * pos.size - pos.fee_paid;

      // Track excursions
      if (priceDelta > 0) {
        pos.max_favorable_excursion = Math.max(pos.max_favorable_excursion, priceDelta);
      } else {
        pos.max_adverse_excursion = Math.max(pos.max_adverse_excursion, Math.abs(priceDelta));
      }
    }
  }

  /**
   * Close a position (e.g., on market resolution, manual exit, or kill condition).
   * Returns the PositionClose record, or null if position not found.
   */
  closePosition(positionId: string, exitPrice: number): PositionClose | null {
    const pos = this.positions.get(positionId);
    if (!pos) return null;

    const t = now();
    const holdingPeriodMs = t - pos.opened_at;

    const priceDelta = pos.direction === 'BUY'
      ? exitPrice - pos.avg_entry_price
      : pos.avg_entry_price - exitPrice;
    const pnlGross = priceDelta * pos.size;
    const pnlNet = pnlGross - pos.fee_paid;

    const close: PositionClose = {
      market_id: pos.market_id,
      token_id: pos.token_id,
      entry_price: pos.avg_entry_price,
      exit_price: exitPrice,
      size: pos.size,
      pnl_gross: pnlGross,
      pnl_net: pnlNet,
      holding_period_ms: holdingPeriodMs,
      strategy_id: pos.strategy_id,
      signal_ev_at_entry: pos.signal_ev_at_entry,
      realized_ev: priceDelta,
      ev_estimation_error: pos.signal_ev_at_entry - priceDelta,
      execution_cost_realized: pos.fee_paid,
      execution_cost_estimated: 0,
    };

    this.closedTrades.push(close);
    this.positions.delete(positionId);

    // Record to ledger
    this.ledger.append({ type: 'position_closed', data: close });

    log.info({
      position_id: positionId,
      strategy: pos.strategy_id,
      market: pos.market_id,
      pnl_net: pnlNet.toFixed(4),
      holding_period_s: (holdingPeriodMs / 1000).toFixed(0),
    }, 'Position closed');

    return close;
  }

  /**
   * Close all positions for a resolved market.
   * Resolution price: 1.0 for winning side, 0.0 for losing side.
   */
  closeOnResolution(marketId: string, resolutionPrice: number): PositionClose[] {
    const closed: PositionClose[] = [];
    for (const [posId, pos] of this.positions) {
      if (pos.market_id === marketId) {
        const c = this.closePosition(posId, resolutionPrice);
        if (c) closed.push(c);
      }
    }
    return closed;
  }

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  /**
   * PnL report broken down by strategy with statistical significance.
   */
  reportPnL(
    periodMs: number,
    significanceThreshold: number = 0.05,
  ): PnLReport {
    const t = now();
    const periodStart = t - periodMs;
    const periodEnd = t;

    // Filter closed trades within the period
    const inPeriod = this.closedTrades.filter(
      c => c.holding_period_ms > 0 || true, // all closed trades
    ).filter(c => {
      // We don't have a close_timestamp on PositionClose, so we filter by
      // checking if the trade was created recently enough. Use a rough
      // heuristic: closed trades are appended in order.
      return true; // For now, include all closed trades within the engine lifetime
    });

    // Group by strategy
    const byStrategy = new Map<string, PositionClose[]>();
    for (const c of this.closedTrades) {
      const arr = byStrategy.get(c.strategy_id) ?? [];
      arr.push(c);
      byStrategy.set(c.strategy_id, arr);
    }

    const strategyReports: PnLByStrategy[] = [];
    for (const [strategyId, trades] of byStrategy) {
      const pnls = trades.map(t => t.pnl_net);
      const realized = pnls.reduce((s, v) => s + v, 0);

      // Unrealized for open positions of this strategy
      let unrealized = 0;
      for (const pos of this.positions.values()) {
        if (pos.strategy_id === strategyId) {
          unrealized += pos.unrealized_pnl;
        }
      }

      const wins = pnls.filter(p => p > 0).length;
      const losses = pnls.filter(p => p <= 0).length;
      const winRate = pnls.length > 0 ? wins / pnls.length : 0;
      const avgPnl = pnls.length > 0 ? mean(pnls) : 0;

      // Statistical significance via t-test (H0: mean PnL = 0)
      const tResult = tTest(pnls, 0);

      strategyReports.push({
        strategy_id: strategyId,
        realized_pnl: realized,
        unrealized_pnl: unrealized,
        total_pnl: realized + unrealized,
        trade_count: trades.length,
        win_count: wins,
        loss_count: losses,
        win_rate: winRate,
        avg_pnl_per_trade: avgPnl,
        t_stat: isNaN(tResult.t) ? 0 : tResult.t,
        p_value: isNaN(tResult.p) ? 1 : tResult.p,
        significant: !isNaN(tResult.p) && tResult.p < significanceThreshold,
      });
    }

    // Total unrealized across all open positions
    let totalUnrealized = 0;
    for (const pos of this.positions.values()) {
      totalUnrealized += pos.unrealized_pnl;
    }

    const totalRealized = this.closedTrades.reduce((s, c) => s + c.pnl_net, 0);

    // Period label
    const hours = Math.round(periodMs / 3_600_000);
    const periodLabel = hours >= 24 ? `${Math.round(hours / 24)}d` : `${hours}h`;

    return {
      timestamp: t,
      period_label: periodLabel,
      period_start: periodStart,
      period_end: periodEnd,
      total_realized_pnl: totalRealized,
      total_unrealized_pnl: totalUnrealized,
      total_fees_paid: this.totalFeesPaid,
      positions_open: this.positions.size,
      positions_closed: this.closedTrades.length,
      by_strategy: strategyReports,
    };
  }

  /**
   * Open positions report with EV estimates.
   */
  reportPositions(showEv: boolean = false): PositionsReport {
    const t = now();
    const entries: PositionReportEntry[] = [];

    for (const pos of this.positions.values()) {
      entries.push({
        position_id: pos.position_id,
        market_id: pos.market_id,
        token_id: pos.token_id,
        strategy_id: pos.strategy_id,
        direction: pos.direction,
        size: pos.size,
        avg_entry_price: pos.avg_entry_price,
        current_mark: pos.current_mark,
        unrealized_pnl: pos.unrealized_pnl,
        time_in_position_ms: t - pos.opened_at,
        signal_ev_at_entry: showEv ? pos.signal_ev_at_entry : 0,
        mfe: pos.max_favorable_excursion,
        mae: pos.max_adverse_excursion,
      });
    }

    // Sort by unrealized PnL descending
    entries.sort((a, b) => b.unrealized_pnl - a.unrealized_pnl);

    let totalUnrealized = 0;
    for (const e of entries) totalUnrealized += e.unrealized_pnl;

    return {
      timestamp: t,
      positions_open: entries.length,
      total_unrealized_pnl: totalUnrealized,
      positions: entries,
    };
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  getOpenPositions(): PaperPosition[] {
    return Array.from(this.positions.values());
  }

  getClosedTrades(): PositionClose[] {
    return [...this.closedTrades];
  }

  getPosition(positionId: string): PaperPosition | undefined {
    return this.positions.get(positionId);
  }

  openPositionCount(): number {
    return this.positions.size;
  }

  closedTradeCount(): number {
    return this.closedTrades.length;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private findExistingPositionKey(
    marketId: string,
    tokenId: string,
    strategyId: string,
    direction: 'BUY' | 'SELL',
  ): string | null {
    for (const [key, pos] of this.positions) {
      if (
        pos.market_id === marketId &&
        pos.token_id === tokenId &&
        pos.strategy_id === strategyId &&
        pos.direction === direction
      ) {
        return key;
      }
    }
    return null;
  }
}
