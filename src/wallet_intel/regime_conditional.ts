// ---------------------------------------------------------------------------
// Regime-Conditional Wallet Performance — Module 7 (SPEC.md)
//
// Computes wallet performance broken down by detected regime.
// Some wallets only have edge in specific regimes (e.g., event-driven).
// This module answers: "In which regimes does this wallet make money?"
//
// For each wallet × regime:
//   - Filter trades to those occurring during that regime
//   - Compute WalletStats (PnL, Sharpe, win rate, etc.)
//   - t-test significance per regime
//   - Identify best/worst regime
//   - Robustness score: fraction of regimes where edge is positive
// ---------------------------------------------------------------------------

import { tTest } from '../utils/statistics.js';
import { recomputeWalletStats } from '../state/wallet_stats.js';
import type { WalletState, WalletStats, RegimeName } from '../state/types.js';
import type { WalletTransaction } from '../ingestion/types.js';
import type { RegimePerformanceEntry, WalletRegimeProfile } from './types.js';

// ---------------------------------------------------------------------------
// All possible regimes
// ---------------------------------------------------------------------------

const ALL_REGIMES: RegimeName[] = [
  'normal',
  'high_volatility',
  'low_liquidity',
  'event_driven',
  'resolution_clustering',
];

// ---------------------------------------------------------------------------
// Regime assignment — maps a timestamp to a regime
// ---------------------------------------------------------------------------

export interface RegimeSpan {
  regime: RegimeName;
  start: number;
  end: number;
}

/**
 * Assigns a regime to a given timestamp by looking up which span it falls into.
 * If no span matches, returns 'normal' as default.
 */
function assignRegime(timestamp: number, spans: RegimeSpan[]): RegimeName {
  // Binary search for efficiency on large span arrays
  let lo = 0;
  let hi = spans.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const span = spans[mid]!;

    if (timestamp < span.start) {
      hi = mid - 1;
    } else if (timestamp > span.end) {
      lo = mid + 1;
    } else {
      return span.regime;
    }
  }

  return 'normal';
}

/**
 * Partitions a wallet's trades by regime.
 * Returns a map: regime → trades that occurred during that regime.
 */
function partitionTradesByRegime(
  trades: WalletTransaction[],
  regimeSpans: RegimeSpan[],
): Map<RegimeName, WalletTransaction[]> {
  const result = new Map<RegimeName, WalletTransaction[]>();

  for (const trade of trades) {
    const regime = assignRegime(trade.timestamp, regimeSpans);
    let bucket = result.get(regime);
    if (!bucket) {
      bucket = [];
      result.set(regime, bucket);
    }
    bucket.push(trade);
  }

  return result;
}

// ---------------------------------------------------------------------------
// FIFO PnL extraction for t-test
// ---------------------------------------------------------------------------

function extractPnls(trades: WalletTransaction[]): number[] {
  const pnls: number[] = [];
  const openPositions = new Map<string, { price: number; size: number }[]>();

  for (const trade of trades) {
    const key = `${trade.market_id}:${trade.token_id}`;

    if (trade.side === 'BUY') {
      let positions = openPositions.get(key);
      if (!positions) {
        positions = [];
        openPositions.set(key, positions);
      }
      positions.push({ price: trade.price, size: trade.size });
    } else {
      const positions = openPositions.get(key);
      if (!positions || positions.length === 0) continue;

      let remaining = trade.size;
      while (remaining > 0 && positions.length > 0) {
        const open = positions[0]!;
        const matched = Math.min(remaining, open.size);
        pnls.push((trade.price - open.price) * matched);
        open.size -= matched;
        remaining -= matched;
        if (open.size <= 0.001) positions.shift();
      }
    }
  }

  return pnls;
}

// ---------------------------------------------------------------------------
// Compute per-regime performance entry
// ---------------------------------------------------------------------------

function computeRegimeEntry(
  regime: RegimeName,
  trades: WalletTransaction[],
  significanceP: number,
): RegimePerformanceEntry {
  const stats = recomputeWalletStats(trades);
  const pnls = extractPnls(trades);
  const tResult = pnls.length >= 2 ? tTest(pnls, 0) : { t: 0, p: 1, n: 0, df: 0 };

  return {
    regime,
    stats,
    n_trades: trades.length,
    sharpe: stats.sharpe_ratio,
    win_rate: stats.win_rate,
    pnl_realized: stats.pnl_realized,
    is_significant: tResult.p < significanceP && pnls.length >= 5 && pnls.some((p) => p > 0),
    t_statistic: tResult.t,
    p_value: tResult.p,
  };
}

// ---------------------------------------------------------------------------
// Robustness scoring
// ---------------------------------------------------------------------------

