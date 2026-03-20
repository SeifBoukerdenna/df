import { now } from '../utils/time.js';
import { vwap, bookDepthWithin } from '../utils/math.js';
import { stddev } from '../utils/statistics.js';
import { config } from '../utils/config.js';
import {
  computeMicroprice,
  computeImbalance,
  computeMultiLevelImbalance,
  computeLiquidityScore,
  computeComplementGap,
  computeComplementGapExecutable,
} from './derived_metrics.js';
import type { MarketState, OrderBook } from './types.js';
import type { MarketMetadata, ParsedBookSnapshot, ParsedTrade } from '../ingestion/types.js';

// ---------------------------------------------------------------------------
// Empty-state factories
// ---------------------------------------------------------------------------

function createEmptyOrderBook(): OrderBook {
  return {
    bids: [],
    asks: [],
    mid: 0,
    spread: 0,
    spread_bps: 0,
    imbalance: 0,
    imbalance_weighted: 0,
    top_of_book_stability_ms: 0,
    queue_depth_at_best: 0,
    microprice: 0,
    last_updated: 0,
  };
}

/**
 * Creates a fresh MarketState from metadata. All book/derived fields are zeroed.
 */
export function createEmptyMarketState(metadata: MarketMetadata): MarketState {
  const t = now();
  return {
    market_id: metadata.market_id,
    question: metadata.question,
    condition_id: metadata.condition_id,
    tokens: { yes_id: metadata.tokens.yes_id, no_id: metadata.tokens.no_id },
    status: metadata.status,
    resolution: metadata.resolution,
    end_date: metadata.end_date,
    category: metadata.category,
    tags: [...metadata.tags],
    book: {
      yes: createEmptyOrderBook(),
      no: createEmptyOrderBook(),
    },
    last_trade_price: { yes: 0, no: 0 },
    volume_24h: 0,
    volume_1h: 0,
    trade_count_1h: 0,
    liquidity_score: 0,
    complement_gap: 0,
    complement_gap_executable: 0,
    staleness_ms: 0,
    volatility_1h: 0,
    autocorrelation_1m: 0,
    related_markets: [],
    event_cluster_id: null,
    updated_at: t,
  };
}

// ---------------------------------------------------------------------------
// Book update from snapshot
// ---------------------------------------------------------------------------

/**
 * Applies a book snapshot to the appropriate side (YES or NO) of a MarketState
 * and recomputes all derived metrics.
 *
 * Returns a new MarketState object — the input is not mutated.
 */
