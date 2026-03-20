import { EventEmitter } from 'node:events';
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

  constructor(gammaUrl: string, pollIntervalMs: number) {
    super();
    this.gammaUrl = gammaUrl;
    this.pollIntervalMs = pollIntervalMs;
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
    log.info('MarketMetadataFetcher stopped');
  }

  getKnownMarkets(): Map<string, MarketMetadata> {
    return this.knownMarkets;
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
      const delay = Math.min(30_000, this.pollIntervalMs);
      log.warn({ err }, `MarketMetadataFetcher error, retrying in ${delay}ms`);
      this.schedule(delay);
    }
  }

  private async fetchAllMarkets(): Promise<MarketMetadata[]> {
    const results: MarketMetadata[] = [];
    let offset = 0;
    const limit = 100;

    for (;;) {
      const url = `${this.gammaUrl}/markets?limit=${limit}&offset=${offset}&active=true&closed=false`;
      const resp = await fetch(url);

      if (resp.status === 429) {
        const retryAfter = Number(resp.headers.get('retry-after') ?? '5');
        await sleep(retryAfter * 1000);
        continue;
      }

      if (!resp.ok) {
        throw new Error(`Gamma API HTTP ${resp.status}: ${resp.statusText}`);
      }

      const data = (await resp.json()) as unknown;

      // Gamma API may return array directly or {data: [...]}
      const page: unknown[] = Array.isArray(data)
        ? (data as unknown[])
        : (data as { data: unknown[] }).data ?? [];

      for (const raw of page) {
        const meta = parseMarket(raw);
        if (meta !== null) results.push(meta);
      }

      if (page.length < limit) break;
      offset += limit;
    }

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

function parseMarket(raw: unknown): MarketMetadata | null {
  try {
    const r = raw as Record<string, unknown>;

    const conditionId = String(r['conditionId'] ?? r['condition_id'] ?? '');
    const marketId = String(r['id'] ?? conditionId);
    const question = String(r['question'] ?? '');

    if (!marketId || !question) return null;

    // Parse tokens
    const tokensRaw = r['tokens'] as Array<Record<string, unknown>> | undefined;
    const yesToken = tokensRaw?.find((t) => String(t['outcome']).toUpperCase() === 'YES');
    const noToken = tokensRaw?.find((t) => String(t['outcome']).toUpperCase() === 'NO');
    const yesId = String(yesToken?.['token_id'] ?? yesToken?.['tokenId'] ?? '');
    const noId = String(noToken?.['token_id'] ?? noToken?.['tokenId'] ?? '');

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
