#!/usr/bin/env tsx
/**
 * Post-session wallet copy-trade analysis.
 *
 * Simulates what your PnL would have been if you copy-traded each tracked
 * wallet at various latencies.
 *
 * Ground truth approach:
 *   - Uses actual CLOB prices at (trade_time + latency) when available
 *   - Falls back to slippage model only when delayed price is unavailable
 *   - Resolution exits: deterministic price, no slippage, no exit fee
 *   - Tracks wallet's own PnL alongside simulated PnL for comparison
 *
 * Usage:
 *   npm run analyze:wallets
 *   npm run analyze:wallets -- --hours 24
 *   npm run analyze:wallets -- --wallet 0x63ce...
 *   npm run analyze:wallets -- --html          # generate HTML report
 */

import { readFileSync, readdirSync, createReadStream, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve, dirname } from 'node:path';
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
const generateHtml = args.includes('--html');

const sinceMs = Date.now() - lookbackHours * 3_600_000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const defaultConfig = JSON.parse(
  readFileSync(join(PROJECT_ROOT, 'config', 'default.json'), 'utf-8')
) as { wallet_intel?: { tracked_wallets?: string[] } };

const TRACKED_WALLETS = new Set(
  (defaultConfig.wallet_intel?.tracked_wallets ?? []).map((w) => w.toLowerCase())
);

// ---------------------------------------------------------------------------
// Market name + token mapping from state snapshots
// ---------------------------------------------------------------------------

interface MarketInfo {
  question: string;
  yes_id: string;
  no_id: string;
}

function loadMarketInfo(): { names: Map<string, MarketInfo>; tokenToMarket: Map<string, string> } {
  const names = new Map<string, MarketInfo>();
  const tokenToMarket = new Map<string, string>();
  const snapshotDir = join(PROJECT_ROOT, 'data', 'snapshots');
  try {
    const files = readdirSync(snapshotDir).filter(f => f.endsWith('.json')).sort().reverse();
    if (files.length === 0) return { names, tokenToMarket };
    const snapshot = JSON.parse(readFileSync(join(snapshotDir, files[0]), 'utf-8')) as Record<string, unknown>;
    const markets = (snapshot['markets'] as Record<string, unknown>)?.['entries'] as Record<string, unknown> | undefined;
    if (!markets) return { names, tokenToMarket };
    for (const [id, market] of Object.entries(markets)) {
      const m = market as Record<string, unknown>;
      const tokens = m['tokens'] as Record<string, string> | undefined;
      const yesId = tokens?.['yes_id'] ?? '';
      const noId = tokens?.['no_id'] ?? '';
      names.set(id, { question: String(m['question'] ?? ''), yes_id: yesId, no_id: noId });
      if (yesId) tokenToMarket.set(yesId, id);
      if (noId) tokenToMarket.set(noId, id);
    }
  } catch { /* ignore */ }
  return { names, tokenToMarket };
}

// ---------------------------------------------------------------------------
// CLOB price index
// ---------------------------------------------------------------------------

interface PricePoint { timestamp: number; price: number; }

async function streamJsonl(filePath: string, onLine: (line: string) => void): Promise<void> {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of rl) { if (line) onLine(line); }
}

async function buildPriceIndex(): Promise<Map<string, PricePoint[]>> {
  const index = new Map<string, PricePoint[]>();
  const rawDir = join(PROJECT_ROOT, 'data', 'raw_events');
  let files: string[];
  try {
    files = readdirSync(rawDir)
      .filter((f) => f.endsWith('.jsonl') && !f.startsWith('wallet_'))
      .map((f) => join(rawDir, f));
  } catch { return index; }

  for (const file of files) {
    await streamJsonl(file, (line) => {
      let e: Record<string, unknown>;
      try { e = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      const ts = Number(e['timestamp_ingested'] ?? 0);
      if (ts < sinceMs - 120_000) return; // extra 2min buffer for delayed lookups
      const parsed = e['parsed'] as Record<string, unknown> | undefined;
      if (!parsed) return;
      const eventType = String(e['type'] ?? '');
      const tokenId = String(parsed['token_id'] ?? '');
      if (!tokenId) return;

      // Index trade events (have explicit price)
      const price = Number(parsed['price'] ?? 0);
      if (price > 0) {
        const arr = index.get(tokenId) ?? [];
        arr.push({ timestamp: ts, price });
        index.set(tokenId, arr);
        return;
      }

      // Index book snapshot events (use mid_price as price reference)
      if (eventType === 'book_snapshot') {
        const midPrice = Number(parsed['mid_price'] ?? 0);
        if (midPrice > 0) {
          const arr = index.get(tokenId) ?? [];
          arr.push({ timestamp: ts, price: midPrice });
          index.set(tokenId, arr);
        }
      }
    });
  }
  for (const arr of index.values()) arr.sort((a, b) => a.timestamp - b.timestamp);
  return index;
}

function lookupPrice(index: Map<string, PricePoint[]>, tokenId: string, targetTs: number): number {
  const arr = index.get(tokenId);
  if (!arr || arr.length === 0) return 0;
  let lo = 0, hi = arr.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].timestamp <= targetTs) { best = mid; lo = mid + 1; }
    else { hi = mid - 1; }
  }
  if (best === -1) return arr[0].price;
  // Only use if within 30s of target (otherwise too stale)
  if (Math.abs(arr[best].timestamp - targetTs) > 30_000) return 0;
  return arr[best].price;
}

// ---------------------------------------------------------------------------
// Load wallet trades
// ---------------------------------------------------------------------------

