// ---------------------------------------------------------------------------
// Wallet Stats — Running statistics computation for tracked wallets
//
// Computes and maintains WalletStats from accumulated WalletTransaction[].
// Updated incrementally on each new trade. Provides:
//   - Basic metrics: total trades, win rate, holding periods
//   - Risk metrics: Sharpe, Sortino, Calmar, max drawdown
//   - Behavioral: market concentration, active hours, trade clustering
//   - Factory for empty WalletState / WalletStats
// ---------------------------------------------------------------------------

import { mean, stddev, tTest } from '../utils/statistics.js';
import { now } from '../utils/time.js';
import type { WalletState, WalletStats, WalletClassification } from './types.js';
import type { WalletTransaction } from '../ingestion/types.js';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function createEmptyWalletStats(): WalletStats {
  return {
    total_trades: 0,
    win_rate: 0,
    avg_holding_period_seconds: 0,
    median_holding_period_seconds: 0,
    avg_trade_size_usd: 0,
    pnl_realized: 0,
    pnl_unrealized: 0,
    sharpe_ratio: 0,
    sortino_ratio: 0,
    calmar_ratio: 0,
    max_drawdown: 0,
    avg_entry_delay_from_event: null,
    preferred_markets: [],
    active_hours: new Array(24).fill(0) as number[],
    profitable_after_delay: new Map<number, number>(),
    pnl_significance: 0,
    consecutive_loss_max: 0,
    trade_clustering_score: 0,
  };
}

export function createEmptyWalletState(address: string, label?: string): WalletState {
  const lower = address.toLowerCase();
  return {
    address: lower,
    label: label ?? lower.slice(0, 10),
    classification: 'unclassified',
    confidence: 0,
    trades: [],
    stats: createEmptyWalletStats(),
    regime_performance: new Map<string, WalletStats>(),
  };
}

// ---------------------------------------------------------------------------
// Holding period tracking — match BUY/SELL pairs per (wallet, market, token)
// ---------------------------------------------------------------------------

interface OpenPosition {
  price: number;
  size: number;
  timestamp: number;
}

/**
 * Computes per-trade PnL and holding periods by matching BUY→SELL pairs
 * (FIFO) per (market_id, token_id).
 */
function computeTradeResults(trades: WalletTransaction[]): {
  pnls: number[];
  holdingPeriods: number[];
  tradeSizesUsd: number[];
} {
  const pnls: number[] = [];
  const holdingPeriods: number[] = [];
  const tradeSizesUsd: number[] = [];

  // Open positions per (market_id, token_id)
  const openPositions = new Map<string, OpenPosition[]>();

  for (const trade of trades) {
    const key = `${trade.market_id}:${trade.token_id}`;
    tradeSizesUsd.push(trade.price * trade.size);

    if (trade.side === 'BUY') {
      let positions = openPositions.get(key);
      if (!positions) {
        positions = [];
        openPositions.set(key, positions);
      }
      positions.push({
        price: trade.price,
        size: trade.size,
        timestamp: trade.timestamp,
      });
    } else {
      // SELL — match against open positions (FIFO)
      const positions = openPositions.get(key);
      if (!positions || positions.length === 0) continue;

      let remaining = trade.size;
      while (remaining > 0 && positions.length > 0) {
        const open = positions[0]!;
        const matched = Math.min(remaining, open.size);

        const pnl = (trade.price - open.price) * matched;
        pnls.push(pnl);

        const holdMs = trade.timestamp - open.timestamp;
        holdingPeriods.push(holdMs / 1000); // convert to seconds

        open.size -= matched;
        remaining -= matched;

        if (open.size <= 0.001) {
          positions.shift();
        }
      }
    }
  }

  return { pnls, holdingPeriods, tradeSizesUsd };
}

// ---------------------------------------------------------------------------
// Market concentration (Herfindahl)
// ---------------------------------------------------------------------------

function computeMarketConcentration(trades: WalletTransaction[]): {
  preferred_markets: string[];
  hhi: number;
} {
  const volumeByMarket = new Map<string, number>();
  let totalVolume = 0;

  for (const t of trades) {
    const vol = t.price * t.size;
    volumeByMarket.set(t.market_id, (volumeByMarket.get(t.market_id) ?? 0) + vol);
    totalVolume += vol;
  }

  if (totalVolume === 0) return { preferred_markets: [], hhi: 0 };

  let hhi = 0;
  const sorted = [...volumeByMarket.entries()].sort((a, b) => b[1] - a[1]);
  for (const [, vol] of sorted) {
    const share = vol / totalVolume;
    hhi += share * share;
  }

  // Top 5 markets by volume
  const preferred = sorted.slice(0, 5).map(([mktId]) => mktId);

  return { preferred_markets: preferred, hhi };
}

// ---------------------------------------------------------------------------
// Active hours histogram
// ---------------------------------------------------------------------------

function computeActiveHours(trades: WalletTransaction[]): number[] {
  const hours = new Array(24).fill(0) as number[];
  for (const t of trades) {
    const hour = new Date(t.timestamp).getUTCHours();
    hours[hour]!++;
  }
  return hours;
}