export function updateBookFromSnapshot(
  state: MarketState,
  snapshot: ParsedBookSnapshot,
): MarketState {
  const t = now();
  const isYes = snapshot.token_id === state.tokens.yes_id;
  const side: 'yes' | 'no' = isYes ? 'yes' : 'no';

  // Determine previous best bid/ask for stability tracking
  const prevBook = state.book[side];
  const prevBestBid = prevBook.bids[0]?.[0] ?? 0;
  const prevBestAsk = prevBook.asks[0]?.[0] ?? 0;

  const newBestBid = snapshot.bids[0]?.[0] ?? 0;
  const newBestAsk = snapshot.asks[0]?.[0] ?? 0;

  const topChanged = newBestBid !== prevBestBid || newBestAsk !== prevBestAsk;
  const stabilityMs = topChanged ? 0 : prevBook.top_of_book_stability_ms + (t - prevBook.last_updated);

  // Build updated order book for this side
  const mid = (newBestBid && newBestAsk) ? (newBestBid + newBestAsk) / 2 : 0;
  const spread = (newBestBid && newBestAsk) ? newBestAsk - newBestBid : 0;
  const spreadBps = mid > 0 ? (spread / mid) * 10_000 : 0;

  const updatedBook: OrderBook = {
    bids: snapshot.bids,
    asks: snapshot.asks,
    mid,
    spread,
    spread_bps: spreadBps,
    imbalance: computeImbalance(snapshot.bids, snapshot.asks),
    imbalance_weighted: computeMultiLevelImbalance(snapshot.bids, snapshot.asks, 5),
    top_of_book_stability_ms: stabilityMs,
    queue_depth_at_best: isYes
      ? (snapshot.bids[0]?.[1] ?? 0)
      : (snapshot.asks[0]?.[1] ?? 0),
    microprice: 0, // set below
    last_updated: t,
  };

  // Microprice uses the book we just built
  updatedBook.microprice = computeMicroprice(updatedBook);
  if (isNaN(updatedBook.microprice)) updatedBook.microprice = mid;

  // Replace the affected side, keep the other untouched
  const newBooks = {
    yes: isYes ? updatedBook : state.book.yes,
    no: isYes ? state.book.no : updatedBook,
  };

  // Recompute cross-side metrics
  const yesMid = newBooks.yes.mid;
  const noMid = newBooks.no.mid;
  const complementGap = computeComplementGap(yesMid, noMid);

  const yesBestAsk = newBooks.yes.asks[0]?.[0] ?? NaN;
  const noBestAsk = newBooks.no.asks[0]?.[0] ?? NaN;
  const complementGapExecutable = computeComplementGapExecutable(
    yesBestAsk,
    noBestAsk,
    config.polymarket.fee_rate,
  );

  // Liquidity score: sum of both sides
  const liqYes = computeLiquidityScore(newBooks.yes.bids, newBooks.yes.asks, yesMid);
  const liqNo = computeLiquidityScore(newBooks.no.bids, newBooks.no.asks, noMid);
  const liquidityScore = (liqYes + liqNo) / 2;

  // Staleness: time since oldest side was last updated
  const oldestUpdate = Math.min(
    newBooks.yes.last_updated || t,
    newBooks.no.last_updated || t,
  );
  const stalenessMs = t - oldestUpdate;

  return {
    ...state,
    book: newBooks,
    liquidity_score: liquidityScore,
    complement_gap: complementGap,
    complement_gap_executable: isNaN(complementGapExecutable) ? 0 : complementGapExecutable,
    staleness_ms: stalenessMs,
    updated_at: t,
  };
}

// ---------------------------------------------------------------------------
// Trade update
// ---------------------------------------------------------------------------

/**
 * Updates market state in response to a trade event.
 * Increments volume/trade counters and sets last_trade_price for the token side.
 *
 * Returns a new MarketState object — the input is not mutated.
 */
export function updateBookFromTrade(
  state: MarketState,
  trade: ParsedTrade,
): MarketState {
  const isYes = trade.token_id === state.tokens.yes_id;
  const lastTradePrice = {
    yes: isYes ? trade.price : state.last_trade_price.yes,
    no: isYes ? state.last_trade_price.no : trade.price,
  };

  return {
    ...state,
    last_trade_price: lastTradePrice,
    volume_1h: state.volume_1h + trade.notional,
    volume_24h: state.volume_24h + trade.notional,
    trade_count_1h: state.trade_count_1h + 1,
    updated_at: now(),
  };
}

// ---------------------------------------------------------------------------
// Volatility
// ---------------------------------------------------------------------------

/**
 * Computes realised volatility from a series of prices over a window.
 *
 * 1. Computes log-returns: ln(p_t / p_{t-1})
 * 2. Returns the sample standard deviation of those log-returns.
 *
 * Returns 0 if fewer than 3 prices are provided.
 */
export function computeVolatility(priceHistory: number[]): number {
  if (priceHistory.length < 3) return 0;

  const logReturns: number[] = [];
  for (let i = 1; i < priceHistory.length; i++) {
    const prev = priceHistory[i - 1]!;
    const curr = priceHistory[i]!;
    if (prev > 0 && curr > 0) {
      logReturns.push(Math.log(curr / prev));
    }
  }

  if (logReturns.length < 2) return 0;
  return stddev(logReturns);
}
