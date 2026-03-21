import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Reconciliation } from '../../src/execution/reconciliation.js';
import type { PaperPosition } from '../../src/execution/reconciliation.js';
import type { ExecutionRecord } from '../../src/ledger/types.js';
import type { OrderBook, MarketState } from '../../src/state/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockLedger() {
  return {
    append: vi.fn(),
    currentFile: vi.fn(() => '/tmp/test.jsonl'),
    rotate: vi.fn(),
  };
}

function makeExec(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const t = Date.now();
  return {
    execution_id: 'exec_1',
    signal_id: 'sig_1',
    strategy_id: 'strat_test',
    market_id: 'mkt_1',
    token_id: 'tok_yes',
    direction: 'BUY',
    execution_strategy: 'paper_immediate',
    t0_signal_generated: t,
    t1_execution_plan_created: t,
    t2_order_submitted: t,
    t3_order_acknowledged: t,
    t4_first_fill: t,
    t5_final_fill: t,
    estimated_fill_price: 0.52,
    estimated_fill_probability: 1.0,
    estimated_cost_vs_mid: 0.01,
    price_at_signal: 0.51,
    price_at_submission: 0.51,
    fill_price: 0.52,
    fill_prices: [0.52],
    slippage_vs_signal: 0,
    slippage_vs_mid: 0.01,
    slippage_vs_estimate: 0,
    size_requested: 100,
    size_filled: 100,
    partial: false,
    num_fills: 1,
    num_cancels: 0,
    num_reposts: 0,
    fee_paid: 1.04,
    gas_cost: 0,
    total_cost: 1.04,
    implementation_shortfall: 0.02,
    timing_cost: 0,
    impact_cost: 0,
    spread_cost: 0.01,
    status: 'filled',
    failure_reason: null,
    ...overrides,
  };
}

function makeOrderBook(overrides: Partial<OrderBook> = {}): OrderBook {
  return {
    bids: [[0.50, 100]],
    asks: [[0.52, 100]],
    mid: 0.51,
    spread: 0.02,
    spread_bps: 392,
    imbalance: 0,
    imbalance_weighted: 0,
    top_of_book_stability_ms: 5000,
    queue_depth_at_best: 100,
    microprice: 0.51,
    last_updated: Date.now(),
    ...overrides,
  };
}

function makeMockWorld(marketOverrides: Record<string, { yesMid: number; noMid: number }> = {}) {
  const markets = new Map<string, Partial<MarketState>>();
  for (const [id, m] of Object.entries(marketOverrides)) {
    markets.set(id, {
      market_id: id,
      tokens: { yes_id: 'tok_yes', no_id: 'tok_no' },
      book: {
        yes: makeOrderBook({ mid: m.yesMid }),
        no: makeOrderBook({ mid: m.noMid }),
      },
    });
  }
  return { markets } as any;
}

// ---------------------------------------------------------------------------
// Tests: openPosition
// ---------------------------------------------------------------------------

