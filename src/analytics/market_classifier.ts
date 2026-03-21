// ---------------------------------------------------------------------------
// Market Classifier
//
// Computes market features, classifies into Type 1/2/3, computes efficiency
// score, determines viable strategies, and produces the EdgeMap.
//
// From MARKET_SELECTION.md:
// - Type 1: Slow / Narrative-Driven
// - Type 2: Event-Driven / Mid-Speed
// - Type 3: HFT / Bot-Dominated
// ---------------------------------------------------------------------------

import { getLogger } from '../utils/logger.js';
import { now } from '../utils/time.js';
import { mean, stddev, percentileRank } from '../utils/statistics.js';
import { bookDepthWithin } from '../utils/math.js';
import { clamp } from '../utils/math.js';
import type { MarketState } from '../state/types.js';
import type {
  MarketFeatures,
  MarketType,
  MarketClassification,
  EdgeMap,
  EdgeMapEntry,
  EdgeRecommendation,
  ReclassificationEvent,
} from './types.js';

const log = getLogger('market_classifier');

// ---------------------------------------------------------------------------
// Feature history ring buffers (per market)
// ---------------------------------------------------------------------------

export interface MarketObservations {
  /** Spread observations for CV computation. */
  spreads: number[];
  /** Timestamps of distinct book changes (for avg_update_interval_ms). */
  bookChangeTimestamps: number[];
  /** Staleness observations (ms). */
  stalenessObservations: number[];
  /** Trade timestamps (for trade_rate_per_min). */
  tradeTimestamps: number[];
  /** Trade sizes in USD. */
  tradeSizes: number[];
  /** Inter-trade arrival times in ms (for dispersion). */
  interTradeArrivals: number[];
  /** Complement gap observations: { timestamp, gapSize }. */
  complementGaps: { timestamp: number; size: number }[];
  /** Wallet volume in 7d: { wallet, volume }. */
  walletVolumes: Map<string, number>;
  /** Trade response times in ms (for bot detection). */
  responseTimesMs: number[];
  /** Previous book hash to detect distinct changes. */
  lastBookHash: string;
}

const MAX_OBSERVATIONS = 1000;
const OBSERVATION_WINDOW_MS = 3_600_000; // 1 hour for most rolling features
const WALLET_VOLUME_WINDOW_MS = 7 * 24 * 3_600_000; // 7 days

/**
 * Creates empty observations for a newly tracked market.
 */
export function createEmptyObservations(): MarketObservations {
  return {
    spreads: [],
    bookChangeTimestamps: [],
    stalenessObservations: [],
    tradeTimestamps: [],
    tradeSizes: [],
    interTradeArrivals: [],
    complementGaps: [],
    walletVolumes: new Map(),
    responseTimesMs: [],
    lastBookHash: '',
  };
}

// ---------------------------------------------------------------------------
// Observation recording functions
// ---------------------------------------------------------------------------

function trimToWindow(arr: number[], windowMs: number): void {
  const cutoff = now() - windowMs;
  let i = 0;
  while (i < arr.length && arr[i]! < cutoff) i++;
  if (i > 0) arr.splice(0, i);
}

function trimToMax(arr: number[] | { timestamp: number; size: number }[]): void {
  if (arr.length > MAX_OBSERVATIONS) {
    arr.splice(0, arr.length - MAX_OBSERVATIONS);
  }
}

/**
 * Records a book update observation. Call this on every book snapshot.
 */
export function recordBookUpdate(
  obs: MarketObservations,
  market: MarketState,
  side: 'yes' | 'no',
): void {
  const book = market.book[side];
  const t = book.last_updated;

  // Record spread
  if (book.spread > 0) {
    obs.spreads.push(book.spread_bps);
    trimToMax(obs.spreads);
  }

  // Record staleness
  obs.stalenessObservations.push(market.staleness_ms);
  trimToMax(obs.stalenessObservations);

  // Detect distinct book change (hash of top 3 levels)
  const hash = bookHash(book.bids.slice(0, 3), book.asks.slice(0, 3));
  if (hash !== obs.lastBookHash) {
    obs.bookChangeTimestamps.push(t);
    trimToMax(obs.bookChangeTimestamps);
    obs.lastBookHash = hash;
  }
}

/**
 * Records a trade observation.
 */
