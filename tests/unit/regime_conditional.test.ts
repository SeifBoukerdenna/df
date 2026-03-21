import { describe, it, expect } from 'vitest';
import {
  computeWalletRegimeProfile,
  computeAllRegimeProfiles,
  buildRegimeSpans,
  applyRegimeProfileToWallet,
} from '../../src/wallet_intel/regime_conditional.js';
import type { RegimeSpan, RegimeChangeEvent } from '../../src/wallet_intel/regime_conditional.js';
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
// buildRegimeSpans
// ---------------------------------------------------------------------------

describe('buildRegimeSpans', () => {
  it('returns single normal span for empty events', () => {
    const spans = buildRegimeSpans([]);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.regime).toBe('normal');
    expect(spans[0]!.start).toBe(0);
  });

  it('builds spans from chronological events', () => {
    const events: RegimeChangeEvent[] = [
      { timestamp: 1000, regime: 'normal' },
      { timestamp: 5000, regime: 'high_volatility' },
      { timestamp: 10000, regime: 'normal' },
    ];

    const spans = buildRegimeSpans(events, 20000);
    // Prepended normal 0→1000, then 3 from events = 4 total
    expect(spans).toHaveLength(4);
    expect(spans[0]!.regime).toBe('normal');
    expect(spans[0]!.start).toBe(0);
    expect(spans[0]!.end).toBe(1000);
    expect(spans[1]!.regime).toBe('normal');
    expect(spans[1]!.start).toBe(1000);
    expect(spans[1]!.end).toBe(5000);
    expect(spans[2]!.regime).toBe('high_volatility');
    expect(spans[2]!.start).toBe(5000);
    expect(spans[2]!.end).toBe(10000);
    expect(spans[3]!.regime).toBe('normal');
    expect(spans[3]!.start).toBe(10000);
    expect(spans[3]!.end).toBe(20000);
  });

  it('sorts unsorted events', () => {
    const events: RegimeChangeEvent[] = [
      { timestamp: 5000, regime: 'high_volatility' },
      { timestamp: 1000, regime: 'normal' },
    ];

    const spans = buildRegimeSpans(events, 10000);
    // Prepended normal 0→1000, then normal 1000→5000, then high_vol 5000→10000
    expect(spans).toHaveLength(3);
    expect(spans[0]!.regime).toBe('normal');       // prepended 0→1000
    expect(spans[1]!.regime).toBe('normal');        // event at 1000
    expect(spans[2]!.regime).toBe('high_volatility'); // event at 5000
  });

  it('prepends normal span if events start after 0', () => {
    const events: RegimeChangeEvent[] = [
      { timestamp: 5000, regime: 'event_driven' },
    ];

    const spans = buildRegimeSpans(events, 10000);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.regime).toBe('normal');
    expect(spans[0]!.start).toBe(0);
    expect(spans[0]!.end).toBe(5000);
    expect(spans[1]!.regime).toBe('event_driven');
  });
});

// ---------------------------------------------------------------------------
// computeWalletRegimeProfile
// ---------------------------------------------------------------------------

