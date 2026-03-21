import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FeatureEngine,
  FEATURE_REGISTRY,
} from '../../src/research/feature_engine.js';
import type { CaptureState, FeatureSnapshot } from '../../src/research/feature_engine.js';
import { createEmptyMarketState } from '../../src/state/market_state.js';
import { createEmptyWalletState, recomputeWalletStats } from '../../src/state/wallet_stats.js';
import type { MarketState, WalletState } from '../../src/state/types.js';
import type { MarketMetadata, WalletTransaction } from '../../src/ingestion/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_DIR = join(import.meta.dirname, '..', '..', 'tmp_test_features');

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
    volume24h?: number;
    volume1h?: number;
    spreadBps?: number;
    mid?: number;
    tradeCount1h?: number;
    status?: 'active' | 'paused' | 'resolved';
  } = {},
): MarketState {
  const m = createEmptyMarketState(makeMetadata(id));
  m.volume_24h = overrides.volume24h ?? 5000;
  m.volume_1h = overrides.volume1h ?? 500;
  m.trade_count_1h = overrides.tradeCount1h ?? 20;

  const spread = overrides.spreadBps ?? 200;
  const mid = overrides.mid ?? 0.50;

  m.book.yes.spread_bps = spread;
  m.book.no.spread_bps = spread;
  m.book.yes.mid = mid;
  m.book.no.mid = 1.0 - mid;
  m.book.yes.spread = spread / 10000;
  m.book.yes.bids = [[mid - 0.01, 100]];
  m.book.yes.asks = [[mid + 0.01, 80]];
  m.book.no.bids = [[(1.0 - mid) - 0.01, 90]];
  m.book.no.asks = [[(1.0 - mid) + 0.01, 110]];
  m.book.yes.queue_depth_at_best = 100;
  m.book.no.queue_depth_at_best = 90;
  m.status = overrides.status ?? 'active';
  m.updated_at = Date.now() - 5000;
  m.complement_gap_executable = 0.01;
  m.autocorrelation_1m = 0.05;
  m.volatility_1h = 0.02;

  return m;
}

function makeState(markets: MarketState[], wallets: WalletState[] = []): CaptureState {
  return {
    markets,
    wallets,
    regime: {
      current_regime: 'normal',
      regime_since: Date.now(),
      confidence: 1.0,
      features: {
        avg_spread_z_score: 0,
        volume_z_score: 0,
        wallet_activity_z_score: 0,
        resolution_rate: 0,
        new_market_rate: 0,
      },
    },
    consistencyViolations: [],
    marketGraph: { edges: new Map(), clusters: [] },
  };
}

let txSeq = 0;
function makeTx(wallet: string, marketId: string, timestamp: number): WalletTransaction {
  return {
    wallet,
    market_id: marketId,
    token_id: `tok_${marketId}`,
    side: 'BUY',
    price: 0.50,
    size: 100,
    timestamp,
    tx_hash: `0xtx_${txSeq++}`,
    block_number: 1000,
    gas_price: 30_000_000_000,
  };
}

