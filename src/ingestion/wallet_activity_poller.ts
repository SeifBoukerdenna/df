// ---------------------------------------------------------------------------
// Wallet Activity Poller — CLOB-side wallet trade detection
//
// Polls `data-api.polymarket.com/activity?user={address}` for each tracked
// wallet. This endpoint returns trades from the CLOB matching engine, which
// knows about trades BEFORE they settle on-chain.
//
// Compared to the on-chain Alchemy path (WalletListener):
//   - Alchemy: block confirmation (~2s) + delivery (~1s) = ~3-5s after trade
//   - This poller: depends on data-api update lag (needs empirical measurement)
//   - This poller provides: exact fill price, market metadata, conditionId
//   - Alchemy provides: only token_id + size (no price, no market_id)
//
// The two paths race each other. Whichever fires first triggers strategy eval.
// The cross-source dedup in main.ts (walletTxSeen) prevents double-processing.
// ---------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { Pool } from 'undici';
import { now } from '../utils/time.js';
import { getLogger } from '../utils/logger.js';
import type { WalletTransaction } from './types.js';

const log = getLogger('wallet_activity_poller');

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface WalletActivityPollerEvents {
  wallet_trade: [tx: WalletTransaction];
  error: [err: Error];
}

// ---------------------------------------------------------------------------
// Types for the data-api response
// ---------------------------------------------------------------------------

interface DataApiActivity {
  proxyWallet: string;
  timestamp: number;        // Unix seconds
  conditionId: string;
  type: string;             // "TRADE" | "MERGE" | etc.
  size: number;
  usdcSize: number;
  transactionHash: string;
  price: number;
  asset: string;            // token_id (77-char decimal)
  side: string;             // "BUY" | "SELL"
  outcomeIndex: number;
  title: string;
  slug: string;
  eventSlug: string;
}

// ---------------------------------------------------------------------------
// WalletActivityPoller
// ---------------------------------------------------------------------------

export class WalletActivityPoller extends EventEmitter {
  private readonly dataApiUrl: string;
  private readonly pollIntervalMs: number;
  private readonly trackedWallets: Set<string>;
  private readonly pool: Pool;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  // Per-wallet: last seen transaction hash to detect new trades
  private readonly lastSeenTx = new Map<string, string>();
  // Per-wallet: last seen timestamp to avoid re-emitting old trades
  private readonly lastSeenTs = new Map<string, number>();

  // Metrics
  readonly metrics = {
    polls: 0,
    trades_detected: 0,
    errors: 0,
    avg_poll_ms: 0,
  };

  private pollTimes: number[] = [];
  private backoffUntil = 0; // timestamp — skip polls until this time
  private consecutiveRateLimits = 0;

