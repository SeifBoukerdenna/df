/**
 * Round-trip tests.
 *
 * 1. Ledger: write 100 entries of mixed types, replay, assert exact match.
 * 2. WorldState: populate with multiple markets + positions + wallets,
 *    serialize/load, assert full structural fidelity.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Ledger } from '../../src/ledger/ledger.js';
import { replay, replayAll, verifyChecksum } from '../../src/ledger/replay.js';
import { WorldState } from '../../src/state/world_state.js';
import type { LedgerEntry, LedgerRecord } from '../../src/ledger/types.js';
import type { MarketMetadata, ParsedBookSnapshot, ParsedTrade } from '../../src/ingestion/types.js';

// ---------------------------------------------------------------------------
// Shared dirs
// ---------------------------------------------------------------------------

const LEDGER_DIR = join(import.meta.dirname, '..', '..', 'tmp_rt_ledger');
const STATE_DIR = join(import.meta.dirname, '..', '..', 'tmp_rt_state');

beforeEach(() => {
  rmSync(LEDGER_DIR, { recursive: true, force: true });
  rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(LEDGER_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(LEDGER_DIR, { recursive: true, force: true });
  rmSync(STATE_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Ledger entry factories
// ---------------------------------------------------------------------------

function makeSignalEntry(i: number): LedgerEntry {
  return {
    type: 'signal_generated',
    data: {
      signal_id: `sig_${i}`,
      strategy_id: `strat_${i % 3}`,
      timestamp: 1_000_000 + i * 100,
      market_id: `market_${i % 5}`,
      token_id: `token_yes_${i % 5}`,
      direction: i % 2 === 0 ? 'BUY' : 'SELL',
      target_price: 0.50 + (i % 10) * 0.01,
      max_price: 0.60 + (i % 10) * 0.01,
      size_requested: 100 + i,
      urgency: 'immediate',
      ev_estimate: 0.03 + (i % 5) * 0.005,
      ev_confidence_interval: [0.01, 0.05] as [number, number],
      ev_after_costs: 0.02 + (i % 5) * 0.004,
      signal_strength: 0.7 + (i % 3) * 0.1,
      expected_holding_period_ms: 60_000,
      expected_sharpe_contribution: 0.15,
      correlation_with_existing: 0.1,
      reasoning: `Signal reason ${i}`,
      kill_conditions: [{ type: 'time_elapsed', threshold: 30_000 }],
      regime_assumption: 'normal',
      decay_model: { half_life_ms: 15_000, initial_ev: 0.03 + (i % 5) * 0.005 },
    },
  };
}

function makeSystemEntry(i: number): LedgerEntry {
  return {
    type: 'system_event',
    data: {
      event: `event_type_${i % 4}`,
      details: {
        index: i,
        value: Math.PI * i,
        flag: i % 2 === 0,
        nested: { deep: `v${i}` },
      },
    },
  };
}

function makeRegimeEntry(i: number): LedgerEntry {
  const regimes = ['normal', 'high_volatility', 'low_liquidity', 'event_driven'] as const;
  return {
    type: 'regime_change',
    data: {
      from: regimes[i % 4]!,
      to: regimes[(i + 1) % 4]!,
      confidence: 0.80 + (i % 5) * 0.04,
    },
  };
}

function makePositionOpenedEntry(i: number): LedgerEntry {
  return {
    type: 'position_opened',
    data: {
      market_id: `market_${i % 5}`,
      token_id: `token_yes_${i % 5}`,
      side: 'YES' as const,
      size: 100 + i * 10,
      avg_entry_price: 0.50 + (i % 10) * 0.01,
      current_mark: 0.52 + (i % 10) * 0.01,
      unrealized_pnl: 2 + i * 0.1,
      opened_at: 1_000_000 + i * 1000,
      strategy_id: `strat_${i % 3}`,
      signal_ev_at_entry: 0.03,
      current_ev_estimate: 0.025,
      time_in_position_ms: i * 1000,
      max_favorable_excursion: 5 + i,
      max_adverse_excursion: -(2 + i * 0.5),
    },
  };
}

// Build a deterministic mix of 100 entry types
function buildEntries(n: number): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (let i = 0; i < n; i++) {
    const bucket = i % 4;
    if (bucket === 0) entries.push(makeSignalEntry(i));
    else if (bucket === 1) entries.push(makeSystemEntry(i));
    else if (bucket === 2) entries.push(makeRegimeEntry(i));
    else entries.push(makePositionOpenedEntry(i));
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Ledger round-trip: 100 entries
// ---------------------------------------------------------------------------

describe('Ledger round-trip (100 entries)', () => {
  it('replays all 100 entries in order with exact data match', async () => {
    const ledger = new Ledger(LEDGER_DIR);
    const input = buildEntries(100);
    const written: LedgerRecord[] = [];

    for (const entry of input) {
      written.push(ledger.append(entry));
    }

    expect(written).toHaveLength(100);

    // Collect all replayed records
    const replayed: LedgerRecord[] = [];
    for await (const r of replay(ledger.currentFile())) {
      replayed.push(r);
    }

    expect(replayed).toHaveLength(100);

    for (let i = 0; i < 100; i++) {
      const w = written[i]!;
      const r = replayed[i]!;

      // Sequence number must match
      expect(r.seq_num).toBe(w.seq_num);
      expect(r.seq_num).toBe(i);

      // Wall clock must match
      expect(r.wall_clock).toBe(w.wall_clock);

      // Entry type must match
      expect(r.entry.type).toBe(w.entry.type);

      // Deep equality of the serialized entry
      // (JSON round-trip preserves all primitives)
      expect(JSON.stringify(r.entry)).toBe(JSON.stringify(w.entry));
    }
  });

  it('seq_num is strictly monotonically increasing across all 100 records', async () => {
    const ledger = new Ledger(LEDGER_DIR);
    const input = buildEntries(100);
    for (const entry of input) ledger.append(entry);

    const replayed: LedgerRecord[] = [];
    for await (const r of replay(ledger.currentFile())) {
      replayed.push(r);
    }

    for (let i = 1; i < replayed.length; i++) {
      expect(replayed[i]!.seq_num).toBe(replayed[i - 1]!.seq_num + 1);
    }
  });

  it('wall_clock is non-decreasing across all 100 records', async () => {
    const ledger = new Ledger(LEDGER_DIR);
    for (const entry of buildEntries(100)) ledger.append(entry);

    const replayed: LedgerRecord[] = [];
    for await (const r of replay(ledger.currentFile())) {
      replayed.push(r);
    }

    for (let i = 1; i < replayed.length; i++) {
      expect(replayed[i]!.wall_clock).toBeGreaterThanOrEqual(replayed[i - 1]!.wall_clock);
    }
  });

  it('all entry types survive the JSON round-trip without data loss', async () => {
    const ledger = new Ledger(LEDGER_DIR);
    const entries = buildEntries(100);
    for (const e of entries) ledger.append(e);

    const replayed: LedgerRecord[] = [];
    for await (const r of replay(ledger.currentFile())) {
      replayed.push(r);
    }

    // Verify each type appears the expected number of times
    const byType = new Map<string, number>();
    for (const r of replayed) {
      byType.set(r.entry.type, (byType.get(r.entry.type) ?? 0) + 1);
    }
    expect(byType.get('signal_generated')).toBe(25);
    expect(byType.get('system_event')).toBe(25);
    expect(byType.get('regime_change')).toBe(25);
    expect(byType.get('position_opened')).toBe(25);
  });

  it('signal entries preserve all numeric fields after round-trip', async () => {
    const ledger = new Ledger(LEDGER_DIR);
    const entries = buildEntries(100);
    for (const e of entries) ledger.append(e);

    const replayed: LedgerRecord[] = [];
    for await (const r of replay(ledger.currentFile())) {
      replayed.push(r);
    }

    const signals = replayed.filter((r) => r.entry.type === 'signal_generated');
    expect(signals).toHaveLength(25);

    for (const record of signals) {
      if (record.entry.type !== 'signal_generated') continue;
      const d = record.entry.data;
      expect(typeof d.ev_estimate).toBe('number');
      expect(typeof d.ev_after_costs).toBe('number');
      expect(typeof d.signal_strength).toBe('number');
      expect(Array.isArray(d.ev_confidence_interval)).toBe(true);
      expect(d.ev_confidence_interval).toHaveLength(2);
      expect(Array.isArray(d.kill_conditions)).toBe(true);
      expect(d.decay_model.half_life_ms).toBe(15_000);
      expect(typeof d.decay_model.initial_ev).toBe('number');
    }
  });

  it('replayAll yields same 100 entries as replay on a single-file ledger', async () => {
    const ledger = new Ledger(LEDGER_DIR);
    for (const e of buildEntries(100)) ledger.append(e);

    const viaReplay: LedgerRecord[] = [];
    for await (const r of replay(ledger.currentFile())) viaReplay.push(r);

    const viaReplayAll: LedgerRecord[] = [];
    for await (const r of replayAll(LEDGER_DIR)) viaReplayAll.push(r);

    expect(viaReplayAll).toHaveLength(100);

    for (let i = 0; i < 100; i++) {
      expect(viaReplayAll[i]!.seq_num).toBe(viaReplay[i]!.seq_num);
      expect(JSON.stringify(viaReplayAll[i]!.entry)).toBe(JSON.stringify(viaReplay[i]!.entry));
    }
  });

  it('verifyChecksum passes after rotate', async () => {
    const ledger = new Ledger(LEDGER_DIR);
    for (const e of buildEntries(100)) ledger.append(e);

    const checksumPath = ledger.rotate();
    expect(checksumPath).not.toBeNull();
    expect(verifyChecksum(ledger.currentFile())).toBe(true);
  });

  it('new Ledger instance resumes seq_num from 100', () => {
    const ledger1 = new Ledger(LEDGER_DIR);
    for (const e of buildEntries(100)) ledger1.append(e);
    expect(ledger1.currentSeqNum()).toBe(100);

    // Fresh instance pointing at same dir
    const ledger2 = new Ledger(LEDGER_DIR);
    expect(ledger2.currentSeqNum()).toBe(100);

    const next = ledger2.append(makeSystemEntry(999));
    expect(next.seq_num).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// WorldState round-trip: fully populated state
// ---------------------------------------------------------------------------

function makeMetadata(id: string, overrides: Partial<MarketMetadata> = {}): MarketMetadata {
  return {
    market_id: id,
    question: `Will ${id} resolve YES?`,
    condition_id: `cond_${id}`,
    tokens: { yes_id: `${id}_yes`, no_id: `${id}_no` },
    status: 'active',
    resolution: null,
    end_date: '2026-12-31',
    category: 'crypto',
    tags: ['defi', id],
    ...overrides,
  };
}

function makeSnapshot(
  marketId: string,
  tokenId: string,
  bid: number,
  ask: number,
): ParsedBookSnapshot {
  return {
    market_id: marketId,
    token_id: tokenId,
    bids: [[bid, 500], [bid - 0.01, 300]],
    asks: [[ask, 400], [ask + 0.01, 200]],
    timestamp: Date.now(),
    mid_price: (bid + ask) / 2,
    spread: ask - bid,
    spread_bps: ((ask - bid) / ((bid + ask) / 2)) * 10_000,
    bid_depth_1pct: 500,
    ask_depth_1pct: 400,
    bid_depth_5pct: 800,
    ask_depth_5pct: 600,
    vwap_bid_1000: bid - 0.002,
    vwap_ask_1000: ask + 0.002,
    queue_position_estimate: 5,
  };
}

function makeTrade(marketId: string, tokenId: string, price: number, size: number): ParsedTrade {
  return {
    market_id: marketId,
    condition_id: `cond_${marketId}`,
    token_id: tokenId,
    side: 'BUY',
    price,
    size,
    notional: price * size,
    maker: '0xmaker',
    taker: '0xtaker',
    tx_hash: `0x${marketId}${tokenId}`,
    timestamp: Date.now(),
    book_state_before: null,
  };
}

describe('WorldState round-trip (populated state)', () => {
  const SNAPSHOT_FILE = join(STATE_DIR, 'populated.json');

  function buildPopulatedState(): WorldState {
    const ws = new WorldState();

    // Register 5 markets
    const markets = ['btc', 'eth', 'sol', 'matic', 'link'];
    for (const id of markets) {
      ws.registerMarket(makeMetadata(id));
    }

    // Apply book snapshots to all markets (YES side)
    const priceMap: Record<string, [number, number]> = {
      btc: [0.62, 0.64],
      eth: [0.48, 0.52],
      sol: [0.71, 0.73],
      matic: [0.30, 0.34],
      link: [0.85, 0.87],
    };

    for (const [id, [bid, ask]] of Object.entries(priceMap)) {
      ws.updateMarket(makeSnapshot(id, `${id}_yes`, bid!, ask!));
      // NO side
      ws.updateMarket(makeSnapshot(id, `${id}_no`, 1 - ask!, 1 - bid!));
    }

    // Apply several trades per market
    for (const id of markets) {
      for (let i = 0; i < 5; i++) {
        ws.updateMarketFromTrade(makeTrade(id, `${id}_yes`, 0.60 + i * 0.01, 100 + i * 10));
      }
    }

    // Add open positions
    ws.own_positions.set('pos_btc', {
      market_id: 'btc',
      token_id: 'btc_yes',
      side: 'YES',
      size: 500,
      avg_entry_price: 0.62,
      current_mark: 0.65,
      unrealized_pnl: 15,
      opened_at: Date.now() - 60_000,
      strategy_id: 'complement_arb',
      signal_ev_at_entry: 0.04,
      current_ev_estimate: 0.035,
      time_in_position_ms: 60_000,
      max_favorable_excursion: 20,
      max_adverse_excursion: -5,
    });

    ws.own_positions.set('pos_eth', {
      market_id: 'eth',
      token_id: 'eth_yes',
      side: 'YES',
      size: 250,
      avg_entry_price: 0.49,
      current_mark: 0.51,
      unrealized_pnl: 5,
      opened_at: Date.now() - 120_000,
      strategy_id: 'book_imbalance',
      signal_ev_at_entry: 0.02,
      current_ev_estimate: 0.015,
      time_in_position_ms: 120_000,
      max_favorable_excursion: 8,
      max_adverse_excursion: -3,
    });

    return ws;
  }

  it('preserves all 5 markets after save/load', () => {
    const ws = buildPopulatedState();
    ws.saveToDisk(SNAPSHOT_FILE);

    const ws2 = new WorldState();
    ws2.loadFromDisk(SNAPSHOT_FILE);

    expect(ws2.markets.size).toBe(5);
    for (const id of ['btc', 'eth', 'sol', 'matic', 'link']) {
      expect(ws2.markets.has(id)).toBe(true);
    }
  });

  it('preserves book data for all markets', () => {
    const ws = buildPopulatedState();
    ws.saveToDisk(SNAPSHOT_FILE);

    const ws2 = new WorldState();
    ws2.loadFromDisk(SNAPSHOT_FILE);

    const btc = ws2.getMarket('btc')!;
    expect(btc).not.toBeUndefined();
    expect(btc.book.yes.bids.length).toBeGreaterThan(0);
    expect(btc.book.yes.asks.length).toBeGreaterThan(0);
    expect(btc.book.yes.mid).toBeCloseTo(0.63, 2);
    expect(btc.book.no.bids.length).toBeGreaterThan(0);

    const sol = ws2.getMarket('sol')!;
    expect(sol.book.yes.mid).toBeCloseTo(0.72, 2);
  });

  it('preserves derived book metrics (microprice, imbalance, spread_bps)', () => {
    const ws = buildPopulatedState();
    ws.saveToDisk(SNAPSHOT_FILE);

    const ws2 = new WorldState();
    ws2.loadFromDisk(SNAPSHOT_FILE);

    const eth = ws2.getMarket('eth')!;
    expect(eth.book.yes.microprice).toBeGreaterThan(0);
    expect(eth.book.yes.spread_bps).toBeGreaterThan(0);
    expect(typeof eth.book.yes.imbalance).toBe('number');
    expect(typeof eth.book.yes.imbalance_weighted).toBe('number');
  });

  it('preserves trade counters and volume', () => {
    const ws = buildPopulatedState();
    ws.saveToDisk(SNAPSHOT_FILE);

    const ws2 = new WorldState();
    ws2.loadFromDisk(SNAPSHOT_FILE);

    for (const id of ['btc', 'eth', 'sol', 'matic', 'link']) {
      const mkt = ws2.getMarket(id)!;
      expect(mkt.trade_count_1h).toBe(5);
      expect(mkt.volume_1h).toBeGreaterThan(0);
      expect(mkt.last_trade_price.yes).toBeGreaterThan(0);
    }
  });

  it('preserves complement_gap and liquidity_score', () => {
    const ws = buildPopulatedState();
    ws.saveToDisk(SNAPSHOT_FILE);

    const ws2 = new WorldState();
    ws2.loadFromDisk(SNAPSHOT_FILE);

    for (const id of ['btc', 'eth', 'sol', 'matic', 'link']) {
      const mkt = ws2.getMarket(id)!;
      expect(typeof mkt.complement_gap).toBe('number');
      expect(typeof mkt.complement_gap_executable).toBe('number');
      expect(typeof mkt.liquidity_score).toBe('number');
    }
  });

  it('preserves open positions with all fields', () => {
    const ws = buildPopulatedState();
    ws.saveToDisk(SNAPSHOT_FILE);

    const ws2 = new WorldState();
    ws2.loadFromDisk(SNAPSHOT_FILE);

    expect(ws2.own_positions.size).toBe(2);

    const posB = ws2.own_positions.get('pos_btc')!;
    expect(posB).not.toBeUndefined();
    expect(posB.market_id).toBe('btc');
    expect(posB.size).toBe(500);
    expect(posB.avg_entry_price).toBe(0.62);
    expect(posB.unrealized_pnl).toBe(15);
    expect(posB.strategy_id).toBe('complement_arb');

    const posE = ws2.own_positions.get('pos_eth')!;
    expect(posE).not.toBeUndefined();
    expect(posE.size).toBe(250);
    expect(posE.strategy_id).toBe('book_imbalance');
    expect(posE.max_favorable_excursion).toBe(8);
    expect(posE.max_adverse_excursion).toBe(-3);
  });

  it('preserves market metadata (question, tokens, category, tags)', () => {
    const ws = buildPopulatedState();
    ws.saveToDisk(SNAPSHOT_FILE);

    const ws2 = new WorldState();
    ws2.loadFromDisk(SNAPSHOT_FILE);

    const link = ws2.getMarket('link')!;
    expect(link.question).toBe('Will link resolve YES?');
    expect(link.tokens.yes_id).toBe('link_yes');
    expect(link.tokens.no_id).toBe('link_no');
    expect(link.category).toBe('crypto');
    expect(link.tags).toContain('defi');
    expect(link.tags).toContain('link');
    expect(link.status).toBe('active');
    expect(link.resolution).toBeNull();
    expect(link.end_date).toBe('2026-12-31');
  });

  it('snapshot JSON is valid and loadable from disk file', () => {
    const ws = buildPopulatedState();
    ws.saveToDisk(SNAPSHOT_FILE);

    // File must exist and be valid JSON
    expect(existsSync(SNAPSHOT_FILE)).toBe(true);

    const ws2 = new WorldState();
    // Should not throw
    expect(() => ws2.loadFromDisk(SNAPSHOT_FILE)).not.toThrow();
    expect(ws2.markets.size).toBe(5);
  });

  it('loaded state is independent from original (no shared references)', () => {
    const ws = buildPopulatedState();
    ws.saveToDisk(SNAPSHOT_FILE);

    const ws2 = new WorldState();
    ws2.loadFromDisk(SNAPSHOT_FILE);

    // Mutate original — should not affect loaded copy
    const btcOrig = ws.getMarket('btc')!;
    // Direct mutation on original's mutable array
    (btcOrig.book.yes.bids as [number, number][]).push([0.01, 9999]);

    const btcLoaded = ws2.getMarket('btc')!;
    const origLen = btcOrig.book.yes.bids.length;
    const loadedLen = btcLoaded.book.yes.bids.length;
    expect(loadedLen).toBe(origLen - 1); // loaded didn't get the extra entry
  });

  it('full field-by-field comparison of a single market across round-trip', () => {
    const ws = buildPopulatedState();
    const ethBefore = ws.getMarket('eth')!;
    ws.saveToDisk(SNAPSHOT_FILE);

    const ws2 = new WorldState();
    ws2.loadFromDisk(SNAPSHOT_FILE);
    const ethAfter = ws2.getMarket('eth')!;

    // Core identifiers
    expect(ethAfter.market_id).toBe(ethBefore.market_id);
    expect(ethAfter.question).toBe(ethBefore.question);
    expect(ethAfter.condition_id).toBe(ethBefore.condition_id);
    expect(ethAfter.tokens.yes_id).toBe(ethBefore.tokens.yes_id);
    expect(ethAfter.tokens.no_id).toBe(ethBefore.tokens.no_id);

    // Book
    expect(ethAfter.book.yes.mid).toBeCloseTo(ethBefore.book.yes.mid, 8);
    expect(ethAfter.book.yes.spread).toBeCloseTo(ethBefore.book.yes.spread, 8);
    expect(ethAfter.book.yes.microprice).toBeCloseTo(ethBefore.book.yes.microprice, 8);
    expect(ethAfter.book.yes.imbalance).toBeCloseTo(ethBefore.book.yes.imbalance, 8);
    expect(ethAfter.book.yes.bids).toEqual(ethBefore.book.yes.bids);
    expect(ethAfter.book.yes.asks).toEqual(ethBefore.book.yes.asks);

    // Trade stats
    expect(ethAfter.volume_1h).toBeCloseTo(ethBefore.volume_1h, 6);
    expect(ethAfter.volume_24h).toBeCloseTo(ethBefore.volume_24h, 6);
    expect(ethAfter.trade_count_1h).toBe(ethBefore.trade_count_1h);
    expect(ethAfter.last_trade_price.yes).toBeCloseTo(ethBefore.last_trade_price.yes, 8);

    // Derived
    expect(ethAfter.complement_gap).toBeCloseTo(ethBefore.complement_gap, 8);
    expect(ethAfter.liquidity_score).toBeCloseTo(ethBefore.liquidity_score, 8);
    expect(ethAfter.staleness_ms).toBeGreaterThanOrEqual(0);
  });
});
