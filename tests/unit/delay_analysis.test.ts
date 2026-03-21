import { describe, it, expect } from 'vitest';
import {
  computeWalletDelayCurve,
  computeAllDelayCurves,
  findPriceAtTime,
  matchTrades,
  computeDelayedPnl,
  estimateEdgeHalflife,
  estimateBreakevenDelay,
} from '../../src/wallet_intel/delay_analysis.js';
import { createEmptyWalletState, recomputeWalletStats } from '../../src/state/wallet_stats.js';
import type { WalletState } from '../../src/state/types.js';
import type { WalletTransaction } from '../../src/ingestion/types.js';
import type { PriceTimeseries, DelayBucketResult } from '../../src/wallet_intel/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let txSeq = 0;

function makeTx(overrides: Partial<WalletTransaction> = {}): WalletTransaction {
  return {
    wallet: '0xabc123',
    market_id: 'mkt_1',
    token_id: 'tok_yes_1',
    side: 'BUY',
    price: 0.50,
    size: 100,
    timestamp: Date.now(),
    tx_hash: '0xtx_' + (txSeq++),
    block_number: 1000,
    gas_price: 30_000_000_000,
    ...overrides,
  };
}

function buildWallet(trades: WalletTransaction[], address = '0xabc123'): WalletState {
  const ws = createEmptyWalletState(address);
  ws.trades = trades;
  ws.stats = recomputeWalletStats(trades);
  return ws;
}

/**
 * Build a price timeseries with prices at regular intervals.
 * priceAtMs maps offset_ms → mid_price
 */
function buildPriceData(
  marketId: string,
  tokenId: string,
  baseTimestamp: number,
  pricePoints: { offsetMs: number; price: number }[],
): Map<string, PriceTimeseries> {
  const key = `${marketId}:${tokenId}`;
  const prices = pricePoints.map((p) => ({
    timestamp: baseTimestamp + p.offsetMs,
    mid_price: p.price,
  }));
  return new Map([[key, { market_id: marketId, token_id: tokenId, prices }]]);
}

// ---------------------------------------------------------------------------
// findPriceAtTime
// ---------------------------------------------------------------------------

