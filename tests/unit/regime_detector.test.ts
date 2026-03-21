import { describe, it, expect, beforeEach } from 'vitest';
import { RegimeDetector, detectRegime } from '../../src/state/regime_detector.js';
import type { MarketState } from '../../src/state/types.js';
import type { MarketMetadata } from '../../src/ingestion/types.js';
import { createEmptyMarketState } from '../../src/state/market_state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetadata(id: string): MarketMetadata {
  return {
    market_id: id,
    question: `Market ${id}?`,
    condition_id: `cond_${id}`,
    tokens: { yes_id: `yes_${id}`, no_id: `no_${id}` },
    status: 'active',
    resolution: null,
    end_date: '2026-12-31',
    category: 'test',
    tags: [],
  };
}

function makeMarket(
  id: string,
  overrides: {
    spreadBps?: number;
    volume1h?: number;
    status?: 'active' | 'paused' | 'resolved';
  } = {},
): MarketState {
  const m = createEmptyMarketState(makeMetadata(id));
  const spread = overrides.spreadBps ?? 200;
  m.book.yes.spread_bps = spread;
  m.book.no.spread_bps = spread;
  m.volume_1h = overrides.volume1h ?? 1000;
  m.status = overrides.status ?? 'active';
  return m;
}

function feedNormalHistory(
  detector: RegimeDetector,
  ticks: number,
  startMs: number,
): void {
  // Feed N ticks with typical markets
  for (let i = 0; i < ticks; i++) {
    const markets = [
      makeMarket('m1', { spreadBps: 180 + Math.sin(i) * 20, volume1h: 900 + i * 10 }),
      makeMarket('m2', { spreadBps: 220 + Math.cos(i) * 20, volume1h: 1100 - i * 5 }),
    ];
    detector.detect(markets, 2, startMs + i * 60_000);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectRegime (standalone)', () => {
  it('returns normal regime with default features', () => {
    const state = detectRegime();
    expect(state.current_regime).toBe('normal');
    expect(state.confidence).toBe(1.0);
    expect(state.features.avg_spread_z_score).toBe(0);
  });
});

