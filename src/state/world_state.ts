import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { now } from '../utils/time.js';
import { getLogger } from '../utils/logger.js';
import { detectRegime } from './regime_detector.js';
import { createEmptyMarketState, updateBookFromSnapshot, updateBookFromTrade } from './market_state.js';
import type {
  WorldState as IWorldState,
  MarketState,
  WalletState,
  PositionState,
  MarketGraph,
  RegimeState,
} from './types.js';
import type { MarketMetadata, ParsedBookSnapshot, ParsedTrade } from '../ingestion/types.js';

const log = getLogger('state');

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

/** Converts a value with Maps into a plain JSON-safe object. */
function toSerializable(obj: unknown): unknown {
  if (obj instanceof Map) {
    const entries: Record<string, unknown> = {};
    for (const [k, v] of obj) {
      entries[String(k)] = toSerializable(v);
    }
    return { __type: 'Map', entries };
  }
  if (Array.isArray(obj)) {
    return obj.map(toSerializable);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = toSerializable(v);
    }
    return result;
  }
  return obj;
}

/** Revives Maps that were serialised by toSerializable. */
function fromSerializable(obj: unknown): unknown {
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    const record = obj as Record<string, unknown>;
    if (record['__type'] === 'Map' && typeof record['entries'] === 'object' && record['entries'] !== null) {
      const map = new Map<string, unknown>();
      for (const [k, v] of Object.entries(record['entries'] as Record<string, unknown>)) {
        map.set(k, fromSerializable(v));
      }
      return map;
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(record)) {
      result[k] = fromSerializable(v);
    }
    return result;
  }
  if (Array.isArray(obj)) {
    return obj.map(fromSerializable);
  }
  return obj;
}

// ---------------------------------------------------------------------------
// WorldState class
// ---------------------------------------------------------------------------

export class WorldState implements IWorldState {
  markets: Map<string, MarketState> = new Map();
  wallets: Map<string, WalletState> = new Map();
  own_positions: Map<string, PositionState> = new Map();
  market_graph: MarketGraph = { edges: new Map(), clusters: [] };
  regime: RegimeState;
  system_clock: number;

  constructor() {
    this.regime = detectRegime();
    this.system_clock = now();
  }

  // -----------------------------------------------------------------------
  // Market registration
  // -----------------------------------------------------------------------

  /** Registers a market from metadata. No-op if already registered. */
  registerMarket(metadata: MarketMetadata): void {
    if (this.markets.has(metadata.market_id)) return;
    this.markets.set(metadata.market_id, createEmptyMarketState(metadata));
  }

  // -----------------------------------------------------------------------
  // Market updates (synchronous, atomic per-market)
  // -----------------------------------------------------------------------

  /**
   * Applies a book snapshot to the corresponding market.
   * If the market isn't registered yet, the snapshot is silently dropped.
   */
  updateMarket(snapshot: ParsedBookSnapshot): void {
    const existing = this.markets.get(snapshot.market_id);
    if (!existing) {
      log.warn({ market_id: snapshot.market_id }, 'Snapshot for unregistered market — skipped');
      return;
    }
    // Atomic: compute the new state, then swap it in a single assignment
    const updated = updateBookFromSnapshot(existing, snapshot);
    this.markets.set(snapshot.market_id, updated);
    this.system_clock = now();
  }

  /**
   * Applies a trade event to the corresponding market.
   */
  updateMarketFromTrade(trade: ParsedTrade): void {
    const existing = this.markets.get(trade.market_id);
    if (!existing) {
      log.warn({ market_id: trade.market_id }, 'Trade for unregistered market — skipped');
      return;
    }
    const updated = updateBookFromTrade(existing, trade);
    this.markets.set(trade.market_id, updated);
    this.system_clock = now();
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  getMarket(marketId: string): MarketState | undefined {
    return this.markets.get(marketId);
  }

  getAllMarkets(): MarketState[] {
    return Array.from(this.markets.values());
  }

  // -----------------------------------------------------------------------
  // Serialisation / persistence
  // -----------------------------------------------------------------------

  /** Returns the full state as a plain JSON-safe object. */
  serialize(): object {
    return toSerializable({
      markets: this.markets,
      wallets: this.wallets,
      own_positions: this.own_positions,
      market_graph: this.market_graph,
      regime: this.regime,
      system_clock: this.system_clock,
    }) as object;
  }

  /** Writes the serialised state to a JSON file on disk. */
  saveToDisk(filePath: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(filePath, JSON.stringify(this.serialize(), null, 2), 'utf-8');
    log.info({ filePath, markets: this.markets.size }, 'State snapshot saved');
  }

  /**
   * Restores state from a previously saved JSON snapshot.
   * Replaces all current state with the loaded data.
   */
  loadFromDisk(filePath: string): void {
    if (!existsSync(filePath)) {
      log.warn({ filePath }, 'State snapshot file not found');
      return;
    }
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    const revived = fromSerializable(raw) as Record<string, unknown>;

    this.markets = (revived['markets'] as Map<string, MarketState>) ?? new Map();
    this.wallets = (revived['wallets'] as Map<string, WalletState>) ?? new Map();
    this.own_positions = (revived['own_positions'] as Map<string, PositionState>) ?? new Map();
    this.market_graph = (revived['market_graph'] as MarketGraph) ?? { edges: new Map(), clusters: [] };
    this.regime = (revived['regime'] as RegimeState) ?? detectRegime();
    this.system_clock = (revived['system_clock'] as number) ?? now();

    log.info({ filePath, markets: this.markets.size }, 'State restored from snapshot');
  }
}
