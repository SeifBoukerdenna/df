import { describe, it, expect } from 'vitest';
import { scoreWallet, scoreAllWallets } from '../../src/wallet_intel/scorer.js';
import { createEmptyWalletState, recomputeWalletStats } from '../../src/state/wallet_stats.js';
import type { WalletState } from '../../src/state/types.js';
import type { WalletTransaction } from '../../src/ingestion/types.js';
import type {
  ClassificationResult,
  WalletDelayCurve,
  WalletRegimeProfile,
  DelayBucketResult,
} from '../../src/wallet_intel/types.js';

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
    timestamp: Date.now() - 3600_000, // 1 hour ago by default
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

function makeBucket(overrides: Partial<DelayBucketResult> = {}): DelayBucketResult {
  return {
    delay_seconds: 3,
    mean_pnl: 5,
    ci_low: 2,
    ci_high: 8,
    t_statistic: 2.5,
    p_value: 0.01,
    n_trades: 50,
    win_rate: 0.65,
    information_ratio: 0.8,
    significantly_positive: true,
    ...overrides,
  };
}

function makeDelayCurve(overrides: Partial<WalletDelayCurve> = {}): WalletDelayCurve {
  return {
    address: '0xabc123',
    label: '0xabc123de',
    classification: 'sniper',
    delay_buckets: [
      makeBucket({ delay_seconds: 1, mean_pnl: 10, information_ratio: 1.5 }),
      makeBucket({ delay_seconds: 3, mean_pnl: 7, information_ratio: 1.0 }),
      makeBucket({ delay_seconds: 5, mean_pnl: 4, information_ratio: 0.5 }),
      makeBucket({ delay_seconds: 10, mean_pnl: 1, information_ratio: 0.1, significantly_positive: false }),
    ],
    optimal_delay_seconds: 1,
    edge_halflife_seconds: 5,
    breakeven_delay_seconds: 12,
    followable_at_latency: true,
    recommendation: 'follow',
    ...overrides,
  };
}

function makeClassification(overrides: Partial<ClassificationResult> = {}): ClassificationResult {
  return {
    address: '0xabc123',
    classification: 'sniper',
    confidence: 0.8,
    components: {
      holding_period_score: 60,
      return_quality_score: 0.7,
      timing_regularity_score: 0.5,
      market_concentration_hhi: 0.4,
      trade_clustering_score: 0.3,
      regime_consistency: 0.7,
      sample_size_factor: 1.0,
    },
    statistical_significance: true,
    t_statistic: 3.0,
    p_value: 0.002,
    n_trades: 50,
    bootstrap_ci: [3, 8],
    ...overrides,
  };
}