/**
 * Robustness = fraction of regimes (with enough data) where performance
 * is positive. Weighted by sample size.
 */
function computeRobustnessScore(entries: RegimePerformanceEntry[]): number {
  const withData = entries.filter((e) => e.n_trades >= 5);
  if (withData.length === 0) return 0;

  let totalWeight = 0;
  let positiveWeight = 0;

  for (const entry of withData) {
    const weight = Math.min(1, entry.n_trades / 30);
    totalWeight += weight;
    if (entry.sharpe > 0) {
      positiveWeight += weight;
    }
  }

  if (totalWeight === 0) return 0;
  return positiveWeight / totalWeight;
}

/**
 * Regime-sensitive = performance varies significantly across regimes.
 * If best regime Sharpe is > 2× worst regime Sharpe, wallet is sensitive.
 */
function isRegimeSensitive(entries: RegimePerformanceEntry[]): boolean {
  const withData = entries.filter((e) => e.n_trades >= 10);
  if (withData.length < 2) return false;

  const sharpes = withData.map((e) => e.sharpe);
  const maxSharpe = Math.max(...sharpes);
  const minSharpe = Math.min(...sharpes);

  // Large dispersion: best is at least 1.0 higher than worst
  if (maxSharpe - minSharpe > 1.0) return true;

  // Or best is positive and worst is negative
  if (maxSharpe > 0.3 && minSharpe < -0.3) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Public API: compute regime profile for a wallet
// ---------------------------------------------------------------------------

export function computeWalletRegimeProfile(
  wallet: WalletState,
  regimeSpans: RegimeSpan[],
  significanceP: number = 0.05,
): WalletRegimeProfile {
  const tradesByRegime = partitionTradesByRegime(wallet.trades, regimeSpans);

  const entries: RegimePerformanceEntry[] = [];

  for (const regime of ALL_REGIMES) {
    const trades = tradesByRegime.get(regime);
    if (!trades || trades.length === 0) continue;
    entries.push(computeRegimeEntry(regime, trades, significanceP));
  }

  // Best and worst regimes (by Sharpe, with minimum data)
  const withEnoughData = entries.filter((e) => e.n_trades >= 5);
  let bestRegime: RegimeName | null = null;
  let worstRegime: RegimeName | null = null;

  if (withEnoughData.length > 0) {
    const sorted = [...withEnoughData].sort((a, b) => b.sharpe - a.sharpe);
    bestRegime = sorted[0]!.regime;
    worstRegime = sorted[sorted.length - 1]!.regime;
  }

  return {
    address: wallet.address,
    label: wallet.label,
    regime_entries: entries,
    best_regime: bestRegime,
    worst_regime: worstRegime,
    regime_sensitive: isRegimeSensitive(entries),
    robustness_score: computeRobustnessScore(entries),
  };
}

// ---------------------------------------------------------------------------
// Batch: compute regime profiles for all wallets
// ---------------------------------------------------------------------------

export function computeAllRegimeProfiles(
  wallets: WalletState[],
  regimeSpans: RegimeSpan[],
  significanceP?: number,
): WalletRegimeProfile[] {
  return wallets.map((w) => computeWalletRegimeProfile(w, regimeSpans, significanceP));
}

// ---------------------------------------------------------------------------
// Build regime spans from a regime change log
// ---------------------------------------------------------------------------

export interface RegimeChangeEvent {
  timestamp: number;
  regime: RegimeName;
}

/**
 * Converts a chronological list of regime change events into spans.
 * The last span extends to `endTime` (default: far future).
 */
export function buildRegimeSpans(
  events: RegimeChangeEvent[],
  endTime: number = Number.MAX_SAFE_INTEGER,
): RegimeSpan[] {
  if (events.length === 0) {
    return [{ regime: 'normal', start: 0, end: endTime }];
  }

  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const spans: RegimeSpan[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const event = sorted[i]!;
    const nextStart = i < sorted.length - 1 ? sorted[i + 1]!.timestamp : endTime;
    spans.push({
      regime: event.regime,
      start: event.timestamp,
      end: nextStart,
    });
  }

  // If the first event doesn't start at 0, add a default 'normal' span
  if (spans.length > 0 && spans[0]!.start > 0) {
    spans.unshift({
      regime: 'normal',
      start: 0,
      end: spans[0]!.start,
    });
  }

  return spans;
}

// ---------------------------------------------------------------------------
// Update wallet's regime_performance map from regime profile
// ---------------------------------------------------------------------------

export function applyRegimeProfileToWallet(
  wallet: WalletState,
  profile: WalletRegimeProfile,
): void {
  wallet.regime_performance.clear();
  for (const entry of profile.regime_entries) {
    wallet.regime_performance.set(entry.regime, entry.stats);
  }
}