export function recordTrade(
  obs: MarketObservations,
  tradeTimestamp: number,
  tradeSizeUsd: number,
  makerWallet: string,
  takerWallet: string,
  responseTimeMs: number | null,
): void {
  // Trade timestamp for rate computation
  const lastTrade = obs.tradeTimestamps[obs.tradeTimestamps.length - 1];
  obs.tradeTimestamps.push(tradeTimestamp);
  trimToMax(obs.tradeTimestamps);

  // Trade size
  obs.tradeSizes.push(tradeSizeUsd);
  trimToMax(obs.tradeSizes);

  // Inter-trade arrival
  if (lastTrade !== undefined) {
    const arrival = tradeTimestamp - lastTrade;
    if (arrival > 0) {
      obs.interTradeArrivals.push(arrival);
      trimToMax(obs.interTradeArrivals);
    }
  }

  // Wallet volume tracking
  const currentVol = obs.walletVolumes.get(makerWallet) ?? 0;
  obs.walletVolumes.set(makerWallet, currentVol + tradeSizeUsd);
  const takerVol = obs.walletVolumes.get(takerWallet) ?? 0;
  obs.walletVolumes.set(takerWallet, takerVol + tradeSizeUsd);

  // Response time for bot detection
  if (responseTimeMs !== null && responseTimeMs >= 0) {
    obs.responseTimesMs.push(responseTimeMs);
    trimToMax(obs.responseTimesMs);
  }
}

/**
 * Records a complement gap observation.
 */
export function recordComplementGap(
  obs: MarketObservations,
  timestamp: number,
  gapSize: number,
  feeRate: number,
): void {
  // Only record executable gaps (above 2× fee)
  if (Math.abs(gapSize) > 2 * feeRate) {
    obs.complementGaps.push({ timestamp, size: Math.abs(gapSize) });
    trimToMax(obs.complementGaps);
  }
}

// ---------------------------------------------------------------------------
// Feature computation
// ---------------------------------------------------------------------------

function bookHash(bids: [number, number][], asks: [number, number][]): string {
  const parts: string[] = [];
  for (const [p, s] of bids) parts.push(`b${p}:${s}`);
  for (const [p, s] of asks) parts.push(`a${p}:${s}`);
  return parts.join('|');
}

/**
 * Computes the Herfindahl-Hirschman Index of depth concentration across
 * the top N levels of one book side.
 *
 * HHI = Σ(share_i²) where share_i = size_i / total_size
 * Range: [1/N, 1.0]. Higher = more concentrated.
 */
function computeDepthHerfindahl(levels: [number, number][], maxLevels: number = 5): number {
  const topLevels = levels.slice(0, maxLevels);
  if (topLevels.length === 0) return 0;

  const totalSize = topLevels.reduce((sum, [, s]) => sum + s, 0);
  if (totalSize === 0) return 0;

  let hhi = 0;
  for (const [, size] of topLevels) {
    const share = size / totalSize;
    hhi += share * share;
  }

  return hhi;
}

/**
 * Computes the HHI of wallet trading volume.
 * Higher = more concentrated (fewer dominant wallets).
 */
function computeWalletHHI(walletVolumes: Map<string, number>): number {
  if (walletVolumes.size === 0) return 0;

  let totalVolume = 0;
  for (const v of walletVolumes.values()) totalVolume += v;
  if (totalVolume === 0) return 0;

  let hhi = 0;
  for (const v of walletVolumes.values()) {
    const share = v / totalVolume;
    hhi += share * share;
  }

  return hhi;
}

/**
 * Finds the dominant wallet (>20% volume share), if any.
 */
function findDominantWallet(
  walletVolumes: Map<string, number>,
): { address: string; share: number } | null {
  if (walletVolumes.size === 0) return null;

  let totalVolume = 0;
  for (const v of walletVolumes.values()) totalVolume += v;
  if (totalVolume === 0) return null;

  let maxAddress = '';
  let maxVolume = 0;
  for (const [addr, vol] of walletVolumes) {
    if (vol > maxVolume) {
      maxVolume = vol;
      maxAddress = addr;
    }
  }

  const share = maxVolume / totalVolume;
  return share > 0.20 ? { address: maxAddress, share } : null;
}

/**
 * Estimates the fraction of trades placed by automated systems.
 *
 * Indicators:
 * - Consistent sub-second response times
 * - Round-number sizing
 * - High trade frequency
 */
