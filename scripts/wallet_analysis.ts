#!/usr/bin/env tsx
/**
 * Post-session wallet copy-trade analysis.
 *
 * Reads wallet_trade events from raw_events and simulates what your PnL
 * would have been if you copy-traded each tracked wallet at various latencies.
 *
 * Prices come from:
 *   1. Ledger wallet_trade entries (if CLOB matching succeeded)
 *   2. Raw CLOB price_change events matched by token_id + timestamp proximity
 *
 * Usage:
 *   npm run analyze:wallets
 *   npm run analyze:wallets -- --hours 24
 *   npm run analyze:wallets -- --wallet 0x63ce...
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}
const lookbackHours = Number(getArg('--hours') ?? '24');
const filterWallet = getArg('--wallet')?.toLowerCase();

const sinceMs = Date.now() - lookbackHours * 3_600_000;

// ---------------------------------------------------------------------------
// Config: tracked wallets (from config/default.json)
// ---------------------------------------------------------------------------

const defaultConfig = JSON.parse(
  readFileSync(join(PROJECT_ROOT, 'config', 'default.json'), 'utf-8')
) as { wallet_intel?: { tracked_wallets?: string[] } };

const TRACKED_WALLETS = new Set(
  (defaultConfig.wallet_intel?.tracked_wallets ?? []).map((w) => w.toLowerCase())
);

// ---------------------------------------------------------------------------
// Build CLOB price index from raw events
// token_id → [{timestamp, price}] sorted by timestamp
// ---------------------------------------------------------------------------

interface PricePoint { timestamp: number; price: number; }

function buildPriceIndex(): Map<string, PricePoint[]> {
  const index = new Map<string, PricePoint[]>();
  const rawDir = join(PROJECT_ROOT, 'data', 'raw_events');
  let files: string[];
  try {
    files = readdirSync(rawDir)
      .filter((f) => f.endsWith('.jsonl') && !f.startsWith('wallet_'))
      .map((f) => join(rawDir, f));
  } catch { return index; }

  for (const file of files) {
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      let e: Record<string, unknown>;
      try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

      const ts = Number(e['timestamp_ingested'] ?? 0);
      if (ts < sinceMs) continue;

      const parsed = e['parsed'] as Record<string, unknown> | undefined;
      if (!parsed) continue;

      const tokenId = String(parsed['token_id'] ?? '');
      const price = Number(parsed['price'] ?? 0);
      if (!tokenId || price <= 0) continue;

      const arr = index.get(tokenId) ?? [];
      arr.push({ timestamp: ts, price });
      index.set(tokenId, arr);
    }
  }

  // Sort each array by timestamp
  for (const arr of index.values()) arr.sort((a, b) => a.timestamp - b.timestamp);
  return index;
}

/** Find the closest price for a token_id at or just before `targetTs`. */
function lookupPrice(
  index: Map<string, PricePoint[]>,
  tokenId: string,
  targetTs: number,
): number {
  const arr = index.get(tokenId);
  if (!arr || arr.length === 0) return 0;

  // Binary search for closest timestamp <= targetTs
  let lo = 0, hi = arr.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].timestamp <= targetTs) { best = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }

  if (best === -1) {
    // All timestamps are after target — use earliest
    return arr[0].price;
  }
  return arr[best].price;
}

// ---------------------------------------------------------------------------
// Load wallet trades from raw_events/wallet_*.jsonl
// ---------------------------------------------------------------------------

interface RawWalletTrade {
  wallet: string;
  token_id: string;
  market_id: string;   // '' if not resolved at capture time
  side: 'BUY' | 'SELL';
  size: number;
  price: number;       // from raw event (usually 0)
  ingested_at: number;
  block_number: number;
}

function loadRawWalletTrades(): RawWalletTrade[] {
  const rawDir = join(PROJECT_ROOT, 'data', 'raw_events');
  let files: string[];
  try {
    files = readdirSync(rawDir)
      .filter((f) => f.startsWith('wallet_') && f.endsWith('.jsonl'))
      .map((f) => join(rawDir, f));
  } catch { return []; }

  const trades: RawWalletTrade[] = [];

  for (const file of files) {
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      let e: Record<string, unknown>;
      try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

      const ts = Number(e['timestamp_ingested'] ?? 0);
      if (ts < sinceMs) continue;

      const parsed = e['parsed'] as Record<string, unknown> | undefined;
      if (!parsed) continue;

      const wallet = String(parsed['wallet'] ?? '').toLowerCase();
      if (!TRACKED_WALLETS.has(wallet)) continue;
      if (filterWallet && wallet !== filterWallet) continue;

      trades.push({
        wallet,
        token_id: String(parsed['token_id'] ?? ''),
        market_id: String(parsed['market_id'] ?? ''),
        side: (parsed['side'] as 'BUY' | 'SELL') ?? 'BUY',
        size: Number(parsed['size'] ?? 0),
        price: Number(parsed['price'] ?? 0),
        ingested_at: ts,
        block_number: Number(parsed['block_number'] ?? 0),
      });
    }
  }

  return trades.sort((a, b) => a.ingested_at - b.ingested_at);
}