interface RawWalletTrade {
  wallet: string;
  token_id: string;
  market_id: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  ingested_at: number;
  actual_timestamp: number;
  block_number: number;
  tx_hash: string;
  source: string;
}

async function loadRawWalletTrades(): Promise<RawWalletTrade[]> {
  const rawDir = join(PROJECT_ROOT, 'data', 'raw_events');
  let files: string[];
  try {
    files = readdirSync(rawDir)
      .filter((f) => f.startsWith('wallet_') && f.endsWith('.jsonl'))
      .map((f) => join(rawDir, f));
  } catch { return []; }

  const tradeMap = new Map<string, RawWalletTrade>();
  for (const file of files) {
    await streamJsonl(file, (line) => {
      let e: Record<string, unknown>;
      try { e = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      const ts = Number(e['timestamp_ingested'] ?? 0);
      if (ts < sinceMs) return;
      const parsed = e['parsed'] as Record<string, unknown> | undefined;
      if (!parsed) return;
      const wallet = String(parsed['wallet'] ?? '').toLowerCase();
      if (!TRACKED_WALLETS.has(wallet)) return;
      if (filterWallet && wallet !== filterWallet) return;

      const txHash = String(parsed['tx_hash'] ?? '');
      const source = String(e['source'] ?? 'chain_listener');
      const sourceTs = Number(e['timestamp_source'] ?? 0);

      const trade: RawWalletTrade = {
        wallet,
        token_id: String(parsed['token_id'] ?? ''),
        market_id: String(parsed['market_id'] ?? ''),
        side: (parsed['side'] as 'BUY' | 'SELL') ?? 'BUY',
        size: Number(parsed['size'] ?? 0),
        price: Number(parsed['price'] ?? 0),
        ingested_at: ts,
        actual_timestamp: sourceTs > 0 ? sourceTs : ts,
        block_number: Number(parsed['block_number'] ?? 0),
        tx_hash: txHash,
        source,
      };

      // Dedup key must include wallet for resolution events
      // (resolution tx_hash is "resolution:market_id:token_id" — same for all wallets)
      const dedupKey = txHash
        ? (txHash.startsWith('resolution:') ? `${wallet}:${txHash}` : txHash)
        : `${wallet}:${ts}`;
      const existing = tradeMap.get(dedupKey);
      if (!existing || source === 'clob_ws') {
        tradeMap.set(dedupKey, trade);
      }
    });
  }
  return [...tradeMap.values()].sort((a, b) => a.actual_timestamp - b.actual_timestamp);
}

// ---------------------------------------------------------------------------
// Ledger prices
// ---------------------------------------------------------------------------

function loadLedgerPrices(): Map<string, number> {
  const prices = new Map<string, number>();
  const ledgerDir = join(PROJECT_ROOT, 'data', 'ledger');
  let files: string[];
  try {
    files = readdirSync(ledgerDir).filter((f) => f.endsWith('.jsonl')).map((f) => join(ledgerDir, f));
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
      if (price > 0 && tokenId && block) prices.set(`${tokenId}:${block}`, price);
    }
  }
  return prices;
}

// ---------------------------------------------------------------------------
// Price enrichment
// ---------------------------------------------------------------------------

type PriceSource = 'direct' | 'resolution' | 'ledger' | 'price_index' | 'book_mid' | 'none';

interface EnrichedTrade extends RawWalletTrade {
  resolved_price: number;
  price_source: PriceSource;
}

function enrichTrades(
  rawTrades: RawWalletTrade[],
  priceIndex: Map<string, PricePoint[]>,
  ledgerPrices: Map<string, number>,
): EnrichedTrade[] {
  return rawTrades.map((t) => {
    if (t.tx_hash.startsWith('resolution:')) {
      return { ...t, resolved_price: t.price, price_source: 'resolution' as PriceSource };
    }
    if (t.price > 0) {
      return { ...t, resolved_price: t.price, price_source: 'direct' as PriceSource };
    }
    const ledgerPrice = ledgerPrices.get(`${t.token_id}:${t.block_number}`);
    if (ledgerPrice && ledgerPrice > 0) {
      return { ...t, resolved_price: ledgerPrice, price_source: 'ledger' as PriceSource };
    }
    const clobPrice = lookupPrice(priceIndex, t.token_id, t.actual_timestamp);
    if (clobPrice > 0) {
      return { ...t, resolved_price: clobPrice, price_source: 'price_index' as PriceSource };
    }
    return { ...t, resolved_price: 0, price_source: 'none' as PriceSource };
  });
}

// ---------------------------------------------------------------------------
// Ground truth simulation using actual delayed CLOB prices
// ---------------------------------------------------------------------------

const FEE_RATE = 0.02;

// Fallback slippage model when no delayed price available
const LATENCY_SLIPPAGE: Record<number, number> = {
  1: 0.002, 2: 0.003, 3: 0.005, 5: 0.009,
  7: 0.012, 10: 0.015, 15: 0.020, 20: 0.022,
  30: 0.025, 60: 0.035,
};

function applySlippage(price: number, side: 'BUY' | 'SELL', latencyS: number): number {
  const slip = LATENCY_SLIPPAGE[latencyS] ?? latencyS * 0.001;
  return side === 'BUY' ? Math.min(0.99, price + slip) : Math.max(0.01, price - slip);
}