function estimateBotRatio(obs: MarketObservations): number {
  if (obs.tradeTimestamps.length < 5) return 0;

  let signals = 0;
  let totalSignals = 0;

  // Signal 1: Response time distribution — sub-second responses suggest bots
  if (obs.responseTimesMs.length > 0) {
    const subSecond = obs.responseTimesMs.filter((t) => t < 1000).length;
    const ratio = subSecond / obs.responseTimesMs.length;
    signals += ratio;
    totalSignals++;
  }

  // Signal 2: Trade size uniformity — bots often use round numbers or fixed sizes
  if (obs.tradeSizes.length >= 5) {
    const rounded = obs.tradeSizes.filter((s) => {
      const r = Math.round(s);
      return Math.abs(s - r) < 0.01 || s % 10 === 0 || s % 5 === 0;
    }).length;
    const ratio = rounded / obs.tradeSizes.length;
    signals += ratio;
    totalSignals++;
  }

  // Signal 3: Trade arrival regularity — bots produce more regular arrivals
  if (obs.interTradeArrivals.length >= 5) {
    const m = mean(obs.interTradeArrivals);
    const s = stddev(obs.interTradeArrivals);
    // Low CV = regular arrivals = more bot-like
    const cv = m > 0 ? s / m : 1;
    signals += clamp(1 - cv, 0, 1);
    totalSignals++;
  }

  // Signal 4: High trade frequency itself is a bot indicator
  const tradeRate = computeTradeRate(obs);
  if (tradeRate > 10) {
    signals += clamp((tradeRate - 10) / 50, 0, 1);
    totalSignals++;
  }

  if (totalSignals === 0) return 0;
  return clamp(signals / totalSignals, 0, 1);
}

function computeTradeRate(obs: MarketObservations): number {
  const cutoff = now() - OBSERVATION_WINDOW_MS;
  const recentTrades = obs.tradeTimestamps.filter((t) => t > cutoff);
  const windowMinutes = OBSERVATION_WINDOW_MS / 60_000;
  return recentTrades.length / windowMinutes;
}

/**
 * Estimates complement gap half-life from historical gap observations.
 * Returns null if insufficient data.
 */
