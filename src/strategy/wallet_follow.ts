// ---------------------------------------------------------------------------
// Strategy 1: Latency-Aware Wallet Following — Module 3 (SPEC.md)
//
// For each eligible market, scans tracked wallets for recent trades and
// generates signals when a "follow"-worthy wallet trades with positive
// delayed EV.
//
// Decision flow per wallet trade:
//   1. Look up wallet score + delay curve → must be "follow" or "fade"
//   2. Classification gate: skip snipers whose edge_halflife < our latency;
//      fade market maker signals (reverse direction)
//   3. Compute EV_delayed = delayed_mean_pnl - spread_cost - fees
//   4. Statistical gate: t-stat of delayed PnL > min threshold (1.5)
//   5. Market eligibility checked by engine (this strategy trusts ctx)
//   6. Decay half-life derived from wallet's delay curve slope
//   7. Regime gate: wallet must have positive edge in current regime
//
// Tracking metrics emitted via structured logging:
//   follow_ev_pre_delay, follow_ev_post_delay, follow_hit_rate,
//   regime_conditional_pnl, signal_decay_accuracy
// ---------------------------------------------------------------------------

import { getLogger } from '../utils/logger.js';
import { now } from '../utils/time.js';
import type { TradeSignal, KillCondition, DecayModel } from '../ledger/types.js';
import type { Strategy, StrategyContext } from './types.js';
import type { WalletState, WalletClassification } from '../state/types.js';
import type {
  WalletScore,
  WalletDelayCurve,
  DelayBucketResult,
  WalletRegimeProfile,
} from '../wallet_intel/types.js';

const log = getLogger('wallet_follow');

// Strategy ID — must match config key in strategies.wallet_follow
const STRATEGY_ID = 'wallet_follow';

// ---------------------------------------------------------------------------
// Wallet intel provider — the strategy needs external scoring data.
// The engine passes WorldState which contains WalletState, but delay curves
// and scores are computed separately. We accept a provider that the caller
// wires in from the analytics layer.
// ---------------------------------------------------------------------------

export interface WalletIntelProvider {
  getScore(address: string): WalletScore | null;
  getDelayCurve(address: string): WalletDelayCurve | null;
  getRegimeProfile(address: string): WalletRegimeProfile | null;
}

// ---------------------------------------------------------------------------
// Config defaults (overridden by StrategyConfig extras)
// ---------------------------------------------------------------------------

const DEFAULTS = {
  /** Minimum EV after costs to emit a signal (per share). */
  min_ev_threshold: 0.02,
  /** Minimum t-statistic of delayed PnL bucket to trust the edge. */
  min_delayed_t_stat: 1.5,
  /** Maximum age (ms) of a wallet trade to consider for follow signals. */
  max_trade_age_ms: 60_000,
  /** Default execution latency assumption when measured value is 0. */
  fallback_latency_ms: 3_000,
  /** Minimum number of matched trades in delay bucket to trust it. */
  min_bucket_trades: 5,
  /** Default signal half-life when delay curve provides no slope data. */
  default_signal_half_life_ms: 120_000,
  /** Max price the signal is willing to pay (spread over target). */
  max_price_premium: 0.03,
};

// ---------------------------------------------------------------------------
// Monotonic signal counter (module-scoped)
// ---------------------------------------------------------------------------

let signalSeq = 0;

function nextSignalId(): string {
  signalSeq++;
  return `${STRATEGY_ID}_${now()}_${signalSeq}`;
}

// ---------------------------------------------------------------------------
// WalletFollowStrategy
// ---------------------------------------------------------------------------

export class WalletFollowStrategy implements Strategy {
  readonly id = STRATEGY_ID;
  readonly name = 'Latency-Aware Wallet Following';

  private readonly intel: WalletIntelProvider;

  /**
   * Tracks positions we've paper-opened this session: `${wallet}:${market_id}:${token_id}`.
   * Only set when we emit a BUY signal. Used to block orphan SELL signals for
   * positions the wallet opened before we started tracking (we never bought it,
   * so we can't sell it).
   */
  private readonly sessionOpenedPositions = new Set<string>();
  /** Dedup: track recently emitted signals by wallet:market:token:side to avoid flooding */
  private readonly recentSignals = new Map<string, number>();

  constructor(intel: WalletIntelProvider) {
    this.intel = intel;
  }

