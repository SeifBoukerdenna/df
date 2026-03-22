import { EventEmitter } from 'node:events';
import { Pool } from 'undici';
import { now } from '../utils/time.js';
import { getLogger } from '../utils/logger.js';
import type { MarketMetadata } from './types.js';

const log = getLogger('market_metadata');

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface MarketMetadataEvents {
  market_created: [metadata: MarketMetadata];
  market_resolved: [metadata: MarketMetadata];
  error: [err: Error];
}

// ---------------------------------------------------------------------------
// MarketMetadataFetcher
// ---------------------------------------------------------------------------

/**
 * Polls the Polymarket Gamma API for market metadata.
 * Diffs on each fetch: emits market_created / market_resolved for changes.
 * Exponential backoff on error. 429 handling with retry-after.
 */
export class MarketMetadataFetcher extends EventEmitter {
  private readonly gammaUrl: string;
  private readonly pollIntervalMs: number;
  private readonly knownMarkets = new Map<string, MarketMetadata>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private readonly minLiquidity: number;
  private readonly maxMarkets: number;
  private readonly pool: Pool;

  constructor(gammaUrl: string, pollIntervalMs: number, opts?: { minLiquidity?: number; maxMarkets?: number }) {
    super();
    this.gammaUrl = gammaUrl;
    this.pollIntervalMs = pollIntervalMs;
    this.minLiquidity = opts?.minLiquidity ?? 1000;
    this.maxMarkets = opts?.maxMarkets ?? 500;

    const url = new URL(gammaUrl);
    this.pool = new Pool(`${url.protocol}//${url.host}`, {
      connections: 2,
      pipelining: 1,
      // Keep connections alive longer than the poll interval so we don't burn
      // a new TCP connection (and leave one in TIME_WAIT) on every metadata poll.
      keepAliveTimeout: Math.max(pollIntervalMs * 1.5, 90_000),
      keepAliveMaxTimeout: Math.max(pollIntervalMs * 2, 120_000),
      connect: { timeout: 15_000 },
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    log.info('MarketMetadataFetcher starting');
    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    void this.pool.destroy();
    log.info('MarketMetadataFetcher stopped');
  }

  getKnownMarkets(): Map<string, MarketMetadata> {
    return this.knownMarkets;
  }

  /**
   * On-demand lookup: given a token_id (on-chain asset_id) that isn't in state,
   * query the Gamma API to find which market it belongs to.
   * Returns the MarketMetadata and emits market_created if found.
   * Returns null if not found or already known.
   */
  async lookupByTokenId(tokenId: string): Promise<MarketMetadata | null> {
    const basePath = new URL(this.gammaUrl).pathname;
    const path = `${basePath}/markets?clob_token_ids=${encodeURIComponent(tokenId)}&limit=1`;

    try {
      const { statusCode, body } = await this.pool.request({
        method: 'GET',
        path,
        headers: { accept: 'application/json' },
        headersTimeout: 10_000,
        bodyTimeout: 10_000,
      });

      if (statusCode < 200 || statusCode >= 300) {
        await body.dump();
        return null;
      }

      const data = (await body.json()) as unknown;
      const page: unknown[] = Array.isArray(data)
        ? (data as unknown[])
        : (data as { data: unknown[] }).data ?? [];

      if (page.length === 0) return null;

      const meta = parseMarket(page[0]);
      if (!meta) return null;

      // Register as known and emit market_created (bypasses liquidity filter —
      // we want to track any market a tracked wallet is actually trading)
      if (!this.knownMarkets.has(meta.market_id)) {
        this.knownMarkets.set(meta.market_id, meta);
        log.info(
          { market_id: meta.market_id, question: meta.question, token_id: tokenId.slice(0, 20) },
          'market_discovered_via_wallet_trade',
        );
        this.emit('market_created', meta);
      }

      return meta;
    } catch (err) {
      log.debug({ err, token_id: tokenId.slice(0, 20) }, 'Token lookup failed');
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => {
      void this.poll();
    }, delayMs);
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const markets = await this.fetchAllMarkets();
      this.diff(markets);
      this.schedule(this.pollIntervalMs);
    } catch (err) {
      const delay = Math.min(10_000, this.pollIntervalMs);
      log.warn({ err }, `MarketMetadataFetcher error, retrying in ${delay}ms`);
      this.emit('error', err as Error);
      this.schedule(delay);
    }
  }

  private async fetchAllMarkets(): Promise<MarketMetadata[]> {
    const results: MarketMetadata[] = [];
    let offset = 0;
    const limit = 100;

    // Sort by volume descending to get the most liquid markets first.
    // Cap total pages to avoid fetching 35K+ markets (most are dead/low volume).
    const maxPages = Math.ceil(this.maxMarkets / limit);
    let pageCount = 0;
    const basePath = new URL(this.gammaUrl).pathname;

    for (;;) {
      const path = `${basePath}/markets?limit=${limit}&offset=${offset}&active=true&closed=false&order=volume24hr&ascending=false`;

      // Retry each page up to 3 times on transient connection errors (ECONNRESET,
      // EADDRNOTAVAIL) before propagating to the top-level poll() error handler.
      const resp = await (async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await this.pool.request({
              method: 'GET',
              path,
              headers: { accept: 'application/json' },
              headersTimeout: 15_000,
              bodyTimeout: 15_000,
            });
          } catch (err) {
            if (attempt < 3) {
              log.debug({ attempt: attempt + 1, offset, err }, 'Gamma API page fetch transient error, retrying');
              await sleep(500 * Math.pow(2, attempt));
              continue;
            }
            throw err; // exhausted retries — propagate to poll()
          }
        }
      })();