// ---------------------------------------------------------------------------
// Also load enriched prices from ledger (CLOB-matched)
// ledger sometimes has better price data than raw events
// ---------------------------------------------------------------------------

function loadLedgerPrices(): Map<string, number> {
  // key = `${token_id}:${block_number}` → price
  const prices = new Map<string, number>();
  const ledgerDir = join(PROJECT_ROOT, 'data', 'ledger');
  let files: string[];
  try {
    files = readdirSync(ledgerDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(ledgerDir, f));
  } catch { return prices; }

  for (const file of files) {
    const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }

      const ts = Number(entry['wall_clock'] ?? 0);
      if (ts < sinceMs) continue;

      const e = entry['entry'] as Record<string, unknown> | undefined;
      if (!e || e['type'] !== 'system_event') continue;
      const data = e['data'] as Record<string, unknown> | undefined;
      if (data?.['event'] !== 'wallet_trade') continue;

      const d = data['details'] as Record<string, unknown> | undefined;
      if (!d) continue;

      const price = Number(d['price'] ?? 0);
      const tokenId = String(d['token_id'] ?? '');
      const block = String(d['block'] ?? '');
      if (price > 0 && tokenId && block) {
        prices.set(`${tokenId}:${block}`, price);
      }
    }
  }

  return prices;
}

// ---------------------------------------------------------------------------
// Latency simulation
// ---------------------------------------------------------------------------

const LATENCY_SLIPPAGE: Record<number, number> = {
  1:  0.002,
  3:  0.005,
  5:  0.009,
  10: 0.015,
  30: 0.025,
};
const FEE_RATE = 0.02;

function applySlippage(price: number, side: 'BUY' | 'SELL', latencyS: number): number {
  const slip = LATENCY_SLIPPAGE[latencyS] ?? latencyS * 0.001;
  return side === 'BUY'
    ? Math.min(0.99, price + slip)
    : Math.max(0.01, price - slip);
}

interface ClosedTrade {
  market_id: string;
  token_id: string;
  entry_price: number;
  exit_price: number;
  size: number;
  hold_ms: number;
  net_pnl: number;
}

interface OpenPosition {
  market_id: string;
  token_id: string;
  entry_price: number;
  entry_size: number;
  entry_time: number;
  entry_block: number;
}

interface SimResult {
  latency_s: number;
  closed: number;
  wins: number;
  gross_pnl: number;
  net_pnl: number;
  avg_hold_ms: number;
  open_count: number;
}

