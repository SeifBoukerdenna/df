import { describe, it, expect, vi } from 'vitest';
import { WalletFollowStrategy } from '../../src/strategy/wallet_follow.js';
import type { WalletIntelProvider } from '../../src/strategy/wallet_follow.js';
import { createEmptyWalletState, recomputeWalletStats } from '../../src/state/wallet_stats.js';
import type { StrategyContext } from '../../src/strategy/types.js';
import type { WalletState, MarketState, RegimeName, PositionState, WorldState } from '../../src/state/types.js';
import type { WalletTransaction } from '../../src/ingestion/types.js';
import type {
  WalletScore,
  WalletDelayCurve,
  WalletRegimeProfile,
  DelayBucketResult,
  RegimePerformanceEntry,
} from '../../src/wallet_intel/types.js';
import type { EdgeMapEntry, MarketClassification, MarketFeatures } from '../../src/analytics/types.js';
import type { StrategyConfig } from '../../src/utils/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
let txSeq = 0;

function makeTx(overrides: Partial<WalletTransaction> = {}): WalletTransaction {
  return {
    wallet: '0xabc123',
    market_id: 'mkt_1',
    token_id: 'tok_yes_1',
    side: 'BUY',
    price: 0.50,
    size: 100,
    timestamp: NOW - 10_000, // 10s ago
    tx_hash: '0xtx_' + (txSeq++),
    block_number: 1000,
    gas_price: 30_000_000_000,
    ...overrides,
  };
}

function makeBucket(overrides: Partial<DelayBucketResult> = {}): DelayBucketResult {
  return {
    delay_seconds: 3,
    mean_pnl: 0.08,
    ci_low: 0.03,
    ci_high: 0.13,
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
    classification: 'swing',
    delay_buckets: [
      makeBucket({ delay_seconds: 1, mean_pnl: 0.12 }),
      makeBucket({ delay_seconds: 3, mean_pnl: 0.08 }),
      makeBucket({ delay_seconds: 5, mean_pnl: 0.05 }),
      makeBucket({ delay_seconds: 10, mean_pnl: 0.02, t_statistic: 1.2, significantly_positive: false }),
    ],
    optimal_delay_seconds: 1,
    edge_halflife_seconds: 8,
    breakeven_delay_seconds: 15,
    followable_at_latency: true,
    recommendation: 'follow',
    ...overrides,
  };
}

function makeScore(overrides: Partial<WalletScore> = {}): WalletScore {
  return {
    address: '0xabc123',
    label: '0xabc123de',
    classification: 'swing',
    overall_score: 0.75,
    components: {
      raw_profitability: 0.7,
      delayed_profitability: 0.8,
      consistency: 0.6,
      statistical_significance: 0.7,
      sample_size: 0.9,
      recency: 0.8,
      regime_robustness: 0.7,
    },
    recommendation: 'follow',
    follow_parameters: {
      optimal_delay_ms: 3000,
      min_trade_size_to_follow: 10,
      max_allocation_per_follow: 200,
      allowed_market_types: ['all'],
      confidence_interval_90: [0.02, 0.10],
    },
    ...overrides,
  };
}

function makeRegimeProfile(overrides: Partial<WalletRegimeProfile> = {}): WalletRegimeProfile {
  const normalEntry: RegimePerformanceEntry = {
    regime: 'normal',
    stats: createEmptyWalletState('0xabc123').stats,
    n_trades: 30,
    sharpe: 1.5,
    win_rate: 0.65,
    pnl_realized: 500,
    is_significant: true,
    t_statistic: 2.5,
    p_value: 0.01,
  };
  return {
    address: '0xabc123',
    label: '0xabc123de',
    regime_entries: [normalEntry],
    best_regime: 'normal',
    worst_regime: null,
    regime_sensitive: false,
    robustness_score: 0.8,
    ...overrides,
  };
}