interface DetailedClosedTrade {
  wallet: string;
  market_id: string;
  token_id: string;
  size: number;
  entry_time: number;
  exit_time: number;
  hold_ms: number;
  wallet_entry_price: number;
  wallet_exit_price: number;
  wallet_net_pnl: number;
  sim_entry_price: number;
  sim_exit_price: number;
  sim_net_pnl: number;
  is_resolution: boolean;
  used_delayed_price: boolean;  // true if we used actual delayed CLOB price
}

interface OpenPosition {
  wallet: string;
  market_id: string;
  token_id: string;
  wallet_entry_price: number;
  sim_entry_price: number;
  entry_size: number;
  entry_time: number;
  used_delayed_price: boolean;
}

interface SimResult {
  latency_s: number;
  closed: number;
  wins: number;
  net_pnl: number;
  wallet_net_pnl: number;
  avg_hold_ms: number;
  open_count: number;
  resolution_closes: number;
  delayed_price_hit_rate: number;
}

function simulate(
  trades: EnrichedTrade[],
  latencyS: number,
  priceIndex: Map<string, PricePoint[]>,
): { result: SimResult; open: OpenPosition[]; closed: DetailedClosedTrade[] } {
  const open = new Map<string, OpenPosition>();
  const closed: DetailedClosedTrade[] = [];
  let delayedHits = 0;
  let delayedAttempts = 0;

  for (const t of trades) {
    const isResolution = t.tx_hash.startsWith('resolution:');
    if (t.resolved_price <= 0 && !isResolution) continue;

    const key = `${t.wallet}:${t.token_id}`;

    if (t.side === 'BUY') {
      if (open.has(key)) continue;
      if (t.resolved_price <= 0) continue;

      // Ground truth: look up actual CLOB price at trade_time + latency
      const delayedTs = t.actual_timestamp + latencyS * 1000;
      const delayedPrice = lookupPrice(priceIndex, t.token_id, delayedTs);
      delayedAttempts++;

      let simEntryPrice: number;
      let usedDelayed = false;
      if (delayedPrice > 0) {
        simEntryPrice = delayedPrice;
        usedDelayed = true;
        delayedHits++;
      } else {
        simEntryPrice = applySlippage(t.resolved_price, 'BUY', latencyS);
      }

      open.set(key, {
        wallet: t.wallet,
        market_id: t.market_id,
        token_id: t.token_id,
        wallet_entry_price: t.resolved_price,
        sim_entry_price: simEntryPrice,
        entry_size: t.size,
        entry_time: t.actual_timestamp,
        used_delayed_price: usedDelayed,
      });
    } else {
      const pos = open.get(key);
      if (!pos) continue;

      let walletExitPrice: number;
      let simExitPrice: number;
      let usedDelayed = pos.used_delayed_price;

      if (isResolution) {
        walletExitPrice = t.resolved_price;
        simExitPrice = t.resolved_price; // resolution = same for everyone
      } else {
        walletExitPrice = t.resolved_price;
        const delayedTs = t.actual_timestamp + latencyS * 1000;
        const delayedPrice = lookupPrice(priceIndex, t.token_id, delayedTs);
        delayedAttempts++;
        if (delayedPrice > 0) {
          simExitPrice = delayedPrice;
          delayedHits++;
        } else {
          simExitPrice = applySlippage(t.resolved_price, 'SELL', latencyS);
          usedDelayed = false;
        }
      }

      const size = Math.min(pos.entry_size, t.size);
      const walletGross = (walletExitPrice - pos.wallet_entry_price) * size;
      const simGross = (simExitPrice - pos.sim_entry_price) * size;

      // Polymarket fees: charged on PROFIT only, not notional
      // fee = max(0, payout - cost) * fee_rate
      // For BUY positions: cost = entry_price * size, payout = exit_price * size
      const walletCost = pos.wallet_entry_price * size;
      const walletPayout = walletExitPrice * size;
      const walletFees = Math.max(0, walletPayout - walletCost) * FEE_RATE;
      const simCost = pos.sim_entry_price * size;
      const simPayout = simExitPrice * size;
      const simFees = Math.max(0, simPayout - simCost) * FEE_RATE;

      closed.push({
        wallet: pos.wallet,
        market_id: pos.market_id,
        token_id: pos.token_id,
        size,
        entry_time: pos.entry_time,
        exit_time: t.actual_timestamp,
        hold_ms: t.actual_timestamp - pos.entry_time,
        wallet_entry_price: pos.wallet_entry_price,
        wallet_exit_price: walletExitPrice,
        wallet_net_pnl: walletGross - walletFees,
        sim_entry_price: pos.sim_entry_price,
        sim_exit_price: simExitPrice,
        sim_net_pnl: simGross - simFees,
        is_resolution: isResolution,
        used_delayed_price: usedDelayed,
      });
      open.delete(key);
    }
  }

  const wins = closed.filter((c) => c.sim_net_pnl > 0).length;

  return {
    result: {
      latency_s: latencyS,
      closed: closed.length,
      wins,
      net_pnl: closed.reduce((s, c) => s + c.sim_net_pnl, 0),
      wallet_net_pnl: closed.reduce((s, c) => s + c.wallet_net_pnl, 0),
      avg_hold_ms: closed.length > 0 ? closed.reduce((s, c) => s + c.hold_ms, 0) / closed.length : 0,
      open_count: open.size,
      resolution_closes: closed.filter((c) => c.is_resolution).length,
      delayed_price_hit_rate: delayedAttempts > 0 ? delayedHits / delayedAttempts : 0,
    },
    open: [...open.values()],
    closed,
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
function rpad(s: string, n: number): string { return s.padStart(n); }
function shortAddr(addr: string): string { return addr.slice(0, 6) + '...' + addr.slice(-4); }
function shortQ(q: string, maxLen = 55): string { return q.length > maxLen ? q.slice(0, maxLen - 3) + '...' : q; }
function sep(c = '-', n = 80): string { return c.repeat(n); }
function heading(t: string): string { return `\n${sep('=', 80)}\n${t}\n${sep('=', 80)}`; }
function fmtTime(ms: number): string { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19); }

// ---------------------------------------------------------------------------
// HTML report generation
// ---------------------------------------------------------------------------

function generateHtmlReport(
  enriched: EnrichedTrade[],
  allClosed: DetailedClosedTrade[],
  allOpen: OpenPosition[],
  marketInfo: Map<string, MarketInfo>,
  tokenToMarket: Map<string, string>,
  sourceCounts: Record<PriceSource, number>,
  simResults: Map<number, SimResult>,
): string {
  const getMarketName = (marketId: string, tokenId: string): string => {
    const mId = marketId || tokenToMarket.get(tokenId) || '';
    return marketInfo.get(mId)?.question ?? (mId.slice(0, 40) || 'Unknown');
  };
  const getTokenSide = (marketId: string, tokenId: string): string => {
    const mId = marketId || tokenToMarket.get(tokenId) || '';
    const info = marketInfo.get(mId);
    if (!info) return '?';
    return info.yes_id === tokenId ? 'YES' : 'NO';
  };
  const pnlColor = (n: number): string => n > 0 ? '#22c55e' : n < 0 ? '#ef4444' : '#666';
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Sort closed by exit_time desc
  const sortedClosed = [...allClosed].sort((a, b) => b.exit_time - a.exit_time);

  // Per-wallet summary
  const walletSummaries = new Map<string, { trades: number; closed: number; walletPnl: number; simPnl: number }>();
  for (const c of allClosed) {
    const s = walletSummaries.get(c.wallet) ?? { trades: 0, closed: 0, walletPnl: 0, simPnl: 0 };
    s.closed++;
    s.walletPnl += c.wallet_net_pnl;
    s.simPnl += c.sim_net_pnl;
    walletSummaries.set(c.wallet, s);
  }
  for (const t of enriched) {
    const s = walletSummaries.get(t.wallet) ?? { trades: 0, closed: 0, walletPnl: 0, simPnl: 0 };
    s.trades++;
    walletSummaries.set(t.wallet, s);
  }

  // Sim results table rows
  const latencies = [...simResults.keys()].sort((a, b) => a - b);
  const simRows = latencies.map(lat => {
    const r = simResults.get(lat)!;
    return `<tr>
      <td>${lat}s</td><td>${r.closed}</td>
      <td>${r.closed > 0 ? pct(r.wins / r.closed) : '--'}</td>
      <td style="color:${pnlColor(r.wallet_net_pnl)}">${usd(r.wallet_net_pnl)}</td>
      <td style="color:${pnlColor(r.net_pnl)}">${usd(r.net_pnl)}</td>
      <td>${r.closed > 0 ? usd(r.net_pnl / r.closed) : '--'}</td>
      <td>${r.avg_hold_ms > 0 ? dur(r.avg_hold_ms) : '--'}</td>
      <td>${r.resolution_closes}</td><td>${r.open_count}</td>
      <td>${pct(r.delayed_price_hit_rate)}</td>
    </tr>`;
  }).join('\n');

  // Closed trades table rows (full detail)
  const closedRows = sortedClosed.map((c, i) => {
    const mktName = esc(getMarketName(c.market_id, c.token_id));
    const tSide = getTokenSide(c.market_id, c.token_id);
    return `<tr>
      <td>${i + 1}</td>
      <td>${fmtTime(c.entry_time)}</td><td>${fmtTime(c.exit_time)}</td>
      <td title="${c.wallet}">${shortAddr(c.wallet)}</td>
      <td title="${mktName}">${esc(shortQ(mktName, 40))}</td>
      <td>${tSide}</td><td>${c.size.toFixed(1)}</td>
      <td>$${c.wallet_entry_price.toFixed(3)}</td><td>$${c.wallet_exit_price.toFixed(3)}</td>
      <td style="color:${pnlColor(c.wallet_net_pnl)};font-weight:600">${usd(c.wallet_net_pnl)}</td>
      <td>$${c.sim_entry_price.toFixed(3)}</td><td>$${c.sim_exit_price.toFixed(3)}</td>
      <td style="color:${pnlColor(c.sim_net_pnl)};font-weight:600">${usd(c.sim_net_pnl)}</td>
      <td>${dur(c.hold_ms)}</td>
      <td>${c.is_resolution ? 'RESOLUTION' : 'SELL'}</td>
      <td>${c.used_delayed_price ? 'Actual' : 'Model'}</td>
    </tr>`;
  }).join('\n');

  // Open positions rows
  const openRows = [...allOpen]
    .sort((a, b) => b.entry_size * b.sim_entry_price - a.entry_size * a.sim_entry_price)
    .map((p, i) => {
      const mktName = esc(getMarketName(p.market_id, p.token_id));
      const tSide = getTokenSide(p.market_id, p.token_id);
      return `<tr>
        <td>${i + 1}</td>
        <td>${fmtTime(p.entry_time)}</td>
        <td title="${p.wallet}">${shortAddr(p.wallet)}</td>
        <td title="${mktName}">${esc(shortQ(mktName, 45))}</td>
        <td>${tSide}</td><td>${p.entry_size.toFixed(1)}</td>
        <td>$${p.wallet_entry_price.toFixed(3)}</td>
        <td>$${p.sim_entry_price.toFixed(3)}</td>
        <td>${dur(Date.now() - p.entry_time)}</td>
      </tr>`;
    }).join('\n');

  // All raw trades rows
  const allTradesRows = enriched.slice(0, 5000).map((t, i) => {
    const mktName = esc(getMarketName(t.market_id, t.token_id));
    const tSide = getTokenSide(t.market_id, t.token_id);
    const sideColor = t.side === 'BUY' ? '#22c55e' : '#ef4444';
    return `<tr>
      <td>${i + 1}</td><td>${fmtTime(t.actual_timestamp)}</td>
      <td title="${t.wallet}">${shortAddr(t.wallet)}</td>
      <td style="color:${sideColor};font-weight:600">${t.side}</td>
      <td title="${mktName}">${esc(shortQ(mktName, 40))}</td>
      <td>${tSide}</td><td>${t.size.toFixed(1)}</td>
      <td>${t.resolved_price > 0 ? '$' + t.resolved_price.toFixed(3) : '--'}</td>
      <td>${t.price_source}</td><td>${t.source}</td>
    </tr>`;
  }).join('\n');

  // Wallet summary cards
  const walletCards = [...walletSummaries.entries()]
    .sort((a, b) => Math.abs(b[1].simPnl) - Math.abs(a[1].simPnl))
    .map(([addr, s]) => `
      <div class="card">
        <h3 title="${addr}">${shortAddr(addr)}</h3>
        <div class="stat"><span>Trades</span><span>${s.trades.toLocaleString()}</span></div>
        <div class="stat"><span>Closed</span><span>${s.closed}</span></div>
        <div class="stat"><span>Wallet PnL</span><span style="color:${pnlColor(s.walletPnl)}">${usd(s.walletPnl)}</span></div>
        <div class="stat"><span>Our PnL (3s)</span><span style="color:${pnlColor(s.simPnl)}">${usd(s.simPnl)}</span></div>
      </div>
    `).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Wallet Copy-Trade Analysis</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0f172a; color: #e2e8f0; padding: 20px; }
  h1 { color: #f8fafc; margin-bottom: 8px; font-size: 1.5rem; }
  h2 { color: #94a3b8; margin: 24px 0 12px; font-size: 1.1rem; border-bottom: 1px solid #334155; padding-bottom: 6px; }
  .meta { color: #64748b; margin-bottom: 20px; font-size: 0.85rem; }
  .cards { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 14px; min-width: 200px; flex: 1; }
  .card h3 { color: #f1f5f9; font-size: 0.95rem; margin-bottom: 8px; font-family: monospace; }
  .stat { display: flex; justify-content: space-between; padding: 2px 0; font-size: 0.85rem; }
  .stat span:first-child { color: #94a3b8; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin-bottom: 30px; }
  th { background: #1e293b; color: #94a3b8; text-align: left; padding: 8px 6px; position: sticky; top: 0; cursor: pointer; border-bottom: 2px solid #334155; white-space: nowrap; }
  th:hover { color: #f1f5f9; }
  td { padding: 5px 6px; border-bottom: 1px solid #1e293b; white-space: nowrap; }
  tr:hover td { background: #1e293b; }
  .section { margin-bottom: 30px; }
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-bottom: 20px; }
  .summary-item { background: #1e293b; border-radius: 6px; padding: 10px; text-align: center; }
  .summary-item .label { color: #64748b; font-size: 0.75rem; }
  .summary-item .value { color: #f1f5f9; font-size: 1.1rem; font-weight: 600; margin-top: 2px; }
  .tab-buttons { display: flex; gap: 4px; margin-bottom: 12px; }
  .tab-btn { background: #1e293b; border: 1px solid #334155; color: #94a3b8; padding: 6px 16px; border-radius: 4px; cursor: pointer; font-size: 0.85rem; }
  .tab-btn.active { background: #334155; color: #f1f5f9; }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  .note { color: #64748b; font-size: 0.8rem; margin-top: 8px; }
  input[type="text"] { background: #1e293b; border: 1px solid #334155; color: #e2e8f0; padding: 6px 10px; border-radius: 4px; width: 300px; margin-bottom: 10px; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>Wallet Copy-Trade Analysis</h1>
<div class="meta">Period: ${fmtTime(sinceMs)} &mdash; ${fmtTime(Date.now())} (${lookbackHours}h) | Generated: ${fmtTime(Date.now())}</div>

<div class="summary-grid">
  <div class="summary-item"><div class="label">Total Trades</div><div class="value">${enriched.length.toLocaleString()}</div></div>
  <div class="summary-item"><div class="label">With Price</div><div class="value">${enriched.filter(t => t.resolved_price > 0 || t.tx_hash.startsWith('resolution:')).length.toLocaleString()}</div></div>
  <div class="summary-item"><div class="label">Closed (3s)</div><div class="value">${allClosed.length}</div></div>
  <div class="summary-item"><div class="label">Open</div><div class="value">${allOpen.length}</div></div>
  <div class="summary-item"><div class="label">Direct Price</div><div class="value">${sourceCounts.direct}</div></div>
  <div class="summary-item"><div class="label">Price Index</div><div class="value">${sourceCounts.price_index}</div></div>
  <div class="summary-item"><div class="label">Resolution</div><div class="value">${sourceCounts.resolution}</div></div>
  <div class="summary-item"><div class="label">No Price</div><div class="value">${sourceCounts.none}</div></div>
</div>

<h2>Per-Wallet Summary</h2>
<div class="cards">${walletCards}</div>

<h2>Delay Curve (Portfolio)</h2>
<table>
<thead><tr><th>Latency</th><th>Closed</th><th>Win%</th><th>Wallet PnL</th><th>Our PnL</th><th>$/trade</th><th>Avg Hold</th><th>Resol.</th><th>Open</th><th>Price Hit%</th></tr></thead>
<tbody>${simRows}</tbody>
</table>
<p class="note">Price Hit% = fraction of trades where actual CLOB price at delayed timestamp was available (vs fallback slippage model).</p>

<h2>Trade Detail</h2>
<div class="tab-buttons">
  <button class="tab-btn active" onclick="showTab('closed')">Closed Trades (${allClosed.length})</button>
  <button class="tab-btn" onclick="showTab('open')">Open Positions (${allOpen.length})</button>
  <button class="tab-btn" onclick="showTab('all')">All Trades (${Math.min(enriched.length, 5000)})</button>
</div>
<input type="text" id="search" placeholder="Filter by market name or wallet..." oninput="filterTable()">

<div id="tab-closed" class="tab-content active">
<table id="closed-table">
<thead><tr>
  <th>#</th><th>Entry Time</th><th>Exit Time</th><th>Wallet</th><th>Market</th><th>Side</th><th>Size</th>
  <th>W.Entry</th><th>W.Exit</th><th>Wallet PnL</th>
  <th>Our Entry</th><th>Our Exit</th><th>Our PnL</th>
  <th>Hold</th><th>Exit Type</th><th>Price Src</th>
</tr></thead>
<tbody>${closedRows}</tbody>
</table>
</div>

<div id="tab-open" class="tab-content">
<table id="open-table">
<thead><tr><th>#</th><th>Entry Time</th><th>Wallet</th><th>Market</th><th>Side</th><th>Size</th><th>W.Price</th><th>Our Price</th><th>Age</th></tr></thead>
<tbody>${openRows}</tbody>
</table>
</div>

<div id="tab-all" class="tab-content">
<table id="all-table">
<thead><tr><th>#</th><th>Time</th><th>Wallet</th><th>Side</th><th>Market</th><th>Token</th><th>Size</th><th>Price</th><th>Price Src</th><th>Source</th></tr></thead>
<tbody>${allTradesRows}</tbody>
</table>
${enriched.length > 5000 ? `<p class="note">Showing first 5,000 of ${enriched.length.toLocaleString()} trades.</p>` : ''}
</div>

<h2>Methodology</h2>
<ul style="color:#94a3b8;font-size:0.85rem;padding-left:20px;line-height:1.8">
  <li><b>Ground truth pricing:</b> Uses actual CLOB price at (trade_time + latency) when available. Falls back to slippage model when no delayed price exists.</li>
  <li><b>Fees:</b> 2% taker fee on entry + exit. Resolution exits: entry fee only (token redemption, not a trade).</li>
  <li><b>Resolution:</b> Market close auto-exits at $1.00 (winning token) or $0.00 (losing token).</li>
  <li><b>Dedup:</b> Cross-source dedup by tx_hash (CLOB source preferred over chain).</li>
  <li><b>Wallet PnL:</b> Computed at wallet's actual prices with same 2% fee assumption.</li>
  <li><b>Our PnL:</b> Entry/exit at actual market price at delayed timestamp, or slippage model if unavailable.</li>
</ul>

<script>
function showTab(name) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  event.target.classList.add('active');
}
function filterTable() {
  const q = document.getElementById('search').value.toLowerCase();
  document.querySelectorAll('.tab-content.active tbody tr').forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async () => {

console.log(heading(`WALLET COPY-TRADE ANALYSIS (last ${lookbackHours}h)`));
console.log(`  Period: ${new Date(sinceMs).toISOString()} -> ${new Date().toISOString()}`);

console.log('\nLoading data...');
const { names: marketInfo, tokenToMarket } = loadMarketInfo();
const priceIndex = await buildPriceIndex();
const ledgerPrices = loadLedgerPrices();
const rawTrades = await loadRawWalletTrades();

console.log(`  Markets loaded: ${marketInfo.size}`);
console.log(`  CLOB price index: ${priceIndex.size} tokens`);
console.log(`  Ledger prices: ${ledgerPrices.size}`);
console.log(`  Raw wallet trades: ${rawTrades.length.toLocaleString()}`);

if (rawTrades.length === 0) {
  console.log('\nNo wallet trades found.');
  process.exit(0);
}

const enriched = enrichTrades(rawTrades, priceIndex, ledgerPrices);

const sourceCounts: Record<PriceSource, number> = { direct: 0, resolution: 0, ledger: 0, price_index: 0, book_mid: 0, none: 0 };
for (const t of enriched) sourceCounts[t.price_source]++;

const withPrice = enriched.filter((t) => t.resolved_price > 0 || t.tx_hash.startsWith('resolution:'));
const noPrice = enriched.filter((t) => t.resolved_price <= 0 && !t.tx_hash.startsWith('resolution:'));

console.log(`\n  PRICE COVERAGE:`);
console.log(`    Total trades:          ${enriched.length.toLocaleString()}`);
console.log(`    With price (usable):   ${withPrice.length.toLocaleString()} (${pct(withPrice.length / enriched.length)})`);
console.log(`      Direct (CLOB):       ${sourceCounts.direct.toLocaleString()}`);
console.log(`      Price index match:   ${sourceCounts.price_index.toLocaleString()}`);
console.log(`      Ledger match:        ${sourceCounts.ledger.toLocaleString()}`);
console.log(`      Book mid:            ${sourceCounts.book_mid.toLocaleString()}`);
console.log(`      Resolution:          ${sourceCounts.resolution.toLocaleString()}`);
console.log(`    Without price:         ${noPrice.length.toLocaleString()} (${pct(noPrice.length / enriched.length)})`);

const sourceBreakdown: Record<string, number> = {};
for (const t of enriched) sourceBreakdown[t.source] = (sourceBreakdown[t.source] ?? 0) + 1;
console.log(`\n  DATA SOURCES:`);
for (const [src, count] of Object.entries(sourceBreakdown).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${pad(src, 18)} ${count.toLocaleString()} (${pct(count / enriched.length)})`);
}

const totalBuys = enriched.filter(t => t.side === 'BUY').length;
const totalSells = enriched.filter(t => t.side === 'SELL' && !t.tx_hash.startsWith('resolution:')).length;
const totalResolutions = enriched.filter(t => t.tx_hash.startsWith('resolution:')).length;
console.log(`\n  TRADE TYPES: ${totalBuys.toLocaleString()} BUY / ${totalSells.toLocaleString()} SELL / ${totalResolutions.toLocaleString()} RESOLUTION`);

if (withPrice.length === 0) {
  console.log('\nNo trades with price data. Rebuild and restart with CLOB-side wallet detection.');
  process.exit(0);
}

const LATENCIES = [1, 3, 5, 10, 30, 60];

// Group by wallet
const byWallet = new Map<string, EnrichedTrade[]>();
const allByWallet = new Map<string, EnrichedTrade[]>();
for (const t of enriched) {
  const all = allByWallet.get(t.wallet) ?? [];
  all.push(t);
  allByWallet.set(t.wallet, all);
  if (t.resolved_price > 0 || t.tx_hash.startsWith('resolution:')) {
    const arr = byWallet.get(t.wallet) ?? [];
    arr.push(t);
    byWallet.set(t.wallet, arr);
  }
}

// Collect all closed trades (at 3s) for HTML report
let allClosedAt3s: DetailedClosedTrade[] = [];
let allOpenAt3s: OpenPosition[] = [];
const allSimResults = new Map<number, SimResult>();

for (const [wallet, trades] of byWallet) {
  const allTrades = allByWallet.get(wallet) ?? trades;
  const buys = allTrades.filter(t => t.side === 'BUY').length;
  const sells = allTrades.filter(t => t.side === 'SELL' && !t.tx_hash.startsWith('resolution:')).length;
  const resolutions = allTrades.filter(t => t.tx_hash.startsWith('resolution:')).length;

  const walletSources: Record<string, number> = {};
  for (const t of allTrades) walletSources[t.source] = (walletSources[t.source] ?? 0) + 1;
  const sourceStr = Object.entries(walletSources).sort((a, b) => b[1] - a[1])
    .map(([s, c]) => `${pct(c / allTrades.length)} ${s}`).join(', ');

  const uniqueMarkets = new Set(allTrades.map(t => t.market_id).filter(Boolean));
  const volume = trades.filter(t => t.resolved_price > 0).reduce((s, t) => s + t.resolved_price * t.size, 0);

  console.log(heading(`WALLET: ${shortAddr(wallet)} (${wallet})`));
  console.log(`  Trades: ${allTrades.length.toLocaleString()} total (${buys} BUY / ${sells} SELL / ${resolutions} RESOLUTION)`);
  console.log(`  With price: ${trades.length.toLocaleString()} | Without: ${(allTrades.length - trades.length).toLocaleString()}`);
  console.log(`  Unique markets: ${uniqueMarkets.size} | Sources: ${sourceStr}`);
  console.log(`  Volume (priced): $${volume.toFixed(0)}`);

  console.log(`\n  COPY-TRADE SIMULATION (ground truth delayed prices + 2% fee):`);
  console.log(`  ${pad('Latency', 9)}${pad('Closed', 8)}${pad('Win%', 8)}${pad('Wallet$', 12)}${pad('Our PnL', 12)}${pad('$/trade', 10)}${pad('Hold', 8)}${pad('Resol', 7)}${pad('Open', 6)}Hit%`);
  console.log('  ' + sep('-', 90));

  for (const lat of LATENCIES) {
    const { result } = simulate(trades, lat, priceIndex);
    if (result.closed === 0 && result.open_count === 0) continue;
    const wr = result.closed > 0 ? pct(result.wins / result.closed) : '--';
    const avgPnl = result.closed > 0 ? usd(result.net_pnl / result.closed) : '--';
    const hold = result.avg_hold_ms > 0 ? dur(result.avg_hold_ms) : '--';
    console.log(
      `  ${pad(`${lat}s`, 9)}${pad(String(result.closed), 8)}${pad(wr, 8)}${pad(usd(result.wallet_net_pnl), 12)}${pad(usd(result.net_pnl), 12)}${pad(avgPnl, 10)}${pad(hold, 8)}${pad(String(result.resolution_closes), 7)}${pad(String(result.open_count), 6)}${pct(result.delayed_price_hit_rate)}`
    );
  }

  // Open positions
  const { open: openAt3s, closed: closedAt3s } = simulate(trades, 3, priceIndex);
  if (openAt3s.length > 0) {
    console.log(`\n  OPEN POSITIONS (${openAt3s.length} total, top 10):`);
    const sorted = openAt3s.sort((a, b) => b.entry_size * b.sim_entry_price - a.entry_size * a.sim_entry_price);
    for (const pos of sorted.slice(0, 10)) {
      const mktId = pos.market_id || tokenToMarket.get(pos.token_id) || '';
      const mktName = marketInfo.get(mktId)?.question ?? mktId.slice(0, 20);
      const age = dur(Date.now() - pos.entry_time);
      const isYes = marketInfo.get(mktId)?.yes_id === pos.token_id;
      console.log(`    $${pos.sim_entry_price.toFixed(3)} x ${pos.entry_size.toFixed(1)} (${isYes ? 'YES' : 'NO'}) | ${age} ago | ${shortQ(mktName)}`);
    }
    if (openAt3s.length > 10) console.log(`    ... and ${openAt3s.length - 10} more`);
  }

  // Top markets
  const marketPnl = new Map<string, { pnl: number; walletPnl: number; trades: number; question: string }>();
  for (const c of closedAt3s) {
    const mktId = c.market_id || tokenToMarket.get(c.token_id) || 'unknown';
    const existing = marketPnl.get(mktId) ?? { pnl: 0, walletPnl: 0, trades: 0, question: '' };
    existing.pnl += c.sim_net_pnl;
    existing.walletPnl += c.wallet_net_pnl;
    existing.trades++;
    if (!existing.question) existing.question = marketInfo.get(mktId)?.question ?? mktId.slice(0, 30);
    marketPnl.set(mktId, existing);
  }
  if (marketPnl.size > 0) {
    const sortedMarkets = [...marketPnl.entries()].sort((a, b) => Math.abs(b[1].pnl) - Math.abs(a[1].pnl));
    console.log(`\n  TOP MARKETS (by |PnL| at 3s):`);
    for (const [, info] of sortedMarkets.slice(0, 8)) {
      console.log(`    ${rpad(usd(info.pnl), 10)} (wallet: ${usd(info.walletPnl)}, ${info.trades} trades) | ${shortQ(info.question)}`);
    }
  }

  allClosedAt3s = allClosedAt3s.concat(closedAt3s);
  allOpenAt3s = allOpenAt3s.concat(openAt3s);
}

// Portfolio summary
console.log(heading('PORTFOLIO SUMMARY (all wallets combined)'));
console.log(`\n  ${pad('Latency', 9)}${pad('Closed', 8)}${pad('Win%', 8)}${pad('Wallet$', 12)}${pad('Our PnL', 12)}${pad('$/trade', 10)}${pad('Hold', 8)}${pad('Resol', 7)}${pad('Open', 6)}Hit%`);
console.log('  ' + sep('-', 90));

for (const lat of LATENCIES) {
  const { result } = simulate(withPrice, lat, priceIndex);
  allSimResults.set(lat, result);
  if (result.closed === 0) continue;
  const wr = pct(result.wins / result.closed);
  const avgPnl = usd(result.net_pnl / result.closed);
  const hold = dur(result.avg_hold_ms);
  console.log(
    `  ${pad(`${lat}s`, 9)}${pad(String(result.closed), 8)}${pad(wr, 8)}${pad(usd(result.wallet_net_pnl), 12)}${pad(usd(result.net_pnl), 12)}${pad(avgPnl, 10)}${pad(hold, 8)}${pad(String(result.resolution_closes), 7)}${pad(String(result.open_count), 6)}${pct(result.delayed_price_hit_rate)}`
  );
}

// Statistical note
const base = allSimResults.get(3);
if (base && base.closed > 0) {
  console.log(`\n  STATISTICAL NOTE (3s latency):`);
  console.log(`    Closed trades:   ${base.closed}`);
  console.log(`    Avg PnL/trade:   ${usd(base.net_pnl / base.closed)}`);
  console.log(`    Wallet PnL:      ${usd(base.wallet_net_pnl)} (what wallets actually made)`);
  console.log(`    Our PnL:         ${usd(base.net_pnl)} (what we'd make copying at 3s delay)`);
  console.log(`    Price accuracy:  ${pct(base.delayed_price_hit_rate)} of entries used actual CLOB price at delayed time`);
  console.log(`    Sample size:     ${base.closed >= 30 ? 'SUFFICIENT (n >= 30)' : `INSUFFICIENT (n=${base.closed}, need 30+)`}`);
}

console.log(`
METHODOLOGY:
  Ground truth: uses actual CLOB price at (trade_time + latency) when available
  Fallback: slippage model [1s:0.2%, 3s:0.5%, 5s:0.9%, 10s:1.5%, 30:2.5%, 60s:3.5%]
  Fees: 2% taker fee on entry + exit (resolution exits: entry fee only)
  Resolution: market close auto-exits at $1.00 (win) or $0.00 (loss)
  Wallet$ column: what the tracked wallet actually made (same fee model)
  Hit%: fraction of entries priced via actual delayed CLOB price vs slippage model
  ${noPrice.length.toLocaleString()} trades had no price data and were excluded
`);

// HTML report
if (generateHtml) {
  const reportDir = join(PROJECT_ROOT, 'data', 'analysis');
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const htmlPath = join(reportDir, `wallet_report_${ts}.html`);

  // Use 3s simulation for HTML
  const { closed: allClosed3s, open: allOpen3s } = simulate(withPrice, 3, priceIndex);

  const html = generateHtmlReport(enriched, allClosed3s, allOpen3s, marketInfo, tokenToMarket, sourceCounts, allSimResults);
  writeFileSync(htmlPath, html);
  console.log(`HTML report saved: ${htmlPath}`);
  console.log(`Open with: open "${htmlPath}"`);
}

})().catch((err) => { console.error(err); process.exit(1); });
