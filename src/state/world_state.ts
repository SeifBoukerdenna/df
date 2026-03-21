import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { now } from '../utils/time.js';
import { getLogger } from '../utils/logger.js';
import { detectRegime } from './regime_detector.js';
import { createEmptyMarketState, updateBookFromSnapshot, updateBookFromTrade } from './market_state.js';
import { createEmptyWalletState, recomputeWalletStats } from './wallet_stats.js';
import type {
  WorldState as IWorldState,
  MarketState,
  WalletState,
  PositionState,
  MarketGraph,
  RegimeState,
} from './types.js';
import type { MarketMetadata, ParsedBookSnapshot, ParsedTrade, WalletTransaction } from '../ingestion/types.js';

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
  // Wallet tracking
  // -----------------------------------------------------------------------

  /**
   * Registers a wallet for tracking. No-op if already registered.
   */
  registerWallet(address: string, label?: string): void {
    const lower = address.toLowerCase();
    if (this.wallets.has(lower)) return;
    this.wallets.set(lower, createEmptyWalletState(lower, label));
  }

  /**
   * Records a wallet transaction and recomputes stats.
   * Auto-registers the wallet if not already tracked.
   */
  recordWalletTrade(tx: WalletTransaction): void {
    const addr = tx.wallet.toLowerCase();
    let wallet = this.wallets.get(addr);
    if (!wallet) {
      wallet = createEmptyWalletState(addr);
      this.wallets.set(addr, wallet);
    }

    wallet.trades.push(tx);
    wallet.stats = recomputeWalletStats(wallet.trades);
    this.system_clock = now();
  }

  /**
   * Records a wallet transaction with regime-conditional tracking.
   * Recomputes both overall stats and stats for the current regime.
   */
  recordWalletTradeWithRegime(tx: WalletTransaction): void {
    this.recordWalletTrade(tx);

    const addr = tx.wallet.toLowerCase();
    const wallet = this.wallets.get(addr);
    if (!wallet) return;

    const regimeName = this.regime.current_regime;
    const regimeTrades = wallet.trades.filter((t) => {
      // Approximate: assign trades to current regime
      // More precise regime assignment requires storing regime at trade time
      return true; // For now, all trades go into current regime bucket
    });

    wallet.regime_performance.set(regimeName, recomputeWalletStats(regimeTrades));
  }

  getWallet(address: string): WalletState | undefined {
    return this.wallets.get(address.toLowerCase());
  }

  getAllWallets(): WalletState[] {
    return Array.from(this.wallets.values());
  }

  // -----------------------------------------------------------------------
  // Trade enrichment
  // -----------------------------------------------------------------------

  /**
   * Resolves a WalletTransaction's market_id from its token_id by looking
   * up registered markets. Returns the enriched transaction, or null if
   * the token_id doesn't match any known market.
   */
  resolveWalletTradeMarket(tx: WalletTransaction): WalletTransaction | null {
    if (tx.market_id) return tx; // already resolved

    for (const market of this.markets.values()) {
      if (market.tokens.yes_id === tx.token_id || market.tokens.no_id === tx.token_id) {
        return { ...tx, market_id: market.market_id };
      }
    }

    return null;
  }

  /**
   * Enriches a WalletTransaction's price from a matching CLOB trade event.
   * Looks for a trade with the same tx_hash or (token_id, timestamp within 5s).
   */
  enrichWalletTradePrice(tx: WalletTransaction, recentTrades: ParsedTrade[]): WalletTransaction {
    if (tx.price > 0) return tx; // already has price

    // Match by tx_hash first (most reliable)
    if (tx.tx_hash) {
      const match = recentTrades.find((t) => t.tx_hash === tx.tx_hash);
      if (match) return { ...tx, price: match.price };
    }

    // Match by token_id + timestamp proximity
    const match = recentTrades.find(
      (t) =>
        t.token_id === tx.token_id &&
        Math.abs(t.timestamp - tx.timestamp) < 5_000,
    );
    if (match) return { ...tx, price: match.price };

    return tx;
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