describe('findPriceAtTime', () => {
  const prices = [
    { timestamp: 1000, mid_price: 0.40 },
    { timestamp: 2000, mid_price: 0.45 },
    { timestamp: 3000, mid_price: 0.50 },
    { timestamp: 5000, mid_price: 0.55 },
    { timestamp: 10000, mid_price: 0.60 },
  ];

  it('finds exact timestamp', () => {
    expect(findPriceAtTime(prices, 3000)).toBe(0.50);
  });

  it('finds closest timestamp', () => {
    expect(findPriceAtTime(prices, 2800)).toBe(0.50); // closer to 3000 than 2000
    expect(findPriceAtTime(prices, 2200)).toBe(0.45); // closer to 2000 than 3000
  });

  it('returns null for empty array', () => {
    expect(findPriceAtTime([], 1000)).toBeNull();
  });

  it('returns null if gap exceeds max', () => {
    expect(findPriceAtTime(prices, 200_000)).toBeNull();
  });

  it('respects custom max gap', () => {
    expect(findPriceAtTime(prices, 11500, 2000)).toBe(0.60);
    expect(findPriceAtTime(prices, 11500, 1000)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// matchTrades (FIFO BUY→SELL matching)
// ---------------------------------------------------------------------------

describe('matchTrades', () => {
  it('matches simple BUY→SELL pair', () => {
    const trades = [
      makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: 1000 }),
      makeTx({ side: 'SELL', price: 0.60, size: 100, timestamp: 5000 }),
    ];

    const matched = matchTrades(trades);
    expect(matched).toHaveLength(1);
    expect(matched[0]!.entry_price).toBe(0.40);
    expect(matched[0]!.exit_price).toBe(0.60);
    expect(matched[0]!.pnl).toBeCloseTo(20, 2);
    expect(matched[0]!.size).toBe(100);
  });

  it('handles partial fills', () => {
    const trades = [
      makeTx({ side: 'BUY', price: 0.40, size: 200, timestamp: 1000 }),
      makeTx({ side: 'SELL', price: 0.50, size: 100, timestamp: 3000 }),
      makeTx({ side: 'SELL', price: 0.60, size: 100, timestamp: 5000 }),
    ];

    const matched = matchTrades(trades);
    expect(matched).toHaveLength(2);
    expect(matched[0]!.pnl).toBeCloseTo(10, 2);  // (0.50-0.40)*100
    expect(matched[1]!.pnl).toBeCloseTo(20, 2);  // (0.60-0.40)*100
  });

  it('skips orphan sells', () => {
    const trades = [
      makeTx({ side: 'SELL', price: 0.60, size: 100, timestamp: 5000 }),
    ];

    const matched = matchTrades(trades);
    expect(matched).toHaveLength(0);
  });

  it('handles multiple markets independently', () => {
    const trades = [
      makeTx({ market_id: 'mkt_1', token_id: 'tok_1', side: 'BUY', price: 0.40, size: 100, timestamp: 1000 }),
      makeTx({ market_id: 'mkt_2', token_id: 'tok_2', side: 'BUY', price: 0.50, size: 100, timestamp: 2000 }),
      makeTx({ market_id: 'mkt_1', token_id: 'tok_1', side: 'SELL', price: 0.50, size: 100, timestamp: 3000 }),
      makeTx({ market_id: 'mkt_2', token_id: 'tok_2', side: 'SELL', price: 0.55, size: 100, timestamp: 4000 }),
    ];

    const matched = matchTrades(trades);
    expect(matched).toHaveLength(2);
    expect(matched[0]!.market_id).toBe('mkt_1');
    expect(matched[1]!.market_id).toBe('mkt_2');
  });
});

// ---------------------------------------------------------------------------
// computeDelayedPnl
// ---------------------------------------------------------------------------

describe('computeDelayedPnl', () => {
  it('computes delayed PnL using price timeseries', () => {
    const trade = {
      entry_price: 0.40,
      exit_price: 0.60,
      entry_timestamp: 1000,
      exit_timestamp: 10000,
      size: 100,
      pnl: 20,
      market_id: 'mkt_1',
      token_id: 'tok_1',
    };

    const priceData = buildPriceData('mkt_1', 'tok_1', 0, [
      { offsetMs: 1000, price: 0.40 },
      { offsetMs: 4000, price: 0.45 },  // delay=3s
      { offsetMs: 6000, price: 0.50 },
      { offsetMs: 10000, price: 0.60 },
    ]);

    // 3 second delay: enter at 0.45, exit at 0.60 → PnL = 15
    const result = computeDelayedPnl(trade, 3, priceData);
    expect(result).toBeCloseTo(15, 2); // (0.60 - 0.45) * 100
  });

  it('returns null if delayed entry is after exit', () => {
    const trade = {
      entry_price: 0.40,
      exit_price: 0.60,
      entry_timestamp: 1000,
      exit_timestamp: 3000,
      size: 100,
      pnl: 20,
      market_id: 'mkt_1',
      token_id: 'tok_1',
    };

    // 5s delay → delayed entry at 6000, which is after exit at 3000
    const result = computeDelayedPnl(trade, 5, new Map());
    expect(result).toBeNull();
  });

  it('uses linear interpolation when no price data', () => {
    const trade = {
      entry_price: 0.40,
      exit_price: 0.60,
      entry_timestamp: 0,
      exit_timestamp: 10000,
      size: 100,
      pnl: 20,
      market_id: 'mkt_1',
      token_id: 'tok_1',
    };

    // No price data → uses linear interpolation
    // 5s delay = 50% through, interpolated price = 0.40 + 0.5 * 0.20 = 0.50
    // PnL = (0.60 - 0.50) * 100 = 10
    const result = computeDelayedPnl(trade, 5, new Map());
    expect(result).toBeCloseTo(10, 2);
  });
});

// ---------------------------------------------------------------------------
// estimateEdgeHalflife
// ---------------------------------------------------------------------------

describe('estimateEdgeHalflife', () => {
  it('estimates halflife from decaying curve', () => {
    const buckets: DelayBucketResult[] = [
      { delay_seconds: 1, mean_pnl: 10, ci_low: 8, ci_high: 12, t_statistic: 3, p_value: 0.01, n_trades: 50, win_rate: 0.7, information_ratio: 1, significantly_positive: true },
      { delay_seconds: 5, mean_pnl: 7, ci_low: 5, ci_high: 9, t_statistic: 2, p_value: 0.02, n_trades: 50, win_rate: 0.6, information_ratio: 0.7, significantly_positive: true },
      { delay_seconds: 10, mean_pnl: 4, ci_low: 2, ci_high: 6, t_statistic: 1.5, p_value: 0.06, n_trades: 50, win_rate: 0.55, information_ratio: 0.4, significantly_positive: false },
      { delay_seconds: 30, mean_pnl: 1, ci_low: -1, ci_high: 3, t_statistic: 0.5, p_value: 0.3, n_trades: 50, win_rate: 0.5, information_ratio: 0.1, significantly_positive: false },
    ];

    const halflife = estimateEdgeHalflife(buckets);
    expect(halflife).not.toBeNull();
    // Half of 10 = 5. PnL goes from 10 → 7 → 4, so halflife is between 5 and 10
    expect(halflife!).toBeGreaterThan(4);
    expect(halflife!).toBeLessThan(11);
  });

  it('returns null for non-positive initial edge', () => {
    const buckets: DelayBucketResult[] = [
      { delay_seconds: 1, mean_pnl: -2, ci_low: -4, ci_high: 0, t_statistic: -1, p_value: 0.8, n_trades: 50, win_rate: 0.4, information_ratio: -0.2, significantly_positive: false },
    ];

    expect(estimateEdgeHalflife(buckets)).toBeNull();
  });

  it('returns null if edge never decays to 50%', () => {
    const buckets: DelayBucketResult[] = [
      { delay_seconds: 1, mean_pnl: 10, ci_low: 8, ci_high: 12, t_statistic: 3, p_value: 0.01, n_trades: 50, win_rate: 0.7, information_ratio: 1, significantly_positive: true },
      { delay_seconds: 60, mean_pnl: 8, ci_low: 6, ci_high: 10, t_statistic: 2.5, p_value: 0.01, n_trades: 50, win_rate: 0.65, information_ratio: 0.8, significantly_positive: true },
    ];

    // Edge only decays from 10 → 8, not to 5 → no halflife
    expect(estimateEdgeHalflife(buckets)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// estimateBreakevenDelay
// ---------------------------------------------------------------------------

describe('estimateBreakevenDelay', () => {
  it('estimates breakeven delay', () => {
    const buckets: DelayBucketResult[] = [
      { delay_seconds: 1, mean_pnl: 10, ci_low: 8, ci_high: 12, t_statistic: 3, p_value: 0.01, n_trades: 50, win_rate: 0.7, information_ratio: 1, significantly_positive: true },
      { delay_seconds: 5, mean_pnl: 5, ci_low: 3, ci_high: 7, t_statistic: 2, p_value: 0.02, n_trades: 50, win_rate: 0.6, information_ratio: 0.5, significantly_positive: true },
      { delay_seconds: 10, mean_pnl: -2, ci_low: -4, ci_high: 0, t_statistic: -1, p_value: 0.8, n_trades: 50, win_rate: 0.4, information_ratio: -0.2, significantly_positive: false },
    ];

    const breakeven = estimateBreakevenDelay(buckets);
    expect(breakeven).not.toBeNull();
    // PnL goes from 5 → -2 between 5s and 10s, so breakeven is ~5 + 5*(5/7) ≈ 8.6
    expect(breakeven!).toBeGreaterThan(5);
    expect(breakeven!).toBeLessThan(10);
  });

  it('returns 0 for initially negative edge', () => {
    const buckets: DelayBucketResult[] = [
      { delay_seconds: 1, mean_pnl: -5, ci_low: -7, ci_high: -3, t_statistic: -2, p_value: 0.95, n_trades: 50, win_rate: 0.3, information_ratio: -0.5, significantly_positive: false },
    ];

    expect(estimateBreakevenDelay(buckets)).toBe(0);
  });

  it('returns null if edge never reaches zero', () => {
    const buckets: DelayBucketResult[] = [
      { delay_seconds: 1, mean_pnl: 10, ci_low: 8, ci_high: 12, t_statistic: 3, p_value: 0.01, n_trades: 50, win_rate: 0.7, information_ratio: 1, significantly_positive: true },
      { delay_seconds: 60, mean_pnl: 5, ci_low: 3, ci_high: 7, t_statistic: 2, p_value: 0.02, n_trades: 50, win_rate: 0.6, information_ratio: 0.5, significantly_positive: true },
    ];

    expect(estimateBreakevenDelay(buckets)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeWalletDelayCurve — full integration
// ---------------------------------------------------------------------------

describe('computeWalletDelayCurve', () => {
  it('returns curve with all delay buckets', () => {
    const t0 = 100_000;
    const trades: WalletTransaction[] = [];

    // 20 profitable trades with enough duration for delay simulation
    for (let i = 0; i < 20; i++) {
      trades.push(makeTx({
        side: 'BUY', price: 0.40, size: 100,
        timestamp: t0 + i * 200_000,
      }));
      trades.push(makeTx({
        side: 'SELL', price: 0.55, size: 100,
        timestamp: t0 + i * 200_000 + 120_000, // 120s hold
      }));
    }

    const ws = buildWallet(trades);

    // Build price data: price gradually moves from entry to exit
    const priceData = new Map<string, PriceTimeseries>();
    const prices: { timestamp: number; mid_price: number }[] = [];
    for (let i = 0; i < 20; i++) {
      const base = t0 + i * 200_000;
      for (let s = 0; s <= 120; s += 2) {
        // Linear price movement from 0.40 to 0.55 over 120s
        const price = 0.40 + (0.55 - 0.40) * (s / 120);
        prices.push({ timestamp: base + s * 1000, mid_price: price });
      }
    }
    priceData.set('mkt_1:tok_yes_1', {
      market_id: 'mkt_1',
      token_id: 'tok_yes_1',
      prices,
    });

    const curve = computeWalletDelayCurve(ws, priceData, [1, 5, 10, 30, 60]);

    expect(curve.address).toBe('0xabc123');
    expect(curve.delay_buckets).toHaveLength(5);

    // Each bucket should have data
    for (const bucket of curve.delay_buckets) {
      expect(bucket.n_trades).toBeGreaterThan(0);
      expect(typeof bucket.mean_pnl).toBe('number');
      expect(typeof bucket.t_statistic).toBe('number');
      expect(typeof bucket.information_ratio).toBe('number');
    }

    // PnL should decrease with delay (since price moves linearly toward exit)
    expect(curve.delay_buckets[0]!.mean_pnl).toBeGreaterThan(curve.delay_buckets[4]!.mean_pnl);
  });

  it('returns empty results for wallet with no matched trades', () => {
    const ws = buildWallet([makeTx({ side: 'BUY', price: 0.50, size: 100 })]);
    const curve = computeWalletDelayCurve(ws, new Map());

    expect(curve.delay_buckets).toHaveLength(10); // default 10 buckets
    for (const bucket of curve.delay_buckets) {
      expect(bucket.n_trades).toBe(0);
    }
    expect(curve.optimal_delay_seconds).toBeNull();
    expect(curve.followable_at_latency).toBe(false);
  });

  it('computes recommendation as follow for strongly profitable wallet', () => {
    const t0 = 100_000;
    const trades: WalletTransaction[] = [];

    // 50 strongly profitable trades with long hold times
    for (let i = 0; i < 50; i++) {
      trades.push(makeTx({
        side: 'BUY', price: 0.30, size: 100,
        timestamp: t0 + i * 200_000,
      }));
      trades.push(makeTx({
        side: 'SELL', price: 0.70, size: 100,
        timestamp: t0 + i * 200_000 + 120_000,
      }));
    }

    const ws = buildWallet(trades);

    // Price data with slow drift
    const priceData = new Map<string, PriceTimeseries>();
    const prices: { timestamp: number; mid_price: number }[] = [];
    for (let i = 0; i < 50; i++) {
      const base = t0 + i * 200_000;
      for (let s = 0; s <= 120; s += 2) {
        const price = 0.30 + (0.70 - 0.30) * (s / 120);
        prices.push({ timestamp: base + s * 1000, mid_price: price });
      }
    }
    priceData.set('mkt_1:tok_yes_1', {
      market_id: 'mkt_1',
      token_id: 'tok_yes_1',
      prices,
    });

    const curve = computeWalletDelayCurve(ws, priceData, [1, 3, 5, 10], 3);

    // With such strong edge, should be followable even at 3s delay
    expect(curve.recommendation).toBe('follow');
    expect(curve.followable_at_latency).toBe(true);
    expect(curve.optimal_delay_seconds).not.toBeNull();
  });

  it('detects edge halflife and breakeven', () => {
    const t0 = 100_000;
    const trades: WalletTransaction[] = [];

    // 30 trades with relatively short hold — edge decays fast
    for (let i = 0; i < 30; i++) {
      trades.push(makeTx({
        side: 'BUY', price: 0.40, size: 100,
        timestamp: t0 + i * 100_000,
      }));
      trades.push(makeTx({
        side: 'SELL', price: 0.50, size: 100,
        timestamp: t0 + i * 100_000 + 30_000, // 30s hold
      }));
    }

    const ws = buildWallet(trades);

    // Price rises quickly then plateaus near exit
    const priceData = new Map<string, PriceTimeseries>();
    const prices: { timestamp: number; mid_price: number }[] = [];
    for (let i = 0; i < 30; i++) {
      const base = t0 + i * 100_000;
      // Price rises exponentially fast
      for (let s = 0; s <= 30; s++) {
        const fraction = s / 30;
        // Exponential rise: price reaches 90% of final value in first 10s
        const price = 0.40 + 0.10 * (1 - Math.exp(-fraction * 5));
        prices.push({ timestamp: base + s * 1000, mid_price: price });
      }
    }
    priceData.set('mkt_1:tok_yes_1', {
      market_id: 'mkt_1',
      token_id: 'tok_yes_1',
      prices,
    });

    const curve = computeWalletDelayCurve(ws, priceData, [1, 2, 3, 5, 7, 10, 15, 20]);

    // Edge should decrease with delay
    if (curve.delay_buckets[0]!.n_trades > 0 && curve.delay_buckets[5]!.n_trades > 0) {
      expect(curve.delay_buckets[0]!.mean_pnl).toBeGreaterThanOrEqual(
        curve.delay_buckets[5]!.mean_pnl,
      );
    }
  });

  it('handles custom delay buckets', () => {
    const ws = buildWallet([]);
    const curve = computeWalletDelayCurve(ws, new Map(), [2, 4, 8, 16]);
    expect(curve.delay_buckets).toHaveLength(4);
    expect(curve.delay_buckets[0]!.delay_seconds).toBe(2);
    expect(curve.delay_buckets[3]!.delay_seconds).toBe(16);
  });

  it('returns ignore for wallet with no edge', () => {
    const t0 = 100_000;
    const trades: WalletTransaction[] = [];

    // Alternating win/loss → no net edge
    for (let i = 0; i < 30; i++) {
      const isWin = i % 2 === 0;
      trades.push(makeTx({
        side: 'BUY', price: isWin ? 0.40 : 0.60, size: 100,
        timestamp: t0 + i * 200_000,
      }));
      trades.push(makeTx({
        side: 'SELL', price: isWin ? 0.60 : 0.40, size: 100,
        timestamp: t0 + i * 200_000 + 60_000,
      }));
    }

    const ws = buildWallet(trades);
    const curve = computeWalletDelayCurve(ws, new Map(), [1, 5, 10]);

    // Should not recommend follow
    expect(curve.recommendation).not.toBe('follow');
  });
});

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

describe('computeAllDelayCurves', () => {
  it('computes curves for multiple wallets', () => {
    const w1 = buildWallet([], '0xabc');
    const w2 = buildWallet([], '0xdef');

    const curves = computeAllDelayCurves([w1, w2], new Map());
    expect(curves).toHaveLength(2);
    expect(curves[0]!.address).toBe('0xabc');
    expect(curves[1]!.address).toBe('0xdef');
  });
});
