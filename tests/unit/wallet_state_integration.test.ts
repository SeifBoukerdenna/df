import { describe, it, expect } from 'vitest';
import { WorldState } from '../../src/state/world_state.js';
import type { WalletTransaction } from '../../src/ingestion/types.js';
import type { MarketMetadata, ParsedTrade } from '../../src/ingestion/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTx(overrides: Partial<WalletTransaction> = {}): WalletTransaction {
  return {
    wallet: '0xabc123',
    market_id: 'mkt_1',
    token_id: 'tok_yes_1',
    side: 'BUY',
    price: 0.50,
    size: 100,
    timestamp: Date.now(),
    tx_hash: '0xtx_' + Math.random().toString(36).slice(2),
    block_number: 1000,
    gas_price: 30_000_000_000,
    ...overrides,
  };
}

function makeMetadata(overrides: Partial<MarketMetadata> = {}): MarketMetadata {
  return {
    market_id: 'mkt_1',
    question: 'Will it rain?',
    condition_id: 'cond_1',
    tokens: { yes_id: 'tok_yes_1', no_id: 'tok_no_1' },
    status: 'active',
    resolution: null,
    end_date: '2025-12-31',
    category: 'weather',
    tags: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// WorldState wallet methods
// ---------------------------------------------------------------------------

describe('WorldState wallet integration', () => {
  it('registerWallet creates empty wallet state', () => {
    const state = new WorldState();
    state.registerWallet('0xABC123');

    const wallet = state.getWallet('0xabc123');
    expect(wallet).toBeDefined();
    expect(wallet!.address).toBe('0xabc123');
    expect(wallet!.classification).toBe('unclassified');
    expect(wallet!.trades).toHaveLength(0);
  });

  it('registerWallet is idempotent', () => {
    const state = new WorldState();
    state.registerWallet('0xABC123');
    state.registerWallet('0xABC123');

    expect(state.getAllWallets()).toHaveLength(1);
  });

  it('recordWalletTrade accumulates trades and recomputes stats', () => {
    const state = new WorldState();
    const t0 = Date.now();

    state.recordWalletTrade(makeTx({
      wallet: '0xabc',
      side: 'BUY',
      price: 0.40,
      size: 100,
      timestamp: t0,
    }));

    state.recordWalletTrade(makeTx({
      wallet: '0xabc',
      side: 'SELL',
      price: 0.60,
      size: 100,
      timestamp: t0 + 5000,
    }));

    const wallet = state.getWallet('0xabc');
    expect(wallet).toBeDefined();
    expect(wallet!.trades).toHaveLength(2);
    expect(wallet!.stats.total_trades).toBe(2);
    expect(wallet!.stats.pnl_realized).toBeCloseTo(20, 2);
    expect(wallet!.stats.win_rate).toBe(1.0);
  });

  it('recordWalletTrade auto-registers unknown wallets', () => {
    const state = new WorldState();
    state.recordWalletTrade(makeTx({ wallet: '0xnew_wallet' }));

    expect(state.getWallet('0xnew_wallet')).toBeDefined();
    expect(state.getWallet('0xnew_wallet')!.trades).toHaveLength(1);
  });

  it('recordWalletTradeWithRegime updates regime stats', () => {
    const state = new WorldState();
    state.recordWalletTradeWithRegime(makeTx({ wallet: '0xabc' }));

    const wallet = state.getWallet('0xabc');
    expect(wallet).toBeDefined();
    expect(wallet!.regime_performance.size).toBeGreaterThan(0);

    const regimeStats = wallet!.regime_performance.get('normal');
    expect(regimeStats).toBeDefined();
    expect(regimeStats!.total_trades).toBe(1);
  });

  it('getAllWallets returns all tracked wallets', () => {
    const state = new WorldState();
    state.registerWallet('0xabc');
    state.registerWallet('0xdef');
    state.registerWallet('0x123');

    expect(state.getAllWallets()).toHaveLength(3);
  });

  it('resolveWalletTradeMarket matches token_id to market', () => {
    const state = new WorldState();
    state.registerMarket(makeMetadata({
      market_id: 'mkt_1',
      tokens: { yes_id: 'tok_yes_1', no_id: 'tok_no_1' },
    }));

    const tx = makeTx({ market_id: '', token_id: 'tok_yes_1' });
    const resolved = state.resolveWalletTradeMarket(tx);

    expect(resolved).not.toBeNull();
    expect(resolved!.market_id).toBe('mkt_1');
  });

  it('resolveWalletTradeMarket returns null for unknown token', () => {
    const state = new WorldState();
    const tx = makeTx({ market_id: '', token_id: 'unknown_token' });

    expect(state.resolveWalletTradeMarket(tx)).toBeNull();
  });

  it('resolveWalletTradeMarket passes through already-resolved tx', () => {
    const state = new WorldState();
    const tx = makeTx({ market_id: 'mkt_1' });

    const resolved = state.resolveWalletTradeMarket(tx);
    expect(resolved).toBe(tx); // same reference
  });

  it('enrichWalletTradePrice matches by tx_hash', () => {
    const state = new WorldState();
    const tx = makeTx({ price: 0, tx_hash: '0xmatch' });

    const recentTrades: ParsedTrade[] = [{
      market_id: 'mkt_1',
      condition_id: 'cond_1',
      token_id: 'tok_yes_1',
      side: 'BUY',
      price: 0.55,
      size: 100,
      notional: 55,
      maker: '0x1',
      taker: '0x2',
      tx_hash: '0xmatch',
      timestamp: Date.now(),
      book_state_before: null,
    }];

    const enriched = state.enrichWalletTradePrice(tx, recentTrades);
    expect(enriched.price).toBe(0.55);
  });

  it('enrichWalletTradePrice matches by token_id + timestamp proximity', () => {
    const state = new WorldState();
    const now = Date.now();
    const tx = makeTx({ price: 0, tx_hash: '0xno_match', token_id: 'tok_yes_1', timestamp: now });

    const recentTrades: ParsedTrade[] = [{
      market_id: 'mkt_1',
      condition_id: 'cond_1',
      token_id: 'tok_yes_1',
      side: 'BUY',
      price: 0.48,
      size: 100,
      notional: 48,
      maker: '0x1',
      taker: '0x2',
      tx_hash: '0xother',
      timestamp: now + 2000, // within 5s
      book_state_before: null,
    }];

    const enriched = state.enrichWalletTradePrice(tx, recentTrades);
    expect(enriched.price).toBe(0.48);
  });

  it('enrichWalletTradePrice returns original if no match', () => {
    const state = new WorldState();
    const tx = makeTx({ price: 0, tx_hash: '0xno_match' });

    const enriched = state.enrichWalletTradePrice(tx, []);
    expect(enriched.price).toBe(0);
  });

  it('enrichWalletTradePrice skips if price already set', () => {
    const state = new WorldState();
    const tx = makeTx({ price: 0.50 });

    const enriched = state.enrichWalletTradePrice(tx, []);
    expect(enriched).toBe(tx); // same reference, not modified
  });
});