function simulate(
  trades: (RawWalletTrade & { resolved_price: number })[],
  latencyS: number,
): { result: SimResult; open: OpenPosition[] } {
  const open = new Map<string, OpenPosition>(); // key = token_id
  const closed: ClosedTrade[] = [];

  for (const t of trades) {
    if (t.resolved_price <= 0) continue; // no price data, skip

    const key = t.token_id;

    if (t.side === 'BUY') {
      if (open.has(key)) continue; // already in position
      open.set(key, {
        market_id: t.market_id,
        token_id: t.token_id,
        entry_price: applySlippage(t.resolved_price, 'BUY', latencyS),
        entry_size: t.size,
        entry_time: t.ingested_at,
        entry_block: t.block_number,
      });
    } else {
      const pos = open.get(key);
      if (!pos) continue; // wallet sold something we never bought

      const exitPrice = applySlippage(t.resolved_price, 'SELL', latencyS);
      const size = Math.min(pos.entry_size, t.size);
      const grossPnl = (exitPrice - pos.entry_price) * size;
      const feeCost = (pos.entry_price + exitPrice) * size * FEE_RATE;
      closed.push({
        market_id: pos.market_id,
        token_id: pos.token_id,
        entry_price: pos.entry_price,
        exit_price: exitPrice,
        size,
        hold_ms: t.ingested_at - pos.entry_time,
        net_pnl: grossPnl - feeCost,
      });
      open.delete(key);
    }
  }

  const wins = closed.filter((c) => c.net_pnl > 0).length;
  const grossPnl = closed.reduce((s, c) => s + (c.net_pnl + (c.entry_price + c.exit_price) * c.size * FEE_RATE), 0);

  return {
    result: {
      latency_s: latencyS,
      closed: closed.length,
      wins,
      gross_pnl: grossPnl,
      net_pnl: closed.reduce((s, c) => s + c.net_pnl, 0),
      avg_hold_ms: closed.length > 0 ? closed.reduce((s, c) => s + c.hold_ms, 0) / closed.length : 0,
      open_count: open.size,
    },
    open: [...open.values()],
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function pct(n: number): string { return `${(n * 100).toFixed(1)}%`; }
function usd(n: number): string { return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`; }
function dur(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
function pad(s: string, n: number): string { return s.padEnd(n); }

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`\n=== Wallet Copy-Trade Analysis (last ${lookbackHours}h) ===`);
console.log(`Since: ${new Date(sinceMs).toISOString()}\n`);

console.log('Loading CLOB price index...');
const priceIndex = buildPriceIndex();
console.log(`  Indexed ${priceIndex.size} token_ids with price history`);

const ledgerPrices = loadLedgerPrices();
console.log(`  Ledger has ${ledgerPrices.size} CLOB-matched prices`);

const rawTrades = loadRawWalletTrades();
console.log(`  Found ${rawTrades.length} raw wallet trades from tracked wallets\n`);

if (rawTrades.length === 0) {
  console.log('No wallet trades found. Make sure the bot has been running and tracking wallets.');
  process.exit(0);
}

// Enrich each raw trade with a price
const enriched = rawTrades.map((t) => {
  // Priority 1: ledger CLOB-matched price
  const ledgerPrice = ledgerPrices.get(`${t.token_id}:${t.block_number}`);
  if (ledgerPrice && ledgerPrice > 0) {
    return { ...t, resolved_price: ledgerPrice, price_source: 'clob' };
  }

  // Priority 2: CLOB price_change at or just before ingestion time
  const clobPrice = lookupPrice(priceIndex, t.token_id, t.ingested_at);
  if (clobPrice > 0) {
    return { ...t, resolved_price: clobPrice, price_source: 'price_change' };
  }

  return { ...t, resolved_price: 0, price_source: 'none' };
});

const withPrice = enriched.filter((t) => t.resolved_price > 0);
const noPrice = enriched.filter((t) => t.resolved_price <= 0);

console.log(`Price coverage: ${withPrice.length}/${enriched.length} trades have prices (${noPrice.length} skipped)`);

if (withPrice.length === 0) {
  console.log('\nNo trades with price data. The CLOB raw events file may not have been populated yet.');
  console.log('Run the bot for a while with active wallet trades to build up price data.');
  process.exit(0);
}

const LATENCIES = [1, 3, 5, 10, 30];

// Group by wallet
const byWallet = new Map<string, typeof withPrice>();
for (const t of withPrice) {
  const arr = byWallet.get(t.wallet) ?? [];
  arr.push(t);
  byWallet.set(t.wallet, arr);
}

for (const [wallet, trades] of byWallet) {
  const buys = trades.filter((t) => t.side === 'BUY').length;
  const sells = trades.filter((t) => t.side === 'SELL').length;
  console.log(`\nWallet: ${wallet}`);
  console.log(`  Trades with price: ${trades.length} (${buys} buy / ${sells} sell)`);

  console.log();
  console.log(`  ${pad('Latency', 10)}${pad('Closed', 8)}${pad('Win%', 8)}${pad('Net PnL', 12)}${pad('$/trade', 10)}${pad('Avg hold', 10)}Open`);
  console.log('  ' + '-'.repeat(70));

  for (const lat of LATENCIES) {
    const { result, open } = simulate(trades, lat);
    if (result.closed === 0 && result.open_count === 0) continue;
    const wr = result.closed > 0 ? pct(result.wins / result.closed) : '—';
    const avgPnl = result.closed > 0 ? usd(result.net_pnl / result.closed) : '—';
    const hold = result.avg_hold_ms > 0 ? dur(result.avg_hold_ms) : '—';
    console.log(
      `  ${pad(`${lat}s`, 10)}${pad(String(result.closed), 8)}${pad(wr, 8)}${pad(usd(result.net_pnl), 12)}${pad(avgPnl, 10)}${pad(hold, 10)}${result.open_count}`
    );
    if (lat === 3 && open.length > 0) {
      for (const pos of open.slice(0, 5)) {
        console.log(`    ↳ open: market=${pos.market_id} entry=${pos.entry_price.toFixed(3)} size=${pos.entry_size.toFixed(1)} age=${dur(Date.now() - pos.entry_time)}`);
      }
      if (open.length > 5) console.log(`    ↳ ... and ${open.length - 5} more`);
    }
  }
}

// Portfolio summary
console.log('\n' + '='.repeat(72));
console.log('PORTFOLIO SUMMARY (all wallets combined)');
console.log('='.repeat(72));
console.log(`  ${pad('Latency', 10)}${pad('Closed', 8)}${pad('Win%', 8)}${pad('Net PnL', 12)}${pad('$/trade', 10)}Avg hold`);
console.log('  ' + '-'.repeat(65));

for (const lat of LATENCIES) {
  const { result } = simulate(withPrice, lat);
  if (result.closed === 0) continue;
  const wr = pct(result.wins / result.closed);
  const avgPnl = usd(result.net_pnl / result.closed);
  const hold = dur(result.avg_hold_ms);
  console.log(`  ${pad(`${lat}s`, 10)}${pad(String(result.closed), 8)}${pad(wr, 8)}${pad(usd(result.net_pnl), 12)}${pad(avgPnl, 10)}${hold}`);
}

console.log(`
Notes:
  • Slippage model: BUY price increased by [1s:0.2%, 3s:0.5%, 5s:0.9%, 10s:1.5%, 30s:2.5%]
  • Fees: 2% taker fee on each leg (entry + exit)
  • "Open" = wallet bought but hasn't sold yet (position still held)
  • Orphan sells (wallet sold before we started tracking) are excluded
  • ${noPrice.length} trades had no price data and were skipped
`);