function computeGapHalfLife(obs: MarketObservations): number | null {
  const gaps = obs.complementGaps;
  if (gaps.length < 3) return null;

  // Estimate: median time between consecutive gaps
  // (rough proxy — real half-life requires tracking gap decay)
  const intervals: number[] = [];
  for (let i = 1; i < gaps.length; i++) {
    intervals.push(gaps[i]!.timestamp - gaps[i - 1]!.timestamp);
  }
  if (intervals.length === 0) return null;

  const sorted = [...intervals].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * Computes all market features from current state and historical observations.
 */
export function computeMarketFeatures(
  market: MarketState,
  obs: MarketObservations,
): MarketFeatures {
  const t = now();

  // Spread characteristics
  const spreadAvgAbs = obs.spreads.length > 0
    ? mean(obs.spreads.map((bps) => bps / 10000 * (market.book.yes.mid || 0.5)))
    : market.book.yes.spread;
  const spreadAvgBps = obs.spreads.length > 0 ? mean(obs.spreads) : market.book.yes.spread_bps;
  const spreadStd = obs.spreads.length >= 3 ? stddev(obs.spreads) : 0;
  const spreadCv = spreadAvgBps > 0 ? spreadStd / spreadAvgBps : 0;

  // Spread regime: based on percentile rank of current spread within history
  let spreadRegime: 'tight' | 'normal' | 'wide' = 'normal';
  if (obs.spreads.length >= 10) {
    const currentRank = percentileRank(market.book.yes.spread_bps, obs.spreads);
    if (currentRank < 0.25) spreadRegime = 'tight';
    else if (currentRank > 0.75) spreadRegime = 'wide';
  }

  // Book dynamics
  const avgUpdateInterval = computeAvgUpdateInterval(obs);
  const bookStalenessAvg = obs.stalenessObservations.length > 0
    ? mean(obs.stalenessObservations)
    : market.staleness_ms;

  // Depth
  const yesBook = market.book.yes;
  const noBook = market.book.no;
  const bidDepth1 = bookDepthWithin(yesBook.bids, 0.01, yesBook.bids[0]?.[0] ?? 0)
    + bookDepthWithin(noBook.bids, 0.01, noBook.bids[0]?.[0] ?? 0);
  const askDepth1 = bookDepthWithin(yesBook.asks, 0.01, yesBook.asks[0]?.[0] ?? 0)
    + bookDepthWithin(noBook.asks, 0.01, noBook.asks[0]?.[0] ?? 0);
  const bidDepth5 = bookDepthWithin(yesBook.bids, 0.05, yesBook.bids[0]?.[0] ?? 0)
    + bookDepthWithin(noBook.bids, 0.05, noBook.bids[0]?.[0] ?? 0);
  const askDepth5 = bookDepthWithin(yesBook.asks, 0.05, yesBook.asks[0]?.[0] ?? 0)
    + bookDepthWithin(noBook.asks, 0.05, noBook.asks[0]?.[0] ?? 0);

  // Depth concentration
  const depthHerfBid = computeDepthHerfindahl(yesBook.bids);
  const depthHerfAsk = computeDepthHerfindahl(yesBook.asks);

  // Trade activity
  const tradeRate = computeTradeRate(obs);
  const avgTradeSize = obs.tradeSizes.length > 0 ? mean(obs.tradeSizes) : 0;

  // Trade arrival dispersion (coefficient of dispersion = variance/mean)
  let tradeArrivalDispersion = 1.0; // default Poisson-like
  if (obs.interTradeArrivals.length >= 5) {
    const m = mean(obs.interTradeArrivals);
    if (m > 0) {
      const v = obs.interTradeArrivals.reduce((sum, x) => sum + (x - m) ** 2, 0) / obs.interTradeArrivals.length;
      tradeArrivalDispersion = v / m;
    }
  }

  // Complement gap dynamics
  const gapHalfLife = computeGapHalfLife(obs);
  const cutoff1h = t - OBSERVATION_WINDOW_MS;
  const recentGaps = obs.complementGaps.filter((g) => g.timestamp > cutoff1h);
  const gapFreqPerHour = recentGaps.length;
  const gapMedianSize = recentGaps.length > 0
    ? [...recentGaps.map((g) => g.size)].sort((a, b) => a - b)[Math.floor(recentGaps.length / 2)]!
    : 0;

  // Participant structure
  const walletHHI = computeWalletHHI(obs.walletVolumes);
  const dominant = findDominantWallet(obs.walletVolumes);
  const botRatio = estimateBotRatio(obs);

  return {
    market_id: market.market_id,
    computed_at: t,
    spread_avg_abs: spreadAvgAbs,
    spread_avg_bps: spreadAvgBps,
    spread_cv: spreadCv,
    spread_regime: spreadRegime,
    avg_update_interval_ms: avgUpdateInterval,
    book_staleness_ms_avg: bookStalenessAvg,
    bid_depth_1pct: bidDepth1,
    ask_depth_1pct: askDepth1,
    bid_depth_5pct: bidDepth5,
    ask_depth_5pct: askDepth5,
    depth_herfindahl_bid: depthHerfBid,
    depth_herfindahl_ask: depthHerfAsk,
    queue_depth_at_best_bid: yesBook.queue_depth_at_best,
    queue_depth_at_best_ask: noBook.queue_depth_at_best,
    trade_rate_per_min: tradeRate,
    avg_trade_size_usd: avgTradeSize,
    trade_arrival_dispersion: tradeArrivalDispersion,
    complement_gap_half_life_ms: gapHalfLife,
    complement_gap_frequency_per_hour: gapFreqPerHour,
    complement_gap_median_size: gapMedianSize,
    wallet_concentration_hhi: walletHHI,
    dominant_wallet_address: dominant?.address ?? null,
    dominant_wallet_share: dominant?.share ?? 0,
    bot_ratio: botRatio,
    breakeven_latency_ms: null,
    edge_halflife_ms: null,
  };
}

function computeAvgUpdateInterval(obs: MarketObservations): number {
  const ts = obs.bookChangeTimestamps;
  if (ts.length < 2) return 60_000; // default to 60s if no data

  const intervals: number[] = [];
  for (let i = 1; i < ts.length; i++) {
    intervals.push(ts[i]! - ts[i - 1]!);
  }

  return intervals.length > 0 ? mean(intervals) : 60_000;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classifies a market into Type 1, 2, or 3 based on its features.
 * Returns the type and a confidence score.
 */
export function classifyMarketType(features: MarketFeatures): { type: MarketType; confidence: number } {
  // Score each type independently, pick highest
  const type1Score = scoreType1(features);
  const type2Score = scoreType2(features);
  const type3Score = scoreType3(features);

  const maxScore = Math.max(type1Score, type2Score, type3Score);

  if (maxScore === 0) {
    // Default to Type 2 if no clear signal
    return { type: 2, confidence: 0.3 };
  }

  const totalScore = type1Score + type2Score + type3Score;
  let type: MarketType;
  let rawConfidence: number;

  if (type1Score === maxScore) {
    type = 1;
    rawConfidence = type1Score / totalScore;
  } else if (type3Score === maxScore) {
    type = 3;
    rawConfidence = type3Score / totalScore;
  } else {
    type = 2;
    rawConfidence = type2Score / totalScore;
  }

  return { type, confidence: clamp(rawConfidence, 0.1, 1.0) };
}

/**
 * Type 1: Slow / Narrative-Driven
 * - avg_update_interval_ms > 10000
 * - book_staleness_ms_avg > 15000
 * - spread_bps_avg > 300
 * - trade_rate_per_min < 2
 * - wallet_concentration_hhi < 0.10
 * - bot_ratio < 0.3
 */
function scoreType1(f: MarketFeatures): number {
  let score = 0;
  const factors = 6;

  if (f.avg_update_interval_ms > 10_000) score += 1;
  else if (f.avg_update_interval_ms > 5_000) score += 0.5;

  if (f.book_staleness_ms_avg > 15_000) score += 1;
  else if (f.book_staleness_ms_avg > 8_000) score += 0.5;

  if (f.spread_avg_bps > 300) score += 1;
  else if (f.spread_avg_bps > 150) score += 0.5;

  if (f.trade_rate_per_min < 2) score += 1;
  else if (f.trade_rate_per_min < 5) score += 0.5;

  if (f.wallet_concentration_hhi < 0.10) score += 1;
  else if (f.wallet_concentration_hhi < 0.15) score += 0.5;

  if (f.bot_ratio < 0.3) score += 1;
  else if (f.bot_ratio < 0.5) score += 0.5;

  return score / factors;
}

/**
 * Type 2: Event-Driven / Mid-Speed
 * - avg_update_interval_ms between 2000 and 10000
 * - trade_rate_per_min between 2 and 15
 * - Bursty trade flow (high dispersion)
 * - wallet_concentration_hhi between 0.10 and 0.25
 */
function scoreType2(f: MarketFeatures): number {
  let score = 0;
  const factors = 4;

  if (f.avg_update_interval_ms >= 2_000 && f.avg_update_interval_ms <= 10_000) score += 1;
  else if (f.avg_update_interval_ms > 1_000 && f.avg_update_interval_ms < 15_000) score += 0.5;

  if (f.trade_rate_per_min >= 2 && f.trade_rate_per_min <= 15) score += 1;
  else if (f.trade_rate_per_min > 1 && f.trade_rate_per_min < 20) score += 0.5;

  // Bursty trade flow — coefficient of dispersion > 1 indicates clustering
  if (f.trade_arrival_dispersion > 2.0) score += 1;
  else if (f.trade_arrival_dispersion > 1.2) score += 0.5;

  if (f.wallet_concentration_hhi >= 0.10 && f.wallet_concentration_hhi <= 0.25) score += 1;
  else if (f.wallet_concentration_hhi >= 0.05 && f.wallet_concentration_hhi <= 0.35) score += 0.5;

  return score / factors;
}

/**
 * Type 3: HFT / Bot-Dominated
 * - avg_update_interval_ms < 2000
 * - spread_bps_avg < 100
 * - book_staleness_ms_avg < 3000
 * - wallet_concentration_hhi > 0.25
 * - bot_ratio > 0.7
 * - complement_gap_half_life_ms < 3000
 */
function scoreType3(f: MarketFeatures): number {
  let score = 0;
  const factors = 6;

  if (f.avg_update_interval_ms < 2_000) score += 1;
  else if (f.avg_update_interval_ms < 3_000) score += 0.5;

  if (f.spread_avg_bps < 100) score += 1;
  else if (f.spread_avg_bps < 200) score += 0.5;

  if (f.book_staleness_ms_avg < 3_000) score += 1;
  else if (f.book_staleness_ms_avg < 5_000) score += 0.5;

  if (f.wallet_concentration_hhi > 0.25) score += 1;
  else if (f.wallet_concentration_hhi > 0.15) score += 0.5;

  if (f.bot_ratio > 0.7) score += 1;
  else if (f.bot_ratio > 0.5) score += 0.5;

  if (f.complement_gap_half_life_ms !== null && f.complement_gap_half_life_ms < 3_000) score += 1;
  else if (f.complement_gap_half_life_ms !== null && f.complement_gap_half_life_ms < 5_000) score += 0.5;

  return score / factors;
}

// ---------------------------------------------------------------------------
// Efficiency score
// ---------------------------------------------------------------------------

/**
 * Computes the market efficiency score using the weighted formula from
 * MARKET_SELECTION.md.
 *
 * market_efficiency_score = weighted_sum(
 *   0.25 × normalized(1 / spread_bps_avg),
 *   0.20 × normalized(1 / avg_update_interval_ms),
 *   0.20 × normalized(1 / complement_gap_half_life),
 *   0.15 × normalized(wallet_concentration_hhi),
 *   0.10 × normalized(1 / book_staleness_ms_avg),
 *   0.10 × normalized(bot_ratio)
 * )
 *
 * Scale: 0.0 (completely inefficient) to 1.0 (perfectly efficient).
 */
export function computeEfficiencyScore(features: MarketFeatures): number {
  // Normalize each component to [0, 1] using sigmoid-like transforms.
  // Higher values mean MORE efficient (harder to exploit).

  // Tighter spread → more efficient
  // 50 bps → ~0.8, 200 bps → ~0.33, 500 bps → ~0.17
  const spreadNorm = features.spread_avg_bps > 0
    ? 1 / (1 + features.spread_avg_bps / 100)
    : 0;

  // Faster updates → more efficient
  // 500ms → ~0.8, 2000ms → ~0.33, 10000ms → ~0.09
  const updateNorm = features.avg_update_interval_ms > 0
    ? 1 / (1 + features.avg_update_interval_ms / 1000)
    : 0;

  // Faster gap closure → more efficient
  // 1000ms → ~0.67, 3000ms → ~0.40, 10000ms → ~0.17
  const gapHalfLife = features.complement_gap_half_life_ms ?? 30_000; // default: very slow
  const gapNorm = gapHalfLife > 0
    ? 1 / (1 + gapHalfLife / 2000)
    : 0;

  // More concentrated wallets → more efficient (sophisticated participants)
  // HHI: 0.05 → 0.05, 0.15 → 0.15, 0.30 → 0.30
  const walletNorm = clamp(features.wallet_concentration_hhi, 0, 1);

  // Less stale → more efficient
  // 1000ms → ~0.67, 5000ms → ~0.29, 15000ms → ~0.12
  const stalenessNorm = features.book_staleness_ms_avg > 0
    ? 1 / (1 + features.book_staleness_ms_avg / 2000)
    : 0;

  // More bots → more efficient
  const botNorm = clamp(features.bot_ratio, 0, 1);

  const score =
    0.25 * spreadNorm +
    0.20 * updateNorm +
    0.20 * gapNorm +
    0.15 * walletNorm +
    0.10 * stalenessNorm +
    0.10 * botNorm;

  return clamp(score, 0, 1);
}

// ---------------------------------------------------------------------------
// Strategy eligibility
// ---------------------------------------------------------------------------

/**
 * Determines which strategies are viable for a given market based on its
 * type, features, and measured latency.
 *
 * Uses strategy conditioning rules from MARKET_SELECTION.md.
 */
export function determineViableStrategies(
  features: MarketFeatures,
  marketType: MarketType,
  measuredLatencyP50Ms: number,
): string[] {
  const viable: string[] = [];

  switch (marketType) {
    case 1: // Slow / Narrative-Driven
      viable.push('wallet_follow');
      viable.push('complement_arb');
      viable.push('stale_book');
      viable.push('cross_market_consistency');
      viable.push('resolution_convergence');
      viable.push('new_market_listing');
      viable.push('cascade_detection');
      // NOT microprice (insufficient trade frequency)
      break;

    case 2: // Event-Driven / Mid-Speed
      if (features.trade_rate_per_min >= 5) viable.push('book_imbalance');
      if (features.trade_rate_per_min >= 10) viable.push('microprice_dislocation');
      viable.push('wallet_follow');
      viable.push('large_trade_reaction');
      viable.push('complement_arb');
      viable.push('cross_market_consistency');
      viable.push('cascade_detection');
      viable.push('stale_book');
      break;

    case 3: // HFT / Bot-Dominated — conditional strategies
      // Complement arb: only if gap persists beyond our latency
      if (
        features.complement_gap_half_life_ms !== null &&
        features.complement_gap_half_life_ms > measuredLatencyP50Ms * 2
      ) {
        viable.push('complement_arb');
      }
      // Wallet follow: only for dominant wallets with edge halflife > 3x latency
      if (
        features.dominant_wallet_address !== null &&
        features.edge_halflife_ms !== null &&
        features.edge_halflife_ms > measuredLatencyP50Ms * 3
      ) {
        viable.push('wallet_follow');
      }
      // Book imbalance: needs backtested IC — allow if features suggest possibility
      if (features.trade_rate_per_min > 5 && features.spread_avg_bps < 500) {
        viable.push('book_imbalance');
      }
      // Large trade reaction: needs calibration data
      if (features.trade_rate_per_min > 3) {
        viable.push('large_trade_reaction');
      }
      break;
  }

  // Cross-type strategy eligibility filters (from conditioning rules)
  return viable.filter((strategy) => {
    switch (strategy) {
      case 'wallet_follow':
        return features.breakeven_latency_ms === null ||
          features.breakeven_latency_ms > measuredLatencyP50Ms * 1.5;

      case 'complement_arb':
        return (
          features.complement_gap_frequency_per_hour > 0.5 &&
          (features.complement_gap_half_life_ms === null ||
            features.complement_gap_half_life_ms > measuredLatencyP50Ms * 2)
        );

      case 'book_imbalance':
        return (
          features.trade_rate_per_min > 5 &&
          features.avg_update_interval_ms < 5_000 &&
          features.spread_avg_bps < 500
        );

      case 'microprice_dislocation':
        return (
          features.trade_rate_per_min > 10 &&
          features.spread_avg_bps < 200 &&
          features.avg_update_interval_ms < 2_000
        );

      case 'stale_book':
        // Needs related markets (checked at signal time, not here)
        return true;

      case 'cascade_detection':
        return features.bot_ratio < 0.7;

      default:
        return true;
    }
  });
}

// ---------------------------------------------------------------------------
// Full classification
// ---------------------------------------------------------------------------

/**
 * Produces a complete MarketClassification for a single market.
 */
export function classifyMarket(
  market: MarketState,
  obs: MarketObservations,
  measuredLatencyP50Ms: number,
): MarketClassification {
  const features = computeMarketFeatures(market, obs);
  const { type, confidence } = classifyMarketType(features);
  const efficiency = computeEfficiencyScore(features);
  const viableStrategies = determineViableStrategies(features, type, measuredLatencyP50Ms);

  return {
    market_id: market.market_id,
    market_type: type,
    confidence,
    efficiency_score: efficiency,
    viable_strategies: viableStrategies,
    classified_at: now(),
    features,
  };
}

// ---------------------------------------------------------------------------
// Edge Map construction
// ---------------------------------------------------------------------------

/**
 * Builds the EdgeMap — the single most important output of this module.
 *
 * For each classified market, determines whether there is exploitable edge
 * and computes capital allocation weights.
 */
export function buildEdgeMap(
  classifications: Map<string, MarketClassification>,
  measuredLatencyP50Ms: number,
  totalCapital: number,
): EdgeMap {
  const t = now();
  const marketsWithEdge: EdgeMapEntry[] = [];
  let marketsWithoutEdge = 0;

  for (const [, cls] of classifications) {
    if (cls.viable_strategies.length > 0) {
      // Estimate edge: inversely related to efficiency
      const edgePerTrade = (1 - cls.efficiency_score) * 0.05; // max ~5 cents
      const edgeConfidence = cls.confidence;

      // Capital weight: (1 - efficiency)² × edge_evidence_scalar
      const edgeEvidenceScalar = Math.max(0.1, Math.min(1.0, cls.viable_strategies.length / 2));
      const weight = (1 - cls.efficiency_score) ** 2 * edgeEvidenceScalar;

      marketsWithEdge.push({
        market_id: cls.market_id,
        market_type: cls.market_type,
        efficiency_score: cls.efficiency_score,
        viable_strategies: cls.viable_strategies,
        estimated_edge_per_trade: edgePerTrade,
        estimated_edge_confidence: edgeConfidence,
        capital_allocated: weight, // normalized later
        breakeven_latency_ms: cls.features.breakeven_latency_ms,
      });
    } else {
      marketsWithoutEdge++;
    }
  }

  // Normalize capital allocation
  const totalWeight = marketsWithEdge.reduce((s, e) => s + e.capital_allocated, 0);
  const exploitableCapital = totalCapital * 0.9; // reserve 10% as buffer

  if (totalWeight > 0) {
    for (const entry of marketsWithEdge) {
      const normalizedWeight = entry.capital_allocated / totalWeight;
      // Cap at 10% of total capital per market
      entry.capital_allocated = Math.min(
        normalizedWeight * exploitableCapital,
        totalCapital * 0.10,
      );
    }
  }

  const totalAllocated = marketsWithEdge.reduce((s, e) => s + e.capital_allocated, 0);
  const idleCapital = totalCapital - totalAllocated;

  // Recommendation
  let recommendation: EdgeRecommendation;
  const validatedCount = marketsWithEdge.filter((e) => e.estimated_edge_confidence > 0.5).length;

  if (marketsWithEdge.length > 0 && validatedCount > 0) {
    recommendation = 'trade_actively';
  } else if (marketsWithEdge.length > 0) {
    recommendation = 'trade_selectively';
  } else if (classifications.size > 0) {
    recommendation = 'reduce_exposure';
  } else {
    recommendation = 'do_not_trade';
  }

  return {
    timestamp: t,
    measured_latency_p50_ms: measuredLatencyP50Ms,
    markets_with_edge: marketsWithEdge,
    markets_without_edge: marketsWithoutEdge,
    total_exploitable_capital: totalAllocated,
    idle_capital: idleCapital,
    recommendation,
  };
}

// ---------------------------------------------------------------------------
// Reclassification orchestrator
// ---------------------------------------------------------------------------

/**
 * Manages the full classification lifecycle: classifies all markets,
 * detects reclassifications, and returns events.
 */
export class MarketClassifier {
  private readonly classifications: Map<string, MarketClassification> = new Map();
  private readonly observations: Map<string, MarketObservations> = new Map();
  private measuredLatencyP50Ms: number;

  constructor(measuredLatencyP50Ms: number = 2000) {
    this.measuredLatencyP50Ms = measuredLatencyP50Ms;
  }

  /** Gets or creates observations for a market. */
  getObservations(marketId: string): MarketObservations {
    let obs = this.observations.get(marketId);
    if (!obs) {
      obs = createEmptyObservations();
      this.observations.set(marketId, obs);
    }
    return obs;
  }

  /** Returns the current classification for a market, if any. */
  getClassification(marketId: string): MarketClassification | undefined {
    return this.classifications.get(marketId);
  }

  /** Returns all current classifications. */
  getAllClassifications(): Map<string, MarketClassification> {
    return this.classifications;
  }

  /** Updates the measured latency (call when latency changes). */
  updateLatency(p50Ms: number): void {
    this.measuredLatencyP50Ms = p50Ms;
  }

  /** Returns the current measured latency. */
  getMeasuredLatency(): number {
    return this.measuredLatencyP50Ms;
  }

  /**
   * Classifies all active markets and returns reclassification events.
   * Call every 60 seconds or on trigger (regime change, anomaly, etc.).
   */
  classifyAll(
    markets: Map<string, MarketState>,
    trigger: ReclassificationEvent['trigger'] = 'scheduled',
  ): ReclassificationEvent[] {
    const events: ReclassificationEvent[] = [];

    for (const [marketId, market] of markets) {
      if (market.status !== 'active') continue;

      const obs = this.getObservations(marketId);
      const newCls = classifyMarket(market, obs, this.measuredLatencyP50Ms);
      const oldCls = this.classifications.get(marketId);

      // Detect reclassification
      if (oldCls && oldCls.market_type !== newCls.market_type) {
        events.push({
          market_id: marketId,
          old_type: oldCls.market_type,
          new_type: newCls.market_type,
          old_efficiency: oldCls.efficiency_score,
          new_efficiency: newCls.efficiency_score,
          trigger,
          timestamp: now(),
        });

        log.info(
          {
            market_id: marketId,
            old_type: oldCls.market_type,
            new_type: newCls.market_type,
            old_efficiency: oldCls.efficiency_score.toFixed(3),
            new_efficiency: newCls.efficiency_score.toFixed(3),
            trigger,
          },
          'Market reclassified',
        );
      }

      this.classifications.set(marketId, newCls);
    }

    return events;
  }

  /**
   * Builds the EdgeMap from current classifications.
   */
  buildEdgeMap(totalCapital: number): EdgeMap {
    return buildEdgeMap(this.classifications, this.measuredLatencyP50Ms, totalCapital);
  }

  /**
   * Removes a market from tracking (e.g., on resolution).
   */
  removeMarket(marketId: string): void {
    this.classifications.delete(marketId);
    this.observations.delete(marketId);
  }
}