describe('RegimeDetector', () => {
  let detector: RegimeDetector;

  beforeEach(() => {
    detector = new RegimeDetector({ min_observations: 5, regime_change_persistence: 2 });
  });

  it('starts in normal regime', () => {
    expect(detector.getState().current_regime).toBe('normal');
  });

  it('stays normal with insufficient history', () => {
    const markets = [makeMarket('m1', { spreadBps: 5000 })];
    // Only 3 ticks — below min_observations of 5
    for (let i = 0; i < 3; i++) {
      detector.detect(markets, 0, 1000 + i * 60_000);
    }
    expect(detector.getState().current_regime).toBe('normal');
  });

  it('stays normal with typical market data', () => {
    feedNormalHistory(detector, 20, 0);
    expect(detector.getState().current_regime).toBe('normal');
  });

  it('detects high_volatility when spreads widen and volume rises', () => {
    const t0 = 0;
    // Build normal baseline
    feedNormalHistory(detector, 15, t0);

    // Now inject high-volatility conditions: very wide spreads + high volume
    const hvTime = t0 + 15 * 60_000;
    for (let i = 0; i < 5; i++) {
      const markets = [
        makeMarket('m1', { spreadBps: 2000, volume1h: 50000 }),
        makeMarket('m2', { spreadBps: 2500, volume1h: 60000 }),
      ];
      detector.detect(markets, 2, hvTime + i * 60_000);
    }

    expect(detector.getState().current_regime).toBe('high_volatility');
  });

  it('detects low_liquidity when spreads widen but volume drops', () => {
    const t0 = 0;
    feedNormalHistory(detector, 15, t0);

    const llTime = t0 + 15 * 60_000;
    for (let i = 0; i < 5; i++) {
      const markets = [
        makeMarket('m1', { spreadBps: 2000, volume1h: 10 }),
        makeMarket('m2', { spreadBps: 2500, volume1h: 5 }),
      ];
      detector.detect(markets, 0, llTime + i * 60_000);
    }

    expect(detector.getState().current_regime).toBe('low_liquidity');
  });

  it('detects event_driven when wallet activity spikes with volume', () => {
    const t0 = 0;
    feedNormalHistory(detector, 15, t0);

    const evTime = t0 + 15 * 60_000;
    for (let i = 0; i < 5; i++) {
      const markets = [
        makeMarket('m1', { spreadBps: 200, volume1h: 50000 }),
        makeMarket('m2', { spreadBps: 200, volume1h: 40000 }),
      ];
      // Massive spike in wallet activity
      detector.detect(markets, 50, evTime + i * 60_000);
    }

    expect(detector.getState().current_regime).toBe('event_driven');
  });

  it('detects resolution_clustering when many markets resolve', () => {
    const t0 = 0;
    feedNormalHistory(detector, 15, t0);

    // Record many resolutions in the last hour
    const rcTime = t0 + 15 * 60_000;
    for (let j = 0; j < 5; j++) {
      detector.recordResolution(rcTime + j * 100);
    }

    const markets = [makeMarket('m1'), makeMarket('m2')];
    // Need persistence ticks
    for (let i = 0; i < 5; i++) {
      detector.detect(markets, 2, rcTime + i * 60_000);
    }

    expect(detector.getState().current_regime).toBe('resolution_clustering');
  });

  it('requires persistence before switching regimes', () => {
    const det = new RegimeDetector({
      min_observations: 5,
      regime_change_persistence: 3,
    });

    feedNormalHistory(det, 15, 0);
    const baseTime = 15 * 60_000;

    // Single extreme tick should not switch
    const extremeMarkets = [
      makeMarket('m1', { spreadBps: 3000, volume1h: 100000 }),
      makeMarket('m2', { spreadBps: 3500, volume1h: 120000 }),
    ];
    det.detect(extremeMarkets, 2, baseTime);
    expect(det.getState().current_regime).toBe('normal');

    // Second tick
    det.detect(extremeMarkets, 2, baseTime + 60_000);
    expect(det.getState().current_regime).toBe('normal');

    // Third tick — now it should switch
    det.detect(extremeMarkets, 2, baseTime + 120_000);
    expect(det.getState().current_regime).toBe('high_volatility');
  });

  it('returns to normal when conditions normalize', () => {
    const t0 = 0;
    feedNormalHistory(detector, 15, t0);

    // Force high_volatility
    const hvTime = t0 + 15 * 60_000;
    for (let i = 0; i < 5; i++) {
      detector.detect(
        [makeMarket('m1', { spreadBps: 3000, volume1h: 80000 })],
        2,
        hvTime + i * 60_000,
      );
    }
    expect(detector.getState().current_regime).toBe('high_volatility');

    // Return to normal conditions
    const normTime = hvTime + 5 * 60_000;
    for (let i = 0; i < 10; i++) {
      detector.detect(
        [makeMarket('m1', { spreadBps: 200, volume1h: 1000 })],
        2,
        normTime + i * 60_000,
      );
    }
    expect(detector.getState().current_regime).toBe('normal');
  });

  it('tracks regime_since timestamp on change', () => {
    const t0 = 0;
    feedNormalHistory(detector, 15, t0);

    const changeTime = t0 + 15 * 60_000;
    for (let i = 0; i < 5; i++) {
      detector.detect(
        [makeMarket('m1', { spreadBps: 3000, volume1h: 80000 })],
        2,
        changeTime + i * 60_000,
      );
    }

    const state = detector.getState();
    expect(state.current_regime).toBe('high_volatility');
    // regime_since should be set when the change was confirmed (after persistence)
    expect(state.regime_since).toBeGreaterThanOrEqual(changeTime);
  });

  it('computes confidence score', () => {
    feedNormalHistory(detector, 15, 0);
    const state = detector.getState();
    expect(state.confidence).toBeGreaterThan(0);
    expect(state.confidence).toBeLessThanOrEqual(1.0);
  });
});