describe('computeWalletRegimeProfile', () => {
  it('returns empty profile for wallet with no trades', () => {
    const ws = createEmptyWalletState('0xabc');
    const spans: RegimeSpan[] = [{ regime: 'normal', start: 0, end: 100000 }];

    const profile = computeWalletRegimeProfile(ws, spans);
    expect(profile.address).toBe('0xabc');
    expect(profile.regime_entries).toHaveLength(0);
    expect(profile.best_regime).toBeNull();
    expect(profile.worst_regime).toBeNull();
    expect(profile.robustness_score).toBe(0);
  });

  it('partitions trades into regimes correctly', () => {
    const spans: RegimeSpan[] = [
      { regime: 'normal', start: 0, end: 5000 },
      { regime: 'high_volatility', start: 5000, end: 10000 },
      { regime: 'normal', start: 10000, end: 20000 },
    ];

    const trades = [
      // During first normal span
      makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: 1000 }),
      makeTx({ side: 'SELL', price: 0.50, size: 100, timestamp: 2000 }),
      makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: 3000 }),
      makeTx({ side: 'SELL', price: 0.50, size: 100, timestamp: 4000 }),
      makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: 4200 }),
      makeTx({ side: 'SELL', price: 0.50, size: 100, timestamp: 4500 }),
      // During high_volatility span
      makeTx({ side: 'BUY', price: 0.30, size: 100, timestamp: 6000 }),
      makeTx({ side: 'SELL', price: 0.35, size: 100, timestamp: 7000 }),
      makeTx({ side: 'BUY', price: 0.30, size: 100, timestamp: 7500 }),
      makeTx({ side: 'SELL', price: 0.35, size: 100, timestamp: 8000 }),
      makeTx({ side: 'BUY', price: 0.30, size: 100, timestamp: 8500 }),
      makeTx({ side: 'SELL', price: 0.35, size: 100, timestamp: 9000 }),
    ];

    const ws = buildWallet(trades);
    const profile = computeWalletRegimeProfile(ws, spans);

    expect(profile.regime_entries.length).toBe(2);

    const normalEntry = profile.regime_entries.find((e) => e.regime === 'normal');
    const hvEntry = profile.regime_entries.find((e) => e.regime === 'high_volatility');

    expect(normalEntry).toBeDefined();
    expect(hvEntry).toBeDefined();
    expect(normalEntry!.n_trades).toBe(6); // 6 trades in normal spans
    expect(hvEntry!.n_trades).toBe(6);     // 6 trades in high_vol span
  });

  it('identifies best and worst regimes by Sharpe', () => {
    const spans: RegimeSpan[] = [
      { regime: 'normal', start: 0, end: 50000 },
      { regime: 'event_driven', start: 50000, end: 200000 },
    ];

    const trades: WalletTransaction[] = [];
    // Normal regime: modest profits with variance (so Sharpe is computable)
    for (let i = 0; i < 5; i++) {
      trades.push(makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: 1000 + i * 8000 }));
      trades.push(makeTx({ side: 'SELL', price: 0.42 + (i % 3) * 0.01, size: 100, timestamp: 2000 + i * 8000 }));
    }
    // Event-driven regime: strong profits with variance
    for (let i = 0; i < 5; i++) {
      trades.push(makeTx({ side: 'BUY', price: 0.30, size: 100, timestamp: 51000 + i * 8000 }));
      trades.push(makeTx({ side: 'SELL', price: 0.48 + (i % 3) * 0.02, size: 100, timestamp: 52000 + i * 8000 }));
    }

    const ws = buildWallet(trades);
    const profile = computeWalletRegimeProfile(ws, spans);

    const normalEntry = profile.regime_entries.find((e) => e.regime === 'normal');
    const eventEntry = profile.regime_entries.find((e) => e.regime === 'event_driven');

    expect(normalEntry).toBeDefined();
    expect(eventEntry).toBeDefined();
    // Event-driven has higher PnL (avg ~20 vs avg ~3 per trade)
    expect(eventEntry!.pnl_realized).toBeGreaterThan(normalEntry!.pnl_realized);
    expect(profile.best_regime).toBe('event_driven');
    expect(profile.worst_regime).toBe('normal');
  });

  it('detects regime sensitivity when performance varies significantly', () => {
    const spans: RegimeSpan[] = [
      { regime: 'normal', start: 0, end: 50000 },
      { regime: 'high_volatility', start: 50000, end: 100000 },
    ];

    const trades: WalletTransaction[] = [];
    // Normal: profitable
    for (let i = 0; i < 10; i++) {
      trades.push(makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: 1000 + i * 4000 }));
      trades.push(makeTx({ side: 'SELL', price: 0.55, size: 100, timestamp: 2000 + i * 4000 }));
    }
    // High volatility: unprofitable
    for (let i = 0; i < 10; i++) {
      trades.push(makeTx({ side: 'BUY', price: 0.60, size: 100, timestamp: 51000 + i * 4000 }));
      trades.push(makeTx({ side: 'SELL', price: 0.45, size: 100, timestamp: 52000 + i * 4000 }));
    }

    const ws = buildWallet(trades);
    const profile = computeWalletRegimeProfile(ws, spans);

    // One regime positive, one negative → sensitive
    expect(profile.regime_sensitive).toBe(true);
  });

  it('is not regime sensitive when performance is consistent', () => {
    const spans: RegimeSpan[] = [
      { regime: 'normal', start: 0, end: 100000 },
      { regime: 'event_driven', start: 100000, end: 200000 },
    ];

    const trades: WalletTransaction[] = [];
    // Both regimes: similar profits with slight variance (so Sharpe > 0)
    for (let i = 0; i < 10; i++) {
      trades.push(makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: 1000 + i * 8000 }));
      trades.push(makeTx({ side: 'SELL', price: 0.49 + (i % 3) * 0.01, size: 100, timestamp: 2000 + i * 8000 }));
    }
    for (let i = 0; i < 10; i++) {
      trades.push(makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: 101000 + i * 8000 }));
      trades.push(makeTx({ side: 'SELL', price: 0.49 + (i % 3) * 0.01, size: 100, timestamp: 102000 + i * 8000 }));
    }

    const ws = buildWallet(trades);
    const profile = computeWalletRegimeProfile(ws, spans);

    expect(profile.regime_sensitive).toBe(false);
    expect(profile.robustness_score).toBeGreaterThan(0.5);
  });

  it('computes robustness score as fraction of positive-Sharpe regimes', () => {
    const spans: RegimeSpan[] = [
      { regime: 'normal', start: 0, end: 100000 },
      { regime: 'high_volatility', start: 100000, end: 200000 },
      { regime: 'low_liquidity', start: 200000, end: 300000 },
    ];

    const trades: WalletTransaction[] = [];
    // Normal: profitable (5 buy+sell pairs = 10 trades, enough for 5+ filter)
    for (let i = 0; i < 5; i++) {
      trades.push(makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: 1000 + i * 10000 }));
      trades.push(makeTx({ side: 'SELL', price: 0.50, size: 100, timestamp: 2000 + i * 10000 }));
    }
    // High vol: profitable
    for (let i = 0; i < 5; i++) {
      trades.push(makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: 101000 + i * 10000 }));
      trades.push(makeTx({ side: 'SELL', price: 0.48, size: 100, timestamp: 102000 + i * 10000 }));
    }
    // Low liquidity: unprofitable
    for (let i = 0; i < 5; i++) {
      trades.push(makeTx({ side: 'BUY', price: 0.50, size: 100, timestamp: 201000 + i * 10000 }));
      trades.push(makeTx({ side: 'SELL', price: 0.45, size: 100, timestamp: 202000 + i * 10000 }));
    }

    const ws = buildWallet(trades);
    const profile = computeWalletRegimeProfile(ws, spans);

    // 3 regime entries
    expect(profile.regime_entries).toHaveLength(3);
    // 2 out of 3 regimes positive → robustness should be ~0.67
    expect(profile.robustness_score).toBeGreaterThan(0.3);
    expect(profile.robustness_score).toBeLessThan(1.0);
  });

  it('computes per-regime stats with PnL', () => {
    const spans: RegimeSpan[] = [
      { regime: 'normal', start: 0, end: 100000 },
    ];

    const trades = [
      makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: 1000 }),
      makeTx({ side: 'SELL', price: 0.60, size: 100, timestamp: 2000 }),
    ];

    const ws = buildWallet(trades);
    const profile = computeWalletRegimeProfile(ws, spans);

    expect(profile.regime_entries).toHaveLength(1);
    const entry = profile.regime_entries[0]!;
    expect(entry.regime).toBe('normal');
    expect(entry.pnl_realized).toBeCloseTo(20, 2);
    expect(entry.win_rate).toBe(1.0);
    expect(entry.n_trades).toBe(2);
  });

  it('handles trades that fall outside all spans (defaults to normal)', () => {
    const spans: RegimeSpan[] = [
      { regime: 'high_volatility', start: 5000, end: 10000 },
    ];

    const trades = [
      makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: 1000 }), // before any span
      makeTx({ side: 'SELL', price: 0.50, size: 100, timestamp: 2000 }),
    ];

    const ws = buildWallet(trades);
    const profile = computeWalletRegimeProfile(ws, spans);

    // Trades at t=1000,2000 fall before the high_vol span at 5000
    // assignRegime returns 'normal' by default for unmatched timestamps
    const normalEntry = profile.regime_entries.find((e) => e.regime === 'normal');
    expect(normalEntry).toBeDefined();
    expect(normalEntry!.n_trades).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// applyRegimeProfileToWallet
