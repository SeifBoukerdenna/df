// ---------------------------------------------------------------------------
// Regime Detector — Module 2 (SPEC.md)
//
// Classifies the current market regime from observable features:
//   avg_spread_z_score   — spread widening → high_volatility or low_liquidity
//   volume_z_score       — volume spikes → event_driven; volume drops → low_liquidity
//   wallet_activity_z    — spike in tracked wallet activity → event_driven
//   resolution_rate      — resolutions per hour → resolution_clustering
//   new_market_rate      — new markets per hour → event_driven
//
// Regimes:
//   normal               — baseline, no extreme features
//   high_volatility      — wide spreads + high volume
//   low_liquidity        — wide spreads + LOW volume
//   event_driven         — high wallet activity + volume spikes in specific markets
//   resolution_clustering — many markets resolving simultaneously
//
// Runs every 60 seconds. Logs regime changes to ledger.
// Builds transition matrix and tracks average regime duration.
// ---------------------------------------------------------------------------

import { now } from '../utils/time.js';
import { mean, stddev, zScore } from '../utils/statistics.js';
import { getLogger } from '../utils/logger.js';
import type { MarketState, RegimeState, RegimeFeatures, RegimeName } from './types.js';

const log = getLogger('regime_detector');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RegimeDetectorConfig {
  /** Minimum number of observations before z-scores are meaningful */
  min_observations: number;
  /** Rolling window size for feature history (number of 60s ticks) */
  history_window: number;
  /** Spread z-score threshold for "wide spreads" */
  spread_z_threshold: number;
  /** Volume z-score threshold for "high volume" */
  volume_z_high_threshold: number;
  /** Volume z-score threshold for "low volume" (negative) */
  volume_z_low_threshold: number;
  /** Wallet activity z-score threshold */
  wallet_z_threshold: number;
  /** Resolution rate (per hour) threshold for resolution_clustering */
  resolution_rate_threshold: number;
  /** New market rate (per hour) threshold for event_driven */
  new_market_rate_threshold: number;
  /** Smoothing: require N consecutive ticks in new regime before switching */
  regime_change_persistence: number;
}

const DEFAULT_CONFIG: RegimeDetectorConfig = {
  min_observations: 10,
  history_window: 120, // 2 hours of 60s ticks
  spread_z_threshold: 1.5,
  volume_z_high_threshold: 1.5,
  volume_z_low_threshold: -1.5,
  wallet_z_threshold: 2.0,
  resolution_rate_threshold: 3.0,
  new_market_rate_threshold: 5.0,
  regime_change_persistence: 2,
};

// ---------------------------------------------------------------------------
// Feature observation ring buffer
// ---------------------------------------------------------------------------

interface FeatureObservation {
  timestamp: number;
  avg_spread_bps: number;
  total_volume_1h: number;
  active_wallet_count: number;
  resolutions_1h: number;
  new_markets_1h: number;
}

// ---------------------------------------------------------------------------
// Regime transition tracking
// ---------------------------------------------------------------------------

const ALL_REGIMES: RegimeName[] = [
  'normal',
  'high_volatility',
  'low_liquidity',
  'event_driven',
  'resolution_clustering',
];

export interface RegimeTransitionMatrix {
  /** Counts of transitions from regime i to regime j */
  counts: Map<RegimeName, Map<RegimeName, number>>;
  /** Normalized probabilities P(to | from) */
  probabilities: Map<RegimeName, Map<RegimeName, number>>;
}

export interface RegimeDurationStats {
  /** Average duration per regime in ms */
  avg_duration_ms: Map<RegimeName, number>;
  /** Number of completed spans per regime */
  span_count: Map<RegimeName, number>;
}

// ---------------------------------------------------------------------------
// Regime Detector class
// ---------------------------------------------------------------------------

export class RegimeDetector {
  private config: RegimeDetectorConfig;
  private history: FeatureObservation[] = [];
  private currentState: RegimeState;

  // Transition tracking
  private transitionCounts: Map<RegimeName, Map<RegimeName, number>> = new Map();
  private regimeDurations: Map<RegimeName, number[]> = new Map();
  private lastRegimeStart: number = 0;
  private firstDetectCalled: boolean = false;

