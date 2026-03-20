import { EventEmitter } from 'node:events';
import { getLogger } from '../utils/logger.js';
import { now } from '../utils/time.js';
import { config } from '../utils/config.js';
import type { MarketMetadata, MarketTokens } from './types.js';

const log = getLogger('ingestion.metadata');

// ---------------------------------------------------------------------------
// Gamma API response shapes (subset we care about)
// ---------------------------------------------------------------------------

interface GammaMarketResponse {
  id: string;
  question: string;
  conditionId: string;
  tokens: { token_id: string; outcome: string }[];
  active: boolean;
  closed: boolean;
  resolved: boolean;
  resolutionSource?: string;
  endDate: string;
  category?: string;
  tags?: { label: string }[];
  outcome?: string; // "Yes" | "No" when resolved
}

interface GammaListResponse {
  data?: GammaMarketResponse[];
  // Gamma API may return the array directly depending on the endpoint
  next_cursor?: string;
}

// ---------------------------------------------------------------------------
// MarketMetadataFetcher
// ---------------------------------------------------------------------------

export interface MarketMetadataFetcherEvents {
  market_created: [metadata: MarketMetadata];
  market_resolved: [metadata: MarketMetadata];
  metadata_updated: [markets: MarketMetadata[]];
  error: [error: Error];
}

export class MarketMetadataFetcher extends EventEmitter<MarketMetadataFetcherEvents> {
  private readonly gammaUrl: string;
  private readonly pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly knownMarkets: Map<string, MarketMetadata> = new Map();
  private running = false;

  constructor() {
    super();
    this.gammaUrl = config.polymarket.gamma_url;
    this.pollIntervalMs = config.ingestion.metadata_poll_interval_ms;
  }

  /** Starts polling. First fetch is immediate. */
  start(): void {
    if (this.running) return;
    this.running = true;
    log.info({ interval_ms: this.pollIntervalMs }, 'Metadata fetcher started');

    // Fire-and-forget the first poll
    void this.poll();

    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    log.info('Metadata fetcher stopped');
  }

  /** Returns currently known markets. */
  getMarkets(): MarketMetadata[] {
    return Array.from(this.knownMarkets.values());
  }

  getMarket(marketId: string): MarketMetadata | undefined {
    return this.knownMarkets.get(marketId);
  }

  // -----------------------------------------------------------------------
  // Polling
  // -----------------------------------------------------------------------

  async poll(): Promise<void> {
    try {
      const fetched = await this.fetchAllMarkets();
      this.diffAndEmit(fetched);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error({ err: error }, 'Metadata poll failed');
      this.emit('error', error);
    }
  }

  // -----------------------------------------------------------------------
  // REST fetch with pagination
  // -----------------------------------------------------------------------

  private async fetchAllMarkets(): Promise<MarketMetadata[]> {
    const all: MarketMetadata[] = [];
    let cursor: string | undefined;
    let page = 0;
    const maxPages = 100; // safety limit

    do {
      const url = new URL('/markets', this.gammaUrl);
      url.searchParams.set('limit', '100');
      url.searchParams.set('active', 'true');
      if (cursor) {
        url.searchParams.set('next_cursor', cursor);
      }

      const response = await this.fetchWithRetry(url.toString(), 3);
      if (!response) break;

      const body = (await response.json()) as GammaListResponse | GammaMarketResponse[];
      const markets = Array.isArray(body) ? body : (body.data ?? []);
      cursor = Array.isArray(body) ? undefined : body.next_cursor;

      for (const raw of markets) {
        const parsed = this.parseMarket(raw);
        if (parsed) all.push(parsed);
      }

      page++;
      if (page >= maxPages) {
        log.warn('Hit max pagination limit for market metadata');
        break;
      }
    } while (cursor);

    log.debug({ count: all.length }, 'Fetched market metadata');
    return all;
  }

  private async fetchWithRetry(
    url: string,
    maxRetries: number,
  ): Promise<Response | null> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });

        if (response.ok) return response;

        // Rate limited — wait and retry
        if (response.status === 429) {
          const delay = Math.min(1000 * 2 ** attempt, 30_000);
          log.warn({ status: 429, delay, attempt }, 'Rate limited, backing off');
          await this.sleep(delay);
          continue;
        }

        // Other HTTP error
        log.warn({ status: response.status, url, attempt }, 'HTTP error fetching metadata');
        lastError = new Error(`HTTP ${response.status}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          const delay = Math.min(1000 * 2 ** attempt, 30_000);
          log.warn({ err: lastError, delay, attempt }, 'Fetch error, retrying');
          await this.sleep(delay);
        }
      }
    }

    if (lastError) {
      log.error({ err: lastError, url }, 'All retries exhausted for metadata fetch');
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // Parsing
  // -----------------------------------------------------------------------

  private parseMarket(raw: GammaMarketResponse): MarketMetadata | null {
    try {
      const tokens = this.extractTokens(raw.tokens);
      if (!tokens) return null;

      let status: 'active' | 'paused' | 'resolved';
      if (raw.resolved) {
        status = 'resolved';
      } else if (raw.closed || !raw.active) {
        status = 'paused';
      } else {
        status = 'active';
      }

      let resolution: 'YES' | 'NO' | null = null;
      if (raw.outcome === 'Yes') resolution = 'YES';
      else if (raw.outcome === 'No') resolution = 'NO';

      return {
        market_id: raw.id,
        question: raw.question,
        condition_id: raw.conditionId,
        tokens,
        status,
        resolution,
        end_date: raw.endDate,
        category: raw.category ?? 'uncategorized',
        tags: (raw.tags ?? []).map((t) => t.label),
      };
    } catch {
      log.warn({ market_id: raw.id }, 'Failed to parse market metadata');
      return null;
    }
  }

  private extractTokens(
    tokens: { token_id: string; outcome: string }[],
  ): MarketTokens | null {
    const yes = tokens.find((t) => t.outcome === 'Yes');
    const no = tokens.find((t) => t.outcome === 'No');
    if (!yes || !no) return null;
    return { yes_id: yes.token_id, no_id: no.token_id };
  }

  // -----------------------------------------------------------------------
  // Diff & emit
  // -----------------------------------------------------------------------

  private diffAndEmit(fetched: MarketMetadata[]): void {
    const fetchedMap = new Map(fetched.map((m) => [m.market_id, m]));

    // Detect new markets
    for (const market of fetched) {
      if (!this.knownMarkets.has(market.market_id)) {
        log.info({ market_id: market.market_id, question: market.question }, 'New market detected');
        this.emit('market_created', market);
      }
    }

    // Detect resolutions: known market was active, now resolved
    for (const [id, known] of this.knownMarkets) {
      const updated = fetchedMap.get(id);
      if (updated && updated.status === 'resolved' && known.status !== 'resolved') {
        log.info(
          { market_id: id, resolution: updated.resolution },
          'Market resolved',
        );
        this.emit('market_resolved', updated);
      }
    }

    // Replace known markets with the fresh set
    this.knownMarkets.clear();
    for (const m of fetched) {
      this.knownMarkets.set(m.market_id, m);
    }

    this.emit('metadata_updated', fetched);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