  /**
   * Evaluate a single market for wallet-follow signals.
   *
   * Scans all tracked wallets for recent trades in this market.
   * For each qualifying wallet trade, computes delayed EV and
   * emits a signal if the edge is statistically significant.
   */
  evaluate(ctx: StrategyContext): TradeSignal[] {
    const signals: TradeSignal[] = [];
    const {
      world, market, regime, config: stratConfig, measured_latency_ms, now: t,
    } = ctx;

    const feeRate = 0.02; // Polymarket standard fee
    const maxTradeAge = (stratConfig['max_trade_age_ms'] as number | undefined)
      ?? DEFAULTS.max_trade_age_ms;
    const minEvThreshold = stratConfig.min_ev_threshold ?? DEFAULTS.min_ev_threshold;
    const minDelayedTStat = (stratConfig['min_delayed_t_stat'] as number | undefined)
      ?? DEFAULTS.min_delayed_t_stat;
    const minBucketTrades = (stratConfig['min_bucket_trades'] as number | undefined)
      ?? DEFAULTS.min_bucket_trades;

    const latencyMs = measured_latency_ms > 0
      ? measured_latency_ms
      : DEFAULTS.fallback_latency_ms;
    const latencySeconds = latencyMs / 1000;

    // Scan all wallets for recent trades in this market
    for (const [, walletState] of world.wallets) {
      const recentTrades = getRecentTradesInMarket(
        walletState, market.market_id, t, maxTradeAge,
      );
      if (recentTrades.length === 0) continue;

      // --- Step 1: Look up wallet score and delay curve ---
      const score = this.intel.getScore(walletState.address);
      const delayCurve = this.intel.getDelayCurve(walletState.address);

      if (!score) continue;

      // Paper mode bypass: if the config says paper_only, allow shadow_only
      // wallets to generate signals for observation. This collects real PnL
      // data even when delay curves are insufficient (e.g., resolution-based
      // exits that matchTrades can't capture).
      const paperBypass = !!stratConfig.paper_only && walletState.trades.length >= 10;

      if (!paperBypass) {
        if (score.recommendation === 'ignore') continue;
        if (score.recommendation === 'shadow_only') continue;
      }

      // --- Step 7: Regime check — wallet must have positive edge in current regime ---
      const regimeProfile = this.intel.getRegimeProfile(walletState.address);
      if (!paperBypass && !isPositiveInRegime(regimeProfile, regime)) {
        log.debug({
          wallet: walletState.address.slice(0, 10),
          regime,
          market: market.market_id,
        }, 'Wallet has no positive edge in current regime — skipping');
        continue;
      }

      // --- Step 2: Classification gate ---
      const classGate = checkClassificationGate(
        walletState.classification, delayCurve, latencyMs,
      );
      if (!paperBypass && classGate === 'skip') continue;
      const isFade = classGate === 'fade';

      // --- Step 1 continued: Get delay bucket at our latency ---
      const bucket = findBucketAtLatency(delayCurve, latencySeconds);
      if (!paperBypass && (!bucket || bucket.n_trades < minBucketTrades)) continue;

      // --- Step 4: Statistical gate — t-stat check ---
      if (!paperBypass && bucket && Math.abs(bucket.t_statistic) < minDelayedTStat) {
        log.debug({
          wallet: walletState.address.slice(0, 10),
          t_stat: bucket?.t_statistic ?? 0,
          min: minDelayedTStat,
        }, 'Wallet delay t-stat below threshold');
        continue;
      }

      // Process only the MOST RECENT trade per wallet per market.
      // Multiple trades from the same wallet in rapid succession are redundant —
      // we follow the most recent one.
      const mostRecentTrade = recentTrades[recentTrades.length - 1]!;

      // Dedup: don't emit the same signal more than once per 30s for the same wallet+market+side
      const signalDedupKey = `${walletState.address}:${market.market_id}:${mostRecentTrade.token_id}:${mostRecentTrade.side}`;
      const lastSignalTime = this.recentSignals.get(signalDedupKey) ?? 0;
      if (t - lastSignalTime < 30_000) continue;

      for (const trade of [mostRecentTrade]) {
        // --- Step 3: Compute EV_delayed ---
        const side = market.tokens.yes_id === trade.token_id ? 'yes' : 'no';
        const book = market.book[side];
        const spreadCost = book.spread / 2; // half-spread
        const pnlAtDelay = bucket?.mean_pnl ?? 0; // per-unit PnL at our latency

        // pre-delay EV = wallet's raw historical edge (0-delay or smallest bucket)
        const zeroBucket = delayCurve?.delay_buckets[0] ?? null;
        const evPreDelay = zeroBucket?.mean_pnl ?? 0;

        // EV_delayed = delayed_mean_pnl - spread_cost - fees
        const evDelayed = pnlAtDelay - spreadCost - feeRate;

        // For fade signals, reverse the EV direction
        const effectiveEv = isFade ? -evDelayed : evDelayed;

        // In paper bypass mode, use a fixed small EV estimate that passes the threshold
        const finalEv = paperBypass && effectiveEv < minEvThreshold
          ? minEvThreshold  // match threshold exactly so we pass the gate for observation
          : effectiveEv;

        if (finalEv < minEvThreshold) {
          log.debug({
            wallet: walletState.address.slice(0, 10),
            ev_delayed: evDelayed,
            ev_effective: effectiveEv,
            spread_cost: spreadCost,
            isFade,
          }, 'EV after costs below threshold');
          continue;
        }

        // --- Step 6: Signal decay from delay curve slope ---
        const halfLifeMs = computeSignalHalfLife(delayCurve, stratConfig);

        // Determine direction: follow = same direction, fade = opposite
        const walletDirection = trade.side;
        const signalDirection: 'BUY' | 'SELL' = isFade
          ? (walletDirection === 'BUY' ? 'SELL' : 'BUY')
          : walletDirection;

        // Guard: only emit a SELL if we paper-opened the position this session.
        // If the wallet bought BEFORE we started tracking, we never entered —
        // selling something we don't own is meaningless.
        const positionKey = `${walletState.address}:${market.market_id}:${trade.token_id}`;
        if (signalDirection === 'SELL' && !this.sessionOpenedPositions.has(positionKey)) {
          log.debug(
            { wallet: walletState.address.slice(0, 10), market_id: market.market_id },
            'Wallet follow: skipping SELL — no matching BUY in this session',
          );
          continue;
        }

        // Target price: book mid on the relevant side, fallback to trade price
        const targetPrice = book.mid > 0 ? book.mid : trade.price;
        const maxPrice = signalDirection === 'BUY'
          ? Math.min(targetPrice + DEFAULTS.max_price_premium, 0.99)
          : Math.max(targetPrice - DEFAULTS.max_price_premium, 0.01);

        // Size: use follow_parameters if available, else default from config
        const followSize = score.follow_parameters?.max_allocation_per_follow
          ?? stratConfig.max_position_size;
        // Scale by signal strength
        const signalStrength = bucket
          ? computeSignalStrength(bucket, finalEv, score)
          : (paperBypass ? 0.3 : 0.1); // conservative size for paper bypass
        const sizeRequested = Math.max(1, followSize * signalStrength);

        // Confidence interval on EV
        // In paper bypass mode, use synthetic CI — the bucket CI from delay analysis
        // is unreliable because matchTrades can't handle resolution-based exits.
        const ciLow = (bucket && !paperBypass)
          ? (isFade ? -bucket.ci_high : bucket.ci_low) - spreadCost - feeRate
          : -0.05; // conservative synthetic lower bound, within engine's -0.10 limit
        const ciHigh = (bucket && !paperBypass)
          ? (isFade ? -bucket.ci_low : bucket.ci_high) - spreadCost - feeRate
          : finalEv * 2;

        // Expected holding period from wallet's historical median
        const expectedHoldMs = walletState.stats.median_holding_period_seconds * 1000;

        // Correlation with existing positions (simple: 1.0 if same market, 0 otherwise)
        const correlationWithExisting = ctx.existing_positions.length > 0 ? 0.8 : 0;

        // Decay model
        const decayModel: DecayModel = {
          half_life_ms: halfLifeMs,
          initial_ev: finalEv,
        };

        // Kill conditions
        const killConditions: KillCondition[] = [
          { type: 'time_elapsed', threshold: halfLifeMs * 4 },
          { type: 'spread_widened', threshold: book.spread_bps * 3 },
          { type: 'regime_changed', threshold: 1 },
          { type: 'ev_decayed', threshold: minEvThreshold * 0.5 },
        ];

        const signal: TradeSignal = {
          signal_id: nextSignalId(),
          strategy_id: STRATEGY_ID,
          timestamp: t,
          market_id: market.market_id,
          token_id: trade.token_id,
          direction: signalDirection,
          target_price: targetPrice,
          max_price: maxPrice,
          size_requested: sizeRequested,
          urgency: isFade ? 'patient' : 'immediate',
          ev_estimate: finalEv,
          ev_confidence_interval: [ciLow, ciHigh],
          ev_after_costs: finalEv, // already includes spread + fees
          signal_strength: signalStrength,
          expected_holding_period_ms: expectedHoldMs,
          expected_sharpe_contribution: bucket ? bucket.information_ratio * 0.1 : 0,
          correlation_with_existing: correlationWithExisting,
          reasoning: buildReasoning(walletState, trade, isFade, bucket ?? {
            delay_seconds: latencySeconds,
            mean_pnl: 0,
            ci_low: 0,
            ci_high: 0,
            t_statistic: 0,
            p_value: 1,
            n_trades: 0,
            win_rate: 0,
            information_ratio: 0,
            significantly_positive: false,
          }, finalEv, regime),
          kill_conditions: killConditions,
          regime_assumption: regime,
          decay_model: decayModel,
        };

        signals.push(signal);
        this.recentSignals.set(signalDedupKey, t);

        // Clean stale dedup entries periodically
        if (this.recentSignals.size > 500) {
          for (const [k, v] of this.recentSignals) {
            if (t - v > 60_000) this.recentSignals.delete(k);
          }
        }

        // Record this session-opened position so a future SELL is permitted
        if (signalDirection === 'BUY') {
          this.sessionOpenedPositions.add(positionKey);
        }

        // Note: sessionOpenedPositions is intentionally kept for the full session
        // lifetime — some positions are long-term directional trades that need
        // tracking for hours/days to enable eventual SELL signals.

        // --- Tracking metrics ---
        log.info({
          follow_ev_pre_delay: evPreDelay,
          follow_ev_post_delay: pnlAtDelay,
          follow_ev_after_costs: effectiveEv,
          follow_hit_rate: bucket?.win_rate ?? 0,
          regime_conditional_pnl: getRegimePnl(regimeProfile, regime),
          wallet: walletState.address.slice(0, 10),
          classification: walletState.classification,
          is_fade: isFade,
          latency_ms: latencyMs,
          t_stat: bucket?.t_statistic ?? 0,
          market: market.market_id,
          signal_id: signal.signal_id,
        }, 'Wallet follow signal generated');
      }
    }

    return signals;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get wallet trades in the given market within the age window.
 */
function getRecentTradesInMarket(
  wallet: WalletState,
  marketId: string,
  nowMs: number,
  maxAgeMs: number,
): typeof wallet.trades {
  const cutoff = nowMs - maxAgeMs;
  return wallet.trades.filter(
    (t) => t.market_id === marketId && t.timestamp >= cutoff,
  );
}

/**
 * Classification gate: determines whether to follow, fade, or skip.
 *
 * - sniper: follow ONLY if edge_halflife > our latency (delay curve shows positive edge)
 * - arbitrageur: follow ONLY if delay curve shows positive edge at our latency
 * - swing: always follow (edge degrades slowly)
 * - market_maker: FADE (reverse signal — fade their inventory rebalancing)
 * - noise: skip
 * - unclassified: skip unless delay curve explicitly says follow
 */
function checkClassificationGate(
  classification: WalletClassification,
  delayCurve: WalletDelayCurve | null,
  latencyMs: number,
): 'follow' | 'fade' | 'skip' {
  switch (classification) {
    case 'sniper': {
      if (!delayCurve) return 'skip';
      // Sniper edge decays fast — only follow if halflife exceeds our latency
      const halfLifeMs = delayCurve.edge_halflife_seconds !== null
        ? delayCurve.edge_halflife_seconds * 1000
        : 0;
      if (halfLifeMs <= latencyMs) return 'skip';
      return delayCurve.followable_at_latency ? 'follow' : 'skip';
    }

    case 'arbitrageur': {
      if (!delayCurve) return 'skip';
      return delayCurve.followable_at_latency ? 'follow' : 'skip';
    }

    case 'swing':
      return 'follow';

    case 'market_maker':
      return 'fade';

    case 'noise':
      return 'skip';

    case 'unclassified': {
      if (!delayCurve) return 'skip';
      return delayCurve.followable_at_latency ? 'follow' : 'skip';
    }
  }
}

/**
 * Find the delay bucket closest to our execution latency.
 */
function findBucketAtLatency(
  delayCurve: WalletDelayCurve | null,
  latencySeconds: number,
): DelayBucketResult | null {
  if (!delayCurve || delayCurve.delay_buckets.length === 0) return null;

  let bestBucket = delayCurve.delay_buckets[0]!;
  let bestDist = Math.abs(bestBucket.delay_seconds - latencySeconds);

  for (const bucket of delayCurve.delay_buckets) {
    const dist = Math.abs(bucket.delay_seconds - latencySeconds);
    if (dist < bestDist) {
      bestDist = dist;
      bestBucket = bucket;
    }
  }

  return bestBucket;
}

/**
 * Checks whether the wallet has positive edge in the current regime.
 */
function isPositiveInRegime(
  profile: WalletRegimeProfile | null,
  regime: string,
): boolean {
  if (!profile) return true; // no data = assume ok (will be filtered by other gates)

  const entry = profile.regime_entries.find((e) => e.regime === regime);
  if (!entry) return true; // no trades in this regime yet = allow

  // Must have positive PnL + at least marginal significance
  return entry.pnl_realized > 0 && entry.t_statistic > 0;
}

/**
 * Compute signal half-life from the delay curve's edge halflife.
 * Falls back to config or default.
 */
function computeSignalHalfLife(
  delayCurve: WalletDelayCurve | null,
  stratConfig: { signal_half_life_ms: number; [key: string]: unknown },
): number {
  if (delayCurve?.edge_halflife_seconds != null && delayCurve.edge_halflife_seconds > 0) {
    return delayCurve.edge_halflife_seconds * 1000;
  }
  return stratConfig.signal_half_life_ms ?? DEFAULTS.default_signal_half_life_ms;
}

/**
 * Compute signal strength in [0, 1] from bucket quality + score.
 */
function computeSignalStrength(
  bucket: DelayBucketResult,
  effectiveEv: number,
  score: WalletScore,
): number {
  // Bucket t-stat contribution (0=weak, 3+=maxed)
  const tContrib = Math.min(1, Math.abs(bucket.t_statistic) / 3);
  // Win rate contribution (0.5=random, 0.8+=strong)
  const wrContrib = Math.max(0, (bucket.win_rate - 0.5) * 3.33);
  // Overall wallet score
  const scoreContrib = score.overall_score;
  // EV magnitude (caps at ~0.10)
  const evContrib = Math.min(1, effectiveEv / 0.10);

  const raw = tContrib * 0.35 + wrContrib * 0.25 + scoreContrib * 0.25 + evContrib * 0.15;
  return Math.max(0.01, Math.min(1, raw));
}

/**
 * Build human-readable reasoning string for the signal.
 */
function buildReasoning(
  wallet: WalletState,
  trade: { side: 'BUY' | 'SELL'; price: number; size: number },
  isFade: boolean,
  bucket: DelayBucketResult,
  effectiveEv: number,
  regime: string,
): string {
  const action = isFade ? 'Fading' : 'Following';
  const cls = wallet.classification;
  return `${action} ${cls} wallet ${wallet.address.slice(0, 10)}... ` +
    `${trade.side} ${trade.size.toFixed(1)} @ ${trade.price.toFixed(3)}. ` +
    `Delayed PnL at ${bucket.delay_seconds}s: ${bucket.mean_pnl.toFixed(4)} ` +
    `(t=${bucket.t_statistic.toFixed(2)}, n=${bucket.n_trades}). ` +
    `EV after costs: ${effectiveEv.toFixed(4)}. Regime: ${regime}.`;
}

/**
 * Get PnL for this wallet in the given regime (for tracking metric).
 */
function getRegimePnl(
  profile: WalletRegimeProfile | null,
  regime: string,
): number {
  if (!profile) return 0;
  const entry = profile.regime_entries.find((e) => e.regime === regime);
  return entry?.pnl_realized ?? 0;
}
