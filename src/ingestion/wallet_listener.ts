// ---------------------------------------------------------------------------
// Wallet Listener — On-Chain Event Subscription
//
// Subscribes to on-chain Transfer events for tracked wallet addresses using
// ethers.js v6 WebSocket provider. Normalizes to WalletTransaction, emits
// 'wallet_trade' events, writes raw events to data/raw_events/.
//
// Reconnection with exponential backoff. Runs continuously in the background.
// ---------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { now, dayKey } from '../utils/time.js';
import { getLogger } from '../utils/logger.js';
import type { WalletTransaction, RawEvent, IngestionSourceMetrics } from './types.js';

const log = getLogger('wallet_listener');

const SOURCE = 'chain_listener';
const HEARTBEAT_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Polymarket CTF Exchange — ERC-1155 Transfer events
// ---------------------------------------------------------------------------

// The Polymarket Conditional Token Framework (CTF) Exchange contract on Polygon.
// Trades settle as ERC-1155 TransferSingle events.
const CTF_EXCHANGE_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

// ERC-1155 TransferSingle event signature
const TRANSFER_SINGLE_TOPIC = ethers.id(
  'TransferSingle(address,address,address,uint256,uint256)',
);

// Polymarket NegRisk CTF Exchange
const NEG_RISK_CTF_ADDRESS = '0xC5d563A36AE78145C45a50134d48A1215220f80a';

// Polymarket NegRisk Adapter
const NEG_RISK_ADAPTER_ADDRESS = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

// All contracts we monitor for transfer events
const MONITORED_CONTRACTS = [
  CTF_EXCHANGE_ADDRESS,
  NEG_RISK_CTF_ADDRESS,
  NEG_RISK_ADAPTER_ADDRESS,
];

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface WalletListenerEvents {
  wallet_trade: [tx: WalletTransaction];
  connected: [];
  disconnected: [reason: string];
  error: [err: Error];
}

// ---------------------------------------------------------------------------
// WalletListener
// ---------------------------------------------------------------------------

export class WalletListener extends EventEmitter {
  private readonly rpcUrl: string;
  private readonly trackedWallets: Set<string>;
  private readonly rawEventsDir: string;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;

  private provider: ethers.WebSocketProvider | null = null;
  private running = false;
  private seqId = 0;

  // Reconnection state
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Heartbeat
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  // Dedup
  private readonly dedupCache = new Map<string, number>();
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly dedupTtlMs: number;

  // Metrics
  readonly metrics: IngestionSourceMetrics = {
    source: SOURCE,
    events_received: 0,
    events_per_second: 0,
    duplicates_removed: 0,
    parse_errors: 0,
    gaps_detected: 0,
    reconnect_count: 0,
    stale_data_flags: 0,
    last_event_at: null,
  };

  private epsWindowStart = now();
  private epsWindowCount = 0;

  constructor(opts: {
    rpcUrl: string;
    trackedWallets: string[];
    rawEventsDir?: string;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
    dedupTtlMs?: number;
  }) {
    super();
    this.rpcUrl = opts.rpcUrl;
    this.trackedWallets = new Set(opts.trackedWallets.map((w) => w.toLowerCase()));
    this.rawEventsDir = opts.rawEventsDir ?? 'data/raw_events';
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 2_000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 120_000;
    this.dedupTtlMs = opts.dedupTtlMs ?? 120_000;

    this.dedupCleanupTimer = setInterval(() => this.evictDedup(), 60_000);
    this.dedupCleanupTimer.unref();
  }

  // -----------------------------------------------------------------------
  // Tracked wallet management
  // -----------------------------------------------------------------------

  addWallet(address: string): void {
    this.trackedWallets.add(address.toLowerCase());
    log.info({ wallet: address }, 'Wallet added to tracking');
  }

  removeWallet(address: string): void {
    this.trackedWallets.delete(address.toLowerCase());
    log.info({ wallet: address }, 'Wallet removed from tracking');
  }