  // Persistence filter: candidate regime must be seen N consecutive times
  private candidateRegime: RegimeName | null = null;
  private candidateCount: number = 0;

  // Event counters (set externally between ticks)
  private resolutionTimestamps: number[] = [];
  private newMarketTimestamps: number[] = [];

  constructor(config: Partial<RegimeDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.currentState = {
      current_regime: 'normal',
      regime_since: now(),
      confidence: 1.0,
      features: {
        avg_spread_z_score: 0,
        volume_z_score: 0,
        wallet_activity_z_score: 0,
        resolution_rate: 0,
        new_market_rate: 0,
      },
    };
    // Initialize transition counts
    for (const r of ALL_REGIMES) {
      this.transitionCounts.set(r, new Map());
      this.regimeDurations.set(r, []);
      for (const s of ALL_REGIMES) {
        this.transitionCounts.get(r)!.set(s, 0);
      }
    }
  }

  // -----------------------------------------------------------------------
  // External event recording
  // -----------------------------------------------------------------------

  /** Record a market resolution event (call when a market resolves) */
  recordResolution(timestamp: number = now()): void {
    this.resolutionTimestamps.push(timestamp);
  }

  /** Record a new market creation event */
  recordNewMarket(timestamp: number = now()): void {
    this.newMarketTimestamps.push(timestamp);
  }

  // -----------------------------------------------------------------------
  // Main detection tick — call every 60 seconds
  // -----------------------------------------------------------------------

  /**
   * Runs regime detection based on current market states and wallet activity.
   *
   * @param markets - All active market states
   * @param activeWalletCount - Number of tracked wallets that traded in the last 60s
   * @param nowMs - Current timestamp (for testing)
   * @returns The current RegimeState (also stored internally)
   */
  detect(
    markets: MarketState[],
    activeWalletCount: number,
    nowMs: number = now(),
  ): RegimeState {
    // Initialize lastRegimeStart on first call to use the caller's timestamp
    if (!this.firstDetectCalled) {
      this.lastRegimeStart = nowMs;
      this.currentState.regime_since = nowMs;
      this.firstDetectCalled = true;
    }

    // Compute raw features from market states
    const observation = this.computeObservation(markets, activeWalletCount, nowMs);
    this.pushObservation(observation);

    // Compute z-scores from history
    const features = this.computeFeatures(observation);

    // Classify regime from features
    const { regime, confidence } = this.classifyRegime(features);

    // Persistence filter: require consecutive agreement
    const confirmedRegime = this.applyPersistenceFilter(regime);

    // Check for regime change
    const previousRegime = this.currentState.current_regime;
    if (confirmedRegime !== previousRegime) {
      // Record transition
      const fromCounts = this.transitionCounts.get(previousRegime)!;
      fromCounts.set(confirmedRegime, (fromCounts.get(confirmedRegime) ?? 0) + 1);

      // Record duration of previous regime
      const duration = nowMs - this.lastRegimeStart;
      this.regimeDurations.get(previousRegime)!.push(duration);
      this.lastRegimeStart = nowMs;

      log.info(
        { from: previousRegime, to: confirmedRegime, confidence, features },
        'Regime change detected',
      );
    }

    this.currentState = {
      current_regime: confirmedRegime,
      regime_since: confirmedRegime !== previousRegime ? nowMs : this.currentState.regime_since,
      confidence,
      features,
    };

    return this.currentState;
  }

  // -----------------------------------------------------------------------
  // Accessors
  // -----------------------------------------------------------------------

  /** Returns the current regime state */
  getState(): RegimeState {
    return this.currentState;
  }

  /** Returns the transition matrix (counts and normalized probabilities) */
  getTransitionMatrix(): RegimeTransitionMatrix {
    const probabilities = new Map<RegimeName, Map<RegimeName, number>>();

    for (const from of ALL_REGIMES) {
      const fromCounts = this.transitionCounts.get(from)!;
      const totalFromTransitions = Array.from(fromCounts.values()).reduce((a, b) => a + b, 0);

      const probs = new Map<RegimeName, number>();
      for (const to of ALL_REGIMES) {
        probs.set(to, totalFromTransitions > 0 ? fromCounts.get(to)! / totalFromTransitions : 0);
      }
      probabilities.set(from, probs);
    }

    return { counts: this.transitionCounts, probabilities };
  }