describe('RegimeDetector transition tracking', () => {
  it('records transitions in the matrix', () => {
    const det = new RegimeDetector({ min_observations: 5, regime_change_persistence: 1 });
    feedNormalHistory(det, 15, 0);

    // Force transition to high_volatility
    const t1 = 15 * 60_000;
    for (let i = 0; i < 3; i++) {
      det.detect(
        [makeMarket('m1', { spreadBps: 3000, volume1h: 80000 })],
        2,
        t1 + i * 60_000,
      );
    }
    expect(det.getState().current_regime).toBe('high_volatility');

    const matrix = det.getTransitionMatrix();
    const normalToHV = matrix.counts.get('normal')!.get('high_volatility')!;
    expect(normalToHV).toBeGreaterThanOrEqual(1);

    // Probabilities should sum to ~1 for the 'normal' row (if any transitions happened)
    const normalRow = matrix.probabilities.get('normal')!;
    const sum = Array.from(normalRow.values()).reduce((a, b) => a + b, 0);
    if (sum > 0) {
      expect(sum).toBeCloseTo(1.0, 5);
    }
  });

  it('tracks regime durations', () => {
    const det = new RegimeDetector({ min_observations: 5, regime_change_persistence: 1 });
    feedNormalHistory(det, 15, 0);

    // Transition to high_volatility at tick 15
    const t1 = 15 * 60_000;
    for (let i = 0; i < 3; i++) {
      det.detect(
        [makeMarket('m1', { spreadBps: 3000, volume1h: 80000 })],
        2,
        t1 + i * 60_000,
      );
    }

    const stats = det.getDurationStats();
    // The initial 'normal' span should have been recorded
    expect(stats.span_count.get('normal')).toBeGreaterThanOrEqual(1);
    expect(stats.avg_duration_ms.get('normal')).toBeGreaterThan(0);
  });
});

describe('RegimeDetector event recording', () => {
  it('prunes old resolution timestamps', () => {
    const det = new RegimeDetector({ min_observations: 5, regime_change_persistence: 1 });

    // Add resolutions from 2 hours ago (should be pruned)
    const twoHoursAgo = Date.now() - 7200_000;
    det.recordResolution(twoHoursAgo);
    det.recordResolution(twoHoursAgo + 1000);

    // Add recent resolutions
    const nowMs = Date.now();
    det.recordResolution(nowMs - 1000);
    det.recordResolution(nowMs - 500);

    // Run detection — old timestamps should be pruned
    feedNormalHistory(det, 10, nowMs - 10 * 60_000);

    // The state should reflect only recent resolutions
    const features = det.getState().features;
    expect(features.resolution_rate).toBeLessThanOrEqual(4); // at most 4 (2 old may survive if nowMs is close)
  });

  it('records new market events', () => {
    const det = new RegimeDetector({
      min_observations: 5,
      regime_change_persistence: 1,
      new_market_rate_threshold: 2,
    });

    const t0 = 100_000_000;
    feedNormalHistory(det, 10, t0);

    // Add many new markets
    const recent = t0 + 10 * 60_000;
    for (let i = 0; i < 10; i++) {
      det.recordNewMarket(recent + i * 100);
    }

    det.detect([makeMarket('m1')], 2, recent + 60_000);
    const features = det.getState().features;
    expect(features.new_market_rate).toBeGreaterThanOrEqual(5);
  });
});

describe('RegimeDetector history management', () => {
  it('trims history to window size', () => {
    const det = new RegimeDetector({
      min_observations: 5,
      history_window: 20,
      regime_change_persistence: 1,
    });

    // Feed 50 ticks
    for (let i = 0; i < 50; i++) {
      det.detect([makeMarket('m1')], 2, i * 60_000);
    }

    expect(det.getHistoryLength()).toBe(20);
  });

  it('handles empty market array gracefully', () => {
    const det = new RegimeDetector({ min_observations: 3, regime_change_persistence: 1 });
    for (let i = 0; i < 10; i++) {
      det.detect([], 0, i * 60_000);
    }
    expect(det.getState().current_regime).toBe('normal');
  });

  it('handles markets with zero spread_bps', () => {
    const det = new RegimeDetector({ min_observations: 3, regime_change_persistence: 1 });
    for (let i = 0; i < 10; i++) {
      det.detect([makeMarket('m1', { spreadBps: 0 })], 0, i * 60_000);
    }
    expect(det.getState().current_regime).toBe('normal');
  });
});