// ---------------------------------------------------------------------------
// Trade clustering score
//
// Measures how bursty the wallet's trading is.
// High score = trades cluster in time bursts; low score = evenly spaced.
// Uses coefficient of dispersion (variance / mean) of inter-arrival times.
// ---------------------------------------------------------------------------

function computeTradeClusteringScore(trades: WalletTransaction[]): number {
  if (trades.length < 3) return 0;

  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const interArrivals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    interArrivals.push(sorted[i]!.timestamp - sorted[i - 1]!.timestamp);
  }

  const m = mean(interArrivals);
  if (m === 0) return 0;

  const v = interArrivals.reduce((sum, ia) => sum + (ia - m) ** 2, 0) / interArrivals.length;
  // Coefficient of dispersion (index of dispersion)
  const cod = v / m;

  // Normalize: Poisson process has CoD = mean, so divide by mean
  // > 1 means overdispersed (clustered), < 1 means underdispersed (regular)
  return m > 0 ? cod / m : 0;
}

// ---------------------------------------------------------------------------
// Max drawdown
// ---------------------------------------------------------------------------

function computeMaxDrawdown(pnls: number[]): number {
  if (pnls.length === 0) return 0;

  let cumPnl = 0;
  let peak = 0;
  let maxDd = 0;

  for (const pnl of pnls) {
    cumPnl += pnl;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDd) maxDd = dd;
  }

  return maxDd;
}

// ---------------------------------------------------------------------------
// Consecutive loss max
// ---------------------------------------------------------------------------

function computeConsecutiveLossMax(pnls: number[]): number {
  let maxStreak = 0;
  let currentStreak = 0;

  for (const pnl of pnls) {
    if (pnl < 0) {
      currentStreak++;
      if (currentStreak > maxStreak) maxStreak = currentStreak;
    } else {
      currentStreak = 0;
    }
  }

  return maxStreak;
}

// ---------------------------------------------------------------------------
// Sortino ratio
// ---------------------------------------------------------------------------

function computeSortino(pnls: number[]): number {
  if (pnls.length < 2) return 0;

  const m = mean(pnls);
  const downsideReturns = pnls.filter((p) => p < 0);
  if (downsideReturns.length === 0) return m > 0 ? Infinity : 0;

  const downsideVar =
    downsideReturns.reduce((sum, p) => sum + p * p, 0) / pnls.length;
  const downsideStd = Math.sqrt(downsideVar);

  return downsideStd === 0 ? 0 : m / downsideStd;
}

// ---------------------------------------------------------------------------
// Public: recompute full WalletStats from trade history
// ---------------------------------------------------------------------------

/**
 * Recomputes all WalletStats from the full trade history.
 * Called after each new trade is appended to the wallet.
 */
export function recomputeWalletStats(trades: WalletTransaction[]): WalletStats {
  const stats = createEmptyWalletStats();

  if (trades.length === 0) return stats;

  stats.total_trades = trades.length;

  const { pnls, holdingPeriods, tradeSizesUsd } = computeTradeResults(trades);

  // Win rate
  if (pnls.length > 0) {
    const wins = pnls.filter((p) => p > 0).length;
    stats.win_rate = wins / pnls.length;
  }

  // Holding periods
  if (holdingPeriods.length > 0) {
    stats.avg_holding_period_seconds = mean(holdingPeriods);
    const sorted = [...holdingPeriods].sort((a, b) => a - b);
    stats.median_holding_period_seconds = sorted[Math.floor(sorted.length / 2)]!;
  }

  // Trade sizes
  if (tradeSizesUsd.length > 0) {
    stats.avg_trade_size_usd = mean(tradeSizesUsd);
  }

  // PnL
  stats.pnl_realized = pnls.reduce((s, p) => s + p, 0);

  // Risk metrics
  if (pnls.length >= 2) {
    const sd = stddev(pnls);
    stats.sharpe_ratio = sd > 0 ? mean(pnls) / sd : 0;
    stats.sortino_ratio = computeSortino(pnls);
  }

  stats.max_drawdown = computeMaxDrawdown(pnls);
  stats.calmar_ratio = stats.max_drawdown > 0
    ? stats.pnl_realized / stats.max_drawdown
    : 0;

  // Statistical significance
  if (pnls.length >= 2) {
    const result = tTest(pnls, 0);
    stats.pnl_significance = isNaN(result.t) ? 0 : result.t;
  }

  stats.consecutive_loss_max = computeConsecutiveLossMax(pnls);

  // Behavioral
  const { preferred_markets } = computeMarketConcentration(trades);
  stats.preferred_markets = preferred_markets;
  stats.active_hours = computeActiveHours(trades);
  stats.trade_clustering_score = computeTradeClusteringScore(trades);

  return stats;
}

/**
 * Enriches a WalletTransaction with market_id and price from a matching
 * CLOB trade event. Called when we can correlate on-chain with off-chain.
 */
export function enrichTransaction(
  tx: WalletTransaction,
  marketId: string,
  price: number,
): WalletTransaction {
  return { ...tx, market_id: marketId, price };
}