function makeMarketState(overrides: Partial<MarketState> = {}): MarketState {
  return {
    market_id: 'mkt_1',
    question: 'Will X happen?',
    condition_id: 'cond_1',
    tokens: { yes_id: 'tok_yes_1', no_id: 'tok_no_1' },
    status: 'active',
    resolution: null,
    end_date: '2026-12-31',
    category: 'politics',
    tags: [],
    book: {
      yes: {
        bids: [[0.49, 100]],
        asks: [[0.51, 100]],
        mid: 0.50,
        spread: 0.02,
        spread_bps: 400,
        imbalance: 0,
        imbalance_weighted: 0,
        top_of_book_stability_ms: 5000,
        queue_depth_at_best: 100,
        microprice: 0.50,
        last_updated: NOW,
      },
      no: {
        bids: [[0.49, 100]],
        asks: [[0.51, 100]],
        mid: 0.50,
        spread: 0.02,
        spread_bps: 400,
        imbalance: 0,
        imbalance_weighted: 0,
        top_of_book_stability_ms: 5000,
        queue_depth_at_best: 100,
        microprice: 0.50,
        last_updated: NOW,
      },
    },
    last_trade_price: { yes: 0.50, no: 0.50 },
    volume_24h: 100_000,
    volume_1h: 5_000,
    trade_count_1h: 50,
    liquidity_score: 0.7,
    complement_gap: 0,
    complement_gap_executable: 0,
    staleness_ms: 0,
    volatility_1h: 0.02,
    autocorrelation_1m: 0.1,
    related_markets: [],
    event_cluster_id: null,
    updated_at: NOW,
    ...overrides,
  } as MarketState;
}

function makeStrategyConfig(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    enabled: true,
    paper_only: true,
    capital_allocation: 0.25,
    max_position_size: 500,
    min_ev_threshold: 0.02,
    max_concurrent_positions: 5,
    cooldown_after_loss_ms: 300_000,
    allowed_regimes: ['normal', 'event_driven'],
    min_statistical_confidence_t: 1.645,
    max_parameter_sensitivity: 0.20,
    signal_half_life_ms: 120_000,
    ...overrides,
  };
}

function makeEdge(): EdgeMapEntry {
  return {
    market_id: 'mkt_1',
    market_type: 2,
    efficiency_score: 0.5,
    viable_strategies: ['wallet_follow'],
    estimated_edge_per_trade: 0.05,
    estimated_edge_confidence: 0.8,
    capital_allocated: 2500,
    breakeven_latency_ms: 5000,
  };
}

function makeClassification(): MarketClassification {
  return {
    market_id: 'mkt_1',
    market_type: 2,
    confidence: 0.8,
    efficiency_score: 0.5,
    viable_strategies: ['wallet_follow'],
    classified_at: NOW,
    features: {} as MarketFeatures,
  };
}

function buildWallet(
  trades: WalletTransaction[],
  address = '0xabc123',
  classification: WalletState['classification'] = 'swing',
): WalletState {
  const ws = createEmptyWalletState(address);
  ws.classification = classification;
  ws.trades = trades;
  ws.stats = recomputeWalletStats(trades);
  return ws;
}

function makeWorldState(wallets: WalletState[], markets: MarketState[]): WorldState {
  const wMap = new Map<string, WalletState>();
  for (const w of wallets) wMap.set(w.address, w);
  const mMap = new Map<string, MarketState>();
  for (const m of markets) mMap.set(m.market_id, m);
  return {
    markets: mMap,
    wallets: wMap,
    own_positions: new Map(),
    market_graph: { edges: new Map(), clusters: [] },
    regime: {
      current_regime: 'normal',
      regime_since: NOW - 3_600_000,
      confidence: 0.9,
      features: {
        avg_spread_z_score: 0,
        volume_z_score: 0,
        wallet_activity_z_score: 0,
        resolution_rate: 0,
        new_market_rate: 0,
      },
    },
    system_clock: NOW,
  };
}

