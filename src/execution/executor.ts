// ---------------------------------------------------------------------------
// Paper Trading Executor
//
// When config.paper_mode is true, simulates fills at best ask/bid + slippage
// based on actual book depth. Sweeps the book for our size, computes VWAP as
// fill price, accounts for fees, and records a full ExecutionRecord to ledger.
// ---------------------------------------------------------------------------

import { now } from '../utils/time.js';
import { getLogger } from '../utils/logger.js';
import type { Ledger } from '../ledger/ledger.js';
import type { TradeSignal, ExecutionRecord, ExecutionStatus } from '../ledger/types.js';
import type { OrderBook, PositionState } from '../state/types.js';
import type { WorldState } from '../state/world_state.js';
import { recordSignal } from '../counterfactual/shadow_engine.js';

const log = getLogger('executor');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExecutorConfig {
  fee_rate: number;
  paper_mode: boolean;
}

export interface FillResult {
  filled: boolean;
  execution: ExecutionRecord;
}

// ---------------------------------------------------------------------------
// Paper Executor
// ---------------------------------------------------------------------------

let execSeq = 0;

/**
 * Sweep the order book at the given levels to compute VWAP fill price
 * for a given size. Returns { vwap, filled_size, levels_consumed }.
 */
export function sweepBook(
  levels: [number, number][],
  size: number,
): { vwap: number; filled_size: number; levels_consumed: number } {
  let remaining = size;
  let cost = 0;
  let filled = 0;
  let consumed = 0;

  for (const [price, depth] of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, depth);
    cost += take * price;
    filled += take;
    remaining -= take;
    consumed++;
  }

  return {
    vwap: filled > 0 ? cost / filled : 0,
    filled_size: filled,
    levels_consumed: consumed,
  };
}

/**
 * Execute a signal in paper mode.
 *
 * - BUY: sweep ask side, fill at VWAP of consumed levels
 * - SELL: sweep bid side, fill at VWAP of consumed levels
 * - Account for fees (fee_rate × notional)
 * - Record full ExecutionRecord to ledger
 * - Record shadow record to counterfactual engine
 */
