import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sweepBook, paperExecute, resetExecutor } from '../../src/execution/executor.js';
import type { ExecutorConfig, FillResult } from '../../src/execution/executor.js';
import type { TradeSignal } from '../../src/ledger/types.js';
import type { OrderBook, MarketState } from '../../src/state/types.js';

// ---------------------------------------------------------------------------
// Mock modules
// ---------------------------------------------------------------------------

vi.mock('../../src/counterfactual/shadow_engine.js', () => ({
  recordSignal: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOrderBook(overrides: Partial<OrderBook> = {}): OrderBook {
  return {
    bids: [[0.50, 100], [0.48, 200], [0.45, 300]],
    asks: [[0.52, 100], [0.54, 200], [0.57, 300]],
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

function makeMarketState(overrides: Partial<MarketState> = {}): MarketState {
  const book = makeOrderBook();
  return {
    market_id: 'mkt_1',
    question: 'Test?',
    condition_id: 'cond_1',
    tokens: { yes_id: 'tok_yes', no_id: 'tok_no' },
    status: 'active',
    resolution: null,
    end_date: '2025-12-31',
    category: 'test',
    tags: [],
    book: { yes: book, no: makeOrderBook() },
    last_trade_price: { yes: 0.51, no: 0.49 },
    volume_24h: 10000,
    volume_1h: 500,
    trade_count_1h: 50,
    liquidity_score: 0.8,
    complement_gap: 0.01,
    complement_gap_executable: 0.02,
    staleness_ms: 1000,
    volatility_1h: 0.05,
    autocorrelation_1m: 0.1,
    related_markets: [],
    ...overrides,
  } as MarketState;
}

function makeSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    signal_id: 'sig_1',
    strategy_id: 'strat_test',
    timestamp: Date.now(),
    market_id: 'mkt_1',
    token_id: 'tok_yes',
    direction: 'BUY',
    target_price: 0.52,
    max_price: 0.60,
    size_requested: 50,
    urgency: 'immediate',
    ev_estimate: 0.03,
    ev_confidence_interval: [0.01, 0.05],
    ev_after_costs: 0.02,
    signal_strength: 0.7,
    expected_holding_period_ms: 60_000,
    expected_sharpe_contribution: 0.1,
    correlation_with_existing: 0,
    reasoning: 'test signal',
    kill_conditions: [],
    regime_assumption: 'normal',
    decay_model: { half_life_ms: 30_000, initial_ev: 0.03 },
    ...overrides,
  };
}

function makeMockLedger() {
  return {
    append: vi.fn(),
    currentFile: vi.fn(() => '/tmp/test.jsonl'),
    rotate: vi.fn(),
  };
}

function makeMockWorld(markets: Map<string, MarketState>) {
  return {
    markets,
    wallets: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Tests: sweepBook
// ---------------------------------------------------------------------------

describe('sweepBook', () => {
  it('fills entirely from first level when size <= depth', () => {
    const levels: [number, number][] = [[0.52, 100], [0.54, 200]];
    const result = sweepBook(levels, 50);

    expect(result.filled_size).toBe(50);
    expect(result.vwap).toBeCloseTo(0.52, 6);
    expect(result.levels_consumed).toBe(1);
  });

  it('sweeps multiple levels for a large order', () => {
    const levels: [number, number][] = [[0.52, 100], [0.54, 200], [0.57, 300]];
    const result = sweepBook(levels, 250);

    // 100 @ 0.52 = 52, 150 @ 0.54 = 81 → total cost = 133, size = 250
    expect(result.filled_size).toBe(250);
    expect(result.vwap).toBeCloseTo((100 * 0.52 + 150 * 0.54) / 250, 6);
    expect(result.levels_consumed).toBe(2);
  });

  it('sweeps all levels for full depth', () => {
    const levels: [number, number][] = [[0.52, 100], [0.54, 200], [0.57, 300]];
    const result = sweepBook(levels, 600);

    expect(result.filled_size).toBe(600);
    const expectedCost = 100 * 0.52 + 200 * 0.54 + 300 * 0.57;
    expect(result.vwap).toBeCloseTo(expectedCost / 600, 6);
    expect(result.levels_consumed).toBe(3);
  });

  it('returns partial fill when size > total depth', () => {
    const levels: [number, number][] = [[0.52, 100], [0.54, 50]];
    const result = sweepBook(levels, 200);

    expect(result.filled_size).toBe(150);
    expect(result.levels_consumed).toBe(2);
    expect(result.vwap).toBeCloseTo((100 * 0.52 + 50 * 0.54) / 150, 6);
  });

  it('returns zero fill for empty levels', () => {
    const result = sweepBook([], 100);

    expect(result.filled_size).toBe(0);
    expect(result.vwap).toBe(0);
    expect(result.levels_consumed).toBe(0);
  });

  it('handles zero size gracefully', () => {
    const levels: [number, number][] = [[0.52, 100]];
    const result = sweepBook(levels, 0);

    expect(result.filled_size).toBe(0);
    expect(result.vwap).toBe(0);
    expect(result.levels_consumed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: paperExecute
// ---------------------------------------------------------------------------

describe('paperExecute', () => {
  const conf: ExecutorConfig = { fee_rate: 0.02, paper_mode: true };

  beforeEach(() => {
    resetExecutor();
  });

  it('fills a BUY at VWAP of ask levels', () => {
    const market = makeMarketState();
    const markets = new Map([['mkt_1', market]]);
    const world = makeMockWorld(markets) as any;
    const ledger = makeMockLedger() as any;
    const signal = makeSignal({ size_requested: 50, direction: 'BUY' });

    const result = paperExecute(signal, world, ledger, conf);

    expect(result.filled).toBe(true);
    expect(result.execution.status).toBe('filled');
    expect(result.execution.size_filled).toBe(50);
    // 50 units from first ask level at 0.52
    expect(result.execution.fill_price).toBeCloseTo(0.52, 6);
    expect(result.execution.direction).toBe('BUY');
    expect(result.execution.fee_paid).toBeCloseTo(50 * 0.52 * 0.02, 6);
    expect(ledger.append).toHaveBeenCalledOnce();
    expect(ledger.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'order_filled' }),
    );
  });

  it('fills a SELL at VWAP of bid levels', () => {
    const market = makeMarketState();
    const markets = new Map([['mkt_1', market]]);
    const world = makeMockWorld(markets) as any;
    const ledger = makeMockLedger() as any;
    const signal = makeSignal({
      size_requested: 50,
      direction: 'SELL',
    });

    const result = paperExecute(signal, world, ledger, conf);

    expect(result.filled).toBe(true);
    expect(result.execution.fill_price).toBeCloseTo(0.50, 6);
    expect(result.execution.direction).toBe('SELL');
  });

  it('reports partial fill when requested size > book depth', () => {
    const book = makeOrderBook({ asks: [[0.52, 30]] });
    const market = makeMarketState({ book: { yes: book, no: makeOrderBook() } });
    const markets = new Map([['mkt_1', market]]);
    const world = makeMockWorld(markets) as any;
    const ledger = makeMockLedger() as any;
    const signal = makeSignal({ size_requested: 50, direction: 'BUY' });

    const result = paperExecute(signal, world, ledger, conf);

    expect(result.filled).toBe(true);
    expect(result.execution.partial).toBe(true);
    expect(result.execution.status).toBe('partial');
    expect(result.execution.size_filled).toBe(30);
  });

  it('fails when market not found', () => {
    const world = makeMockWorld(new Map()) as any;
    const ledger = makeMockLedger() as any;
    const signal = makeSignal();

    const result = paperExecute(signal, world, ledger, conf);

    expect(result.filled).toBe(false);
    expect(result.execution.status).toBe('failed');
    expect(result.execution.failure_reason).toBe('Market not found');
  });

  it('fails when book side is empty', () => {
    const book = makeOrderBook({ asks: [] });
    const market = makeMarketState({ book: { yes: book, no: makeOrderBook() } });
    const markets = new Map([['mkt_1', market]]);
    const world = makeMockWorld(markets) as any;
    const ledger = makeMockLedger() as any;
    const signal = makeSignal({ direction: 'BUY' });

    const result = paperExecute(signal, world, ledger, conf);

    expect(result.filled).toBe(false);
    expect(result.execution.failure_reason).toBe('No liquidity on book');
  });

  it('computes cost decomposition fields', () => {
    const market = makeMarketState();
    const markets = new Map([['mkt_1', market]]);
    const world = makeMockWorld(markets) as any;
    const ledger = makeMockLedger() as any;
    const signal = makeSignal({ size_requested: 50, direction: 'BUY' });

    const result = paperExecute(signal, world, ledger, conf);
    const exec = result.execution;

    expect(exec.spread_cost).toBeCloseTo(0.01, 6); // spread/2
    expect(exec.timing_cost).toBe(0); // instantaneous in paper
    expect(exec.gas_cost).toBe(0);
    expect(exec.total_cost).toBe(exec.fee_paid);
    expect(exec.implementation_shortfall).toBeDefined();
  });

  it('uses NO book when token_id matches no_id', () => {
    const yesBook = makeOrderBook({ asks: [[0.80, 100]], mid: 0.79 });
    const noBook = makeOrderBook({ asks: [[0.22, 100]], mid: 0.21 });
    const market = makeMarketState({
      book: { yes: yesBook, no: noBook },
    });
    const markets = new Map([['mkt_1', market]]);
    const world = makeMockWorld(markets) as any;
    const ledger = makeMockLedger() as any;
    const signal = makeSignal({
      token_id: 'tok_no',
      direction: 'BUY',
      size_requested: 50,
    });

    const result = paperExecute(signal, world, ledger, conf);

    expect(result.filled).toBe(true);
    expect(result.execution.fill_price).toBeCloseTo(0.22, 6);
  });

  it('assigns unique execution IDs', () => {
    const market = makeMarketState();
    const markets = new Map([['mkt_1', market]]);
    const world = makeMockWorld(markets) as any;
    const ledger = makeMockLedger() as any;

    const r1 = paperExecute(makeSignal({ signal_id: 's1' }), world, ledger, conf);
    const r2 = paperExecute(makeSignal({ signal_id: 's2' }), world, ledger, conf);

    expect(r1.execution.execution_id).not.toBe(r2.execution.execution_id);
  });
});
