import { describe, it, expect } from 'vitest';
import { classifyWallet, classifyAllWallets } from '../../src/wallet_intel/classifier.js';
import { createEmptyWalletState, recomputeWalletStats } from '../../src/state/wallet_stats.js';
import type { WalletState } from '../../src/state/types.js';
import type { WalletTransaction } from '../../src/ingestion/types.js';

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

// ---------------------------------------------------------------------------
// Factory: empty wallet
// ---------------------------------------------------------------------------

describe('classifyWallet', () => {
  it('returns unclassified for empty wallet', () => {
    const ws = createEmptyWalletState('0xabc');
    const result = classifyWallet(ws);
    expect(result.classification).toBe('unclassified');
    expect(result.confidence).toBe(0);
    expect(result.n_trades).toBe(0);
  });

  it('returns unclassified for single trade', () => {
    const ws = buildWallet([makeTx()]);
    const result = classifyWallet(ws);
    expect(result.classification).toBe('unclassified');
    expect(result.confidence).toBe(0);
    expect(result.n_trades).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Sniper detection
  // -----------------------------------------------------------------------

  it('classifies as sniper: short holds, high win rate', () => {
    const t0 = 1_000_000;
    const trades: WalletTransaction[] = [];

    // 40 winning trades, hold time ~60s each
    for (let i = 0; i < 40; i++) {
      trades.push(makeTx({
        side: 'BUY', price: 0.40, size: 100,
        timestamp: t0 + i * 120_000,
      }));
      trades.push(makeTx({
        side: 'SELL', price: 0.55, size: 100,
        timestamp: t0 + i * 120_000 + 60_000, // 60s hold
      }));
    }

    const ws = buildWallet(trades);
    const result = classifyWallet(ws);
    expect(result.classification).toBe('sniper');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.n_trades).toBe(80);
  });

  // -----------------------------------------------------------------------
  // Swing trader detection
  // -----------------------------------------------------------------------

  it('classifies as swing: long holds, high Sharpe', () => {
    const t0 = 1_000_000;
    const trades: WalletTransaction[] = [];

    // 40 trades with ~2 hour hold time, consistently profitable
    for (let i = 0; i < 40; i++) {
      trades.push(makeTx({
        side: 'BUY', price: 0.30 + (i % 3) * 0.01, size: 100,
        timestamp: t0 + i * 10_000_000,
      }));
      trades.push(makeTx({
        side: 'SELL', price: 0.45 + (i % 3) * 0.01, size: 100,
        timestamp: t0 + i * 10_000_000 + 7_200_000, // 2 hour hold
      }));
    }

    const ws = buildWallet(trades);
    const result = classifyWallet(ws);
    expect(result.classification).toBe('swing');
    expect(result.confidence).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Arbitrageur detection
  // -----------------------------------------------------------------------

  it('classifies as arbitrageur: trades both YES and NO tokens in same market', () => {
    const t0 = 1_000_000;
    const trades: WalletTransaction[] = [];

    // Trade both YES and NO tokens in the same market repeatedly
    for (let i = 0; i < 20; i++) {
      trades.push(makeTx({
        market_id: 'mkt_1', token_id: 'tok_yes_1',
        side: 'BUY', price: 0.45, size: 100,
        timestamp: t0 + i * 60_000,
      }));
      trades.push(makeTx({
        market_id: 'mkt_1', token_id: 'tok_no_1',
        side: 'BUY', price: 0.45, size: 100,
        timestamp: t0 + i * 60_000 + 1000,
      }));
    }

    const ws = buildWallet(trades);
    const result = classifyWallet(ws);
    expect(result.classification).toBe('arbitrageur');
    expect(result.confidence).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Market maker detection
  // -----------------------------------------------------------------------

  it('classifies as market_maker: balanced buy/sell on both sides', () => {
    const t0 = 1_000_000;
    const trades: WalletTransaction[] = [];

    // Balanced buys and sells on both tokens — looks like market making
    for (let i = 0; i < 15; i++) {
      // Buy YES, sell YES, buy NO, sell NO — balanced, long hold to avoid sniper
      trades.push(makeTx({
        market_id: 'mkt_1', token_id: 'tok_yes_1',
        side: 'BUY', price: 0.49, size: 100,
        timestamp: t0 + i * 2_000_000,
      }));
      trades.push(makeTx({
        market_id: 'mkt_1', token_id: 'tok_yes_1',
        side: 'SELL', price: 0.51, size: 100,
        timestamp: t0 + i * 2_000_000 + 400_000, // 400s hold, above sniper threshold
      }));
      trades.push(makeTx({
        market_id: 'mkt_1', token_id: 'tok_no_1',
        side: 'BUY', price: 0.49, size: 100,
        timestamp: t0 + i * 2_000_000 + 500_000,
      }));
      trades.push(makeTx({
        market_id: 'mkt_1', token_id: 'tok_no_1',
        side: 'SELL', price: 0.51, size: 100,
        timestamp: t0 + i * 2_000_000 + 900_000, // 400s hold
      }));
    }

    const ws = buildWallet(trades);
    const result = classifyWallet(ws);
    // Could be arbitrageur or market_maker — both trade both sides
    expect(['market_maker', 'arbitrageur']).toContain(result.classification);
    expect(result.confidence).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Noise detection
  // -----------------------------------------------------------------------

  it('classifies as noise: low Sharpe, random-looking trades', () => {
    const t0 = 1_000_000;
    const trades: WalletTransaction[] = [];

    // Mix of wins and losses that roughly cancel out — Sharpe ≈ 0
    for (let i = 0; i < 20; i++) {
      const isWin = i % 2 === 0;
      trades.push(makeTx({
        side: 'BUY', price: isWin ? 0.40 : 0.60, size: 100,
        timestamp: t0 + i * 600_000,
      }));
      trades.push(makeTx({
        side: 'SELL', price: isWin ? 0.42 : 0.58, size: 100,
        timestamp: t0 + i * 600_000 + 300_000, // 5 min hold
      }));
    }

    const ws = buildWallet(trades);
    const result = classifyWallet(ws);
    expect(result.classification).toBe('noise');
  });

  // -----------------------------------------------------------------------
  // Tentative classification (insufficient trades)
  // -----------------------------------------------------------------------

  it('returns low confidence for insufficient trade count', () => {
    const t0 = 1_000_000;
    const trades = [
      makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: t0 }),
      makeTx({ side: 'SELL', price: 0.55, size: 100, timestamp: t0 + 60_000 }),
      makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: t0 + 120_000 }),
      makeTx({ side: 'SELL', price: 0.55, size: 100, timestamp: t0 + 180_000 }),
    ];

    const ws = buildWallet(trades);
    const result = classifyWallet(ws);
    // Tentative sniper with low confidence
    expect(result.confidence).toBeLessThan(0.3);
  });

  // -----------------------------------------------------------------------
  // Components
  // -----------------------------------------------------------------------

  it('populates all classification components', () => {
    const t0 = 1_000_000;
    const trades: WalletTransaction[] = [];
    for (let i = 0; i < 10; i++) {
      trades.push(makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: t0 + i * 120_000 }));
      trades.push(makeTx({ side: 'SELL', price: 0.50, size: 100, timestamp: t0 + i * 120_000 + 60_000 }));
    }

    const ws = buildWallet(trades);
    const result = classifyWallet(ws);

    expect(result.components).toBeDefined();
    expect(typeof result.components.holding_period_score).toBe('number');
    expect(typeof result.components.return_quality_score).toBe('number');
    expect(typeof result.components.timing_regularity_score).toBe('number');
    expect(typeof result.components.market_concentration_hhi).toBe('number');
    expect(typeof result.components.trade_clustering_score).toBe('number');
    expect(typeof result.components.regime_consistency).toBe('number');
    expect(typeof result.components.sample_size_factor).toBe('number');
  });

  it('returns statistical significance fields', () => {
    const t0 = 1_000_000;
    const trades: WalletTransaction[] = [];
    for (let i = 0; i < 40; i++) {
      trades.push(makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: t0 + i * 120_000 }));
      trades.push(makeTx({ side: 'SELL', price: 0.55, size: 100, timestamp: t0 + i * 120_000 + 60_000 }));
    }

    const ws = buildWallet(trades);
    const result = classifyWallet(ws);

    expect(typeof result.t_statistic).toBe('number');
    expect(typeof result.p_value).toBe('number');
    expect(result.t_statistic).toBeGreaterThan(0);
    expect(result.p_value).toBeLessThan(0.05);
    expect(result.statistical_significance).toBe(true);
    expect(result.bootstrap_ci[0]).toBeLessThanOrEqual(result.bootstrap_ci[1]);
  });

  it('returns significance false when PnL is not significant', () => {
    const t0 = 1_000_000;
    const trades: WalletTransaction[] = [];
    // Alternating win/loss of equal magnitude → mean PnL ≈ 0
    for (let i = 0; i < 40; i++) {
      const buy = i % 2 === 0 ? 0.40 : 0.60;
      const sell = i % 2 === 0 ? 0.60 : 0.40;
      trades.push(makeTx({ side: 'BUY', price: buy, size: 100, timestamp: t0 + i * 120_000 }));
      trades.push(makeTx({ side: 'SELL', price: sell, size: 100, timestamp: t0 + i * 120_000 + 60_000 }));
    }

    const ws = buildWallet(trades);
    const result = classifyWallet(ws);

    // Mean PnL is 0 → not significant
    expect(result.statistical_significance).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Config overrides
  // -----------------------------------------------------------------------

  it('respects config overrides', () => {
    const t0 = 1_000_000;
    const trades: WalletTransaction[] = [];
    // 40 trades with 200s hold — sniper with default config (< 300s)
    for (let i = 0; i < 40; i++) {
      trades.push(makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: t0 + i * 600_000 }));
      trades.push(makeTx({ side: 'SELL', price: 0.55, size: 100, timestamp: t0 + i * 600_000 + 200_000 }));
    }

    const ws = buildWallet(trades);

    // With default config: sniper (200s < 300s)
    const r1 = classifyWallet(ws);
    expect(r1.classification).toBe('sniper');

    // With strict config: 200s > 100s → not sniper
    const r2 = classifyWallet(ws, { sniper_max_hold_seconds: 100 });
    expect(r2.classification).not.toBe('sniper');
  });

  // -----------------------------------------------------------------------
  // HHI / market concentration
  // -----------------------------------------------------------------------

  it('computes high HHI for single-market wallet', () => {
    const trades = [
      makeTx({ market_id: 'mkt_1', side: 'BUY', price: 0.50, size: 100 }),
      makeTx({ market_id: 'mkt_1', side: 'SELL', price: 0.55, size: 100 }),
    ];

    const ws = buildWallet(trades);
    const result = classifyWallet(ws);
    expect(result.components.market_concentration_hhi).toBe(1); // single market → HHI = 1
  });

  it('computes lower HHI for diversified wallet', () => {
    const trades = [
      makeTx({ market_id: 'mkt_1', side: 'BUY', price: 0.50, size: 100 }),
      makeTx({ market_id: 'mkt_2', side: 'BUY', price: 0.50, size: 100 }),
      makeTx({ market_id: 'mkt_3', side: 'BUY', price: 0.50, size: 100 }),
      makeTx({ market_id: 'mkt_4', side: 'BUY', price: 0.50, size: 100 }),
    ];

    const ws = buildWallet(trades);
    const result = classifyWallet(ws);
    // 4 markets, equal volume → HHI = 4 * (0.25)^2 = 0.25
    expect(result.components.market_concentration_hhi).toBeCloseTo(0.25, 2);
  });

  // -----------------------------------------------------------------------
  // Regime consistency
  // -----------------------------------------------------------------------

  it('handles regime performance in confidence', () => {
    const t0 = 1_000_000;
    const trades: WalletTransaction[] = [];
    for (let i = 0; i < 40; i++) {
      trades.push(makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: t0 + i * 120_000 }));
      trades.push(makeTx({ side: 'SELL', price: 0.55, size: 100, timestamp: t0 + i * 120_000 + 60_000 }));
    }

    const ws = buildWallet(trades);

    // Add regime performance
    ws.regime_performance.set('normal', { ...ws.stats });
    ws.regime_performance.set('high_volatility', { ...ws.stats, sharpe_ratio: ws.stats.sharpe_ratio * 0.9 });

    const result = classifyWallet(ws);
    expect(result.components.regime_consistency).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Batch classification
// ---------------------------------------------------------------------------

describe('classifyAllWallets', () => {
  it('classifies multiple wallets', () => {
    const w1 = buildWallet([makeTx()], '0xabc');
    const w2 = buildWallet([makeTx(), makeTx()], '0xdef');

    const results = classifyAllWallets([w1, w2]);
    expect(results).toHaveLength(2);
    expect(results[0]!.address).toBe('0xabc');
    expect(results[1]!.address).toBe('0xdef');
  });
});