export function paperExecute(
  signal: TradeSignal,
  world: WorldState,
  ledger: Ledger,
  conf: ExecutorConfig,
): FillResult {
  const t = now();
  execSeq++;
  const executionId = `paper_${signal.signal_id}_${execSeq}`;

  // Resolve order book
  const market = world.markets.get(signal.market_id);
  if (!market) {
    return failedFill(executionId, signal, t, 'Market not found');
  }

  const isYes = market.tokens.yes_id === signal.token_id;
  const book: OrderBook = isYes ? market.book.yes : market.book.no;
  const priceAtSignal = book.mid;

  // Record to counterfactual engine
  recordSignal(signal, book, 0);

  // Sweep the appropriate side
  const levels = signal.direction === 'BUY' ? book.asks : book.bids;
  if (levels.length === 0) {
    return failedFill(executionId, signal, t, 'No liquidity on book');
  }

  const sweep = sweepBook(levels, signal.size_requested);

  if (sweep.filled_size === 0) {
    return failedFill(executionId, signal, t, 'Zero fill from sweep');
  }

  const fillPrice = sweep.vwap;
  const sizeFilled = sweep.filled_size;
  const partial = sizeFilled < signal.size_requested;
  const status: ExecutionStatus = partial ? 'partial' : 'filled';

  // Cost decomposition
  const notional = sizeFilled * fillPrice;
  const feePaid = notional * conf.fee_rate;
  const slippageVsSignal = signal.direction === 'BUY'
    ? fillPrice - signal.target_price
    : signal.target_price - fillPrice;
  const slippageVsMid = signal.direction === 'BUY'
    ? fillPrice - priceAtSignal
    : priceAtSignal - fillPrice;
  const spreadCost = book.spread / 2;
  const impactCost = Math.max(0, Math.abs(slippageVsMid) - spreadCost);
  const implementationShortfall = slippageVsMid + feePaid / sizeFilled;

  const execution: ExecutionRecord = {
    execution_id: executionId,
    signal_id: signal.signal_id,
    strategy_id: signal.strategy_id,
    market_id: signal.market_id,
    token_id: signal.token_id,
    direction: signal.direction,
    execution_strategy: 'paper_immediate',
    // Timestamps — all simultaneous in paper mode
    t0_signal_generated: signal.timestamp,
    t1_execution_plan_created: t,
    t2_order_submitted: t,
    t3_order_acknowledged: t,
    t4_first_fill: t,
    t5_final_fill: t,
    // Pre-trade estimates
    estimated_fill_price: signal.target_price,
    estimated_fill_probability: 1.0,
    estimated_cost_vs_mid: signal.ev_estimate - signal.ev_after_costs,
    // Actual results
    price_at_signal: priceAtSignal,
    price_at_submission: priceAtSignal,
    fill_price: fillPrice,
    fill_prices: [fillPrice],
    slippage_vs_signal: slippageVsSignal,
    slippage_vs_mid: slippageVsMid,
    slippage_vs_estimate: slippageVsMid - (signal.ev_estimate - signal.ev_after_costs),
    // Sizes
    size_requested: signal.size_requested,
    size_filled: sizeFilled,
    partial,
    num_fills: 1,
    num_cancels: 0,
    num_reposts: 0,
    // Costs
    fee_paid: feePaid,
    gas_cost: 0, // no gas in paper mode
    total_cost: feePaid,
    // Quality attribution
    implementation_shortfall: implementationShortfall,
    timing_cost: 0, // instantaneous in paper
    impact_cost: impactCost,
    spread_cost: spreadCost,
    // Result
    status,
    failure_reason: null,
  };

  // Record to ledger
  ledger.append({ type: 'order_filled', data: execution });

  log.info(
    {
      execution_id: executionId,
      strategy: signal.strategy_id,
      market: signal.market_id,
      direction: signal.direction,
      fill_price: fillPrice.toFixed(4),
      size_filled: sizeFilled,
      fee: feePaid.toFixed(4),
      slippage_vs_mid: slippageVsMid.toFixed(4),
      status,
    },
    'Paper fill executed',
  );

  return { filled: true, execution };
}

function failedFill(
  executionId: string,
  signal: TradeSignal,
  t: number,
  reason: string,
): FillResult {
  const execution: ExecutionRecord = {
    execution_id: executionId,
    signal_id: signal.signal_id,
    strategy_id: signal.strategy_id,
    market_id: signal.market_id,
    token_id: signal.token_id,
    direction: signal.direction,
    execution_strategy: 'paper_immediate',
    t0_signal_generated: signal.timestamp,
    t1_execution_plan_created: t,
    t2_order_submitted: t,
    t3_order_acknowledged: t,
    t4_first_fill: t,
    t5_final_fill: t,
    estimated_fill_price: signal.target_price,
    estimated_fill_probability: 0,
    estimated_cost_vs_mid: 0,
    price_at_signal: 0,
    price_at_submission: 0,
    fill_price: 0,
    fill_prices: [],
    slippage_vs_signal: 0,
    slippage_vs_mid: 0,
    slippage_vs_estimate: 0,
    size_requested: signal.size_requested,
    size_filled: 0,
    partial: false,
    num_fills: 0,
    num_cancels: 0,
    num_reposts: 0,
    fee_paid: 0,
    gas_cost: 0,
    total_cost: 0,
    implementation_shortfall: 0,
    timing_cost: 0,
    impact_cost: 0,
    spread_cost: 0,
    status: 'failed',
    failure_reason: reason,
  };

  log.warn({ execution_id: executionId, signal_id: signal.signal_id, reason }, 'Paper fill failed');
  return { filled: false, execution };
}

/** Reset sequence counter (for tests). */
export function resetExecutor(): void {
  execSeq = 0;
}