describe('Reconciliation.openPosition', () => {
  let recon: Reconciliation;
  let ledger: ReturnType<typeof makeMockLedger>;

  beforeEach(() => {
    ledger = makeMockLedger();
    recon = new Reconciliation(ledger as any);
  });

  it('opens a new position from a filled execution', () => {
    const exec = makeExec();
    const pos = recon.openPosition(exec, 0.03);

    expect(pos).not.toBeNull();
    expect(pos!.market_id).toBe('mkt_1');
    expect(pos!.direction).toBe('BUY');
    expect(pos!.size).toBe(100);
    expect(pos!.avg_entry_price).toBeCloseTo(0.52, 6);
    expect(pos!.signal_ev_at_entry).toBe(0.03);
    expect(recon.openPositionCount()).toBe(1);
    expect(ledger.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'position_opened' }),
    );
  });

  it('returns null for a failed execution', () => {
    const exec = makeExec({ status: 'failed', size_filled: 0 });
    const pos = recon.openPosition(exec, 0.03);

    expect(pos).toBeNull();
    expect(recon.openPositionCount()).toBe(0);
  });

  it('aggregates positions for the same market/token/strategy/direction', () => {
    const exec1 = makeExec({ execution_id: 'e1', fill_price: 0.50, size_filled: 100, fee_paid: 1.0 });
    const exec2 = makeExec({ execution_id: 'e2', fill_price: 0.54, size_filled: 100, fee_paid: 1.08 });

    recon.openPosition(exec1, 0.03);
    const pos = recon.openPosition(exec2, 0.04);

    expect(recon.openPositionCount()).toBe(1);
    expect(pos!.size).toBe(200);
    // Weighted avg: (0.50 * 100 + 0.54 * 100) / 200 = 0.52
    expect(pos!.avg_entry_price).toBeCloseTo(0.52, 6);
    expect(pos!.fee_paid).toBeCloseTo(2.08, 6);
  });

  it('does NOT aggregate positions with different directions', () => {
    const execBuy = makeExec({ execution_id: 'e1', direction: 'BUY' });
    const execSell = makeExec({ execution_id: 'e2', direction: 'SELL' });

    recon.openPosition(execBuy, 0.03);
    recon.openPosition(execSell, 0.03);

    expect(recon.openPositionCount()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Tests: markToMarket
// ---------------------------------------------------------------------------

describe('Reconciliation.markToMarket', () => {
  let recon: Reconciliation;
  let ledger: ReturnType<typeof makeMockLedger>;

  beforeEach(() => {
    ledger = makeMockLedger();
    recon = new Reconciliation(ledger as any);
  });

  it('updates unrealized PnL for BUY positions', () => {
    const exec = makeExec({ fill_price: 0.50, fee_paid: 1.0, size_filled: 100 });
    recon.openPosition(exec, 0.03);

    // Mark at Yes mid = 0.55 → price moved up by 0.05
    const world = makeMockWorld({ mkt_1: { yesMid: 0.55, noMid: 0.45 } });
    recon.markToMarket(world);

    const positions = recon.getOpenPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0]!.current_mark).toBeCloseTo(0.55, 6);
    // PnL = (0.55 - 0.50) * 100 - 1.0 fee = 4.0
    expect(positions[0]!.unrealized_pnl).toBeCloseTo(4.0, 6);
    expect(positions[0]!.max_favorable_excursion).toBeCloseTo(0.05, 6);
  });

  it('updates unrealized PnL for SELL positions', () => {
    const exec = makeExec({
      direction: 'SELL',
      fill_price: 0.50,
      fee_paid: 1.0,
      size_filled: 100,
    });
    recon.openPosition(exec, 0.03);

    // Sell at 0.50, mark at 0.45 → profit
    const world = makeMockWorld({ mkt_1: { yesMid: 0.45, noMid: 0.55 } });
    recon.markToMarket(world);

    const positions = recon.getOpenPositions();
    // PnL = (0.50 - 0.45) * 100 - 1.0 fee = 4.0
    expect(positions[0]!.unrealized_pnl).toBeCloseTo(4.0, 6);
  });

  it('tracks adverse excursion when price moves against position', () => {
    const exec = makeExec({ fill_price: 0.50, fee_paid: 0, size_filled: 100 });
    recon.openPosition(exec, 0.03);

    // Price drops to 0.45 → adverse for a BUY
    const world = makeMockWorld({ mkt_1: { yesMid: 0.45, noMid: 0.55 } });
    recon.markToMarket(world);

    const positions = recon.getOpenPositions();
    expect(positions[0]!.max_adverse_excursion).toBeCloseTo(0.05, 6);
    expect(positions[0]!.max_favorable_excursion).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: closePosition
// ---------------------------------------------------------------------------

describe('Reconciliation.closePosition', () => {
  let recon: Reconciliation;
  let ledger: ReturnType<typeof makeMockLedger>;

  beforeEach(() => {
    ledger = makeMockLedger();
    recon = new Reconciliation(ledger as any);
  });

  it('closes a position and records PnL', () => {
    const exec = makeExec({ fill_price: 0.50, fee_paid: 1.0, size_filled: 100 });
    const pos = recon.openPosition(exec, 0.03)!;

    const close = recon.closePosition(pos.position_id, 0.60);

    expect(close).not.toBeNull();
    expect(close!.pnl_gross).toBeCloseTo(10.0, 6); // (0.60 - 0.50) * 100
    expect(close!.pnl_net).toBeCloseTo(9.0, 6); // 10.0 - 1.0 fee
    expect(close!.entry_price).toBeCloseTo(0.50, 6);
    expect(close!.exit_price).toBeCloseTo(0.60, 6);
    expect(recon.openPositionCount()).toBe(0);
    expect(recon.closedTradeCount()).toBe(1);
    // position_opened + position_closed
    expect(ledger.append).toHaveBeenCalledTimes(2);
  });

  it('returns null for nonexistent position', () => {
    const close = recon.closePosition('nonexistent', 0.60);
    expect(close).toBeNull();
  });

  it('records SELL close PnL correctly', () => {
    const exec = makeExec({
      direction: 'SELL',
      fill_price: 0.50,
      fee_paid: 0.5,
      size_filled: 100,
    });
    const pos = recon.openPosition(exec, 0.03)!;

    // Exit at 0.40 → profit for SHORT
    const close = recon.closePosition(pos.position_id, 0.40);

    expect(close!.pnl_gross).toBeCloseTo(10.0, 6); // (0.50 - 0.40) * 100
    expect(close!.pnl_net).toBeCloseTo(9.5, 6); // 10.0 - 0.5 fee
  });
});

// ---------------------------------------------------------------------------
// Tests: closeOnResolution
// ---------------------------------------------------------------------------

describe('Reconciliation.closeOnResolution', () => {
  let recon: Reconciliation;
  let ledger: ReturnType<typeof makeMockLedger>;

  beforeEach(() => {
    ledger = makeMockLedger();
    recon = new Reconciliation(ledger as any);
  });

  it('closes all positions for a resolved market', () => {
    const exec1 = makeExec({ execution_id: 'e1', strategy_id: 's1' });
    const exec2 = makeExec({ execution_id: 'e2', strategy_id: 's2' });
    recon.openPosition(exec1, 0.03);
    recon.openPosition(exec2, 0.04);

    const closed = recon.closeOnResolution('mkt_1', 1.0);

    expect(closed).toHaveLength(2);
    expect(recon.openPositionCount()).toBe(0);
  });

  it('does not close positions for other markets', () => {
    const exec1 = makeExec({ execution_id: 'e1', market_id: 'mkt_1', strategy_id: 's1' });
    const exec2 = makeExec({ execution_id: 'e2', market_id: 'mkt_2', strategy_id: 's2' });
    recon.openPosition(exec1, 0.03);
    recon.openPosition(exec2, 0.04);

    const closed = recon.closeOnResolution('mkt_1', 1.0);

    expect(closed).toHaveLength(1);
    expect(recon.openPositionCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: reportPnL
// ---------------------------------------------------------------------------

describe('Reconciliation.reportPnL', () => {
  let recon: Reconciliation;
  let ledger: ReturnType<typeof makeMockLedger>;

  beforeEach(() => {
    ledger = makeMockLedger();
    recon = new Reconciliation(ledger as any);
  });

  it('returns an empty report when no trades', () => {
    const report = recon.reportPnL(86_400_000);

    expect(report.total_realized_pnl).toBe(0);
    expect(report.total_unrealized_pnl).toBe(0);
    expect(report.positions_open).toBe(0);
    expect(report.positions_closed).toBe(0);
    expect(report.by_strategy).toHaveLength(0);
  });

  it('reports PnL grouped by strategy', () => {
    // Strategy A: one winning trade
    const execA = makeExec({ execution_id: 'e1', strategy_id: 'strat_a', fill_price: 0.50, fee_paid: 0.5, size_filled: 100 });
    const posA = recon.openPosition(execA, 0.03)!;
    recon.closePosition(posA.position_id, 0.60);

    // Strategy B: one losing trade
    const execB = makeExec({ execution_id: 'e2', strategy_id: 'strat_b', fill_price: 0.50, fee_paid: 0.5, size_filled: 100 });
    const posB = recon.openPosition(execB, 0.03)!;
    recon.closePosition(posB.position_id, 0.40);

    const report = recon.reportPnL(86_400_000);

    expect(report.by_strategy).toHaveLength(2);

    const stratA = report.by_strategy.find(s => s.strategy_id === 'strat_a')!;
    expect(stratA.realized_pnl).toBeCloseTo(9.5, 4); // (0.60-0.50)*100 - 0.5
    expect(stratA.trade_count).toBe(1);
    expect(stratA.win_count).toBe(1);

    const stratB = report.by_strategy.find(s => s.strategy_id === 'strat_b')!;
    expect(stratB.realized_pnl).toBeCloseTo(-10.5, 4); // (0.40-0.50)*100 - 0.5
    expect(stratB.loss_count).toBe(1);
  });

  it('computes t-statistic for strategy performance', () => {
    // Create multiple trades for strat_a to get meaningful t-test
    for (let i = 0; i < 10; i++) {
      const exec = makeExec({
        execution_id: `e_${i}`,
        strategy_id: 'strat_a',
        fill_price: 0.50,
        fee_paid: 0.01,
        size_filled: 100,
      });
      const pos = recon.openPosition(exec, 0.03)!;
      // All wins: exit at 0.52
      recon.closePosition(pos.position_id, 0.52);
    }

    const report = recon.reportPnL(86_400_000);
    const strat = report.by_strategy.find(s => s.strategy_id === 'strat_a')!;

    expect(strat.trade_count).toBe(10);
    expect(strat.t_stat).toBeGreaterThan(0); // positive PnL trades
    expect(strat.p_value).toBeLessThan(1);
  });

  it('includes unrealized PnL from open positions in strategy report', () => {
    const exec = makeExec({ fill_price: 0.50, fee_paid: 1.0, size_filled: 100 });
    recon.openPosition(exec, 0.03);

    // Mark to market at higher price
    const world = makeMockWorld({ mkt_1: { yesMid: 0.55, noMid: 0.45 } });
    recon.markToMarket(world);

    const report = recon.reportPnL(86_400_000);
    expect(report.total_unrealized_pnl).toBeCloseTo(4.0, 4); // (0.55-0.50)*100 - 1.0 fee
    expect(report.positions_open).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: reportPositions
// ---------------------------------------------------------------------------

describe('Reconciliation.reportPositions', () => {
  let recon: Reconciliation;
  let ledger: ReturnType<typeof makeMockLedger>;

  beforeEach(() => {
    ledger = makeMockLedger();
    recon = new Reconciliation(ledger as any);
  });

  it('lists open positions', () => {
    const exec = makeExec();
    recon.openPosition(exec, 0.03);

    const report = recon.reportPositions(false);

    expect(report.positions_open).toBe(1);
    expect(report.positions).toHaveLength(1);
    expect(report.positions[0]!.market_id).toBe('mkt_1');
    expect(report.positions[0]!.signal_ev_at_entry).toBe(0); // showEv = false
  });

  it('shows EV when showEv is true', () => {
    const exec = makeExec();
    recon.openPosition(exec, 0.03);

    const report = recon.reportPositions(true);

    expect(report.positions[0]!.signal_ev_at_entry).toBe(0.03);
  });

  it('sorts positions by unrealized PnL descending', () => {
    // Two strategies so they don't aggregate
    const exec1 = makeExec({ execution_id: 'e1', strategy_id: 's1', fill_price: 0.50, fee_paid: 0, size_filled: 100 });
    const exec2 = makeExec({ execution_id: 'e2', strategy_id: 's2', fill_price: 0.60, fee_paid: 0, size_filled: 100 });
    recon.openPosition(exec1, 0.03);
    recon.openPosition(exec2, 0.01);

    // Mark: mid = 0.55 → s1 gains, s2 loses
    const world = makeMockWorld({ mkt_1: { yesMid: 0.55, noMid: 0.45 } });
    recon.markToMarket(world);

    const report = recon.reportPositions(false);

    // s1: (0.55-0.50)*100 = 5.0, s2: (0.55-0.60)*100 = -5.0
    expect(report.positions[0]!.unrealized_pnl).toBeGreaterThan(report.positions[1]!.unrealized_pnl);
  });
});

// ---------------------------------------------------------------------------
// Tests: accessors
// ---------------------------------------------------------------------------

describe('Reconciliation accessors', () => {
  it('getPosition returns correct position', () => {
    const ledger = makeMockLedger();
    const recon = new Reconciliation(ledger as any);
    const exec = makeExec();
    const pos = recon.openPosition(exec, 0.03)!;

    const found = recon.getPosition(pos.position_id);
    expect(found).toBe(pos);
  });

  it('getClosedTrades returns copies', () => {
    const ledger = makeMockLedger();
    const recon = new Reconciliation(ledger as any);
    const exec = makeExec();
    const pos = recon.openPosition(exec, 0.03)!;
    recon.closePosition(pos.position_id, 0.60);

    const trades = recon.getClosedTrades();
    expect(trades).toHaveLength(1);
    expect(trades[0]!.pnl_gross).toBeCloseTo(8.0, 4); // (0.60-0.52)*100
  });
});