  constructor(opts: {
    dataApiUrl?: string;
    pollIntervalMs?: number;
    trackedWallets: string[];
  }) {
    super();
    this.dataApiUrl = opts.dataApiUrl ?? 'https://data-api.polymarket.com';
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000; // 1s default — aggressive
    this.trackedWallets = new Set(opts.trackedWallets.map(w => w.toLowerCase()));

    const url = new URL(this.dataApiUrl);
    this.pool = new Pool(`${url.protocol}//${url.host}`, {
      connections: Math.min(this.trackedWallets.size, 6), // one per wallet, max 6
      pipelining: 1,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    if (this.trackedWallets.size === 0) {
      log.warn('WalletActivityPoller: no tracked wallets');
      return;
    }

    // Seed lastSeenTs with current time so the first poll only catches
    // genuinely new trades, not hundreds of historical ones.
    const startTs = now();
    for (const w of this.trackedWallets) {
      if (!this.lastSeenTs.has(w)) {
        this.lastSeenTs.set(w, startTs);
      }
    }

    log.info(
      { wallets: this.trackedWallets.size, interval_ms: this.pollIntervalMs },
      'WalletActivityPoller starting',
    );

    // Initial poll immediately
    void this.pollAll();

    // Then poll on interval
    this.pollTimer = setInterval(() => void this.pollAll(), this.pollIntervalMs);
    this.pollTimer.unref();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.pool.close().catch(() => {});
    log.info('WalletActivityPoller stopped');
  }

  /**
   * Fetch historical trades for all tracked wallets to bootstrap delay curves.
   * Returns all trades sorted oldest-first. These should be recorded in state
   * but NOT treated as live signals.
   */
  async bootstrap(limit: number = 100): Promise<WalletTransaction[]> {
    const allTrades: WalletTransaction[] = [];
    const wallets = [...this.trackedWallets];
    const batchSize = 4;

    log.info({ wallets: wallets.length, limit }, 'Bootstrapping historical wallet trades');

    for (let i = 0; i < wallets.length; i += batchSize) {
      const batch = wallets.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(w => this.fetchHistorical(w, limit)),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') allTrades.push(...r.value);
      }
    }

    // Sort oldest first so FIFO trade matching works correctly
    allTrades.sort((a, b) => a.timestamp - b.timestamp);

    log.info({ total_trades: allTrades.length, wallets: wallets.length }, 'Bootstrap complete');
    return allTrades;
  }

  private async fetchHistorical(address: string, limit: number): Promise<WalletTransaction[]> {
    const trades: WalletTransaction[] = [];
    try {
      const urlObj = new URL(this.dataApiUrl);
      const path = `${urlObj.pathname}/activity?user=${address}&limit=${limit}`.replace('//', '/');

      const { statusCode, body } = await this.pool.request({
        method: 'GET',
        path,
        headers: { accept: 'application/json' },
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      });

      if (statusCode !== 200) {
        await body.dump();
        return trades;
      }

      const data = (await body.json()) as DataApiActivity[];
      if (!Array.isArray(data)) return trades;

      for (const activity of data) {
        if (activity.type !== 'TRADE') continue;
        if (!activity.transactionHash) continue;

        trades.push({
          wallet: address,
          market_id: '',
          token_id: activity.asset,
          side: activity.side.toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
          price: activity.price,
          size: activity.size,
          timestamp: activity.timestamp * 1000,
          tx_hash: activity.transactionHash,
          block_number: 0,
          gas_price: 0,
        });
      }

      log.info({ wallet: address.slice(0, 10), trades: trades.length }, 'Fetched historical trades');
    } catch (err) {
      log.warn({ err, wallet: address.slice(0, 10) }, 'Historical fetch failed');
    }
    return trades;
  }

  addWallet(address: string): void {
    this.trackedWallets.add(address.toLowerCase());
  }

  removeWallet(address: string): void {
    const lower = address.toLowerCase();
    this.trackedWallets.delete(lower);
    this.lastSeenTx.delete(lower);
    this.lastSeenTs.delete(lower);
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  private async pollAll(): Promise<void> {
    // Skip if we're in backoff from rate limiting
    if (now() < this.backoffUntil) return;

    // Poll all wallets in parallel with concurrency limit
    const wallets = [...this.trackedWallets];
    const batchSize = 4; // max concurrent requests

    for (let i = 0; i < wallets.length; i += batchSize) {
      if (now() < this.backoffUntil) return; // abort if rate limited mid-cycle
      const batch = wallets.slice(i, i + batchSize);
      await Promise.allSettled(batch.map(w => this.pollWallet(w)));
    }
  }

  private async pollWallet(address: string): Promise<void> {
    const start = now();
    this.metrics.polls++;

    try {
      const urlObj = new URL(this.dataApiUrl);
      const path = `${urlObj.pathname}/activity?user=${address}&limit=5`.replace('//', '/');

      const { statusCode, body } = await this.pool.request({
        method: 'GET',
        path,
        headers: { accept: 'application/json' },
        headersTimeout: 3_000,
        bodyTimeout: 3_000,
      });

      if (statusCode !== 200) {
        await body.dump();
        if (statusCode === 429) {
          this.consecutiveRateLimits++;
          const backoffMs = Math.min(1000 * Math.pow(2, this.consecutiveRateLimits), 30_000);
          this.backoffUntil = now() + backoffMs;
          log.warn({ backoff_ms: backoffMs, consecutive: this.consecutiveRateLimits },
            'WalletActivityPoller: rate limited (429), backing off');
        }
        return;
      }

      // Reset rate limit counter on success
      if (this.consecutiveRateLimits > 0) {
        this.consecutiveRateLimits = 0;
      }

      const data = (await body.json()) as DataApiActivity[];
      if (!Array.isArray(data) || data.length === 0) return;

      const elapsed = now() - start;
      this.pollTimes.push(elapsed);
      if (this.pollTimes.length > 100) this.pollTimes.shift();
      this.metrics.avg_poll_ms = this.pollTimes.reduce((a, b) => a + b, 0) / this.pollTimes.length;

      // Process new trades (most recent first)
      const lastTx = this.lastSeenTx.get(address);
      const lastTs = this.lastSeenTs.get(address) ?? 0;

      for (const activity of data) {
        if (activity.type !== 'TRADE') continue;
        if (!activity.transactionHash) continue;

        // Skip if we've already seen this tx
        if (activity.transactionHash === lastTx) break;

        // Skip if older than last seen timestamp (first poll catchup)
        const activityTs = activity.timestamp * 1000; // convert to ms
        if (activityTs <= lastTs) break;

        // New trade detected!
        const tx: WalletTransaction = {
          wallet: address,
          market_id: '', // Will be resolved by main thread via state.resolveWalletTradeMarket
          token_id: activity.asset,
          side: activity.side.toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
          price: activity.price,
          size: activity.size,
          timestamp: activityTs,
          tx_hash: activity.transactionHash,
          block_number: 0,
          gas_price: 0,
        };

        this.metrics.trades_detected++;
        this.emit('wallet_trade', tx);

        const walletShort = address.slice(0, 6) + '…' + address.slice(-4);
        log.info(
          {
            wallet: address,
            side: tx.side,
            size: tx.size,
            price: tx.price,
            token: tx.token_id.slice(0, 16),
            age_ms: now() - activityTs,
          },
          `wallet_trade (data-api) | [${walletShort}] ${tx.side} ${tx.size.toFixed(1)} @ $${tx.price.toFixed(3)}`,
        );
      }

      // Update last-seen markers
      if (data.length > 0 && data[0]!.type === 'TRADE' && data[0]!.transactionHash) {
        this.lastSeenTx.set(address, data[0]!.transactionHash);
        this.lastSeenTs.set(address, data[0]!.timestamp * 1000);
      }
    } catch (err) {
      this.metrics.errors++;
      // Don't spam logs — only log occasionally
      if (this.metrics.errors % 10 === 1) {
        log.warn({ err, wallet: address.slice(0, 10) }, 'WalletActivityPoller poll failed');
      }
    }
  }
}