  /** Returns average duration stats per regime */
  getDurationStats(): RegimeDurationStats {
    const avgDuration = new Map<RegimeName, number>();
    const spanCount = new Map<RegimeName, number>();

    for (const regime of ALL_REGIMES) {
      const durations = this.regimeDurations.get(regime)!;
      spanCount.set(regime, durations.length);
      avgDuration.set(regime, durations.length > 0 ? mean(durations) : 0);
    }

    return { avg_duration_ms: avgDuration, span_count: spanCount };
  }

  /** Returns the number of observations in history */
  getHistoryLength(): number {
    return this.history.length;
  }

  // -----------------------------------------------------------------------
  // Internal: observation computation
  // -----------------------------------------------------------------------

  private computeObservation(
    markets: MarketState[],
    activeWalletCount: number,
    nowMs: number,
  ): FeatureObservation {
    // Average spread across all active markets with book data
    const activeMarkets = markets.filter(
      (m) => m.status === 'active' && m.book.yes.spread_bps > 0,
    );

    const avgSpreadBps =
      activeMarkets.length > 0
        ? mean(activeMarkets.map((m) => (m.book.yes.spread_bps + m.book.no.spread_bps) / 2))
        : 0;

    // Total volume across all markets (1h)
    const totalVolume1h = markets.reduce((sum, m) => sum + m.volume_1h, 0);

    // Resolution and new market rates (events in last hour)
    const oneHourAgo = nowMs - 3600_000;
    this.resolutionTimestamps = this.resolutionTimestamps.filter((t) => t > oneHourAgo);
    this.newMarketTimestamps = this.newMarketTimestamps.filter((t) => t > oneHourAgo);

    return {
      timestamp: nowMs,
      avg_spread_bps: avgSpreadBps,
      total_volume_1h: totalVolume1h,
      active_wallet_count: activeWalletCount,
      resolutions_1h: this.resolutionTimestamps.length,
      new_markets_1h: this.newMarketTimestamps.length,
    };
  }

  private pushObservation(obs: FeatureObservation): void {
    this.history.push(obs);
    // Trim to window size
    if (this.history.length > this.config.history_window) {
      this.history = this.history.slice(this.history.length - this.config.history_window);
    }
  }

  // -----------------------------------------------------------------------
  // Internal: z-score computation
  // -----------------------------------------------------------------------

  private computeFeatures(current: FeatureObservation): RegimeFeatures {
    const n = this.history.length;

    if (n < this.config.min_observations) {
      // Not enough history — return zeros (regime stays 'normal')
      return {
        avg_spread_z_score: 0,
        volume_z_score: 0,
        wallet_activity_z_score: 0,
        resolution_rate: current.resolutions_1h,
        new_market_rate: current.new_markets_1h,
      };
    }

    const spreads = this.history.map((o) => o.avg_spread_bps);
    const volumes = this.history.map((o) => o.total_volume_1h);
    const wallets = this.history.map((o) => o.active_wallet_count);

    const spreadMean = mean(spreads);
    const spreadStd = stddev(spreads);
    const volumeMean = mean(volumes);
    const volumeStd = stddev(volumes);
    const walletMean = mean(wallets);
    const walletStd = stddev(wallets);

    return {
      avg_spread_z_score: zScore(current.avg_spread_bps, spreadMean, spreadStd),
      volume_z_score: zScore(current.total_volume_1h, volumeMean, volumeStd),
      wallet_activity_z_score: zScore(current.active_wallet_count, walletMean, walletStd),
      resolution_rate: current.resolutions_1h,
      new_market_rate: current.new_markets_1h,
    };
  }

  // -----------------------------------------------------------------------
  // Internal: regime classification from features
  // -----------------------------------------------------------------------