      const { statusCode, body, headers } = resp;

      if (statusCode === 429) {
        const retryAfter = Number((headers as Record<string, string>)['retry-after'] ?? '5');
        await body.dump();
        await sleep(retryAfter * 1000);
        continue;
      }

      if (statusCode < 200 || statusCode >= 300) {
        await body.dump();
        throw new Error(`Gamma API HTTP ${statusCode}`);
      }

      const data = (await body.json()) as unknown;

      // Gamma API may return array directly or {data: [...]}
      const page: unknown[] = Array.isArray(data)
        ? (data as unknown[])
        : (data as { data: unknown[] }).data ?? [];

      for (const raw of page) {
        const meta = parseMarketWithLiquidity(raw, this.minLiquidity);
        if (meta !== null) results.push(meta);
      }

      pageCount++;
      if (page.length < limit || pageCount >= maxPages) break;
      offset += limit;
    }

    log.info({
      total_markets: results.length,
      with_tokens: results.filter(m => m.tokens.yes_id && m.tokens.no_id).length,
      pages_fetched: pageCount,
      max_markets: this.maxMarkets,
    }, 'Fetched markets from Gamma API');
    return results;
  }

  private diff(markets: MarketMetadata[]): void {
    const t = now();

    for (const meta of markets) {
      const prev = this.knownMarkets.get(meta.market_id);

      if (prev === undefined) {
        // New market discovered
        this.knownMarkets.set(meta.market_id, meta);
        log.info({ market_id: meta.market_id, question: meta.question }, 'market_created');
        this.emit('market_created', meta);
      } else if (prev.status !== meta.status || prev.resolution !== meta.resolution) {
        // Status change — check for resolution
        this.knownMarkets.set(meta.market_id, meta);

        if (meta.status === 'resolved' && prev.status !== 'resolved') {
          log.info(
            { market_id: meta.market_id, resolution: meta.resolution, t },
            'market_resolved',
          );
          this.emit('market_resolved', meta);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseMarketWithLiquidity(raw: unknown, minLiquidity: number): MarketMetadata | null {
  try {
    const r = raw as Record<string, unknown>;
    const liquidity = Number(r['liquidity'] ?? 0);
    if (liquidity < minLiquidity) return null;
  } catch {
    return null;
  }
  return parseMarket(raw);
}

function parseMarket(raw: unknown): MarketMetadata | null {
  try {
    const r = raw as Record<string, unknown>;

    const conditionId = String(r['conditionId'] ?? r['condition_id'] ?? '');
    const marketId = String(r['id'] ?? conditionId);
    const question = String(r['question'] ?? '');

    if (!marketId || !question) return null;

    // Parse tokens — Gamma API returns clobTokenIds as a JSON-encoded array [yesId, noId]
    // Fall back to legacy tokens array format if present
    let yesId = '';
    let noId = '';
    const clobTokenIdsRaw = r['clobTokenIds'];
    if (clobTokenIdsRaw) {
      const parsed: string[] = typeof clobTokenIdsRaw === 'string'
        ? (JSON.parse(clobTokenIdsRaw) as string[])
        : (clobTokenIdsRaw as string[]);
      yesId = String(parsed[0] ?? '');
      noId = String(parsed[1] ?? '');
    } else {
      const tokensRaw = r['tokens'] as Array<Record<string, unknown>> | undefined;
      const yesToken = tokensRaw?.find((t) => String(t['outcome']).toUpperCase() === 'YES');
      const noToken = tokensRaw?.find((t) => String(t['outcome']).toUpperCase() === 'NO');
      yesId = String(yesToken?.['token_id'] ?? yesToken?.['tokenId'] ?? '');
      noId = String(noToken?.['token_id'] ?? noToken?.['tokenId'] ?? '');
    }

    const statusRaw = String(r['status'] ?? 'active').toLowerCase();
    const status: 'active' | 'paused' | 'resolved' =
      statusRaw === 'resolved' ? 'resolved' : statusRaw === 'paused' ? 'paused' : 'active';

    const resolutionRaw = r['resolution'] as string | null | undefined;
    const resolution: 'YES' | 'NO' | null =
      resolutionRaw === 'YES' ? 'YES' : resolutionRaw === 'NO' ? 'NO' : null;

    return {
      market_id: marketId,
      question,
      condition_id: conditionId,
      tokens: { yes_id: yesId, no_id: noId },
      status,
      resolution,
      end_date: String(r['endDate'] ?? r['end_date'] ?? ''),
      category: String(r['category'] ?? ''),
      tags: Array.isArray(r['tags']) ? (r['tags'] as string[]) : [],
    };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