function makeRegimeProfile(overrides: Partial<WalletRegimeProfile> = {}): WalletRegimeProfile {
  return {
    address: '0xabc123',
    label: '0xabc123de',
    regime_entries: [
      {
        regime: 'normal',
        stats: recomputeWalletStats([]),
        n_trades: 30,
        sharpe: 1.2,
        win_rate: 0.65,
        pnl_realized: 100,
        is_significant: true,
        t_statistic: 2.5,
        p_value: 0.01,
      },
      {
        regime: 'high_volatility',
        stats: recomputeWalletStats([]),
        n_trades: 20,
        sharpe: 0.8,
        win_rate: 0.6,
        pnl_realized: 40,
        is_significant: true,
        t_statistic: 1.8,
        p_value: 0.04,
      },
    ],
    best_regime: 'normal',
    worst_regime: 'high_volatility',
    regime_sensitive: false,
    robustness_score: 0.8,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scoreWallet', () => {
  it('returns zero score for empty wallet', () => {
    const ws = createEmptyWalletState('0xabc');
    const result = scoreWallet({
      wallet: ws,
      classification: null,
      delayCurve: null,
      regimeProfile: null,
    });

    // Regime robustness defaults to 0.5 when no profile → 0.5 * 0.10 = 0.05
    expect(result.overall_score).toBeCloseTo(0.05, 2);
    expect(result.recommendation).toBe('ignore');
    expect(result.follow_parameters).toBeNull();
  });

  it('computes weighted score with all inputs', () => {
    const t0 = Date.now() - 86400_000;
    const trades: WalletTransaction[] = [];
    for (let i = 0; i < 50; i++) {
      trades.push(makeTx({
        side: 'BUY', price: 0.40, size: 100,
        timestamp: t0 + i * 120_000,
      }));
      trades.push(makeTx({
        side: 'SELL', price: 0.55, size: 100,
        timestamp: t0 + i * 120_000 + 60_000,
      }));
    }

    const ws = buildWallet(trades);
    const result = scoreWallet({
      wallet: ws,
      classification: makeClassification(),
      delayCurve: makeDelayCurve(),
      regimeProfile: makeRegimeProfile(),
      nowMs: Date.now(),
    });

    expect(result.overall_score).toBeGreaterThan(0);
    expect(result.address).toBe('0xabc123');
    expect(result.components.delayed_profitability).toBeGreaterThan(0);
    expect(result.components.consistency).toBeGreaterThan(0);
    expect(result.components.statistical_significance).toBeGreaterThan(0);
    expect(result.components.raw_profitability).toBeGreaterThan(0);
    expect(result.components.regime_robustness).toBeGreaterThan(0);
    expect(result.components.sample_size).toBeGreaterThan(0);
    expect(result.components.recency).toBeGreaterThan(0);
  });

  it('weights delayed_profitability highest (0.35)', () => {
    const t0 = Date.now() - 86400_000;
    const trades: WalletTransaction[] = [];
    for (let i = 0; i < 50; i++) {
      trades.push(makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: t0 + i * 120_000 }));
      trades.push(makeTx({ side: 'SELL', price: 0.55, size: 100, timestamp: t0 + i * 120_000 + 60_000 }));
    }
    const ws = buildWallet(trades);

    // Score with strong delay curve
    const strong = scoreWallet({
      wallet: ws,
      classification: makeClassification(),
      delayCurve: makeDelayCurve(),
      regimeProfile: null,
      nowMs: Date.now(),
    });

    // Score with no delay curve
    const weak = scoreWallet({
      wallet: ws,
      classification: makeClassification(),
      delayCurve: null,
      regimeProfile: null,
      nowMs: Date.now(),
    });

    // Strong delay curve should boost score significantly
    expect(strong.overall_score).toBeGreaterThan(weak.overall_score);
    expect(strong.overall_score - weak.overall_score).toBeGreaterThan(0.1);
  });

  it('recommends follow for high-scoring wallet', () => {
    const t0 = Date.now() - 3600_000;
    const trades: WalletTransaction[] = [];
    for (let i = 0; i < 50; i++) {
      trades.push(makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: t0 + i * 60_000 }));
      trades.push(makeTx({ side: 'SELL', price: 0.55, size: 100, timestamp: t0 + i * 60_000 + 30_000 }));
    }
    const ws = buildWallet(trades);

    const result = scoreWallet({
      wallet: ws,
      classification: makeClassification({ t_statistic: 4.0 }),
      delayCurve: makeDelayCurve({ recommendation: 'follow' }),
      regimeProfile: makeRegimeProfile({ robustness_score: 0.9 }),
      nowMs: Date.now(),
    });

    expect(result.recommendation).toBe('follow');
    expect(result.follow_parameters).not.toBeNull();
  });

  it('provides follow_parameters for follow recommendation', () => {
    const t0 = Date.now() - 3600_000;
    const trades: WalletTransaction[] = [];
    for (let i = 0; i < 50; i++) {
      trades.push(makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: t0 + i * 60_000 }));
      trades.push(makeTx({ side: 'SELL', price: 0.55, size: 100, timestamp: t0 + i * 60_000 + 30_000 }));
    }
    const ws = buildWallet(trades);

    const result = scoreWallet({
      wallet: ws,
      classification: makeClassification({ t_statistic: 4.0 }),
      delayCurve: makeDelayCurve({ recommendation: 'follow', optimal_delay_seconds: 3 }),
      regimeProfile: makeRegimeProfile({ robustness_score: 0.9 }),
      totalCapital: 10_000,
      nowMs: Date.now(),
    });

    expect(result.follow_parameters).not.toBeNull();
    const params = result.follow_parameters!;
    expect(params.optimal_delay_ms).toBe(3000);
    expect(params.min_trade_size_to_follow).toBeGreaterThan(0);
    expect(params.max_allocation_per_follow).toBeGreaterThan(0);
    expect(params.max_allocation_per_follow).toBeLessThanOrEqual(10_000);
    expect(params.allowed_market_types.length).toBeGreaterThan(0);
    expect(params.confidence_interval_90).toBeDefined();
  });

  it('recommends ignore for low-scoring wallet', () => {
    const ws = buildWallet([
      makeTx({ side: 'BUY', price: 0.50, size: 10, timestamp: Date.now() - 86400_000 * 60 }),
      makeTx({ side: 'SELL', price: 0.48, size: 10, timestamp: Date.now() - 86400_000 * 59 }),
    ]);

    const result = scoreWallet({
      wallet: ws,
      classification: makeClassification({
        t_statistic: -0.5,
        p_value: 0.7,
        statistical_significance: false,
      }),
      delayCurve: makeDelayCurve({
        recommendation: 'ignore',
        delay_buckets: [
          makeBucket({ mean_pnl: -2, information_ratio: -0.3, significantly_positive: false, n_trades: 3 }),
        ],
      }),
      regimeProfile: makeRegimeProfile({ robustness_score: 0 }),
      nowMs: Date.now(),
    });

    expect(result.overall_score).toBeLessThan(0.35);
    expect(result.follow_parameters).toBeNull();
  });

  it('recommends fade for significantly negative delayed PnL', () => {
    const ws = buildWallet([
      makeTx({ side: 'BUY', price: 0.60, size: 100 }),
      makeTx({ side: 'SELL', price: 0.40, size: 100 }),
    ]);

    const result = scoreWallet({
      wallet: ws,
      classification: makeClassification({
        t_statistic: -2.0,
        p_value: 0.95,
        statistical_significance: false,
      }),
      delayCurve: makeDelayCurve({
        recommendation: 'fade',
        delay_buckets: [
          makeBucket({ mean_pnl: -5, t_statistic: -2.5, information_ratio: -0.8, significantly_positive: false }),
        ],
      }),
      regimeProfile: null,
      nowMs: Date.now(),
    });

    expect(result.recommendation).toBe('fade');
    expect(result.follow_parameters).toBeNull();
  });

  it('recency score decays over time', () => {
    const recentWs = buildWallet([
      makeTx({ timestamp: Date.now() - 3600_000 }), // 1 hour ago
      makeTx({ timestamp: Date.now() - 1800_000 }),
    ]);
    const staleWs = buildWallet([
      makeTx({ timestamp: Date.now() - 86400_000 * 25 }), // 25 days ago
      makeTx({ timestamp: Date.now() - 86400_000 * 24 }),
    ]);

    const recent = scoreWallet({ wallet: recentWs, classification: null, delayCurve: null, regimeProfile: null, nowMs: Date.now() });
    const stale = scoreWallet({ wallet: staleWs, classification: null, delayCurve: null, regimeProfile: null, nowMs: Date.now() });

    expect(recent.components.recency).toBeGreaterThan(stale.components.recency);
  });

  it('sample size score ramps linearly', () => {
    const smallWs = buildWallet([makeTx(), makeTx()]);
    const largeWs = buildWallet(Array.from({ length: 60 }, () => makeTx()));

    const small = scoreWallet({ wallet: smallWs, classification: null, delayCurve: null, regimeProfile: null });
    const large = scoreWallet({ wallet: largeWs, classification: null, delayCurve: null, regimeProfile: null });

    expect(small.components.sample_size).toBeLessThan(large.components.sample_size);
    expect(large.components.sample_size).toBe(1); // 60 >= 30 min required
  });

  it('regime robustness uses profile score', () => {
    const ws = buildWallet([makeTx(), makeTx()]);

    const robust = scoreWallet({
      wallet: ws, classification: null, delayCurve: null,
      regimeProfile: makeRegimeProfile({ robustness_score: 0.9 }),
    });
    const fragile = scoreWallet({
      wallet: ws, classification: null, delayCurve: null,
      regimeProfile: makeRegimeProfile({ robustness_score: 0.1 }),
    });

    expect(robust.components.regime_robustness).toBeGreaterThan(fragile.components.regime_robustness);
  });

  it('defaults regime robustness to 0.5 when no profile', () => {
    const ws = buildWallet([makeTx(), makeTx()]);
    const result = scoreWallet({ wallet: ws, classification: null, delayCurve: null, regimeProfile: null });
    expect(result.components.regime_robustness).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Batch scoring
// ---------------------------------------------------------------------------

describe('scoreAllWallets', () => {
  it('scores multiple wallets', () => {
    const w1 = buildWallet([makeTx()], '0xabc');
    const w2 = buildWallet([makeTx()], '0xdef');

    const results = scoreAllWallets([
      { wallet: w1, classification: null, delayCurve: null, regimeProfile: null },
      { wallet: w2, classification: null, delayCurve: null, regimeProfile: null },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0]!.address).toBe('0xabc');
    expect(results[1]!.address).toBe('0xdef');
  });
});