function makeWallet(address: string, trades: WalletTransaction[]): WalletState {
  const ws = createEmptyWalletState(address);
  ws.trades = trades;
  ws.stats = recomputeWalletStats(trades);
  ws.classification = 'sniper';
  ws.confidence = 0.8;
  return ws;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeatureEngine', () => {
  let engine: FeatureEngine;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    engine = new FeatureEngine({ outputDir: TEST_DIR, minVolume24h: 1000 });
  });

  afterEach(() => {
    engine.stop();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it('creates output directory if missing', () => {
    const dir = join(TEST_DIR, 'sub', 'dir');
    const eng = new FeatureEngine({ outputDir: dir });
    expect(existsSync(dir)).toBe(true);
    eng.stop();
  });

  describe('capture()', () => {
    it('returns empty array when no markets are eligible', () => {
      const result = engine.capture(makeState([]));
      expect(result).toHaveLength(0);
    });

    it('filters out markets below volume threshold', () => {
      const markets = [
        makeMarket('m1', { volume24h: 500 }),  // below 1000
        makeMarket('m2', { volume24h: 5000 }), // above
      ];
      const result = engine.capture(makeState(markets));
      expect(result).toHaveLength(1);
      expect(result[0]!.market_id).toBe('m2');
    });

    it('filters out non-active markets', () => {
      const markets = [
        makeMarket('m1', { status: 'resolved', volume24h: 5000 }),
        makeMarket('m2', { volume24h: 5000 }),
      ];
      const result = engine.capture(makeState(markets));
      expect(result).toHaveLength(1);
      expect(result[0]!.market_id).toBe('m2');
    });

    it('computes all 18 features for an eligible market', () => {
      const markets = [makeMarket('m1')];
      const result = engine.capture(makeState(markets));

      expect(result).toHaveLength(1);
      const snap = result[0]!;
      expect(snap.market_id).toBe('m1');

      // All 18 features should be present
      for (const def of FEATURE_REGISTRY) {
        expect(snap.features).toHaveProperty(def.id);
        expect(typeof snap.features[def.id]).toBe('number');
      }
    });

    it('includes forward return placeholders as null', () => {
      const markets = [makeMarket('m1')];
      const result = engine.capture(makeState(markets));
      const snap = result[0]!;

      expect(snap.forward_return_1m).toBeNull();
      expect(snap.forward_return_5m).toBeNull();
      expect(snap.forward_return_1h).toBeNull();
    });

    it('writes JSONL to daily file', () => {
      const nowMs = Date.now();
      const markets = [makeMarket('m1'), makeMarket('m2')];
      engine.capture(makeState(markets), nowMs);

      const day = new Date(nowMs).toISOString().slice(0, 10);
      const filePath = join(TEST_DIR, `${day}.jsonl`);
      expect(existsSync(filePath)).toBe(true);

      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);

      // Each line should be valid JSON
      for (const line of lines) {
        const parsed = JSON.parse(line) as FeatureSnapshot;
        expect(parsed.market_id).toBeDefined();
        expect(parsed.features).toBeDefined();
        expect(parsed.timestamp).toBeGreaterThan(0);
      }
    });

    it('appends to existing file on subsequent captures', () => {
      const nowMs = Date.now();
      const markets = [makeMarket('m1')];

      engine.capture(makeState(markets), nowMs);
      engine.capture(makeState(markets), nowMs + 60_000);

      const day = new Date(nowMs).toISOString().slice(0, 10);
      const filePath = join(TEST_DIR, `${day}.jsonl`);
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
    });

    it('tracks snapshot count', () => {
      expect(engine.getSnapshotCount()).toBe(0);

      const markets = [makeMarket('m1'), makeMarket('m2')];
      engine.capture(makeState(markets));
      expect(engine.getSnapshotCount()).toBe(2);

      engine.capture(makeState(markets));
      expect(engine.getSnapshotCount()).toBe(4);
    });
  });

  describe('feature computations', () => {
    it('book_imbalance_l1 returns valid range [-1, 1]', () => {
      const markets = [makeMarket('m1')];
      const snaps = engine.capture(makeState(markets));
      const imb = snaps[0]!.features['book_imbalance_l1']!;
      expect(imb).toBeGreaterThanOrEqual(-1);
      expect(imb).toBeLessThanOrEqual(1);
    });

    it('book_imbalance_l5 returns valid range', () => {
      const markets = [makeMarket('m1')];
      const snaps = engine.capture(makeState(markets));
      const imb = snaps[0]!.features['book_imbalance_l5']!;
      expect(imb).toBeGreaterThanOrEqual(-1);
      expect(imb).toBeLessThanOrEqual(1);
    });

    it('microprice_deviation returns 0 for zero-spread market', () => {
      const m = makeMarket('m1', { spreadBps: 0 });
      m.book.yes.spread = 0;
      const snaps = engine.capture(makeState([m]));
      expect(snaps[0]!.features['microprice_deviation']).toBe(0);
    });

    it('staleness_ms is positive', () => {
      const nowMs = Date.now();
      const m = makeMarket('m1');
      m.updated_at = nowMs - 10_000;
      const snaps = engine.capture(makeState([m]), nowMs);
      expect(snaps[0]!.features['staleness_ms']).toBeCloseTo(10_000, -2);
    });

    it('complement_gap_executable reflects market state', () => {
      const m = makeMarket('m1');
      m.complement_gap_executable = 0.03;
      const snaps = engine.capture(makeState([m]));
      expect(snaps[0]!.features['complement_gap_executable']).toBe(0.03);
    });

    it('time_to_resolution_hours returns positive for future date', () => {
      const m = makeMarket('m1');
      m.end_date = new Date(Date.now() + 86400_000 * 7).toISOString();
      const snaps = engine.capture(makeState([m]));
      const hours = snaps[0]!.features['time_to_resolution_hours']!;
      expect(hours).toBeGreaterThan(100);
      expect(hours).toBeLessThan(200);
    });

    it('book_fragility is 1.0 for single-level book', () => {
      const m = makeMarket('m1');
      // Single level on each side — HHI = 1.0 (all at one level)
      m.book.yes.bids = [[0.49, 100]];
      m.book.yes.asks = [[0.51, 100]];
      const snaps = engine.capture(makeState([m]));
      expect(snaps[0]!.features['book_fragility']).toBe(1);
    });

    it('book_fragility decreases with more distributed depth', () => {
      const m1 = makeMarket('m1');
      m1.book.yes.bids = [[0.49, 100]];
      m1.book.yes.asks = [[0.51, 100]];

      const m2 = makeMarket('m2');
      m2.book.yes.bids = [[0.49, 50], [0.48, 50]];
      m2.book.yes.asks = [[0.51, 50], [0.52, 50]];

      const snaps = engine.capture(makeState([m1, m2]));
      const fragility1 = snaps[0]!.features['book_fragility']!;
      const fragility2 = snaps[1]!.features['book_fragility']!;
      expect(fragility1).toBeGreaterThan(fragility2);
    });

    it('spread_z_score is 0 with insufficient history', () => {
      const snaps = engine.capture(makeState([makeMarket('m1')]));
      expect(snaps[0]!.features['spread_z_score']).toBe(0);
    });

    it('spread_z_score becomes nonzero after building history', () => {
      const m = makeMarket('m1', { spreadBps: 200 });
      const state = makeState([m]);

      // Build history with consistent spreads
      for (let i = 0; i < 10; i++) {
        m.book.yes.spread_bps = 200 + i;
        m.book.no.spread_bps = 200 + i;
        engine.capture(state, Date.now() + i * 60_000);
      }

      // Now inject a very different spread
      m.book.yes.spread_bps = 1000;
      m.book.no.spread_bps = 1000;
      const snaps = engine.capture(state, Date.now() + 11 * 60_000);
      expect(Math.abs(snaps[0]!.features['spread_z_score']!)).toBeGreaterThan(1);
    });

    it('gas_price_z_score works with setGasPrice', () => {
      // Seed gas price history
      for (let i = 0; i < 10; i++) {
        engine.setGasPrice(30 + i);
      }
      // Set extreme gas price
      engine.setGasPrice(200);

      const snaps = engine.capture(makeState([makeMarket('m1')]));
      expect(Math.abs(snaps[0]!.features['gas_price_z_score']!)).toBeGreaterThan(1);
    });
  });

  describe('wallet_heat_score', () => {
    it('returns 0 when no wallets have recent trades in market', () => {
      const snaps = engine.capture(makeState([makeMarket('m1')], []));
      expect(snaps[0]!.features['wallet_heat_score']).toBe(0);
    });

    it('returns positive when a sniper wallet has recent trades in market', () => {
      const nowMs = Date.now();
      const m = makeMarket('m1');
      const w = makeWallet('0xabc', [
        makeTx('0xabc', 'm1', nowMs - 60_000), // 1 min ago — within 5 min
      ]);

      const snaps = engine.capture(makeState([m], [w]), nowMs);
      expect(snaps[0]!.features['wallet_heat_score']!).toBeGreaterThan(0);
    });

    it('returns higher score for sniper than noise wallet', () => {
      const nowMs = Date.now();
      const m = makeMarket('m1');

      const sniper = makeWallet('0x1', [makeTx('0x1', 'm1', nowMs - 60_000)]);
      sniper.classification = 'sniper';
      sniper.confidence = 0.8;

      const noise = makeWallet('0x2', [makeTx('0x2', 'm1', nowMs - 60_000)]);
      noise.classification = 'noise';
      noise.confidence = 0.5;

      const snapsSniper = engine.capture(makeState([m], [sniper]), nowMs);
      const sniperScore = snapsSniper[0]!.features['wallet_heat_score']!;

      // Reset engine for clean test
      const engine2 = new FeatureEngine({ outputDir: TEST_DIR, minVolume24h: 1000 });
      const snapsNoise = engine2.capture(makeState([m], [noise]), nowMs);
      const noiseScore = snapsNoise[0]!.features['wallet_heat_score']!;
      engine2.stop();

      expect(sniperScore).toBeGreaterThan(noiseScore);
    });
  });

  describe('consistency_violation_magnitude', () => {
    it('returns 0 when no violations', () => {
      const snaps = engine.capture(makeState([makeMarket('m1')]));
      expect(snaps[0]!.features['consistency_violation_magnitude']).toBe(0);
    });

    it('returns violation magnitude when market is involved', () => {
      const m = makeMarket('m1');
      const state = makeState([m]);
      state.consistencyViolations = [
        {
          check_id: 'test',
          check_type: 'exhaustive_partition',
          markets_involved: ['m1', 'm2'],
          expected_relationship: 'P(A)+P(B)=1',
          actual_values: new Map(),
          violation_magnitude: 0.15,
          executable_violation: 0.10,
          tradeable: true,
          trade_plan: null,
          detected_at: Date.now(),
        },
      ];

      const snaps = engine.capture(state);
      expect(snaps[0]!.features['consistency_violation_magnitude']).toBe(0.15);
    });
  });

  describe('backfillForwardReturns', () => {
    it('fills in 1m return when enough time has elapsed', () => {
      const nowMs = 1_000_000;
      const m = makeMarket('m1', { mid: 0.50 });
      const state = makeState([m]);

      // Capture at t0
      const snaps = engine.capture(state, nowMs);
      const snap = snaps[0]!;

      // Simulate mid-price change after 1 minute
      // Add a mid-price entry at t0+60s
      const history = (engine as unknown as { marketHistories: Map<string, { midPrices: { timestamp: number; mid: number }[] }> }).marketHistories;
      const mh = history.get('m1')!;
      mh.midPrices.push({ timestamp: nowMs + 60_000, mid: 0.55 });

      const filled = engine.backfillForwardReturns(snap, 0.55, nowMs + 60_000);
      expect(filled.forward_return_1m).toBeCloseTo(0.10, 1);
      expect(filled.forward_return_5m).toBeNull(); // not enough time
    });
  });

  describe('start() and stop()', () => {
    it('start is idempotent', () => {
      const getState = () => makeState([makeMarket('m1')]);
      engine.start(getState);
      engine.start(getState); // second call is no-op
      engine.stop();
    });

    it('stop without start does not throw', () => {
      expect(() => engine.stop()).not.toThrow();
    });
  });
});

describe('FEATURE_REGISTRY', () => {
  it('contains exactly 18 features', () => {
    expect(FEATURE_REGISTRY).toHaveLength(18);
  });

  it('all feature IDs are unique', () => {
    const ids = FEATURE_REGISTRY.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all features have descriptions', () => {
    for (const f of FEATURE_REGISTRY) {
      expect(f.description.length).toBeGreaterThan(0);
    }
  });

  it('contains the required features from SPEC', () => {
    const ids = new Set(FEATURE_REGISTRY.map((f) => f.id));
    const required = [
      'book_imbalance_l1',
      'book_imbalance_l5',
      'microprice_deviation',
      'spread_z_score',
      'volume_z_score_1h',
      'staleness_ms',
      'complement_gap_executable',
      'autocorrelation_1m',
      'large_trade_imbalance_5m',
      'wallet_heat_score',
      'consistency_violation_magnitude',
      'time_to_resolution_hours',
      'volatility_ratio_1h_24h',
      'queue_depth_ratio',
      'trade_arrival_rate_z',
      'book_fragility',
      'spread_regime',
      'gas_price_z_score',
    ];
    for (const r of required) {
      expect(ids.has(r)).toBe(true);
    }
  });
});