// ---------------------------------------------------------------------------

describe('applyRegimeProfileToWallet', () => {
  it('updates wallet regime_performance map', () => {
    const ws = createEmptyWalletState('0xabc');
    const spans: RegimeSpan[] = [
      { regime: 'normal', start: 0, end: 50000 },
      { regime: 'event_driven', start: 50000, end: 100000 },
    ];

    const trades: WalletTransaction[] = [];
    for (let i = 0; i < 6; i++) {
      trades.push(makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: 1000 + i * 5000 }));
      trades.push(makeTx({ side: 'SELL', price: 0.50, size: 100, timestamp: 2000 + i * 5000 }));
    }
    for (let i = 0; i < 4; i++) {
      trades.push(makeTx({ side: 'BUY', price: 0.40, size: 100, timestamp: 51000 + i * 5000 }));
      trades.push(makeTx({ side: 'SELL', price: 0.55, size: 100, timestamp: 52000 + i * 5000 }));
    }
    ws.trades = trades;
    ws.stats = recomputeWalletStats(trades);

    const profile = computeWalletRegimeProfile(ws, spans);
    applyRegimeProfileToWallet(ws, profile);

    expect(ws.regime_performance.size).toBe(2);
    expect(ws.regime_performance.has('normal')).toBe(true);
    expect(ws.regime_performance.has('event_driven')).toBe(true);

    const normalStats = ws.regime_performance.get('normal')!;
    expect(normalStats.total_trades).toBeGreaterThan(0);
    expect(normalStats.pnl_realized).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Batch
// ---------------------------------------------------------------------------

describe('computeAllRegimeProfiles', () => {
  it('computes profiles for multiple wallets', () => {
    const spans: RegimeSpan[] = [{ regime: 'normal', start: 0, end: 100000 }];
    const w1 = buildWallet([makeTx({ timestamp: 1000 })], '0xabc');
    const w2 = buildWallet([makeTx({ timestamp: 2000 })], '0xdef');

    const profiles = computeAllRegimeProfiles([w1, w2], spans);
    expect(profiles).toHaveLength(2);
    expect(profiles[0]!.address).toBe('0xabc');
    expect(profiles[1]!.address).toBe('0xdef');
  });
});
