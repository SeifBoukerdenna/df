import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeMicroprice,
  computeImbalance,
  computeMultiLevelImbalance,
  computeLiquidityScore,
  computeComplementGap,
  computeComplementGapExecutable,
  computeRollingAutocorrelation,
} from '../../src/state/derived_metrics.js';
import {
  createEmptyMarketState,
  updateBookFromSnapshot,
  updateBookFromTrade,
  computeVolatility,
} from '../../src/state/market_state.js';
import { WorldState } from '../../src/state/world_state.js';
import type { OrderBook } from '../../src/state/types.js';
import type { MarketMetadata, ParsedBookSnapshot, ParsedTrade } from '../../src/ingestion/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = join(import.meta.dirname, '..', '..', 'tmp_test_state');

function makeBook(
  bids: [number, number][],
  asks: [number, number][],
): OrderBook {
  const bestBid = bids[0]?.[0] ?? 0;
  const bestAsk = asks[0]?.[0] ?? 0;
  return {
    bids,
    asks,
    mid: bestBid && bestAsk ? (bestBid + bestAsk) / 2 : 0,
    spread: bestBid && bestAsk ? bestAsk - bestBid : 0,
    spread_bps: 0,
    imbalance: 0,
    imbalance_weighted: 0,
    top_of_book_stability_ms: 0,
    queue_depth_at_best: 0,
    microprice: 0,
    last_updated: Date.now(),
  };
}

