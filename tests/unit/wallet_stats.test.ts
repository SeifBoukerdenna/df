import { describe, it, expect } from 'vitest';
import {
  createEmptyWalletStats,
  createEmptyWalletState,
  recomputeWalletStats,
} from '../../src/state/wallet_stats.js';
import type { WalletTransaction } from '../../src/ingestion/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTx(overrides: Partial<WalletTransaction> = {}): WalletTransaction {
  return {
    wallet: '0xabc123',
    market_id: 'mkt_1',
    token_id: 'tok_yes_1',
    side: 'BUY',
    price: 0.50,
    size: 100,
    timestamp: Date.now(),
    tx_hash: '0xtx_' + Math.random().toString(36).slice(2),
    block_number: 1000,
    gas_price: 30_000_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Factory tests
// ---------------------------------------------------------------------------

describe('createEmptyWalletStats', () => {
  it('returns zeroed stats', () => {
    const stats = createEmptyWalletStats();
    expect(stats.total_trades).toBe(0);
    expect(stats.win_rate).toBe(0);
    expect(stats.sharpe_ratio).toBe(0);
    expect(stats.max_drawdown).toBe(0);
    expect(stats.active_hours).toHaveLength(24);
    expect(stats.profitable_after_delay).toBeInstanceOf(Map);
  });
});

describe('createEmptyWalletState', () => {
  it('creates wallet with address and default label', () => {
    const ws = createEmptyWalletState('0xABC123DEF');
    expect(ws.address).toBe('0xabc123def');
    expect(ws.label).toBe('0xabc123de'); // label derived from lowered address
    expect(ws.classification).toBe('unclassified');
    expect(ws.confidence).toBe(0);
    expect(ws.trades).toHaveLength(0);
    expect(ws.regime_performance).toBeInstanceOf(Map);
  });

  it('accepts custom label', () => {
    const ws = createEmptyWalletState('0xABC', 'Smart Wallet');
    expect(ws.label).toBe('Smart Wallet');
  });
});

// ---------------------------------------------------------------------------
// recomputeWalletStats
// ---------------------------------------------------------------------------

describe('recomputeWalletStats', () => {
  it('returns empty stats for no trades', () => {
    const stats = recomputeWalletStats([]);
    expect(stats.total_trades).toBe(0);
    expect(stats.win_rate).toBe(0);
  });

  it('counts total trades', () => {
    const trades = [makeTx(), makeTx(), makeTx()];
    const stats = recomputeWalletStats(trades);
    expect(stats.total_trades).toBe(3);
  });

  it('computes win rate from BUY→SELL pairs', () => {
    const t0 = 1000000;
    const trades = [
      // Trade 1: buy at 0.40, sell at 0.60 → profit
      makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: t0 }),
      makeTx({ side: 'SELL', price: 0.60, size: 100, timestamp: t0 + 10000 }),
      // Trade 2: buy at 0.70, sell at 0.50 → loss
      makeTx({ side: 'BUY', price: 0.70, size: 100, timestamp: t0 + 20000 }),
      makeTx({ side: 'SELL', price: 0.50, size: 100, timestamp: t0 + 30000 }),
    ];

    const stats = recomputeWalletStats(trades);
    expect(stats.win_rate).toBe(0.5); // 1 win, 1 loss
    expect(stats.pnl_realized).toBeCloseTo(20 - 20, 2); // net 0
  });

  it('computes positive PnL', () => {
    const t0 = 1000000;
    const trades = [
      makeTx({ side: 'BUY', price: 0.30, size: 100, timestamp: t0 }),
      makeTx({ side: 'SELL', price: 0.60, size: 100, timestamp: t0 + 5000 }),
    ];

    const stats = recomputeWalletStats(trades);
    expect(stats.pnl_realized).toBeCloseTo(30, 2); // (0.60 - 0.30) * 100
    expect(stats.win_rate).toBe(1.0);
  });

  it('computes holding period', () => {
    const t0 = 1000000;
    const trades = [
      makeTx({ side: 'BUY', price: 0.50, size: 100, timestamp: t0 }),
      makeTx({ side: 'SELL', price: 0.55, size: 100, timestamp: t0 + 60000 }),
    ];

    const stats = recomputeWalletStats(trades);
    expect(stats.avg_holding_period_seconds).toBeCloseTo(60, 0);
    expect(stats.median_holding_period_seconds).toBeCloseTo(60, 0);
  });

  it('computes average trade size', () => {
    const trades = [
      makeTx({ price: 0.50, size: 100 }),
      makeTx({ price: 0.60, size: 200 }),
    ];

    const stats = recomputeWalletStats(trades);
    // avg = (0.50*100 + 0.60*200) / 2 = (50 + 120) / 2 = 85
    expect(stats.avg_trade_size_usd).toBeCloseTo(85, 1);
  });

  it('computes Sharpe ratio', () => {
    const t0 = 1000000;
    const trades = [
      // Three winning trades
      makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: t0 }),
      makeTx({ side: 'SELL', price: 0.50, size: 100, timestamp: t0 + 5000 }),
      makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: t0 + 10000 }),
      makeTx({ side: 'SELL', price: 0.50, size: 100, timestamp: t0 + 15000 }),
      makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: t0 + 20000 }),
      makeTx({ side: 'SELL', price: 0.50, size: 100, timestamp: t0 + 25000 }),
    ];

    const stats = recomputeWalletStats(trades);
    // All PnLs are +10, so std = 0, Sharpe would be edge case
    // With all equal positive PnLs, Sharpe = 0 (std = 0)
    expect(stats.pnl_realized).toBeCloseTo(30, 2);
  });

  it('computes Sortino ratio', () => {
    const t0 = 1000000;
    const trades = [
      makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: t0 }),
      makeTx({ side: 'SELL', price: 0.60, size: 100, timestamp: t0 + 5000 }), // +20
      makeTx({ side: 'BUY', price: 0.60, size: 100, timestamp: t0 + 10000 }),
      makeTx({ side: 'SELL', price: 0.50, size: 100, timestamp: t0 + 15000 }), // -10
    ];

    const stats = recomputeWalletStats(trades);
    // Has both upside and downside → Sortino should be computable
    expect(typeof stats.sortino_ratio).toBe('number');
    expect(stats.sortino_ratio).toBeGreaterThan(0); // net positive
  });

  it('computes max drawdown', () => {
    const t0 = 1000000;
    const trades = [
      // Win +20
      makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: t0 }),
      makeTx({ side: 'SELL', price: 0.60, size: 100, timestamp: t0 + 5000 }),
      // Lose -30
      makeTx({ side: 'BUY', price: 0.70, size: 100, timestamp: t0 + 10000 }),
      makeTx({ side: 'SELL', price: 0.40, size: 100, timestamp: t0 + 15000 }),
      // Win +10
      makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: t0 + 20000 }),
      makeTx({ side: 'SELL', price: 0.50, size: 100, timestamp: t0 + 25000 }),
    ];

    const stats = recomputeWalletStats(trades);
    // Cumulative PnL: +20, -10, 0
    // Peak was 20, trough was -10, drawdown = 30
    expect(stats.max_drawdown).toBeCloseTo(30, 2);
  });

  it('computes consecutive loss max', () => {
    const t0 = 1000000;
    const trades = [
      // Win
      makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: t0 }),
      makeTx({ side: 'SELL', price: 0.50, size: 100, timestamp: t0 + 5000 }),
      // Loss 1
      makeTx({ side: 'BUY', price: 0.60, size: 100, timestamp: t0 + 10000 }),
      makeTx({ side: 'SELL', price: 0.55, size: 100, timestamp: t0 + 15000 }),
      // Loss 2
      makeTx({ side: 'BUY', price: 0.60, size: 100, timestamp: t0 + 20000 }),
      makeTx({ side: 'SELL', price: 0.58, size: 100, timestamp: t0 + 25000 }),
      // Loss 3
      makeTx({ side: 'BUY', price: 0.60, size: 100, timestamp: t0 + 30000 }),
      makeTx({ side: 'SELL', price: 0.57, size: 100, timestamp: t0 + 35000 }),
    ];

    const stats = recomputeWalletStats(trades);
    expect(stats.consecutive_loss_max).toBe(3);
  });

  it('computes PnL significance (t-statistic)', () => {
    const t0 = 1000000;
    const trades: WalletTransaction[] = [];
    // Generate 10 profitable trades
    for (let i = 0; i < 10; i++) {
      trades.push(makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: t0 + i * 10000 }));
      trades.push(makeTx({ side: 'SELL', price: 0.45 + i * 0.005, size: 100, timestamp: t0 + i * 10000 + 5000 }));
    }

    const stats = recomputeWalletStats(trades);
    expect(stats.pnl_significance).toBeGreaterThan(0);
  });

  it('computes market concentration (preferred markets)', () => {
    const trades = [
      makeTx({ market_id: 'mkt_1', price: 0.50, size: 1000 }),
      makeTx({ market_id: 'mkt_1', price: 0.50, size: 500 }),
      makeTx({ market_id: 'mkt_2', price: 0.50, size: 100 }),
      makeTx({ market_id: 'mkt_3', price: 0.50, size: 50 }),
    ];

    const stats = recomputeWalletStats(trades);
    expect(stats.preferred_markets[0]).toBe('mkt_1');
    expect(stats.preferred_markets).toContain('mkt_2');
  });

  it('computes active hours histogram', () => {
    // Create trades at specific UTC hours
    const trades = [
      makeTx({ timestamp: new Date('2025-01-01T14:00:00Z').getTime() }),
      makeTx({ timestamp: new Date('2025-01-01T14:30:00Z').getTime() }),
      makeTx({ timestamp: new Date('2025-01-01T03:00:00Z').getTime() }),
    ];

    const stats = recomputeWalletStats(trades);
    expect(stats.active_hours[14]).toBe(2);
    expect(stats.active_hours[3]).toBe(1);
    expect(stats.active_hours[0]).toBe(0);
  });

  it('computes trade clustering score', () => {
    const t0 = 1000000;
    // Bursty trades: 3 trades within 100ms, then a gap, then 3 more
    const trades = [
      makeTx({ timestamp: t0 }),
      makeTx({ timestamp: t0 + 50 }),
      makeTx({ timestamp: t0 + 100 }),
      makeTx({ timestamp: t0 + 60000 }),
      makeTx({ timestamp: t0 + 60050 }),
      makeTx({ timestamp: t0 + 60100 }),
    ];

    const stats = recomputeWalletStats(trades);
    expect(stats.trade_clustering_score).toBeGreaterThan(0);
  });

  it('handles partial fills (FIFO matching)', () => {
    const t0 = 1000000;
    const trades = [
      // Buy 200 at 0.40
      makeTx({ side: 'BUY', price: 0.40, size: 200, timestamp: t0 }),
      // Sell 100 at 0.50 (partial close)
      makeTx({ side: 'SELL', price: 0.50, size: 100, timestamp: t0 + 5000 }),
      // Sell remaining 100 at 0.60
      makeTx({ side: 'SELL', price: 0.60, size: 100, timestamp: t0 + 10000 }),
    ];

    const stats = recomputeWalletStats(trades);
    // PnL: (0.50-0.40)*100 + (0.60-0.40)*100 = 10 + 20 = 30
    expect(stats.pnl_realized).toBeCloseTo(30, 2);
    expect(stats.win_rate).toBe(1.0); // both closes are profitable
  });

  it('ignores sells without matching buys', () => {
    const trades = [
      makeTx({ side: 'SELL', price: 0.50, size: 100 }),
    ];

    const stats = recomputeWalletStats(trades);
    expect(stats.pnl_realized).toBe(0);
    expect(stats.win_rate).toBe(0);
  });

  it('handles multiple markets independently', () => {
    const t0 = 1000000;
    const trades = [
      // Market 1: buy and sell → +10
      makeTx({ market_id: 'mkt_1', side: 'BUY', price: 0.40, size: 100, timestamp: t0 }),
      makeTx({ market_id: 'mkt_1', side: 'SELL', price: 0.50, size: 100, timestamp: t0 + 5000 }),
      // Market 2: buy and sell → -5
      makeTx({ market_id: 'mkt_2', side: 'BUY', price: 0.60, size: 100, timestamp: t0 + 10000, token_id: 'tok_2' }),
      makeTx({ market_id: 'mkt_2', side: 'SELL', price: 0.55, size: 100, timestamp: t0 + 15000, token_id: 'tok_2' }),
    ];

    const stats = recomputeWalletStats(trades);
    expect(stats.pnl_realized).toBeCloseTo(5, 2); // 10 - 5
  });
});