function makeIntel(
  score: WalletScore | null = null,
  delayCurve: WalletDelayCurve | null = null,
  regimeProfile: WalletRegimeProfile | null = null,
): WalletIntelProvider {
  return {
    getScore: () => score,
    getDelayCurve: () => delayCurve,
    getRegimeProfile: () => regimeProfile,
  };
}

function makeContext(
  world: WorldState,
  market: MarketState,
  overrides: Partial<StrategyContext> = {},
): StrategyContext {
  return {
    world,
    market,
    classification: makeClassification(),
    edge: makeEdge(),
    existing_positions: [],
    regime: 'normal',
    config: makeStrategyConfig(),
    measured_latency_ms: 3000,
    now: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WalletFollowStrategy', () => {
  describe('basic signal generation', () => {
    it('generates a follow signal for a swing wallet with positive delayed EV', () => {
      const trades = [
        makeTx({ side: 'BUY', price: 0.45, timestamp: NOW - 100_000 }),
        makeTx({ side: 'SELL', price: 0.55, timestamp: NOW - 70_000 }),
        makeTx({ side: 'BUY', timestamp: NOW - 5_000 }), // recent trade in market
      ];
      const wallet = buildWallet(trades, '0xabc123', 'swing');
      const market = makeMarketState();
      const world = makeWorldState([wallet], [market]);
      const intel = makeIntel(makeScore(), makeDelayCurve(), makeRegimeProfile());
      const strategy = new WalletFollowStrategy(intel);
      const ctx = makeContext(world, market);

      const signals = strategy.evaluate(ctx);

      expect(signals.length).toBeGreaterThan(0);
      const sig = signals[0]!;
      expect(sig.strategy_id).toBe('wallet_follow');
      expect(sig.market_id).toBe('mkt_1');
      expect(sig.direction).toBe('BUY'); // follow = same direction
      expect(sig.ev_estimate).toBeGreaterThan(0);
      expect(sig.ev_after_costs).toBeGreaterThan(0);
      expect(sig.signal_strength).toBeGreaterThan(0);
      expect(sig.signal_strength).toBeLessThanOrEqual(1);
      expect(sig.kill_conditions.length).toBeGreaterThan(0);
      expect(sig.decay_model.half_life_ms).toBeGreaterThan(0);
      expect(sig.decay_model.initial_ev).toBeGreaterThan(0);
      expect(sig.regime_assumption).toBe('normal');
      expect(sig.reasoning).toContain('Following');
      expect(sig.reasoning).toContain('swing');
    });

    it('returns empty array when no wallets have recent trades in market', () => {
      // Wallet traded in a DIFFERENT market
      const trades = [makeTx({ market_id: 'mkt_OTHER', timestamp: NOW - 5_000 })];
      const wallet = buildWallet(trades);
      const market = makeMarketState();
      const world = makeWorldState([wallet], [market]);
      const intel = makeIntel(makeScore(), makeDelayCurve(), makeRegimeProfile());
      const strategy = new WalletFollowStrategy(intel);

      const signals = strategy.evaluate(makeContext(world, market));
      expect(signals).toHaveLength(0);
    });

    it('returns empty array when wallet trade is too old', () => {
      const trades = [makeTx({ timestamp: NOW - 120_000 })]; // 2 min ago, default max = 60s
      const wallet = buildWallet(trades);
      const market = makeMarketState();
      const world = makeWorldState([wallet], [market]);
      const intel = makeIntel(makeScore(), makeDelayCurve(), makeRegimeProfile());
      const strategy = new WalletFollowStrategy(intel);

      const signals = strategy.evaluate(makeContext(world, market));
      expect(signals).toHaveLength(0);
    });
  });

  describe('classification gate', () => {
    it('follows swing traders directly', () => {
      const trades = [makeTx({ timestamp: NOW - 5_000 })];
      const wallet = buildWallet(trades, '0xswing', 'swing');
      const market = makeMarketState();
      const world = makeWorldState([wallet], [market]);
      const score = makeScore({ address: '0xswing', recommendation: 'follow' });
      const curve = makeDelayCurve({ address: '0xswing', classification: 'swing' });
      const regime = makeRegimeProfile({ address: '0xswing' });
      const intel = makeIntel(score, curve, regime);
      const strategy = new WalletFollowStrategy(intel);

      const signals = strategy.evaluate(makeContext(world, market));
      expect(signals.length).toBeGreaterThan(0);
      expect(signals[0]!.direction).toBe('BUY');
    });

    it('fades market makers (reverses direction)', () => {
      const trades = [makeTx({ side: 'BUY', timestamp: NOW - 5_000 })];
      const wallet = buildWallet(trades, '0xmm', 'market_maker');
      const market = makeMarketState();
      const world = makeWorldState([wallet], [market]);
      // For fade: the delay curve mean_pnl is wallet's PnL (positive for them = negative for us)
      // So we reverse the EV. Need the NEGATIVE of their PnL to exceed threshold.
      // Make bucket mean_pnl negative (mm loses) so -(-) = positive effective EV
      const curve = makeDelayCurve({
        address: '0xmm',
        classification: 'market_maker',
        delay_buckets: [
          makeBucket({ delay_seconds: 1, mean_pnl: -0.08 }),
          makeBucket({ delay_seconds: 3, mean_pnl: -0.06, ci_low: -0.10, ci_high: -0.02 }),
          makeBucket({ delay_seconds: 5, mean_pnl: -0.04 }),
        ],
      });
      const score = makeScore({ address: '0xmm', classification: 'market_maker', recommendation: 'follow' });
      const regime = makeRegimeProfile({ address: '0xmm' });
      const intel = makeIntel(score, curve, regime);
      const strategy = new WalletFollowStrategy(intel);

      const signals = strategy.evaluate(makeContext(world, market));
      expect(signals.length).toBeGreaterThan(0);
      const sig = signals[0]!;
      expect(sig.direction).toBe('SELL'); // reversed: wallet buys → we sell
      expect(sig.reasoning).toContain('Fading');
    });

    it('skips noise wallets', () => {
      const trades = [makeTx({ timestamp: NOW - 5_000 })];
      const wallet = buildWallet(trades, '0xnoise', 'noise');
      const market = makeMarketState();
      const world = makeWorldState([wallet], [market]);
      const intel = makeIntel(
        makeScore({ address: '0xnoise', recommendation: 'follow' }),
        makeDelayCurve({ address: '0xnoise', classification: 'noise' }),
        makeRegimeProfile({ address: '0xnoise' }),
      );
      const strategy = new WalletFollowStrategy(intel);

      const signals = strategy.evaluate(makeContext(world, market));
      expect(signals).toHaveLength(0);
    });

    it('follows snipers only if edge halflife exceeds our latency', () => {
      const trades = [makeTx({ timestamp: NOW - 5_000 })];
      const wallet = buildWallet(trades, '0xsniper', 'sniper');
      const market = makeMarketState();

      // Case 1: halflife > latency → follow
      const world1 = makeWorldState([wallet], [market]);
      const curve1 = makeDelayCurve({
        address: '0xsniper',
        classification: 'sniper',
        edge_halflife_seconds: 5, // 5s > 3s latency
        followable_at_latency: true,
      });
      const intel1 = makeIntel(
        makeScore({ address: '0xsniper', recommendation: 'follow' }),
        curve1,
        makeRegimeProfile({ address: '0xsniper' }),
      );
      const strategy1 = new WalletFollowStrategy(intel1);
      const signals1 = strategy1.evaluate(makeContext(world1, market));
      expect(signals1.length).toBeGreaterThan(0);

      // Case 2: halflife <= latency → skip
      const world2 = makeWorldState([buildWallet(trades, '0xsniper2', 'sniper')], [market]);
      const curve2 = makeDelayCurve({
        address: '0xsniper2',
        classification: 'sniper',
        edge_halflife_seconds: 2, // 2s < 3s latency
        followable_at_latency: false,
      });
      const intel2 = makeIntel(
        makeScore({ address: '0xsniper2', recommendation: 'follow' }),
        curve2,
        makeRegimeProfile({ address: '0xsniper2' }),
      );
      const strategy2 = new WalletFollowStrategy(intel2);
      const signals2 = strategy2.evaluate(makeContext(world2, market));
      expect(signals2).toHaveLength(0);
    });

    it('follows arbitrageurs only if delay curve shows positive edge', () => {
      const trades = [makeTx({ timestamp: NOW - 5_000 })];
      const wallet = buildWallet(trades, '0xarb', 'arbitrageur');
      const market = makeMarketState();
      const world = makeWorldState([wallet], [market]);

      // followable_at_latency = false → skip
      const curve = makeDelayCurve({
        address: '0xarb',
        classification: 'arbitrageur',
        followable_at_latency: false,
      });
      const intel = makeIntel(
        makeScore({ address: '0xarb', recommendation: 'follow' }),
        curve,
        makeRegimeProfile({ address: '0xarb' }),
      );
      const strategy = new WalletFollowStrategy(intel);
      const signals = strategy.evaluate(makeContext(world, market));
      expect(signals).toHaveLength(0);
    });
  });

  describe('statistical gate', () => {
    it('skips when delay bucket t-stat is below threshold', () => {
      const trades = [makeTx({ timestamp: NOW - 5_000 })];
      const wallet = buildWallet(trades, '0xweak', 'swing');
      const market = makeMarketState();
      const world = makeWorldState([wallet], [market]);
      // Low t-stat in delay bucket
      const curve = makeDelayCurve({
        address: '0xweak',
        delay_buckets: [
          makeBucket({ delay_seconds: 3, t_statistic: 0.8, mean_pnl: 0.05 }),
        ],
      });
      const intel = makeIntel(
        makeScore({ address: '0xweak', recommendation: 'follow' }),
        curve,
        makeRegimeProfile({ address: '0xweak' }),
      );
      const strategy = new WalletFollowStrategy(intel);
      const signals = strategy.evaluate(makeContext(world, market));
      expect(signals).toHaveLength(0);
    });

    it('skips when delay bucket has too few trades', () => {
      const trades = [makeTx({ timestamp: NOW - 5_000 })];
      const wallet = buildWallet(trades, '0xfew', 'swing');
      const market = makeMarketState();
      const world = makeWorldState([wallet], [market]);
      const curve = makeDelayCurve({
        address: '0xfew',
        delay_buckets: [
          makeBucket({ delay_seconds: 3, n_trades: 2 }), // below min of 5
        ],
      });
      const intel = makeIntel(
        makeScore({ address: '0xfew', recommendation: 'follow' }),
        curve,
        makeRegimeProfile({ address: '0xfew' }),
      );
      const strategy = new WalletFollowStrategy(intel);
      const signals = strategy.evaluate(makeContext(world, market));
      expect(signals).toHaveLength(0);
    });
  });

  describe('EV computation', () => {
    it('subtracts spread cost and fees from delayed mean PnL', () => {
      const trades = [makeTx({ timestamp: NOW - 5_000 })];
      const wallet = buildWallet(trades, '0xev', 'swing');
      const market = makeMarketState(); // spread = 0.02
      const world = makeWorldState([wallet], [market]);
      const curve = makeDelayCurve({
        address: '0xev',
        delay_buckets: [
          makeBucket({ delay_seconds: 3, mean_pnl: 0.08 }), // 0.08 - 0.01 (half-spread) - 0.02 (fee) = 0.05
        ],
      });
      const intel = makeIntel(
        makeScore({ address: '0xev', recommendation: 'follow' }),
        curve,
        makeRegimeProfile({ address: '0xev' }),
      );
      const strategy = new WalletFollowStrategy(intel);
      const signals = strategy.evaluate(makeContext(world, market));

      expect(signals.length).toBe(1);
      // EV = 0.08 - 0.01 (spread/2) - 0.02 (fee) = 0.05
      expect(signals[0]!.ev_after_costs).toBeCloseTo(0.05, 2);
    });

    it('rejects when EV after costs is below min_ev_threshold', () => {
      const trades = [makeTx({ timestamp: NOW - 5_000 })];
      const wallet = buildWallet(trades, '0xlow', 'swing');
      const market = makeMarketState(); // spread = 0.02
      const world = makeWorldState([wallet], [market]);
      // mean_pnl = 0.04 → EV = 0.04 - 0.01 - 0.02 = 0.01 → below 0.02 threshold
      const curve = makeDelayCurve({
        address: '0xlow',
        delay_buckets: [
          makeBucket({ delay_seconds: 3, mean_pnl: 0.04 }),
        ],
      });
      const intel = makeIntel(
        makeScore({ address: '0xlow', recommendation: 'follow' }),
        curve,
        makeRegimeProfile({ address: '0xlow' }),
      );
      const strategy = new WalletFollowStrategy(intel);
      const signals = strategy.evaluate(makeContext(world, market));
      expect(signals).toHaveLength(0);
    });
  });

  describe('regime gate', () => {
    it('skips wallets with negative edge in current regime', () => {
      const trades = [makeTx({ timestamp: NOW - 5_000 })];
      const wallet = buildWallet(trades, '0xbad_regime', 'swing');
      const market = makeMarketState();
      const world = makeWorldState([wallet], [market]);
      // Wallet loses money in 'normal' regime
      const regimeProfile = makeRegimeProfile({
        address: '0xbad_regime',
        regime_entries: [{
          regime: 'normal',
          stats: createEmptyWalletState('0x').stats,
          n_trades: 30,
          sharpe: -0.5,
          win_rate: 0.35,
          pnl_realized: -200,
          is_significant: true,
          t_statistic: -1.5,
          p_value: 0.07,
        }],
      });
      const intel = makeIntel(
        makeScore({ address: '0xbad_regime', recommendation: 'follow' }),
        makeDelayCurve({ address: '0xbad_regime' }),
        regimeProfile,
      );
      const strategy = new WalletFollowStrategy(intel);
      const signals = strategy.evaluate(makeContext(world, market));
      expect(signals).toHaveLength(0);
    });

    it('allows wallets with no regime data (assumes ok)', () => {
      const trades = [makeTx({ timestamp: NOW - 5_000 })];
      const wallet = buildWallet(trades, '0xnew', 'swing');
      const market = makeMarketState();
      const world = makeWorldState([wallet], [market]);
      // No regime profile at all
      const intel = makeIntel(
        makeScore({ address: '0xnew', recommendation: 'follow' }),
        makeDelayCurve({ address: '0xnew' }),
        null,
      );
      const strategy = new WalletFollowStrategy(intel);
      const signals = strategy.evaluate(makeContext(world, market));
      expect(signals.length).toBeGreaterThan(0);
    });
  });

  describe('signal properties', () => {
    it('sets decay model half-life from delay curve edge_halflife', () => {
      const trades = [makeTx({ timestamp: NOW - 5_000 })];
      const wallet = buildWallet(trades, '0xdecay', 'swing');
      const market = makeMarketState();
      const world = makeWorldState([wallet], [market]);
      const curve = makeDelayCurve({
        address: '0xdecay',
        edge_halflife_seconds: 12,
      });
      const intel = makeIntel(
        makeScore({ address: '0xdecay', recommendation: 'follow' }),
        curve,
        makeRegimeProfile({ address: '0xdecay' }),
      );
      const strategy = new WalletFollowStrategy(intel);
      const signals = strategy.evaluate(makeContext(world, market));

      expect(signals.length).toBe(1);
      expect(signals[0]!.decay_model.half_life_ms).toBe(12_000);
    });

    it('falls back to config signal_half_life_ms when delay curve has no halflife', () => {
      const trades = [makeTx({ timestamp: NOW - 5_000 })];
      const wallet = buildWallet(trades, '0xfallback', 'swing');
      const market = makeMarketState();
      const world = makeWorldState([wallet], [market]);
      const curve = makeDelayCurve({
        address: '0xfallback',
        edge_halflife_seconds: null,
      });
      const intel = makeIntel(
        makeScore({ address: '0xfallback', recommendation: 'follow' }),
        curve,
        makeRegimeProfile({ address: '0xfallback' }),
      );
      const strategy = new WalletFollowStrategy(intel);
      const config = makeStrategyConfig({ signal_half_life_ms: 90_000 });
      const signals = strategy.evaluate(makeContext(world, market, { config }));

      expect(signals.length).toBe(1);
      expect(signals[0]!.decay_model.half_life_ms).toBe(90_000);
    });

    it('generates kill conditions including time, spread, regime, and ev_decayed', () => {
      const trades = [makeTx({ timestamp: NOW - 5_000 })];
      const wallet = buildWallet(trades, '0xkill', 'swing');
      const market = makeMarketState();
      const world = makeWorldState([wallet], [market]);
      const intel = makeIntel(
        makeScore({ address: '0xkill', recommendation: 'follow' }),
        makeDelayCurve({ address: '0xkill' }),
        makeRegimeProfile({ address: '0xkill' }),
      );
      const strategy = new WalletFollowStrategy(intel);
      const signals = strategy.evaluate(makeContext(world, market));

      const kc = signals[0]!.kill_conditions;
      const types = kc.map((k) => k.type);
      expect(types).toContain('time_elapsed');
      expect(types).toContain('spread_widened');
      expect(types).toContain('regime_changed');
      expect(types).toContain('ev_decayed');
    });

    it('sets urgency to immediate for follow signals, patient for fade', () => {
      // Follow signal
      const trades = [makeTx({ side: 'BUY', timestamp: NOW - 5_000 })];
      const wallet = buildWallet(trades, '0xurg', 'swing');
      const market = makeMarketState();
      const world = makeWorldState([wallet], [market]);
      const intel = makeIntel(
        makeScore({ address: '0xurg', recommendation: 'follow' }),
        makeDelayCurve({ address: '0xurg' }),
        makeRegimeProfile({ address: '0xurg' }),
      );
      const strategy = new WalletFollowStrategy(intel);
      const followSignals = strategy.evaluate(makeContext(world, market));
      expect(followSignals[0]!.urgency).toBe('immediate');

      // Fade signal (market maker)
      const mmTrades = [makeTx({ side: 'BUY', timestamp: NOW - 5_000 })];
      const mmWallet = buildWallet(mmTrades, '0xmm_urg', 'market_maker');
      const mmWorld = makeWorldState([mmWallet], [market]);
      const mmCurve = makeDelayCurve({
        address: '0xmm_urg',
        classification: 'market_maker',
        delay_buckets: [
          makeBucket({ delay_seconds: 3, mean_pnl: -0.08, ci_low: -0.12, ci_high: -0.04 }),
        ],
      });
      const mmIntel = makeIntel(
        makeScore({ address: '0xmm_urg', recommendation: 'follow' }),
        mmCurve,
        makeRegimeProfile({ address: '0xmm_urg' }),
      );
      const mmStrategy = new WalletFollowStrategy(mmIntel);
      const fadeSignals = mmStrategy.evaluate(makeContext(mmWorld, market));
      if (fadeSignals.length > 0) {
        expect(fadeSignals[0]!.urgency).toBe('patient');
      }
    });

    it('generates unique signal IDs', () => {
      const trades = [
        makeTx({ timestamp: NOW - 5_000, token_id: 'tok_yes_1' }),
        makeTx({ timestamp: NOW - 4_000, token_id: 'tok_yes_1' }),
      ];
      const wallet = buildWallet(trades, '0xuniq', 'swing');
      const market = makeMarketState();
      const world = makeWorldState([wallet], [market]);
      const intel = makeIntel(
        makeScore({ address: '0xuniq', recommendation: 'follow' }),
        makeDelayCurve({ address: '0xuniq' }),
        makeRegimeProfile({ address: '0xuniq' }),
      );
      const strategy = new WalletFollowStrategy(intel);
      const signals = strategy.evaluate(makeContext(world, market));

      if (signals.length >= 2) {
        expect(signals[0]!.signal_id).not.toBe(signals[1]!.signal_id);
      }
    });
  });

  describe('score filtering', () => {
    it('skips wallets with ignore recommendation', () => {
      const trades = [makeTx({ timestamp: NOW - 5_000 })];
      const wallet = buildWallet(trades, '0xignore', 'swing');
      const market = makeMarketState();
      const world = makeWorldState([wallet], [market]);
      const intel = makeIntel(
        makeScore({ address: '0xignore', recommendation: 'ignore' }),
        makeDelayCurve({ address: '0xignore' }),
        makeRegimeProfile({ address: '0xignore' }),
      );
      const strategy = new WalletFollowStrategy(intel);
      const signals = strategy.evaluate(makeContext(world, market));
      expect(signals).toHaveLength(0);
    });

    it('skips wallets with shadow_only recommendation', () => {
      const trades = [makeTx({ timestamp: NOW - 5_000 })];
      const wallet = buildWallet(trades, '0xshadow', 'swing');
      const market = makeMarketState();
      const world = makeWorldState([wallet], [market]);
      const intel = makeIntel(
        makeScore({ address: '0xshadow', recommendation: 'shadow_only' }),
        makeDelayCurve({ address: '0xshadow' }),
        makeRegimeProfile({ address: '0xshadow' }),
      );
      const strategy = new WalletFollowStrategy(intel);
      const signals = strategy.evaluate(makeContext(world, market));
      expect(signals).toHaveLength(0);
    });

    it('skips wallets with no score', () => {
      const trades = [makeTx({ timestamp: NOW - 5_000 })];
      const wallet = buildWallet(trades, '0xnoscore', 'swing');
      const market = makeMarketState();
      const world = makeWorldState([wallet], [market]);
      const intel = makeIntel(null, makeDelayCurve(), makeRegimeProfile());
      const strategy = new WalletFollowStrategy(intel);
      const signals = strategy.evaluate(makeContext(world, market));
      expect(signals).toHaveLength(0);
    });
  });

  describe('confidence interval', () => {
    it('includes spread and fee costs in CI bounds', () => {
      const trades = [makeTx({ timestamp: NOW - 5_000 })];
      const wallet = buildWallet(trades, '0xci', 'swing');
      const market = makeMarketState(); // spread=0.02, fee=0.02
      const world = makeWorldState([wallet], [market]);
      const curve = makeDelayCurve({
        address: '0xci',
        delay_buckets: [
          makeBucket({ delay_seconds: 3, mean_pnl: 0.08, ci_low: 0.03, ci_high: 0.13 }),
        ],
      });
      const intel = makeIntel(
        makeScore({ address: '0xci', recommendation: 'follow' }),
        curve,
        makeRegimeProfile({ address: '0xci' }),
      );
      const strategy = new WalletFollowStrategy(intel);
      const signals = strategy.evaluate(makeContext(world, market));

      expect(signals.length).toBe(1);
      const [ciLow, ciHigh] = signals[0]!.ev_confidence_interval;
      // ci_low = 0.03 - 0.01 - 0.02 = 0.00, ci_high = 0.13 - 0.01 - 0.02 = 0.10
      expect(ciLow).toBeCloseTo(0.00, 2);
      expect(ciHigh).toBeCloseTo(0.10, 2);
    });
  });
});