function makeMetadata(overrides: Partial<MarketMetadata> = {}): MarketMetadata {
  return {
    market_id: 'mkt_1',
    question: 'Will it rain tomorrow?',
    condition_id: 'cond_1',
    tokens: { yes_id: 'tok_yes', no_id: 'tok_no' },
    status: 'active',
    resolution: null,
    end_date: '2025-12-31',
    category: 'weather',
    tags: ['weather', 'daily'],
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<ParsedBookSnapshot> = {}): ParsedBookSnapshot {
  return {
    market_id: 'mkt_1',
    token_id: 'tok_yes',
    bids: [[0.48, 200], [0.47, 300], [0.46, 400]],
    asks: [[0.52, 150], [0.53, 250], [0.54, 350]],
    timestamp: Date.now(),
    mid_price: 0.50,
    spread: 0.04,
    spread_bps: 800,
    bid_depth_1pct: 200,
    ask_depth_1pct: 150,
    bid_depth_5pct: 900,
    ask_depth_5pct: 750,
    vwap_bid_1000: 0.47,
    vwap_ask_1000: 0.53,
    queue_position_estimate: 5000,
    ...overrides,
  };
}

function makeTrade(overrides: Partial<ParsedTrade> = {}): ParsedTrade {
  return {
    market_id: 'mkt_1',
    condition_id: 'cond_1',
    token_id: 'tok_yes',
    side: 'BUY',
    price: 0.51,
    size: 100,
    notional: 51,
    maker: '0xmaker',
    taker: '0xtaker',
    tx_hash: '0xhash',
    timestamp: Date.now(),
    book_state_before: null,
    ...overrides,
  };
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Derived Metrics
// ---------------------------------------------------------------------------

describe('computeMicroprice', () => {
  it('returns size-weighted mid', () => {
    // bid=0.48@200, ask=0.52@100 → micro = (100*0.48 + 200*0.52) / 300 = (48+104)/300 = 0.50667
    const book = makeBook([[0.48, 200]], [[0.52, 100]]);
    const mp = computeMicroprice(book);
    expect(mp).toBeCloseTo((100 * 0.48 + 200 * 0.52) / 300, 10);
  });

  it('equals mid when sizes are equal', () => {
    const book = makeBook([[0.48, 100]], [[0.52, 100]]);
    expect(computeMicroprice(book)).toBeCloseTo(0.50, 10);
  });

  it('returns NaN when one side is empty', () => {
    const book = makeBook([[0.48, 100]], []);
    expect(computeMicroprice(book)).toBeNaN();
  });
});

describe('computeImbalance', () => {
  it('returns 0 for equal depth', () => {
    expect(computeImbalance([[0.50, 100]], [[0.51, 100]])).toBe(0);
  });

  it('returns positive for bid-heavy', () => {
    expect(computeImbalance([[0.50, 300]], [[0.51, 100]])).toBeCloseTo(0.5, 10);
  });

  it('returns 0 for empty book', () => {
    expect(computeImbalance([], [])).toBe(0);
  });
});

describe('computeMultiLevelImbalance', () => {
  it('weighs deeper levels less', () => {
    // Level 1: bids dominate. Level 2: asks dominate equally.
    // Weight 1 for level 1, weight 0.5 for level 2.
    // So bid-heavy level 1 should win.
    const bids: [number, number][] = [[0.50, 200], [0.49, 50]];
    const asks: [number, number][] = [[0.51, 50], [0.52, 200]];
    const imb = computeMultiLevelImbalance(bids, asks, 2);
    expect(imb).toBeGreaterThan(0); // bid-heavy due to level 1 weight
  });
});

describe('computeLiquidityScore', () => {
  it('returns 0 for empty book', () => {
    expect(computeLiquidityScore([], [], 0.50)).toBe(0);
  });

  it('returns > 0 for non-empty book', () => {
    const bids: [number, number][] = [[0.49, 1000]];
    const asks: [number, number][] = [[0.51, 1000]];
    const score = computeLiquidityScore(bids, asks, 0.50);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it('deeper book yields higher score', () => {
    const shallow = computeLiquidityScore([[0.49, 100]], [[0.51, 100]], 0.50);
    const deep = computeLiquidityScore([[0.49, 10000]], [[0.51, 10000]], 0.50);
    expect(deep).toBeGreaterThan(shallow);
  });
});

describe('computeComplementGap', () => {
  it('returns 0 when YES + NO = 1.0', () => {
    expect(computeComplementGap(0.60, 0.40)).toBeCloseTo(0, 10);
  });

  it('detects positive gap', () => {
    expect(computeComplementGap(0.55, 0.50)).toBeCloseTo(0.05, 10);
  });
});

describe('computeComplementGapExecutable', () => {
  it('returns positive profit when ask sum < 1.0 - 2*fees', () => {
    // yes_ask=0.45, no_ask=0.45 → total=0.90
    // profit = 1.0 - 0.90 - 2*0.02 = 0.06
    expect(computeComplementGapExecutable(0.45, 0.45, 0.02)).toBeCloseTo(0.06, 10);
  });

  it('returns negative when no arb after fees', () => {
    // yes_ask=0.50, no_ask=0.50 → total=1.00
    // profit = 1.0 - 1.00 - 0.04 = -0.04
    expect(computeComplementGapExecutable(0.50, 0.50, 0.02)).toBeCloseTo(-0.04, 10);
  });

  it('returns NaN for missing asks', () => {
    expect(computeComplementGapExecutable(NaN, 0.50, 0.02)).toBeNaN();
  });

  it('accounts for different fee rates', () => {
    const lowFee = computeComplementGapExecutable(0.45, 0.45, 0.01);
    const highFee = computeComplementGapExecutable(0.45, 0.45, 0.05);
    expect(lowFee).toBeGreaterThan(highFee);
  });
});

describe('computeRollingAutocorrelation', () => {
  it('returns ~1 for perfectly trending series', () => {
    // Monotonic returns → high positive autocorrelation
    const returns = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.10];
    const ac = computeRollingAutocorrelation(returns, 1);
    expect(ac).toBeGreaterThanOrEqual(0.7);
  });

  it('returns ~negative for alternating series', () => {
    const returns = [0.05, -0.05, 0.05, -0.05, 0.05, -0.05, 0.05, -0.05];
    const ac = computeRollingAutocorrelation(returns, 1);
    expect(ac).toBeLessThan(-0.5);
  });

  it('returns 0 for constant series', () => {
    expect(computeRollingAutocorrelation([1, 1, 1, 1, 1], 1)).toBe(0);
  });

  it('returns 0 for too-short series', () => {
    expect(computeRollingAutocorrelation([0.01], 1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Market State functions
// ---------------------------------------------------------------------------

describe('createEmptyMarketState', () => {
  it('creates state with correct metadata', () => {
    const meta = makeMetadata();
    const state = createEmptyMarketState(meta);
    expect(state.market_id).toBe('mkt_1');
    expect(state.question).toBe('Will it rain tomorrow?');
    expect(state.tokens.yes_id).toBe('tok_yes');
    expect(state.status).toBe('active');
    expect(state.book.yes.bids).toEqual([]);
    expect(state.volume_24h).toBe(0);
  });
});

describe('updateBookFromSnapshot', () => {
  it('updates YES side and recomputes mid/spread', () => {
    const state = createEmptyMarketState(makeMetadata());
    const snapshot = makeSnapshot();
    const updated = updateBookFromSnapshot(state, snapshot);

    expect(updated.book.yes.bids).toEqual(snapshot.bids);
    expect(updated.book.yes.asks).toEqual(snapshot.asks);
    expect(updated.book.yes.mid).toBeCloseTo(0.50, 10);
    expect(updated.book.yes.spread).toBeCloseTo(0.04, 10);
  });

  it('updates NO side when token matches no_id', () => {
    const state = createEmptyMarketState(makeMetadata());
    const snapshot = makeSnapshot({
      token_id: 'tok_no',
      bids: [[0.40, 100]],
      asks: [[0.60, 100]],
    });
    const updated = updateBookFromSnapshot(state, snapshot);

    expect(updated.book.no.bids).toEqual([[0.40, 100]]);
    expect(updated.book.no.mid).toBeCloseTo(0.50, 10);
    // YES side should remain untouched (empty)
    expect(updated.book.yes.bids).toEqual([]);
  });

  it('computes microprice on update', () => {
    const state = createEmptyMarketState(makeMetadata());
    const snapshot = makeSnapshot({
      bids: [[0.48, 200]],
      asks: [[0.52, 100]],
    });
    const updated = updateBookFromSnapshot(state, snapshot);
    // micro = (100*0.48 + 200*0.52) / 300 = 0.50667
    expect(updated.book.yes.microprice).toBeCloseTo((100 * 0.48 + 200 * 0.52) / 300, 5);
  });

  it('computes complement gap when both sides have data', () => {
    let state = createEmptyMarketState(makeMetadata());

    // Update YES side
    state = updateBookFromSnapshot(state, makeSnapshot({
      token_id: 'tok_yes',
      bids: [[0.55, 100]],
      asks: [[0.57, 100]],
    }));
    // Update NO side
    state = updateBookFromSnapshot(state, makeSnapshot({
      token_id: 'tok_no',
      bids: [[0.40, 100]],
      asks: [[0.42, 100]],
    }));

    // yes_mid=0.56, no_mid=0.41 → gap = |0.56+0.41-1.0| = 0.03
    expect(state.complement_gap).toBeCloseTo(0.03, 5);
  });

  it('does not mutate the input state', () => {
    const state = createEmptyMarketState(makeMetadata());
    const snapshot = makeSnapshot();
    const updated = updateBookFromSnapshot(state, snapshot);

    expect(state.book.yes.bids).toEqual([]);
    expect(updated.book.yes.bids.length).toBeGreaterThan(0);
    expect(state).not.toBe(updated);
  });
});

describe('updateBookFromTrade', () => {
  it('increments volume and trade count', () => {
    const state = createEmptyMarketState(makeMetadata());
    const trade = makeTrade({ notional: 51, price: 0.51 });
    const updated = updateBookFromTrade(state, trade);

    expect(updated.volume_1h).toBe(51);
    expect(updated.volume_24h).toBe(51);
    expect(updated.trade_count_1h).toBe(1);
    expect(updated.last_trade_price.yes).toBe(0.51);
  });

  it('updates correct side (NO token)', () => {
    const state = createEmptyMarketState(makeMetadata());
    const trade = makeTrade({ token_id: 'tok_no', price: 0.45 });
    const updated = updateBookFromTrade(state, trade);

    expect(updated.last_trade_price.no).toBe(0.45);
    expect(updated.last_trade_price.yes).toBe(0); // unchanged
  });

  it('does not mutate the input state', () => {
    const state = createEmptyMarketState(makeMetadata());
    const trade = makeTrade();
    const updated = updateBookFromTrade(state, trade);

    expect(state.trade_count_1h).toBe(0);
    expect(updated.trade_count_1h).toBe(1);
  });
});

describe('computeVolatility', () => {
  it('returns 0 for too few prices', () => {
    expect(computeVolatility([1.0, 1.1])).toBe(0);
  });

  it('returns 0 for constant prices', () => {
    expect(computeVolatility([1.0, 1.0, 1.0, 1.0])).toBe(0);
  });

  it('returns positive for varying prices', () => {
    const prices = [0.50, 0.52, 0.48, 0.55, 0.45, 0.53];
    expect(computeVolatility(prices)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// WorldState
// ---------------------------------------------------------------------------

describe('WorldState', () => {
  it('registers markets and retrieves them', () => {
    const ws = new WorldState();
    ws.registerMarket(makeMetadata());
    ws.registerMarket(makeMetadata({ market_id: 'mkt_2', question: 'Second market' }));

    expect(ws.getMarket('mkt_1')?.question).toBe('Will it rain tomorrow?');
    expect(ws.getMarket('mkt_2')?.question).toBe('Second market');
    expect(ws.getAllMarkets()).toHaveLength(2);
  });

  it('does not overwrite existing market on duplicate register', () => {
    const ws = new WorldState();
    ws.registerMarket(makeMetadata());
    ws.updateMarket(makeSnapshot());

    // Re-register should be a no-op
    ws.registerMarket(makeMetadata());
    expect(ws.getMarket('mkt_1')!.book.yes.bids.length).toBeGreaterThan(0);
  });

  it('applies book snapshots', () => {
    const ws = new WorldState();
    ws.registerMarket(makeMetadata());
    ws.updateMarket(makeSnapshot());

    const mkt = ws.getMarket('mkt_1')!;
    expect(mkt.book.yes.mid).toBeCloseTo(0.50, 10);
    expect(mkt.book.yes.bids.length).toBeGreaterThan(0);
  });

  it('applies trades', () => {
    const ws = new WorldState();
    ws.registerMarket(makeMetadata());
    ws.updateMarketFromTrade(makeTrade());

    expect(ws.getMarket('mkt_1')!.trade_count_1h).toBe(1);
  });

  it('silently drops updates for unregistered markets', () => {
    const ws = new WorldState();
    // Should not throw
    ws.updateMarket(makeSnapshot({ market_id: 'unknown' }));
    ws.updateMarketFromTrade(makeTrade({ market_id: 'unknown' }));
    expect(ws.getAllMarkets()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Serialize / Load round-trip
// ---------------------------------------------------------------------------

describe('WorldState serialize/load', () => {
  it('round-trips through save and load', () => {
    const ws = new WorldState();
    ws.registerMarket(makeMetadata());
    ws.updateMarket(makeSnapshot());
    ws.updateMarketFromTrade(makeTrade());

    const filePath = join(TEST_DIR, 'snapshot.json');
    ws.saveToDisk(filePath);

    const ws2 = new WorldState();
    ws2.loadFromDisk(filePath);

    expect(ws2.markets.size).toBe(1);
    const mkt = ws2.getMarket('mkt_1')!;
    expect(mkt.question).toBe('Will it rain tomorrow?');
    expect(mkt.book.yes.bids.length).toBeGreaterThan(0);
    expect(mkt.trade_count_1h).toBe(1);
  });

  it('preserves market count across round-trip', () => {
    const ws = new WorldState();
    ws.registerMarket(makeMetadata({ market_id: 'a' }));
    ws.registerMarket(makeMetadata({ market_id: 'b' }));
    ws.registerMarket(makeMetadata({ market_id: 'c' }));

    const filePath = join(TEST_DIR, 'multi.json');
    ws.saveToDisk(filePath);

    const ws2 = new WorldState();
    ws2.loadFromDisk(filePath);
    expect(ws2.markets.size).toBe(3);
  });

  it('loadFromDisk is a no-op for missing file', () => {
    const ws = new WorldState();
    ws.registerMarket(makeMetadata());

    ws.loadFromDisk(join(TEST_DIR, 'nonexistent.json'));
    // State should be unchanged
    expect(ws.markets.size).toBe(1);
  });

  it('serialize output is valid JSON', () => {
    const ws = new WorldState();
    ws.registerMarket(makeMetadata());
    ws.updateMarket(makeSnapshot());

    const serialized = ws.serialize();
    const json = JSON.stringify(serialized);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Regime detection integration
// ---------------------------------------------------------------------------

describe('WorldState regime detection', () => {
  it('exposes a RegimeDetector instance', () => {
    const ws = new WorldState();
    expect(ws.regimeDetector).toBeDefined();
    expect(typeof ws.regimeDetector.detect).toBe('function');
  });

  it('runRegimeDetection updates state.regime', () => {
    const ws = new WorldState();
    const before = ws.regime.current_regime;
    const result = ws.runRegimeDetection(Date.now());
    expect(result.current_regime).toBe(before); // stays normal with no data
    expect(ws.regime).toBe(result);
  });

  it('runRegimeDetection counts active wallets from recent trades', () => {
    const ws = new WorldState();
    const nowMs = Date.now();

    ws.registerWallet('0xaaa');
    ws.recordWalletTrade({
      wallet: '0xaaa',
      market_id: 'mkt_1',
      token_id: 'tok_1',
      side: 'BUY',
      price: 0.5,
      size: 100,
      timestamp: nowMs - 30_000, // 30s ago — within 60s window
      tx_hash: '0xtx1',
      block_number: 100,
      gas_price: 30_000_000_000,
    });

    // Should not throw, and the detector receives activeWalletCount=1
    const result = ws.runRegimeDetection(nowMs);
    expect(result.current_regime).toBe('normal');
  });

  it('fires onRegimeChange callback on regime transition', () => {
    const ws = new WorldState({ min_observations: 5, regime_change_persistence: 1 });

    // Build baseline with normal markets
    for (let i = 0; i < 15; i++) {
      const meta = makeMetadata(`m_${i}`);
      ws.registerMarket(meta);
    }

    // Seed normal history
    const t0 = 1_000_000;
    for (let i = 0; i < 15; i++) {
      // Set normal spread/volume on all markets
      for (const m of ws.markets.values()) {
        m.book.yes.spread_bps = 200 + Math.sin(i) * 20;
        m.book.no.spread_bps = 200 + Math.cos(i) * 20;
        m.volume_1h = 1000 + i * 10;
      }
      ws.runRegimeDetection(t0 + i * 60_000);
    }
    expect(ws.regime.current_regime).toBe('normal');

    // Track regime changes via callback
    const changes: { from: string; to: string; confidence: number }[] = [];
    ws.onRegimeChange = (from, to, confidence) => {
      changes.push({ from, to, confidence });
    };

    // Now inject extreme conditions — wide spreads + high volume = high_volatility
    const hvTime = t0 + 15 * 60_000;
    for (let i = 0; i < 5; i++) {
      for (const m of ws.markets.values()) {
        m.book.yes.spread_bps = 3000;
        m.book.no.spread_bps = 3000;
        m.volume_1h = 100_000;
      }
      ws.runRegimeDetection(hvTime + i * 60_000);
    }

    expect(ws.regime.current_regime).toBe('high_volatility');
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes[0]!.from).toBe('normal');
    expect(changes[0]!.to).toBe('high_volatility');
    expect(changes[0]!.confidence).toBeGreaterThan(0);
  });

  it('startRegimeDetection and stopRegimeDetection manage the interval', () => {
    const ws = new WorldState();
    ws.startRegimeDetection();
    // Starting twice should be idempotent
    ws.startRegimeDetection();
    // Stop should not throw
    ws.stopRegimeDetection();
    ws.stopRegimeDetection(); // double stop is safe
  });

  it('regime detector receives resolution events via regimeDetector', () => {
    const ws = new WorldState({ min_observations: 5, regime_change_persistence: 1 });
    // Record resolutions through the public API
    ws.regimeDetector.recordResolution(Date.now());
    ws.regimeDetector.recordResolution(Date.now());

    // Should not throw
    const result = ws.runRegimeDetection(Date.now());
    expect(result).toBeDefined();
  });
});