  private classifyRegime(features: RegimeFeatures): { regime: RegimeName; confidence: number } {
    // Score each regime. Higher score = more likely.
    const scores = new Map<RegimeName, number>();

    // --- resolution_clustering: many markets resolving ---
    const resolutionScore =
      features.resolution_rate >= this.config.resolution_rate_threshold ? 1.0 : 0;
    scores.set('resolution_clustering', resolutionScore);

    // --- event_driven: wallet activity spike + volume spike in localized markets ---
    const walletSpike = features.wallet_activity_z_score >= this.config.wallet_z_threshold;
    const volumeSpike = features.volume_z_score >= this.config.volume_z_high_threshold;
    const newMarketSpike = features.new_market_rate >= this.config.new_market_rate_threshold;
    let eventScore = 0;
    if (walletSpike && volumeSpike) eventScore = 1.0;
    else if (walletSpike || newMarketSpike) eventScore = 0.6;
    else if (volumeSpike && features.wallet_activity_z_score >= 1.0) eventScore = 0.5;
    scores.set('event_driven', eventScore);

    // --- high_volatility: wide spreads + high volume ---
    const wideSpread = features.avg_spread_z_score >= this.config.spread_z_threshold;
    const highVolume = features.volume_z_score >= this.config.volume_z_high_threshold;
    let hvScore = 0;
    if (wideSpread && highVolume) hvScore = 1.0;
    else if (wideSpread && features.volume_z_score > 0) hvScore = 0.6;
    scores.set('high_volatility', hvScore);

    // --- low_liquidity: wide spreads + LOW volume ---
    const lowVolume = features.volume_z_score <= this.config.volume_z_low_threshold;
    let llScore = 0;
    if (wideSpread && lowVolume) llScore = 1.0;
    else if (wideSpread && features.volume_z_score < 0) llScore = 0.5;
    else if (lowVolume) llScore = 0.4;
    scores.set('low_liquidity', llScore);

    // --- normal: default when nothing is extreme ---
    // Normal gets a baseline score; it wins when no other regime is dominant
    const maxNonNormalScore = Math.max(
      resolutionScore,
      eventScore,
      hvScore,
      llScore,
    );
    const normalScore = maxNonNormalScore < 0.4 ? 0.8 : 0.3 - maxNonNormalScore * 0.2;
    scores.set('normal', Math.max(0, normalScore));

    // Pick the regime with the highest score
    let bestRegime: RegimeName = 'normal';
    let bestScore = -1;

    for (const [regime, score] of scores) {
      if (score > bestScore) {
        bestScore = score;
        bestRegime = regime;
      }
    }

    // Confidence: how dominant is the winning regime?
    const allScores = Array.from(scores.values());
    const totalScore = allScores.reduce((a, b) => a + b, 0);
    const confidence = totalScore > 0 ? bestScore / totalScore : 1.0;

    return { regime: bestRegime, confidence: Math.min(1.0, confidence) };
  }

  // -----------------------------------------------------------------------
  // Internal: persistence filter
  // -----------------------------------------------------------------------

  private applyPersistenceFilter(detected: RegimeName): RegimeName {
    if (detected === this.currentState.current_regime) {
      // Same as current regime — reset candidate
      this.candidateRegime = null;
      this.candidateCount = 0;
      return detected;
    }

    if (detected === this.candidateRegime) {
      this.candidateCount++;
      if (this.candidateCount >= this.config.regime_change_persistence) {
        // Confirmed: switch to new regime
        this.candidateRegime = null;
        this.candidateCount = 0;
        return detected;
      }
    } else {
      // New candidate
      this.candidateRegime = detected;
      this.candidateCount = 1;
      if (this.config.regime_change_persistence <= 1) {
        // No persistence required
        this.candidateRegime = null;
        this.candidateCount = 0;
        return detected;
      }
    }

    // Not yet confirmed — stay in current regime
    return this.currentState.current_regime;
  }
}

// ---------------------------------------------------------------------------
// Convenience: standalone function for backward compatibility
// ---------------------------------------------------------------------------

/**
 * Creates a default RegimeState without market data.
 * Used for initialization before the detector has observations.
 */
export function detectRegime(): RegimeState {
  return {
    current_regime: 'normal',
    regime_since: now(),
    confidence: 1.0,
    features: {
      avg_spread_z_score: 0,
      volume_z_score: 0,
      wallet_activity_z_score: 0,
      resolution_rate: 0,
      new_market_rate: 0,
    },
  };
}