  getTrackedWallets(): string[] {
    return [...this.trackedWallets];
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;

    if (this.trackedWallets.size === 0) {
      log.warn('WalletListener started with no tracked wallets');
    }

    log.info(
      { wallets: this.trackedWallets.size, rpc: this.rpcUrl.slice(0, 30) + '...' },
      'WalletListener starting',
    );
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearHeartbeat();

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.dedupCleanupTimer !== null) {
      clearInterval(this.dedupCleanupTimer);
      this.dedupCleanupTimer = null;
    }
    if (this.provider !== null) {
      this.provider.destroy();
      this.provider = null;
    }
    log.info('WalletListener stopped');
  }

  // -----------------------------------------------------------------------
  // Connection
  // -----------------------------------------------------------------------

  private connect(): void {
    if (!this.running) return;

    log.info({ attempt: this.reconnectAttempt }, 'WalletListener connecting');

    try {
      const wsUrl = this.toWsUrl(this.rpcUrl);
      const provider = new ethers.WebSocketProvider(wsUrl);
      this.provider = provider;

      // Wait for the provider to be ready via _waitUntilReady (v6 pattern)
      provider.getBlockNumber()
        .then(() => {
          if (!this.running || this.provider !== provider) return;

          log.info('WalletListener connected to chain');
          this.reconnectAttempt = 0;
          this.resetHeartbeat();
          this.emit('connected');
          this.subscribeToEvents(provider);
        })
        .catch((err: unknown) => {
          log.warn({ err }, 'WalletListener provider connection failed');
          this.handleDisconnect('provider_ready_failed');
        });

      // Attach onerror to the underlying WebSocket (ethers v6 uses a public 'websocket'
      // getter with browser-style onerror interface but does NOT set onerror itself,
      // leaving 502/503 errors as unhandled EventEmitter 'error' events that crash Node)
      try {
        const ws = (provider as unknown as { websocket: { onerror?: unknown } }).websocket;
        if (ws && typeof ws === 'object') {
          ws.onerror = (evt: unknown) => {
            let err: Error;
            if (evt instanceof Error) {
              err = evt;
            } else if (evt !== null && typeof evt === 'object' && 'message' in evt) {
              err = new Error(String((evt as { message: unknown }).message));
            } else {
              err = new Error('WebSocket error');
            }
            log.warn({ err }, 'WalletListener WebSocket error');
            this.emit('error', err);
            if (this.provider === provider) {
              this.handleDisconnect('ws_error');
            }
          };
        }
      } catch {
        // websocket getter throws if connection already failed — safe to ignore
      }
    } catch (err) {
      log.warn({ err }, 'WalletListener connect failed');
      if (this.running) this.scheduleReconnect();
    }
  }

  private handleDisconnect(reason: string): void {
    log.warn({ reason }, 'WalletListener disconnected');
    this.clearHeartbeat();

    if (this.provider !== null) {
      try { this.provider.destroy(); } catch { /* ignore */ }
      this.provider = null;
    }

    this.emit('disconnected', reason);
    if (this.running) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer !== null) return;

    const base = Math.min(
      this.reconnectBaseMs * Math.pow(2, this.reconnectAttempt),
      this.reconnectMaxMs,
    );
    const jitter = base * 0.1 * Math.random();
    const delay = Math.round(base + jitter);

    this.reconnectAttempt++;
    this.metrics.reconnect_count++;

    log.info({ delay, attempt: this.reconnectAttempt }, 'WalletListener scheduling reconnect');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // -----------------------------------------------------------------------
  // Event subscription
  // -----------------------------------------------------------------------

  private subscribeToEvents(provider: ethers.WebSocketProvider): void {
    // Subscribe to TransferSingle events on all monitored contracts
    for (const contractAddr of MONITORED_CONTRACTS) {
      const filter: ethers.Filter = {
        address: contractAddr,
        topics: [TRANSFER_SINGLE_TOPIC],
      };

      provider.on(filter, (logEntry: ethers.Log) => {
        this.resetHeartbeat();
        this.handleTransferLog(logEntry, provider).catch((err) => {
          this.metrics.parse_errors++;
          log.warn({ err }, 'Failed to process transfer log');
        });
      });
    }

    log.info(
      { contracts: MONITORED_CONTRACTS.length },
      'Subscribed to TransferSingle events',
    );
  }

  private async handleTransferLog(
    logEntry: ethers.Log,
    provider: ethers.WebSocketProvider,
  ): Promise<void> {
    const t = now();
    this.metrics.events_received++;
    this.updateEps(t);
    this.metrics.last_event_at = t;

    // Decode TransferSingle(address operator, address from, address to, uint256 id, uint256 value)
    const iface = new ethers.Interface([
      'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
    ]);

    let parsed: ethers.LogDescription | null;
    try {
      parsed = iface.parseLog({ topics: logEntry.topics as string[], data: logEntry.data });
    } catch {
      this.metrics.parse_errors++;
      return;
    }
    if (!parsed) return;

    const from = (parsed.args[1] as string).toLowerCase();
    const to = (parsed.args[2] as string).toLowerCase();
    const tokenId = (parsed.args[3] as bigint).toString();
    const value = parsed.args[4] as bigint;

    // Check if either address is a tracked wallet
    const fromTracked = this.trackedWallets.has(from);
    const toTracked = this.trackedWallets.has(to);

    if (!fromTracked && !toTracked) return;

    // Dedup
    const dedupKey = `${logEntry.transactionHash}:${logEntry.index}`;
    if (this.isDuplicate(dedupKey)) {
      this.metrics.duplicates_removed++;
      return;
    }
    this.markSeen(dedupKey);

    // Get block for timestamp and gas info
    let blockTimestamp = t;
    let gasPrice = 0;
    let blockNumber = logEntry.blockNumber;

    try {
      const block = await provider.getBlock(logEntry.blockNumber);
      if (block) {
        blockTimestamp = block.timestamp * 1000; // seconds → ms
        // baseFeePerGas is available on Polygon post-EIP-1559
        gasPrice = block.baseFeePerGas ? Number(block.baseFeePerGas) : 0;
      }
    } catch {
      // Use ingestion timestamp as fallback
    }

    // Stale data check
    if (t - blockTimestamp > 30_000) {
      this.metrics.stale_data_flags++;
    }

    // Estimate price from position in the order (0–1 range for prediction markets)
    // The actual price comes from matching this with CLOB trade data
    // For now, we estimate based on the token value pattern
    const size = Number(ethers.formatUnits(value, 6)); // USDC has 6 decimals

    // Emit for each tracked wallet involved
    if (fromTracked) {
      const tx = this.buildWalletTransaction(
        from, tokenId, 'SELL', size, blockTimestamp,
        logEntry.transactionHash, blockNumber, gasPrice,
      );
      this.emitTransaction(tx, logEntry, t);
    }

    if (toTracked) {
      const tx = this.buildWalletTransaction(
        to, tokenId, 'BUY', size, blockTimestamp,
        logEntry.transactionHash, blockNumber, gasPrice,
      );
      this.emitTransaction(tx, logEntry, t);
    }
  }

  private buildWalletTransaction(
    wallet: string,
    tokenId: string,
    side: 'BUY' | 'SELL',
    size: number,
    timestamp: number,
    txHash: string,
    blockNumber: number,
    gasPrice: number,
  ): WalletTransaction {
    return {
      wallet,
      market_id: '', // Resolved by correlating token_id with market metadata
      token_id: tokenId,
      side,
      price: 0, // Resolved by matching with CLOB trade at same tx_hash
      size,
      timestamp,
      tx_hash: txHash,
      block_number: blockNumber,
      gas_price: gasPrice,
    };
  }

  private emitTransaction(tx: WalletTransaction, logEntry: ethers.Log, ingestedAt: number): void {
    const rawEvent: RawEvent = {
      source: 'chain_listener',
      type: 'wallet_tx',
      timestamp_ingested: ingestedAt,
      timestamp_source: tx.timestamp,
      raw_payload: {
        transactionHash: logEntry.transactionHash,
        blockNumber: logEntry.blockNumber,
        logIndex: logEntry.index,
        address: logEntry.address,
        topics: logEntry.topics,
        data: logEntry.data,
      },
      parsed: tx,
      sequence_id: ++this.seqId,
    };

    this.persistRawEvent(rawEvent);
    this.emit('wallet_trade', tx);

    log.debug(
      {
        wallet: tx.wallet.slice(0, 10),
        side: tx.side,
        size: tx.size,
        token: tx.token_id.slice(0, 10),
        block: tx.block_number,
      },
      'Wallet trade detected',
    );
  }

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------

  private resetHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setTimeout(() => {
      log.warn('WalletListener heartbeat timeout — forcing reconnect');
      this.handleDisconnect('heartbeat_timeout');
    }, HEARTBEAT_TIMEOUT_MS);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Dedup
  // -----------------------------------------------------------------------

  private isDuplicate(key: string): boolean {
    const expiry = this.dedupCache.get(key);
    return expiry !== undefined && expiry > now();
  }

  private markSeen(key: string): void {
    this.dedupCache.set(key, now() + this.dedupTtlMs);
  }

  private evictDedup(): void {
    const t = now();
    for (const [key, expiry] of this.dedupCache) {
      if (expiry <= t) this.dedupCache.delete(key);
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Converts an HTTP RPC URL to a WebSocket URL. */
  private toWsUrl(url: string): string {
    if (url.startsWith('ws://') || url.startsWith('wss://')) return url;
    return url.replace('https://', 'wss://').replace('http://', 'ws://');
  }

  private updateEps(t: number): void {
    this.epsWindowCount++;
    const elapsed = (t - this.epsWindowStart) / 1000;
    if (elapsed >= 5) {
      this.metrics.events_per_second = this.epsWindowCount / elapsed;
      this.epsWindowCount = 0;
      this.epsWindowStart = t;
    }
  }

  private persistRawEvent(rawEvent: RawEvent): void {
    try {
      const dir = this.rawEventsDir;
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const file = join(dir, `wallet_${dayKey(rawEvent.timestamp_ingested)}.jsonl`);
      appendFileSync(file, JSON.stringify(rawEvent) + '\n');
    } catch (err) {
      log.warn({ err }, 'WalletListener: failed to persist raw event');
    }
  }
}
