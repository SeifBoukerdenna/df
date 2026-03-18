# MASTER PROMPT v2 — POLYMARKET QUANTITATIVE RESEARCH AND EXECUTION PLATFORM

You are a principal systems engineer and quantitative researcher building a **profit-maximizing, self-improving quantitative research and trading platform for Polymarket prediction markets**. This is not a bot. This is not a copy-trader. This is a **quant research laboratory with an attached execution facility.** You will implement every module described below with production-grade code. No shortcuts. No placeholder logic. Every component must be testable, observable, deterministic, and statistically defensible.

---

## SYSTEM PHILOSOPHY

- Terminal-first. No UI. All output via structured logs (JSON lines) and CLI commands.
- Every decision the system makes must be traceable to an expected-value calculation with confidence intervals.
- Every trade must be replayable from the ledger.
- Assume adversarial conditions: latency spikes, stale data, disappearing liquidity, front-running, regime changes, alpha decay.
- The system's purpose is **continuous edge discovery, rigorous validation, optimal capital allocation, and disciplined exploitation.**
- The system must treat its own strategies with the same skepticism it applies to market prices. Observed profits are suspect until proven statistically significant, robust to parameter perturbation, and decomposed into explainable components.
- The system must be able to answer, at any moment: "Why are we making money, and will it continue?" If it cannot answer this, it must reduce exposure.

---

## ARCHITECTURE OVERVIEW

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          ALPHA RESEARCH FACTORY                                 │
│  ┌──────────┐  ┌───────────┐  ┌──────────────┐  ┌────────────┐  ┌───────────┐ │
│  │Hypothesis│  │  Feature   │  │  Walk-Forward │  │  Regime    │  │   Decay   │ │
│  │ Registry │  │ Extraction │  │  Validation   │  │ Detection  │  │  Monitor  │ │
│  └──────────┘  └───────────┘  └──────────────┘  └────────────┘  └───────────┘ │
└──────────────────────────────┬──────────────────────────────────────────────────┘
                               │ validated strategies
                               ▼
┌─────────────┐    ┌─────────────┐    ┌──────────────┐    ┌─────────────┐    ┌──────────┐
│  INGESTION   │───▶│    STATE     │───▶│   STRATEGY    │───▶│  EXECUTION   │───▶│  LEDGER  │
│  (data in)   │    │  (world view)│    │  (decisions)  │    │  (orders)    │    │ (truth)  │
└─────────────┘    └─────────────┘    └──────────────┘    └─────────────┘    └──────────┘
       │                  │                   │                   │                │
       │                  │          ┌────────▼────────┐          │                │
       │                  │          │    PORTFOLIO     │          │                │
       │                  │          │  CONSTRUCTION    │          │                │
       │                  │          │  & ALLOCATION    │          │                │
       │                  │          └─────────────────┘          │                │
       │                  │                                       │                │
       │                  │          ┌────────────────────┐       │                │
       │                  │          │ EXECUTION RESEARCH │       │                │
       │                  │          │  (fill modeling,   │       │                │
       │                  │          │   cost attribution)│       │                │
       │                  │          └────────────────────┘       │                │
       │                  │                                       │                │
       └──────────────────┴───────────────────────────────────────┴────────────────┘
                                          │
                               ┌──────────▼──────────┐
                               │   DIAGNOSTICS &      │
                               │   TRUTH SYSTEM       │
                               └─────────────────────┘
```

All modules communicate through well-defined interfaces. No module reaches into another module's internals. State is the single source of truth for the current world view. Ledger is the single source of truth for historical actions. The Alpha Research Factory operates above the trading loop — it feeds validated strategies into the portfolio, and the portfolio allocates capital and routes signals to execution.

---

## MODULE 1: INGESTION

### Purpose
Ingest all relevant data streams into a normalized internal format with nanosecond-precision timestamping.

### Data Sources to Implement

| Source | Method | Frequency |
|---|---|---|
| Polymarket CLOB API (orders, trades) | WebSocket + REST fallback | Real-time |
| Polymarket order book snapshots | REST polling | 1–5s intervals |
| Wallet activity (tracked wallets) | On-chain event listener + API | Real-time |
| Market metadata (conditions, tokens, resolution) | REST | On change / 60s poll |
| Gas prices / network conditions | RPC or API | 10s poll |
| Market creation / resolution events | Event listener | Real-time |
| Cross-market relationship data | Computed internally | On market change |

### Data Models

```typescript
interface RawEvent {
  source: string;           // "clob_ws" | "chain_listener" | "rest_poll"
  type: string;             // "trade" | "order_placed" | "order_cancelled" | "book_snapshot" | "wallet_tx"
  timestamp_ingested: number; // Date.now() at ingestion — ms precision
  timestamp_source: number | null; // timestamp from source if available
  raw_payload: object;      // original unmodified payload
  parsed: ParsedEvent;      // normalized structure
  sequence_id: number;       // monotonically increasing per source
}

interface ParsedTrade {
  market_id: string;
  condition_id: string;
  token_id: string;         // YES or NO token
  side: "BUY" | "SELL";
  price: number;            // 0.00–1.00
  size: number;             // in tokens
  notional: number;         // price × size in USD terms
  maker: string;            // wallet address
  taker: string;
  tx_hash: string | null;
  timestamp: number;
  book_state_before: BookSummary | null;  // snapshot of book just before trade
}

interface BookSummary {
  mid: number;
  spread: number;
  best_bid: number;
  best_ask: number;
  bid_depth_5lvl: number;
  ask_depth_5lvl: number;
}

interface ParsedBookSnapshot {
  market_id: string;
  token_id: string;
  bids: [price: number, size: number][];
  asks: [price: number, size: number][];
  timestamp: number;
  mid_price: number;
  spread: number;
  spread_bps: number;
  bid_depth_1pct: number;   // total size within 1% of best bid
  ask_depth_1pct: number;
  bid_depth_5pct: number;
  ask_depth_5pct: number;
  vwap_bid_1000: number;    // VWAP if selling 1000 units into bids
  vwap_ask_1000: number;    // VWAP if buying 1000 units from asks
  queue_position_estimate: number; // estimated time-to-fill at best bid/ask
}

interface WalletTransaction {
  wallet: string;
  market_id: string;
  token_id: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  timestamp: number;
  tx_hash: string;
  block_number: number;
  gas_price: number;
}
```

### Instrumentation
- `ingestion_latency_ms`: time from source timestamp to ingestion timestamp
- `events_per_second`: throughput counter per source
- `gaps_detected`: sequence gaps or missing heartbeats
- `reconnect_count`: WebSocket reconnection events
- `stale_data_flags`: when source timestamp is >5s old at ingestion time
- `duplicate_rate`: percentage of events deduplicated
- `parse_error_rate`: percentage of events failing normalization

### Requirements
- All raw events persisted to append-only log (JSONL file, rotated daily).
- Reconnection logic with exponential backoff.
- Deduplication by (source, type, unique_key) tuple.
- Health check: if no events from a source in 30s, emit alert.
- Sequence ID tracking per source for gap detection.
- Pre-trade book snapshot capture: when a trade event arrives, attach the most recent book state so downstream analysis has context.

---

## MODULE 2: STATE

### Purpose
Maintain a consistent, queryable view of the current world: markets, books, positions, wallet states, cross-market relationships.

### State Components

```typescript
interface WorldState {
  markets: Map<string, MarketState>;
  wallets: Map<string, WalletState>;
  own_positions: Map<string, PositionState>;
  market_graph: MarketGraph;          // cross-market relationships
  regime: RegimeState;                 // current detected regime
  system_clock: number;
}

interface MarketState {
  market_id: string;
  question: string;
  condition_id: string;
  tokens: { yes_id: string; no_id: string };
  status: "active" | "paused" | "resolved";
  resolution: "YES" | "NO" | null;
  end_date: string;
  category: string;
  tags: string[];
  book: {
    yes: OrderBook;
    no: OrderBook;
  };
  last_trade_price: { yes: number; no: number };
  volume_24h: number;
  volume_1h: number;
  trade_count_1h: number;
  liquidity_score: number;
  complement_gap: number;               // |yes_mid + no_mid - 1.0|
  complement_gap_executable: number;    // actual arb after fees using executable prices
  staleness_ms: number;                 // time since last book update
  volatility_1h: number;               // realized vol over last hour
  autocorrelation_1m: number;           // 1-minute return autocorrelation
  related_markets: string[];            // semantically linked market IDs
  event_cluster_id: string | null;      // cluster of related event markets
  updated_at: number;
}

interface OrderBook {
  bids: [number, number][];  // [price, size] sorted desc
  asks: [number, number][];  // [price, size] sorted asc
  mid: number;
  spread: number;
  spread_bps: number;
  imbalance: number;                    // (bid_depth - ask_depth) / (bid_depth + ask_depth)
  imbalance_weighted: number;           // size-weighted across top 5 levels
  top_of_book_stability_ms: number;     // how long current best bid/ask has been unchanged
  queue_depth_at_best: number;          // size sitting at best bid or ask
  microprice: number;                   // size-weighted mid: (ask_size*bid + bid_size*ask) / (bid_size + ask_size)
  last_updated: number;
}

interface WalletState {
  address: string;
  label: string;
  classification: "sniper" | "arbitrageur" | "swing" | "market_maker" | "noise" | "unclassified";
  confidence: number;
  trades: WalletTransaction[];
  stats: WalletStats;
  regime_performance: Map<string, WalletStats>;  // performance per regime
}

interface WalletStats {
  total_trades: number;
  win_rate: number;
  avg_holding_period_seconds: number;
  median_holding_period_seconds: number;
  avg_trade_size_usd: number;
  pnl_realized: number;
  pnl_unrealized: number;
  sharpe_ratio: number;
  sortino_ratio: number;
  calmar_ratio: number;
  max_drawdown: number;
  avg_entry_delay_from_event: number | null;
  preferred_markets: string[];
  active_hours: number[];
  profitable_after_delay: Map<number, number>;
  pnl_significance: number;            // t-statistic of mean PnL
  consecutive_loss_max: number;
  trade_clustering_score: number;       // do trades cluster in time?
}

interface PositionState {
  market_id: string;
  token_id: string;
  side: "YES" | "NO";
  size: number;
  avg_entry_price: number;
  current_mark: number;
  unrealized_pnl: number;
  opened_at: number;
  strategy_id: string;
  signal_ev_at_entry: number;           // what we estimated the edge was
  current_ev_estimate: number;          // what we now estimate the edge is
  time_in_position_ms: number;
  max_favorable_excursion: number;      // best unrealized PnL seen
  max_adverse_excursion: number;        // worst unrealized PnL seen
}

interface MarketGraph {
  // Adjacency: market_id → [{market_id, relationship_type, strength}]
  edges: Map<string, MarketRelationship[]>;
  clusters: MarketCluster[];
}

interface MarketRelationship {
  target_market_id: string;
  relationship: "same_event" | "complementary" | "correlated" | "causal" | "semantic";
  strength: number;       // 0–1
  price_correlation: number;
  staleness_propagation_lag_ms: number;  // how fast price changes propagate
}

interface MarketCluster {
  cluster_id: string;
  market_ids: string[];
  event_description: string;
  consistency_score: number;            // do probabilities within cluster sum correctly?
  consistency_violation: number;        // magnitude of violation
  last_checked: number;
}

interface RegimeState {
  current_regime: "normal" | "high_volatility" | "low_liquidity" | "event_driven" | "resolution_clustering";
  regime_since: number;
  confidence: number;
  features: {
    avg_spread_z_score: number;
    volume_z_score: number;
    wallet_activity_z_score: number;
    resolution_rate: number;
    new_market_rate: number;
  };
}
```

### Derived Metrics (Computed Continuously)

- **Complement gap (executable)**: For every market, compute the actual profit from buying YES ask + NO ask, accounting for fees and realistic fill sizes. This is NOT the mid-point gap — it's the executable gap.
- **Cross-market consistency**: For event clusters (e.g., "Who wins the election?" with multiple outcome markets), do implied probabilities sum to 1.0? If not, by how much?
- **Microprice**: Size-weighted mid-price — more predictive of next trade direction than raw mid.
- **Liquidity score**: Weighted depth across top 5 levels of each book side, discounted by distance from mid.
- **Book imbalance (multi-level)**: Imbalance computed at each of top 5 levels, not just best bid/ask.
- **Staleness index**: Time since last update per market. Stale books are exploitable.
- **Wallet heat map**: Which wallets are active right now, in which markets.
- **Autocorrelation**: Rolling 1-minute return autocorrelation — positive autocorrelation → momentum regime; negative → mean reversion regime.
- **Queue stability**: How long the best bid/ask has been static. Long stability → stale quotes or low activity.
- **Volatility surface**: Rolling realized volatility at 1m, 5m, 1h, 24h horizons per market.

### Requirements
- State updates must be atomic per-market.
- State must be serializable to disk for cold restart.
- All state changes logged with before/after snapshots for replay.
- MarketGraph rebuilt every 5 minutes or on market creation/resolution.
- Regime detection runs every 60 seconds.

---

## MODULE 3: STRATEGY ENGINE

### Purpose
Evaluate current state, generate trade signals with expected value estimates and confidence intervals, and pass actionable orders to the portfolio construction layer.

### Signal Format

```typescript
interface TradeSignal {
  signal_id: string;
  strategy_id: string;
  timestamp: number;
  market_id: string;
  token_id: string;
  direction: "BUY" | "SELL";
  target_price: number;
  max_price: number;
  size_requested: number;           // raw size before portfolio adjustment
  urgency: "immediate" | "patient" | "scheduled";
  ev_estimate: number;
  ev_confidence_interval: [number, number];  // 90% CI
  ev_after_costs: number;           // EV net of estimated execution costs
  signal_strength: number;          // 0–1 normalized
  expected_holding_period_ms: number;
  expected_sharpe_contribution: number;
  correlation_with_existing: number; // correlation with current portfolio
  reasoning: string;
  kill_conditions: KillCondition[];
  regime_assumption: string;        // which regime this signal assumes
  decay_model: {                    // how fast this signal loses value
    half_life_ms: number;
    ev_at_t: (t_ms: number) => number;
  };
}

interface KillCondition {
  type: "time_elapsed" | "price_moved" | "spread_widened" | "book_thinned" | "regime_changed" | "ev_decayed";
  threshold: number;
}
```

### STRATEGY 1: Latency-Aware Wallet Following

**Do NOT blindly copy.** Instead:

1. Maintain a rolling performance model per tracked wallet.
2. For each wallet trade observed at time T0:
   - Estimate the wallet's historical edge at the observed price.
   - Simulate what happens if we enter at T0 + Δ (where Δ = our realistic latency, 10–30s).
   - Compute: `EV_delayed = wallet_edge - price_impact(Δ) - spread_cost - fees`
   - Only emit signal if `EV_delayed > threshold` (default 0.02 = 2 cents per share).
3. Use wallet classification:
   - **Snipers** (hold < 5 min): DO NOT FOLLOW — edge is destroyed by our latency.
   - **Swing** (hold > 1 hour): FOLLOW if historically profitable after 30s delay.
   - **Arbitrageurs**: DO NOT FOLLOW — they extract the entire edge instantly.
   - **Market makers**: REVERSE SIGNAL — fade their inventory rebalancing.
4. Adaptive threshold: if wallet's delayed-PnL is declining over last 20 trades, stop following.
5. Regime-conditional: only follow wallets whose edge is positive in the CURRENT regime.
6. Signal decay: wallet-follow signals lose half their EV every `wallet_specific_halflife` ms. Compute this from historical price impact curves.

**Metrics to track:**
- `wallet_follow_ev_pre_delay` vs `wallet_follow_ev_post_delay`
- `follow_hit_rate` (% of follows that were profitable)
- `avg_follow_pnl`
- `optimal_delay_per_wallet` (backtest different delays)
- `regime_conditional_pnl` (per wallet per regime)
- `signal_decay_accuracy` (predicted vs actual EV at different delays)

### STRATEGY 2: Complement Arbitrage

For each market:
- `gap = yes_best_ask + no_best_ask - 1.0`
- If `gap < -fee_rate`: buy both YES and NO. One resolves to 1.0, guaranteed profit.
- `gap = yes_best_bid + no_best_bid - 1.0`
- If `gap > fee_rate`: sell both (if holding inventory).
- Edge = `|gap| - 2 * fee_rate - slippage_estimate`

**Critical implementation detail:**
- Both legs must execute atomically or near-atomically.
- If one leg fills and the other doesn't → you have directional exposure, not arb.
- Track: `arb_opportunities_detected`, `arb_opportunities_executed`, `arb_leg_slip_rate`, `arb_realized_pnl`.
- Compute: `expected_leg_slip_probability` per market based on historical book volatility. If P(second_leg_slip) > 0.1, reduce size or skip.
- Monitor: `arb_gap_persistence_ms` — how long does a gap persist? If gaps close in <5s, we cannot capture them. Track this.

### STRATEGY 3: Book Imbalance Mean Reversion

When order book imbalance exceeds threshold (e.g., |imbalance| > 0.6):
- Imbalance often predicts short-term price movement.
- Enter in direction of imbalance.
- Exit on mean reversion or time limit.
- Sizing proportional to imbalance magnitude × liquidity.

**Key:** This only works on markets with sufficient activity. Filter by `volume_24h > $50k` and `avg_trades_per_hour > 10`.

**Enhancement:** Use multi-level imbalance (not just top of book). Imbalance at levels 2–5 may be more predictive because top-of-book is more easily manipulated.

### STRATEGY 4: Large Trade Reaction

When a large trade is detected (> 2σ of market's trade size distribution):
- Measure price impact.
- If price impact > spread: enter in same direction (momentum).
- If price reverts within 60s historically: fade the trade (mean reversion).
- Requires per-market calibration of impact/reversion dynamics.

**Build a model:**
```
for each market:
  collect all trades > 2σ
  measure price at T+10s, T+30s, T+60s, T+5m
  classify: momentum or reversion
  compute: avg_reversion_amount, avg_reversion_time
  compute: conditional on book state (thin book → more reversion?)
  compute: conditional on time of day
  compute: conditional on trade direction (buys vs sells may behave differently)
```

### STRATEGY 5: Stale Book Exploitation

- If a market's order book hasn't been updated in > 30s but a correlated market has moved:
  - The stale book may have resting orders at incorrect prices.
  - Sweep the stale side.
- Correlation model: use MarketGraph relationships.
- **Enhancement:** Build a `staleness_propagation_model`:
  - When market A moves, how long until market B's book updates?
  - If propagation_lag > our execution latency → exploitable.
  - Track this lag per market pair continuously.

### STRATEGY 6: Resolution Convergence

As markets approach resolution:
- Price should converge toward 0 or 1.
- If price is at 0.85 with strong public evidence pointing to YES → price should be higher.
- This is fundamentally an information strategy: integrate external signals.
- For now: track how fast markets converge and identify consistently slow ones.
- **Enhancement:** Build a `convergence_speed_model` per market category. Sports markets converge faster than political markets. Identify laggards.

### STRATEGY 7: Cross-Market Consistency Arbitrage

When a cluster of related markets has inconsistent implied probabilities:
- Example: "Will X win?" has P=0.60, but the market for "Will X or Y win?" has P=0.55. Structural violation.
- Build event trees from market clusters. Identify violations of probability axioms.
- Trade the most mispriced leg toward consistency.
- Edge = magnitude of consistency violation × (1 / time_to_resolution) - costs.

### STRATEGY 8: Microprice Dislocation

When microprice diverges significantly from mid-price:
- Microprice is a better estimator of "true" price than mid.
- If `|microprice - mid| > 0.5 * spread`:
  - Enter in the direction microprice suggests the mid should move.
  - Exit when mid converges to microprice or time limit.
- This is a very short-term strategy. Only viable in liquid markets with tight spreads.

### Strategy Selection & Portfolio

```typescript
interface StrategyPortfolio {
  strategies: StrategyConfig[];
  total_capital: number;
  max_exposure_per_market: number;
  max_exposure_per_strategy: number;
  max_total_exposure: number;
  correlation_limit: number;
  rebalance_frequency_ms: number;
}

interface StrategyConfig {
  id: string;
  name: string;
  enabled: boolean;
  capital_allocation: number;
  max_position_size: number;
  min_ev_threshold: number;
  max_concurrent_positions: number;
  cooldown_after_loss_ms: number;
  paper_only: boolean;
  allowed_regimes: string[];          // only active in these regimes
  min_statistical_confidence: number; // t-stat threshold
  max_parameter_sensitivity: number;  // max allowed PnL change from 10% param perturbation
}
```

---

## MODULE 4: EXECUTION ENGINE

### Purpose
Convert trade signals into filled orders with minimal slippage and latency, with full execution quality attribution.

### Execution Flow

```
Signal received from Portfolio Construction layer
  → Pre-trade analysis (book state, expected fill, cost estimate)
  → Validate (market active, within risk limits, no duplicate)
  → Execution strategy selection (passive / aggressive / scheduled)
  → Submit order
  → Monitor fill (partial fill handling, repost logic)
  → Post-trade analysis (actual vs expected)
  → Record result to ledger
  → Feed execution quality data back to Execution Research module
```

### Execution Strategy Selection

```typescript
interface ExecutionPlan {
  signal_id: string;
  chosen_strategy: "immediate_cross" | "aggressive_limit" | "passive_limit" | "iceberg" | "scheduled";
  reasoning: string;
  expected_fill_probability: number;
  expected_fill_price: number;
  expected_fill_time_ms: number;
  expected_cost_vs_mid: number;       // expected slippage from mid
  opportunity_cost_of_waiting: number; // EV lost per ms of delay (from signal decay model)
  // Decision logic
  spread_regime: "tight" | "normal" | "wide";
  liquidity_regime: "deep" | "normal" | "thin";
  urgency_regime: "decaying_fast" | "stable" | "improving";
}
```

### Order Type Logic (Enhanced)

```
1. Compute signal decay rate from signal.decay_model
2. Compute expected fill time for passive vs aggressive
3. Compute opportunity cost: decay_rate × expected_passive_fill_time
4. Compute crossing cost: spread / 2 + expected_impact

if opportunity_cost > crossing_cost:
  → immediate cross (market order or aggressive limit at best_ask + 0.001)
elif spread < 0.02 AND book is stable (top_stability > 5s):
  → passive limit at mid (expected to fill on natural flow)
  → cancel and re-evaluate after signal.decay_model.half_life
elif signal.urgency == "scheduled":
  → TWAP-style: split into chunks, place over time window
else:
  → aggressive limit (best_ask - 0.001 for buys)
  → monitor, repost if book moves
```

### Partial Fill Handling

```
on partial fill:
  remaining_size = size_requested - size_filled
  if remaining_size < min_viable_size → cancel remainder
  elif signal.ev_after_costs still positive at current price → repost
  elif time_since_signal > signal.decay_model.half_life → cancel
  else → repost at current best price
```

### Cancel / Repost Logic

```
Every 2 seconds while order is live:
  if order is not at current best price AND signal still valid:
    cancel and repost at new best price
  if book has thinned (depth < 50% of when order was placed):
    cancel (adverse selection risk)
  if spread has widened > 2x from order placement:
    cancel (market conditions deteriorated)
```

### Execution Data Model

```typescript
interface ExecutionRecord {
  execution_id: string;
  signal_id: string;
  strategy_id: string;
  market_id: string;
  token_id: string;
  direction: "BUY" | "SELL";
  execution_strategy: string;
  // Timestamps (all ms)
  t0_signal_generated: number;
  t1_execution_plan_created: number;
  t2_order_submitted: number;
  t3_order_acknowledged: number;
  t4_first_fill: number;
  t5_final_fill: number;
  // Pre-trade estimates
  estimated_fill_price: number;
  estimated_fill_probability: number;
  estimated_cost_vs_mid: number;
  // Actual results
  price_at_signal: number;
  price_at_submission: number;
  fill_price: number;           // VWAP if multiple fills
  fill_prices: number[];        // individual fill prices
  slippage_vs_signal: number;
  slippage_vs_mid: number;
  slippage_vs_estimate: number; // actual - estimated cost
  // Sizes
  size_requested: number;
  size_filled: number;
  partial: boolean;
  num_fills: number;
  num_cancels: number;
  num_reposts: number;
  // Costs
  fee_paid: number;
  gas_cost: number;
  total_cost: number;
  // Quality attribution
  implementation_shortfall: number;  // (fill_price - price_at_signal) × size
  timing_cost: number;               // cost from delay between signal and submission
  impact_cost: number;               // cost from our order moving the market
  spread_cost: number;               // cost from crossing the spread
  // Result
  status: "filled" | "partial" | "cancelled" | "failed";
  failure_reason: string | null;
}
```

### Latency Budget

| Stage | Target | Alert Threshold |
|---|---|---|
| Signal → Execution plan | < 100ms | > 500ms |
| Execution plan → Order submission | < 400ms | > 2s |
| Order submission → ACK | < 1s | > 5s |
| ACK → First fill | < 5s (limit) | > 30s |
| End-to-end (signal → final fill) | < 10s | > 30s |

### Requirements
- Idempotent order submission (dedup by signal_id).
- Automatic cancellation of stale unfilled orders.
- Position reconciliation after every fill.
- Never exceed risk limits even under race conditions (check-then-act with locks).
- Every execution feeds back to the Execution Research module for quality analysis.

---

## MODULE 5: LEDGER

### Purpose
Immutable, append-only record of all system events. The single source of truth.

### Entry Types

```typescript
type LedgerEntry =
  | { type: "signal_generated"; data: TradeSignal }
  | { type: "signal_filtered"; data: { signal_id: string; reason: string; filter: string } }
  | { type: "portfolio_decision"; data: PortfolioDecision }
  | { type: "execution_plan"; data: ExecutionPlan }
  | { type: "order_submitted"; data: { signal_id: string; order_details: object } }
  | { type: "order_filled"; data: ExecutionRecord }
  | { type: "order_cancelled"; data: { signal_id: string; reason: string } }
  | { type: "position_opened"; data: PositionState }
  | { type: "position_closed"; data: PositionClose }
  | { type: "pnl_snapshot"; data: PnLSnapshot }
  | { type: "regime_change"; data: { from: string; to: string; confidence: number } }
  | { type: "strategy_promoted"; data: { strategy_id: string; experiment_id: string } }
  | { type: "strategy_retired"; data: { strategy_id: string; reason: string } }
  | { type: "hypothesis_registered"; data: Hypothesis }
  | { type: "experiment_result"; data: ExperimentResult }
  | { type: "system_event"; data: { event: string; details: object } }

interface PositionClose {
  market_id: string;
  token_id: string;
  entry_price: number;
  exit_price: number;
  size: number;
  pnl_gross: number;
  pnl_net: number;
  holding_period_ms: number;
  strategy_id: string;
  signal_ev_at_entry: number;
  realized_ev: number;
  ev_estimation_error: number;  // how wrong was our EV estimate?
  execution_cost_realized: number;
  execution_cost_estimated: number;
}

interface PnLSnapshot {
  timestamp: number;
  total_realized_pnl: number;
  total_unrealized_pnl: number;
  total_fees_paid: number;
  total_slippage_cost: number;
  total_implementation_shortfall: number;
  positions_open: number;
  capital_deployed: number;
  capital_available: number;
  portfolio_sharpe_rolling_7d: number;
  portfolio_sharpe_rolling_30d: number;
  per_strategy_pnl: Map<string, number>;
  regime: string;
}
```

### Requirements
- JSONL format, one entry per line.
- Append-only. Never modify or delete entries.
- Daily rotation with SHA-256 checksums.
- Full replay capability: `replay(ledger_file) → reconstructed state`.
- Snapshot PnL every 5 minutes.
- Every entry includes a monotonically increasing sequence number and wall-clock timestamp.

---

## MODULE 6: SHADOW / COUNTERFACTUAL ENGINE

### Purpose
For every trade signal, simulate what would have happened under ideal and degraded conditions. This is how we determine whether a strategy has real edge vs. is killed by execution friction.

### Implementation

For every signal generated:

```typescript
interface CounterfactualAnalysis {
  signal_id: string;
  strategy_id: string;
  // Ideal execution (0ms latency, 0 slippage, 0 fees)
  ideal_entry_price: number;
  ideal_exit_price: number;
  ideal_pnl: number;
  // Realistic execution (actual latency, actual slippage, actual fees)
  actual_entry_price: number;
  actual_exit_price: number;
  actual_pnl: number;
  // Pure signal quality (0 latency, but realistic slippage and fees)
  signal_quality_pnl: number;
  // Decomposition
  edge_gross: number;
  cost_latency: number;
  cost_slippage: number;
  cost_fees: number;
  cost_gas: number;
  cost_market_impact: number;
  edge_net: number;
  // Attribution
  signal_alpha: number;         // edge_gross — is the signal actually right?
  execution_alpha: number;      // did we execute better or worse than expected?
  // Viability
  viable_at_latency: Map<number, boolean>;
  breakeven_latency_ms: number;
  // Parameter sensitivity
  pnl_if_threshold_plus_10pct: number;
  pnl_if_threshold_minus_10pct: number;
  pnl_if_size_half: number;
  pnl_if_size_double: number;
}
```

### Output
- Per-strategy summary: `avg_ideal_pnl`, `avg_actual_pnl`, `signal_alpha`, `execution_alpha`, `latency_cost_pct`, `fee_cost_pct`
- Viability matrix: for each strategy × latency bucket → is it profitable?
- Trend detection: is a strategy's edge growing or decaying over time?
- Signal vs Execution decomposition: "This strategy finds real edge but we lose it in execution" vs "This strategy executes well but the signals are wrong"

---

## MODULE 7: WALLET INTELLIGENCE

### Purpose
Reverse-engineer what makes tracked wallets profitable and determine which signals survive our execution constraints.

### Classification Pipeline

```
For each tracked wallet:
  1. Collect all trades (last 30 days minimum)
  2. Compute holding period distribution
  3. Compute return distribution (with bootstrap confidence intervals)
  4. Compute timing patterns (hour-of-day, day-of-week, event-driven?)
  5. Compute market concentration (Herfindahl index)
  6. Compute trade clustering (do trades come in bursts?)
  7. Compute regime-conditional performance
  8. Classify:
     - median_hold < 300s AND win_rate > 0.6 → "sniper"
     - trades both YES and NO in same market frequently → "arbitrageur"
     - median_hold > 3600s AND sharpe > 1.0 → "swing"
     - provides liquidity on both sides → "market_maker"
     - sharpe < 0.3 → "noise"
  9. Confidence = f(sample_size, consistency, regime_stability)
  10. Statistical test: is this wallet's performance significantly different from random? (t-test, p < 0.05)
```

### Delay Profitability Analysis

For each wallet, for each historical trade:
```
for delay in [5, 10, 15, 20, 30, 60, 120, 300] seconds:
  simulated_entry = price_at(trade.timestamp + delay)
  simulated_exit = actual_exit_price (same exit timing)
  delayed_pnl = (simulated_exit - simulated_entry) * trade.size - fees
  record(wallet, delay, delayed_pnl)

Compute:
  - mean delayed_pnl per (wallet, delay) with 95% CI
  - t-statistic: is delayed_pnl significantly > 0?
  - optimal_delay: which delay maximizes risk-adjusted return?
  - delay_sensitivity: how fast does PnL degrade with delay?
```

Output: `wallet_delay_curve[wallet][delay] → { mean_pnl, ci_low, ci_high, t_stat, n_trades }`

This tells us exactly which wallets are worth following at our latency, with statistical confidence.

### Wallet Scoring

```typescript
interface WalletScore {
  address: string;
  overall_score: number;
  components: {
    raw_profitability: number;
    delayed_profitability: number;       // THIS IS MOST IMPORTANT
    consistency: number;
    statistical_significance: number;    // p-value of edge
    sample_size: number;
    recency: number;
    regime_robustness: number;           // is edge present across regimes?
  };
  recommendation: "follow" | "shadow_only" | "ignore" | "fade";
  follow_parameters: {
    optimal_delay_ms: number;
    min_trade_size_to_follow: number;
    max_allocation_per_follow: number;
    allowed_market_types: string[];
    confidence_interval: [number, number]; // 90% CI of expected PnL per follow
  } | null;
}
```

---

## MODULE 8: DIAGNOSTICS & ANALYTICS (TRUTH SYSTEM)

### Purpose
Answer the fundamental questions: where is our edge, is it real, is it growing, and what should we do about it?

### Required Reports (CLI commands)

```bash
# Overall system health
$ quant report health

# PnL breakdown by strategy with statistical tests
$ quant report pnl --period=24h --by=strategy --significance

# PnL attribution: signal alpha vs execution alpha vs costs
$ quant report attribution --period=7d

# Wallet performance analysis with confidence intervals
$ quant report wallets --sort=delayed_pnl --min-trades=30

# Latency analysis with cost decomposition
$ quant report latency --period=24h

# Strategy viability matrix
$ quant report viability

# Counterfactual summary
$ quant report counterfactual --strategy=wallet_follow

# Active positions with current EV estimates
$ quant report positions --show-ev

# Market scanner (current opportunities)
$ quant report scanner

# Cross-market consistency violations
$ quant report consistency

# Portfolio analysis: correlations, exposure, allocation efficiency
$ quant report portfolio

# Execution quality report
$ quant report execution-quality --period=7d

# Alpha decay detection
$ quant report decay --strategy=all

# Regime analysis
$ quant report regime

# Full system state dump
$ quant report state

# Research factory status
$ quant report research

# Parameter sensitivity analysis
$ quant report sensitivity --strategy=wallet_follow
```

### Key Metrics Dashboard (JSON output, updated every 60s)

```typescript
interface SystemMetrics {
  timestamp: number;
  uptime_seconds: number;
  regime: string;
  // PnL
  pnl_realized_24h: number;
  pnl_unrealized: number;
  pnl_net_24h: number;
  pnl_net_7d: number;
  sharpe_7d: number;
  sharpe_30d: number;
  // Attribution
  signal_alpha_24h: number;
  execution_alpha_24h: number;
  // Costs
  fees_24h: number;
  slippage_24h: number;
  gas_24h: number;
  implementation_shortfall_24h: number;
  total_cost_24h: number;
  cost_as_pct_of_gross_pnl: number;
  // Execution quality
  signals_generated_24h: number;
  signals_executed_24h: number;
  signals_filtered_by_portfolio: number;
  signals_filtered_by_risk: number;
  avg_fill_latency_ms: number;
  fill_rate: number;
  execution_quality_score: number;
  // Strategy breakdown
  per_strategy: Map<string, {
    pnl: number;
    trades: number;
    hit_rate: number;
    avg_ev: number;
    sharpe: number;
    t_statistic: number;
    alpha_decaying: boolean;
    regime_conditional_sharpe: Map<string, number>;
  }>;
  // Portfolio
  portfolio_sharpe: number;
  portfolio_diversification_ratio: number;
  capital_deployed: number;
  capital_available: number;
  max_drawdown_24h: number;
  positions_open: number;
  cross_strategy_correlation: number;
  // Research
  hypotheses_active: number;
  experiments_running: number;
  strategies_in_shadow: number;
  strategies_promoted_30d: number;
  strategies_retired_30d: number;
  // Data health
  ingestion_lag_ms: number;
  stale_markets: number;
  ws_reconnects_24h: number;
  consistency_violations_detected: number;
}
```

---

## MODULE 9: RISK MANAGEMENT

### Hard Limits (Non-overridable)

| Parameter | Value | Action on Breach |
|---|---|---|
| Max position size per market | 10% of capital | Reject signal |
| Max total exposure | 80% of capital | Reject all new signals |
| Max daily loss | 5% of capital | Kill switch: stop all trading for 24h |
| Max drawdown from peak | 15% of capital | Kill switch: stop all trading, alert |
| Max single trade loss | 2% of capital | Auto-close position |
| Max correlated exposure | 25% of capital | Reject signal if correlated |
| Max strategy concentration | 40% of capital | Reject signals from over-concentrated strategy |
| Max single-event exposure | 20% of capital | Reject signal if same event cluster |

### Dynamic Sizing (Enhanced)

```
# Step 1: Kelly-based raw size
kelly_fraction = max(0, (win_rate * avg_win - (1 - win_rate) * avg_loss) / avg_win)
# Half-Kelly for safety
kelly_fraction = kelly_fraction * 0.5

# Step 2: Confidence adjustment
# Reduce size when sample is small or significance is low
confidence_scalar = min(1.0, t_statistic / 2.0) * min(1.0, n_trades / 50)

# Step 3: Regime adjustment
regime_scalar = regime_performance_ratio  # current regime vs all-time performance

# Step 4: Correlation penalty
# Reduce size when new position is correlated with existing portfolio
correlation_penalty = 1.0 - abs(correlation_with_portfolio) * 0.5

# Step 5: Drawdown penalty
# Reduce size when in drawdown
drawdown_scalar = max(0.2, 1.0 - (current_drawdown / max_drawdown_limit))

# Final size
base_size = strategy.capital_allocation * total_capital
adjusted_size = base_size * kelly_fraction * confidence_scalar * regime_scalar * correlation_penalty * drawdown_scalar
final_size = min(adjusted_size, max_position_size, available_capital * 0.1)
```

### Kill Switches

```typescript
interface KillSwitch {
  id: string;
  condition: string;
  action: "pause_strategy" | "pause_all" | "close_all_positions" | "shutdown";
  cooldown_hours: number;
  triggered_at: number | null;
  requires_manual_reset: boolean;
}
```

Implemented kill switches:
- `daily_loss_5pct`: pause all trading for 24h
- `drawdown_15pct`: close all positions, require manual reset
- `strategy_loss_streak_10`: pause individual strategy
- `execution_failure_rate_50pct`: pause execution, alert (something is wrong with the exchange or our connection)
- `data_staleness_60s`: pause all strategies (we're trading blind)
- `regime_unknown`: reduce all position sizes by 50%

Implement: `CTRL+C` or `$ quant kill` immediately cancels all open orders and stops all strategies.

---

## MODULE 10: SECURITY & INFRASTRUCTURE

### Key Management
- Private keys NEVER in source code or config files.
- Load from environment variable or encrypted keystore.
- Support for hardware wallet signing (future).
- API keys rotated regularly, scoped to minimum permissions.

### Idempotency
- Every order has a unique `signal_id` used as idempotency key.
- On restart, reconcile all pending orders before resuming.
- Order submission includes a nonce to prevent replay.

### Fault Tolerance
- On crash: replay ledger to reconstruct state.
- On network failure: exponential backoff, no duplicate orders.
- On data inconsistency: halt strategy, alert, require manual review.
- On partial system failure: degrade gracefully (e.g., if book polling fails, strategies that need book data pause, but wallet-follow can continue).

### File Structure

```
polymarket-quant/
├── src/
│   ├── ingestion/
│   │   ├── clob_websocket.ts
│   │   ├── book_poller.ts
│   │   ├── wallet_listener.ts
│   │   ├── market_metadata.ts
│   │   ├── market_graph_builder.ts
│   │   └── types.ts
│   ├── state/
│   │   ├── world_state.ts
│   │   ├── market_state.ts
│   │   ├── wallet_state.ts
│   │   ├── position_state.ts
│   │   ├── market_graph.ts
│   │   ├── regime_detector.ts
│   │   └── derived_metrics.ts
│   ├── research/
│   │   ├── hypothesis_registry.ts
│   │   ├── feature_engine.ts
│   │   ├── walk_forward.ts
│   │   ├── parameter_sweep.ts
│   │   ├── significance_tests.ts
│   │   ├── decay_detector.ts
│   │   ├── regime_analyzer.ts
│   │   ├── ablation.ts
│   │   └── types.ts
│   ├── strategy/
│   │   ├── engine.ts
│   │   ├── wallet_follow.ts
│   │   ├── complement_arb.ts
│   │   ├── book_imbalance.ts
│   │   ├── large_trade_reaction.ts
│   │   ├── stale_book.ts
│   │   ├── cross_market_consistency.ts
│   │   ├── microprice_dislocation.ts
│   │   └── types.ts
│   ├── portfolio/
│   │   ├── portfolio_constructor.ts
│   │   ├── covariance_estimator.ts
│   │   ├── capital_allocator.ts
│   │   ├── exposure_netter.ts
│   │   ├── rebalancer.ts
│   │   └── types.ts
│   ├── execution/
│   │   ├── executor.ts
│   │   ├── order_manager.ts
│   │   ├── execution_strategy_selector.ts
│   │   ├── fill_model.ts
│   │   ├── partial_fill_handler.ts
│   │   ├── cancel_repost.ts
│   │   ├── reconciliation.ts
│   │   ├── execution_research.ts
│   │   └── types.ts
│   ├── ledger/
│   │   ├── ledger.ts
│   │   ├── replay.ts
│   │   └── types.ts
│   ├── counterfactual/
│   │   ├── shadow_engine.ts
│   │   ├── viability.ts
│   │   └── attribution.ts
│   ├── wallet_intel/
│   │   ├── classifier.ts
│   │   ├── delay_analysis.ts
│   │   ├── scorer.ts
│   │   ├── regime_conditional.ts
│   │   └── types.ts
│   ├── risk/
│   │   ├── risk_manager.ts
│   │   ├── position_sizer.ts
│   │   ├── kill_switch.ts
│   │   ├── correlation_monitor.ts
│   │   └── drawdown_tracker.ts
│   ├── analytics/
│   │   ├── reports.ts
│   │   ├── metrics.ts
│   │   ├── scanner.ts
│   │   ├── consistency_checker.ts
│   │   └── attribution.ts
│   ├── utils/
│   │   ├── logger.ts
│   │   ├── config.ts
│   │   ├── time.ts
│   │   ├── math.ts
│   │   ├── statistics.ts        # t-tests, bootstrap, CI, significance
│   │   └── text_similarity.ts   # for semantic market clustering
│   └── main.ts
├── config/
│   ├── default.json
│   ├── paper.json
│   └── production.json
├── data/
│   ├── ledger/
│   ├── raw_events/
│   ├── snapshots/
│   ├── research/               # hypothesis results, experiment data
│   ├── features/               # extracted feature timeseries
│   └── analysis/
├── scripts/
│   ├── backtest.ts
│   ├── replay.ts
│   ├── wallet_report.ts
│   ├── parameter_sweep.ts
│   ├── ablation_study.ts
│   └── consistency_scan.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── statistical/            # tests that validate statistical methods
│   └── fixtures/
├── package.json
├── tsconfig.json
└── README.md
```

### Tech Stack
- **Language:** TypeScript (Node.js 20+)
- **Runtime:** Single process, event-driven (no unnecessary microservices)
- **Storage:** File-based (JSONL for ledger, JSON for state snapshots)
- **Logging:** Pino (structured JSON)
- **HTTP:** Native fetch or undici
- **WebSocket:** ws library
- **Blockchain:** ethers.js v6 or viem
- **CLI:** Commander.js
- **Testing:** Vitest
- **Statistics:** Simple-statistics + custom implementations (t-test, bootstrap, rolling regression)
- **Text similarity:** String comparison for market clustering (Jaccard, cosine on TF-IDF)
- **No databases.** File I/O is sufficient. Avoid unnecessary complexity.

---

## MODULE 11: ALPHA RESEARCH FACTORY

### Purpose
This is not just a trading system. It is a **continuous edge discovery platform**. The Research Factory is the engine that generates, tests, validates, and retires trading hypotheses systematically. It operates above the trading loop. Its output is validated strategies that get promoted into the live portfolio.

### Hypothesis Registry

Every potential edge starts as a hypothesis. Hypotheses are first-class objects.

```typescript
interface Hypothesis {
  id: string;
  created_at: number;
  author: string;                      // "system" | "manual"
  category: "microstructure" | "wallet_signal" | "cross_market" | "timing" | "behavioral" | "structural";
  statement: string;                   // "Book imbalance > 0.6 predicts 1-minute returns with IC > 0.05"
  required_features: string[];         // feature IDs needed to test this
  null_hypothesis: string;             // "Book imbalance has zero predictive power for 1-minute returns"
  test_methodology: string;            // "Walk-forward OOS test, 70/30 split, rolling 7-day window"
  minimum_sample_size: number;
  significance_level: number;          // default 0.05
  status: "registered" | "collecting_data" | "testing" | "validated" | "rejected" | "promoted" | "retired";
  results: HypothesisTestResult | null;
  promoted_to_strategy: string | null;
  rejected_reason: string | null;
}

interface HypothesisTestResult {
  hypothesis_id: string;
  tested_at: number;
  in_sample_sharpe: number;
  out_of_sample_sharpe: number;
  oos_degradation: number;             // (IS_sharpe - OOS_sharpe) / IS_sharpe
  t_statistic: number;
  p_value: number;
  effect_size: number;                 // Cohen's d or equivalent
  information_coefficient: number;     // correlation between predicted and actual
  hit_rate: number;
  avg_pnl_per_trade: number;
  avg_pnl_per_trade_after_costs: number;
  max_drawdown: number;
  parameter_sensitivity: ParameterSensitivity;
  regime_breakdown: Map<string, { sharpe: number; hit_rate: number; n_trades: number }>;
  walk_forward_results: WalkForwardResult[];
  conclusion: "significant_edge" | "marginal_edge" | "no_edge" | "negative_edge" | "insufficient_data";
}
```

### Feature Extraction Framework

All predictive signals are formalized as features. Features are computed from state and stored as time series.

```typescript
interface FeatureDefinition {
  id: string;
  name: string;
  description: string;
  inputs: string[];                     // state fields needed
  compute: (state: WorldState, market_id: string) => number;
  lookback_required: number;            // ms of history needed
  update_frequency_ms: number;
  normalization: "z_score" | "rank" | "percentile" | "raw";
}

// Feature registry — all features the system knows how to compute
const FEATURES: FeatureDefinition[] = [
  { id: "book_imbalance_l1", ... },
  { id: "book_imbalance_l5", ... },
  { id: "microprice_deviation", ... },
  { id: "spread_z_score", ... },
  { id: "volume_z_score_1h", ... },
  { id: "staleness_ms", ... },
  { id: "complement_gap_executable", ... },
  { id: "autocorrelation_1m", ... },
  { id: "large_trade_imbalance_5m", ... },
  { id: "wallet_heat_score", ... },
  { id: "consistency_violation_magnitude", ... },
  { id: "time_to_resolution_hours", ... },
  { id: "volatility_ratio_1h_24h", ... },
  { id: "queue_depth_ratio", ... },
  { id: "trade_arrival_rate_z", ... },
  // ... extensible
];

interface FeatureSnapshot {
  timestamp: number;
  market_id: string;
  features: Map<string, number>;
  forward_return_1m: number | null;    // filled in retrospectively
  forward_return_5m: number | null;
  forward_return_1h: number | null;
}
```

Features are stored as time series. This is the training data for the research factory. Every 60 seconds, for every active market, compute all features and record forward returns (filled in after the fact).

### Parameter Sweep / Grid Search / Ablation

```typescript
interface ParameterSweep {
  hypothesis_id: string;
  parameter: string;                    // e.g., "imbalance_threshold"
  values: number[];                     // e.g., [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
  results: Map<number, {
    sharpe: number;
    pnl: number;
    n_trades: number;
    hit_rate: number;
  }>;
  optimal_value: number;
  sensitivity: number;                  // std of sharpe across parameter values
  cliff_risk: boolean;                  // does performance collapse at nearby values?
}

interface AblationResult {
  hypothesis_id: string;
  full_model_sharpe: number;
  ablations: Map<string, {             // feature_id → performance without it
    sharpe_without: number;
    sharpe_delta: number;              // how much worse without this feature
    is_critical: boolean;              // sharpe_delta > 20% of full model
  }>;
}
```

**Rules:**
- Every strategy must survive a ±20% perturbation of its key parameters. If Sharpe drops below 0.5 at ±20%, the strategy is too parameter-sensitive and must not be promoted.
- Ablation: remove each feature/condition one at a time. If removing any single component causes >50% Sharpe degradation, document this as a concentration risk.

### Walk-Forward Validation

No strategy is tested on a single train/test split. Walk-forward is mandatory.

```typescript
interface WalkForwardConfig {
  training_window_days: number;        // e.g., 14
  test_window_days: number;            // e.g., 7
  step_days: number;                   // e.g., 7 (rolling forward)
  min_trades_per_window: number;       // e.g., 10
  total_periods: number;               // determined by available data
}

interface WalkForwardResult {
  period_index: number;
  training_start: string;
  training_end: string;
  test_start: string;
  test_end: string;
  training_sharpe: number;
  test_sharpe: number;
  test_pnl: number;
  test_trades: number;
  test_hit_rate: number;
  degradation: number;                 // (train_sharpe - test_sharpe) / train_sharpe
}
```

**Rules:**
- If average OOS degradation > 50%, the strategy is likely overfit. Reject.
- If any single OOS period has Sharpe < -0.5, flag as regime-sensitive.
- Walk-forward must span at least 3 distinct regime periods.

### Rolling Out-of-Sample Testing

For live strategies, continuously measure OOS performance:

```
every 7 days:
  compute rolling Sharpe over last 7 days (this is always OOS — it's real trading)
  compare to historical Sharpe
  if rolling_sharpe < 0.3 for 3 consecutive periods:
    flag as "decaying"
  if rolling_sharpe < 0.0 for 2 consecutive periods:
    auto-pause strategy
  if rolling_sharpe < -0.5 for 1 period:
    auto-retire strategy
```

### Regime Detection

```typescript
interface RegimeDetector {
  // Hidden Markov Model-style regime classification
  features_used: string[];             // ["avg_spread_z", "volume_z", "wallet_activity_z", "resolution_rate"]
  regimes: RegimeDefinition[];
  current_regime: string;
  transition_matrix: number[][];       // P(regime_j | regime_i)
  regime_duration_avg: Map<string, number>;
}

interface RegimeDefinition {
  name: string;
  description: string;
  feature_ranges: Map<string, [number, number]>;  // expected feature ranges
  historical_frequency: number;
  avg_strategy_performance: Map<string, number>;   // strategy_id → avg sharpe in this regime
}
```

Implemented regimes:
- **normal**: average spreads, average volume, moderate wallet activity
- **high_volatility**: wide spreads, high volume, rapid price moves
- **low_liquidity**: wide spreads, low volume, thin books
- **event_driven**: high wallet activity, volume spikes in specific markets
- **resolution_clustering**: many markets resolving simultaneously, capital recycling

Every strategy must report its performance per regime. A strategy that is profitable only in one regime gets lower capital allocation.

### Decay Detection

```typescript
interface DecayMonitor {
  strategy_id: string;
  sharpe_timeseries: { timestamp: number; rolling_sharpe_7d: number }[];
  slope: number;                        // regression slope of sharpe over time
  slope_significance: number;           // t-stat of slope
  estimated_halflife_days: number;      // when edge decays to 50%
  estimated_zero_crossing_days: number; // when edge reaches zero
  recommendation: "healthy" | "monitor" | "reduce_allocation" | "retire";
}
```

**Rules:**
- If slope is significantly negative (p < 0.1) and estimated zero-crossing is < 30 days: reduce allocation by 50%.
- If estimated zero-crossing is < 14 days: retire strategy.
- If Sharpe has been < 0.5 for 21 consecutive days: retire regardless of slope.

### Automatic Strategy Retirement

```
Strategy retirement triggers (ANY one is sufficient):
1. Rolling 21-day Sharpe < 0.0
2. Rolling 21-day Sharpe < 0.5 for 3 consecutive measurement periods
3. Decay monitor recommends "retire"
4. Max drawdown exceeded
5. Strategy's edge source has structurally changed (e.g., market mechanics updated)
6. Parameter sensitivity has increased (strategy becoming fragile)
7. Manual kill command
```

On retirement:
- Close all positions associated with strategy.
- Record retirement reason in ledger.
- Strategy enters "archived" state — data preserved for future analysis.
- Capital is freed and returned to portfolio for reallocation.

### Statistical Significance Standards

Every claimed edge must pass:
1. **t-test**: mean PnL per trade significantly > 0 (p < 0.05, one-tailed)
2. **Minimum sample size**: n ≥ 30 trades
3. **Effect size**: Cohen's d > 0.2 (small but meaningful)
4. **Out-of-sample validation**: OOS Sharpe > 0.5
5. **Parameter robustness**: survives ±20% parameter perturbation
6. **Regime robustness**: profitable in at least 2/3 of detected regimes
7. **Cost survival**: profitable AFTER realistic fees, slippage, and latency

A strategy that passes all 7 is "validated." A strategy that passes 5-6 is "marginal" and enters shadow trading. A strategy that passes < 5 is rejected.

### Exploration vs Exploitation

```
Capital allocation between live strategies (exploitation) and shadow strategies (exploration):

exploration_budget = max(5%, min(20%, capital * (1 - portfolio_sharpe / target_sharpe)))

Interpretation:
- If portfolio is performing well (Sharpe near target): spend less on exploration (5%)
- If portfolio is underperforming: spend more on exploration (up to 20%)
- Exploration capital is paper-traded only — no real risk
- Exploration strategies are promoted to exploitation when they pass validation criteria
```

---

## MODULE 12: PORTFOLIO CONSTRUCTION LAYER

### Purpose
Transform raw signals from multiple strategies into an optimally allocated, risk-managed portfolio. The strategy engine produces signals. The portfolio constructor decides which signals to act on, at what size, and how they interact with each other.

### Architecture

```
Strategy Engine outputs N signals per period
  → Portfolio Constructor receives all signals
  → Covariance estimation: how correlated are these signals with each other and existing positions?
  → Capital allocation: how much capital does each strategy deserve?
  → Signal filtering: which signals improve portfolio Sharpe vs. add correlated risk?
  → Position sizing: final size accounting for portfolio-level constraints
  → Output: ExecutionOrder[] → Execution Engine
```

### Cross-Strategy Covariance Estimation

```typescript
interface CovarianceModel {
  strategy_ids: string[];
  // Return covariance matrix (rolling 30-day, daily returns)
  covariance_matrix: number[][];
  // Correlation matrix
  correlation_matrix: number[][];
  // Eigenvalue decomposition for concentration risk
  eigenvalues: number[];
  // Effective number of independent bets
  effective_n: number;                 // = (sum(eigenvalues))^2 / sum(eigenvalues^2)
  // Pairwise correlations flagged as concerning
  high_correlation_pairs: { strategy_a: string; strategy_b: string; correlation: number }[];
}
```

**Compute daily:**
- Rolling 30-day return covariance between all active strategies.
- If two strategies have correlation > 0.7, treat them as partially redundant. Reduce allocation to the weaker one.
- `effective_n` measures true diversification. If effective_n < 2 even with 5 strategies running, the portfolio is concentrated.

### Cross-Market Correlation Graph

```typescript
interface MarketCorrelationGraph {
  // Pairwise return correlation between all active markets we trade
  correlations: Map<string, Map<string, number>>;  // market_id → market_id → correlation
  // Cluster assignments
  clusters: { cluster_id: string; market_ids: string[]; avg_intra_correlation: number }[];
  // Exposure per cluster
  cluster_exposure: Map<string, number>;           // cluster_id → total exposure
}
```

**Rules:**
- Max exposure to any single correlation cluster: 25% of capital.
- If entering a position in market A, and market A is correlated > 0.5 with existing positions, reduce size by `(1 - correlation) * base_size`.

### Capital Allocation (Marginal EV + Marginal Sharpe)

```typescript
interface CapitalAllocation {
  strategy_id: string;
  // Historical performance
  realized_sharpe_30d: number;
  realized_sharpe_7d: number;
  // Confidence
  sharpe_t_statistic: number;
  n_trades_30d: number;
  // Marginal contribution
  marginal_sharpe_contribution: number;  // how much does this strategy improve portfolio Sharpe?
  marginal_ev_per_dollar: number;        // expected return per dollar allocated
  // Allocation
  target_allocation_pct: number;
  current_allocation_pct: number;
  rebalance_needed: number;
}
```

**Allocation algorithm:**

```
1. For each strategy, compute marginal Sharpe contribution:
   marginal_sharpe(strategy_i) = portfolio_sharpe(with_i) - portfolio_sharpe(without_i)

2. Rank strategies by: marginal_sharpe * confidence_scalar

3. Allocate capital proportional to ranking, subject to:
   - min allocation per strategy: 5% (if active)
   - max allocation per strategy: 40%
   - sum of allocations = total_exploitable_capital (1 - exploration_budget)

4. Rebalance when:
   - any strategy's actual allocation deviates > 5% from target
   - a strategy is promoted or retired
   - regime changes
```

### Exposure Netting

```
Before submitting a new order:
1. Check all existing positions in the same market or correlated markets
2. If new signal is opposite direction to existing position in same market:
   - Net out: reduce existing position instead of opening new opposing position
   - Saves on fees and spread crossing
3. If new signal is in a correlated market:
   - Compute net directional exposure across the correlation cluster
   - If adding this position would increase cluster exposure beyond limit, resize or skip
```

### Portfolio-Level Drawdown Control

```
Portfolio drawdown tiers:
  0–3% drawdown from peak: normal operation
  3–5% drawdown: reduce all new position sizes by 30%
  5–8% drawdown: reduce all new position sizes by 60%, begin closing lowest-conviction positions
  8–12% drawdown: stop all new trades, close bottom 50% of positions by conviction
  12–15% drawdown: close all positions, stop all trading, require manual restart
```

### Opportunity Cost-Aware Capital Deployment

```
Before deploying capital to a signal:
  1. Compute expected return of this signal: EV_new
  2. Compute expected return of capital in current best alternative:
     - If capital is idle: alternative return = 0
     - If capital would need to be freed from an existing position: alternative return = current_position.ev_estimate
  3. Only deploy if: EV_new > EV_alternative + switching_cost

  switching_cost = exit_spread_cost + exit_fees + entry_spread_cost + entry_fees
```

### Portfolio Decision Record

```typescript
interface PortfolioDecision {
  timestamp: number;
  signals_received: string[];          // signal IDs
  signals_accepted: string[];
  signals_rejected: { signal_id: string; reason: string }[];
  portfolio_state_before: PortfolioSummary;
  portfolio_state_after: PortfolioSummary;
  rebalance_actions: RebalanceAction[];
}

interface PortfolioSummary {
  total_exposure: number;
  per_strategy_exposure: Map<string, number>;
  per_cluster_exposure: Map<string, number>;
  portfolio_sharpe_estimate: number;
  diversification_ratio: number;
  drawdown_from_peak: number;
}

interface RebalanceAction {
  type: "accept_signal" | "reject_signal" | "resize_signal" | "close_position" | "reduce_position";
  details: object;
  reasoning: string;
}
```

---

## MODULE 13: ADVERSARIAL EXECUTION RESEARCH LAYER

### Purpose
Execution is not a solved problem. This module continuously studies execution quality, models fill dynamics, and feeds improvements back into the execution engine. It separates execution quality from signal quality — a critical distinction most retail systems fail to make.

### Queue-Aware Fill Modeling

```typescript
interface FillModel {
  market_id: string;
  // Historical fill rate by price level
  fill_probability_at_best: number;     // P(fill) if posted at best bid/ask
  fill_probability_at_mid: number;      // P(fill) if posted at mid
  avg_time_to_fill_at_best_ms: number;
  avg_time_to_fill_at_mid_ms: number;
  // Queue position modeling
  estimated_queue_ahead: number;        // size ahead of us if we post now
  estimated_fill_time_ms: number;       // given current arrival rate
  // Trade arrival model
  trade_arrival_rate_per_min: number;   // Poisson parameter
  trade_arrival_rate_buy: number;
  trade_arrival_rate_sell: number;
  // Size distribution of incoming trades
  avg_incoming_trade_size: number;
  median_incoming_trade_size: number;
}
```

**Build from data:**
```
For each market with sufficient activity:
  1. Track all order placements and fills
  2. Estimate queue position from book snapshots
  3. Model time-to-fill as f(queue_position, trade_arrival_rate)
  4. Validate model: predicted fill probability vs actual fill rate
  5. Update model every hour
```

### Passive vs Aggressive Execution Simulation

```typescript
interface ExecutionSimulation {
  signal_id: string;
  // Simulate passive execution (post at mid, wait)
  passive: {
    expected_fill_probability: number;
    expected_fill_time_ms: number;
    expected_fill_price: number;
    expected_cost_vs_mid: number;       // should be ~0 or slightly positive (rebates)
    expected_ev_loss_from_delay: number; // signal decay while waiting
    expected_adverse_selection_cost: number; // getting filled because price moved against us
    net_expected_cost: number;
  };
  // Simulate aggressive execution (cross spread)
  aggressive: {
    expected_fill_probability: number;   // ~1.0
    expected_fill_time_ms: number;       // ~immediate
    expected_fill_price: number;
    expected_cost_vs_mid: number;        // spread/2 + impact
    expected_ev_loss_from_delay: number;  // ~0
    expected_adverse_selection_cost: number; // ~0
    net_expected_cost: number;
  };
  // Decision
  recommended: "passive" | "aggressive";
  expected_cost_savings: number;        // from choosing recommended over other
}
```

**Key insight:** Passive execution is cheaper on spread but exposes you to:
1. Signal decay (edge disappears while you wait)
2. Adverse selection (you only get filled when price moves against you — the adverse selection problem)
3. Non-fill risk (signal expires, opportunity missed)

The model must quantify all three and compare to the certain cost of crossing the spread.

### Partial Fill Path Analysis

```
For orders that receive partial fills:
  1. What % of orders experience partial fills? (partial_fill_rate)
  2. What is the average fill ratio? (size_filled / size_requested)
  3. Is the unfilled portion correlated with adverse price movement?
     (i.e., do we get partially filled and then price moves against us?)
  4. What is the optimal action after a partial fill?
     - Repost remainder (risk: market moved)
     - Cancel remainder (risk: missed opportunity)
     - Cross spread on remainder (cost: spread)
  5. Track: partial_fill_pnl vs full_fill_pnl — are partial fills systematically worse?
```

### Book Sweep Simulation

```
Before placing a large order:
  1. Simulate sweeping the book at current state
  2. Compute: VWAP for our full size vs best price
  3. Compute: expected impact = VWAP - mid
  4. If expected_impact > signal.ev_estimate * 0.5:
     → split into smaller chunks (iceberg)
  5. If expected_impact > signal.ev_estimate:
     → skip (our own execution would destroy the edge)
```

### Execution Quality Attribution

**Critical:** Separate signal quality from execution quality.

```typescript
interface ExecutionQualityAttribution {
  period: string;                      // "24h" | "7d" | "30d"
  // Signal quality: did we pick the right trades?
  signal_hit_rate: number;
  signal_avg_ev: number;
  signal_sharpe: number;
  // Execution quality: did we execute them well?
  avg_implementation_shortfall: number;
  avg_timing_cost: number;
  avg_impact_cost: number;
  avg_spread_cost: number;
  execution_quality_score: number;     // 0–1, higher is better
  // Decomposition
  total_pnl: number;
  pnl_from_signal_alpha: number;       // what we'd make with perfect execution
  pnl_lost_to_execution: number;       // signal_pnl - actual_pnl
  pnl_lost_breakdown: {
    to_latency: number;
    to_slippage: number;
    to_fees: number;
    to_partial_fills: number;
    to_adverse_selection: number;
  };
  // Improvement opportunities
  estimated_pnl_if_passive_only: number;
  estimated_pnl_if_aggressive_only: number;
  estimated_pnl_with_optimal_execution: number;
}
```

This report tells you exactly: "Are we losing money because our signals are bad, or because our execution is bad?" These have completely different solutions.

### Execution Scheduling Under Thin Liquidity

```
For markets with low liquidity (liquidity_score < 0.3):
  1. Never place full size at once
  2. Compute: max_size_without_impact = depth_at_best * 0.5
  3. If signal_size > max_size_without_impact:
     → schedule as TWAP: split into N chunks over T minutes
     → N = ceil(signal_size / max_size_without_impact)
     → T = min(signal.decay_model.half_life / 2, 300000)  // half the signal halflife, max 5 minutes
  4. Between chunks, re-evaluate:
     → has book replenished?
     → has price moved against us?
     → is signal still valid?
  5. Cancel remaining chunks if signal EV drops below threshold
```

---

## MODULE 14: DEEP MARKET STRUCTURE AND CONSISTENCY CHECKS

### Purpose
Exploit structural properties of prediction markets that go beyond single-market analysis. Polymarket creates related markets that must satisfy probability axioms. Violations are free money.

### Linked-Market Probability Consistency Checks

```typescript
interface ConsistencyCheck {
  check_type: "exhaustive_partition" | "subset_superset" | "conditional" | "temporal";
  markets_involved: string[];
  expected_relationship: string;        // e.g., "P(A) + P(B) + P(C) = 1.0"
  actual_values: Map<string, number>;   // market_id → current implied probability
  violation_magnitude: number;          // how far from consistency
  executable_violation: number;         // violation after accounting for spreads and fees
  tradeable: boolean;                   // is executable_violation > min_threshold?
  trade_plan: ConsistencyTradePlan | null;
}

interface ConsistencyTradePlan {
  legs: { market_id: string; token_id: string; direction: "BUY" | "SELL"; size: number }[];
  expected_profit: number;
  worst_case_loss: number;              // if one leg fails to fill
  execution_risk: string;
}
```

### Consistency Check Types

**1. Exhaustive Partition:**
"Who will win the election?" → markets for each candidate.
Sum of all candidate YES prices must equal ~1.0.
If sum > 1.0: sell the overpriced leg(s). If sum < 1.0: buy the underpriced leg(s).

**2. Subset/Superset:**
"Will X happen by June?" and "Will X happen by December?"
P(by_December) >= P(by_June). If violated, arbitrage.

**3. Conditional:**
"Will X win the primary?" and "Will X win the general?"
P(win_general) <= P(win_primary). Structural bound. Trade violations.

**4. Temporal:**
Markets on the same question at different time horizons.
Probabilities should be monotonic in the expected direction.

### Semantic Clustering of Related Markets

```
1. For all active markets, extract question text
2. Compute pairwise text similarity (TF-IDF cosine or Jaccard on key terms)
3. Cluster markets with similarity > 0.5
4. Within each cluster, build probability relationship graph
5. Run consistency checks per cluster
6. Flag violations
7. Re-cluster every hour and on new market creation
```

### Synthetic Basket Pricing

```
For event clusters with exhaustive outcomes:
  synthetic_basket_price = sum of all YES prices
  if synthetic_basket_price != 1.0:
    this is a mispricing
  if synthetic_basket_price > 1.0 + total_fee_cost:
    sell basket (sell YES on all outcomes)
  if synthetic_basket_price < 1.0 - total_fee_cost:
    buy basket (buy YES on all outcomes)
```

### Event Tree Inconsistencies

```typescript
interface EventTree {
  root_event: string;                   // e.g., "2024 US Election"
  nodes: EventTreeNode[];
  consistency_violations: ConsistencyViolation[];
}

interface EventTreeNode {
  market_id: string;
  question: string;
  implied_probability: number;
  parent_node: string | null;
  children: string[];
  // For conditional checks
  conditional_probability: number | null;  // P(this | parent)
  joint_probability: number | null;        // P(this AND parent)
}

interface ConsistencyViolation {
  type: string;
  nodes_involved: string[];
  expected: string;
  actual: string;
  magnitude: number;
  profit_opportunity: number;
}
```

### Stale-Price Propagation Model

```
For each pair of related markets (A, B):
  1. When A's price moves significantly (> 1σ):
     - Record A's price change timestamp
     - Record when B's price begins to adjust
     - Compute: propagation_lag = B_adjustment_start - A_move_time
  2. Build distribution of propagation_lag per pair
  3. If median propagation_lag > our execution latency:
     - This pair is exploitable
     - When A moves, immediately trade B in the expected direction
     - Expected edge = correlation * A_move_magnitude * (1 - propagation_efficiency)
  4. Track: propagation_lag_timeseries for regime dependency
```

---

## MODULE 15: WHAT THE SYSTEM SHOULD DISCOVER THAT RETAIL TRADERS MISS

This section enumerates classes of hidden edge the platform must actively search for. These are not strategies — they are categories of structural advantage that most market participants overlook.

### 1. Complement Mispricing is Persistent, Not Random
Retail traders check YES + NO = 1.0 occasionally. The system must monitor this continuously, at executable prices (not mid), and build a model of WHY gaps appear (new information hitting one side, stale quotes on the other, market maker rebalancing). Gaps that appear for structural reasons (e.g., after large trades) are more reliably exploitable than random fluctuations.

### 2. Cross-Market Consistency Violations Grow Before Events
When a major event is approaching, prediction markets create multiple related markets. The number of consistency violations increases because different markets update at different speeds. The system should detect this clustering and trade more aggressively during event-driven inconsistency periods.

### 3. Wallet Behavior Reveals Information Before Prices Move
A wallet that has been dormant for weeks suddenly placing large trades is a stronger signal than a continuously active wallet doing the same thing. The system must track wallet activity patterns and weight "unusual activity" signals higher than "regular activity."

### 4. Book Shape Predicts Impact Better Than Top-of-Book
Most copy-traders look at best bid/ask. The system must analyze the full book shape: is depth concentrated at one level (fragile) or distributed (resilient)? Concentrated books move violently on small trades. The system should pre-position in anticipation of book fragility events.

### 5. Market Maker Rebalancing is Predictable
Market makers on Polymarket rebalance their inventory predictably. After accumulating a directional position, they will place orders to reduce exposure. These rebalancing flows are not information — they are mechanical. The system should detect market maker rebalancing and fade it.

### 6. Resolution Timing Creates Forced Selling
When a market is about to resolve, participants who are wrong (holding the losing side) often sell at suboptimal prices as the outcome becomes clear. This "resolution rush" depresses prices below fair value. The system should buy during resolution rushes when the probability of correct resolution is already >95%.

### 7. New Market Listing Premium
Newly listed markets are often mispriced because liquidity providers haven't arrived yet and the initial prices are set by a small number of participants. The system should monitor for new market creation and immediately run consistency checks against related markets.

### 8. Time-of-Day Liquidity Patterns
Liquidity varies predictably by time of day (US hours vs Asia vs Europe). Spreads widen during low-activity periods. The system should schedule less-urgent trades for high-liquidity periods and exploit wide spreads during low-activity periods.

### 9. Gas Price Spikes Create Execution Asymmetry
When on-chain gas prices spike, slow participants are priced out of the market. Fast participants with pre-funded wallets can execute while others cannot. The system should monitor gas prices and trade more aggressively during gas spikes if competitors are likely to be inhibited.

### 10. Information Cascade Detection
When multiple wallets trade the same direction in rapid succession without obvious cause, it may be an information cascade (herding) rather than genuine information. Cascades overshoot and revert. The system should detect cascade patterns and fade them.

### 11. Implied Probability Term Structure
When the same event has markets at multiple time horizons, the "term structure" of implied probabilities reveals market expectations about timing. Convexity in the term structure can be exploited with calendar-like trades.

### 12. Maker Incentive Exploitation
If Polymarket offers maker rebates, the system should preferentially use passive limit orders and treat the rebate as negative cost. This changes the EV calculation for every strategy — some strategies that are negative-EV when crossing the spread become positive-EV when making liquidity.

---

## MODULE 16: WHAT A WORLD-CLASS QUANT FIRM WOULD DO DIFFERENTLY FROM A RETAIL BOT BUILDER

This section forces a higher standard of rigor. Every point below is a mandatory constraint on the system.

### 1. Statistical Rigor Over Anecdotal Evidence
A retail builder sees 10 profitable trades and calls it a strategy. A quant firm requires:
- Minimum 30 trades for any conclusion.
- t-test with p < 0.05 for claimed edge.
- Walk-forward out-of-sample validation.
- Multiple testing correction (Bonferroni or FDR) when testing multiple hypotheses simultaneously.
- The system must implement ALL of these and refuse to promote any strategy that fails them.

### 2. PnL Attribution, Not Just PnL Reporting
A retail builder tracks total PnL. A quant firm decomposes:
- Signal alpha (was the prediction correct?)
- Execution alpha (did we execute well?)
- Cost attribution (how much did fees/slippage/latency eat?)
- Regime attribution (was this a favorable regime?)
- Luck vs skill decomposition (is the Sharpe significant given the sample size?)
- The system must produce this decomposition for every strategy, every week.

### 3. Risk-Adjusted Returns Over Absolute Returns
A retail builder maximizes total profit. A quant firm maximizes Sharpe ratio subject to drawdown constraints. The portfolio construction layer must enforce this: a strategy with 5% return and 20% vol is worse than a strategy with 3% return and 5% vol.

### 4. Parameter Sensitivity Over Parameter Optimization
A retail builder optimizes parameters to maximize backtest PnL. A quant firm tests parameter sensitivity:
- If the best parameter is 0.6 but 0.5 and 0.7 are terrible → the parameter is overfit.
- The system must compute and display sensitivity surfaces for all key parameters.
- No strategy with cliff-like parameter sensitivity is promoted.

### 5. Regime Awareness Over Unconditional Backtests
A retail builder backtests over all historical data. A quant firm separates performance by regime:
- Does this strategy work in high-vol AND low-vol?
- Does it work in event-driven AND normal markets?
- Strategies that only work in one regime are allowed but must be LABELED as such, and the system must automatically reduce their allocation when the regime changes.

### 6. Continuous Model Monitoring Over Set-and-Forget
A retail builder deploys a strategy and walks away. A quant firm:
- Monitors alpha decay continuously.
- Runs automated regression of Sharpe against time.
- Detects structural breaks in market dynamics.
- Auto-retires strategies that have lost their edge.
- The system must do all of this autonomously.

### 7. Execution as a First-Class Research Problem
A retail builder uses market orders. A quant firm:
- Models fill probability, adverse selection, and queue dynamics.
- Separates execution quality from signal quality.
- Continuously A/B tests execution strategies.
- Computes implementation shortfall and decomposes it.
- The system must treat execution research as an independent module with its own metrics and improvement cycle.

### 8. Capital Allocation as Portfolio Optimization
A retail builder allocates equal capital to all strategies. A quant firm:
- Estimates cross-strategy covariance.
- Computes marginal Sharpe contribution.
- Allocates capital to maximize portfolio Sharpe, not individual strategy returns.
- Nets correlated exposures.
- The system must implement portfolio-level optimization.

### 9. Adversarial Thinking About Own Performance
A retail builder trusts their backtest. A quant firm asks:
- Am I overfitting? (Walk-forward validation)
- Is this edge real or data-mined? (Multiple testing correction)
- Would this survive under worse conditions? (Stress testing)
- Am I capturing alpha or beta? (Regime decomposition)
- Is the market structure that creates this edge likely to persist? (Structural analysis)
- The system must implement adversarial checks against its own claimed performance.

### 10. Opportunity Cost Discipline
A retail builder takes every positive-EV trade. A quant firm computes opportunity cost:
- Capital deployed here cannot be deployed elsewhere.
- A 2% edge trade that consumes 10% of capital is worse than a 1.5% edge trade that consumes 2% of capital.
- The portfolio construction layer must enforce opportunity-cost-aware capital deployment.

---

## IMPLEMENTATION ORDER

Build in this exact sequence. Each phase must be testable before moving to the next.

### Phase 1: Foundation (Days 1–3)
1. Project scaffolding (file structure, config, logging, CLI skeleton)
2. Statistics library (t-test, bootstrap CI, rolling Sharpe, regression)
3. Ingestion: CLOB WebSocket connection + REST book polling
4. State: MarketState with book updates, derived metrics, microprice
5. Ledger: Append-only JSONL writer with replay and checksums
6. CLI: `quant report state`, `quant report health`

### Phase 2: Wallet Intelligence (Days 4–6)
1. Ingestion: Wallet transaction listener
2. WalletState: Trade collection and stats computation with significance tests
3. Wallet classifier with confidence scoring
4. Delay profitability analysis with confidence intervals
5. Wallet scorer
6. CLI: `quant report wallets`

### Phase 3: Market Structure (Days 7–9)
1. Market graph builder (semantic clustering, relationship detection)
2. Consistency checker (exhaustive partition, subset/superset)
3. Regime detector
4. Stale-price propagation model
5. Feature extraction engine (all features defined, stored as time series)
6. CLI: `quant report consistency`, `quant report regime`

### Phase 4: Research Factory Core (Days 10–13)
1. Hypothesis registry
2. Walk-forward validation framework
3. Parameter sweep / ablation framework
4. Significance testing pipeline
5. Decay detector
6. Experiment lifecycle (register → test → validate/reject → promote/retire)
7. CLI: `quant report research`, `quant report sensitivity`

### Phase 5: Strategy Engine + Shadow (Days 14–18)
1. Strategy engine framework (signal generation → portfolio → execution routing)
2. Implement Strategy 1 (Latency-Aware Wallet Follow) in shadow mode
3. Implement Strategy 2 (Complement Arbitrage) in shadow mode
4. Implement Strategy 7 (Cross-Market Consistency) in shadow mode
5. Counterfactual engine with full attribution
6. CLI: `quant report counterfactual`, `quant report viability`, `quant report attribution`

### Phase 6: Portfolio Construction (Days 19–22)
1. Covariance estimator (cross-strategy, cross-market)
2. Capital allocator (marginal Sharpe optimization)
3. Exposure netter
4. Portfolio-level drawdown controller
5. Opportunity cost calculator
6. CLI: `quant report portfolio`

### Phase 7: Execution Engine + Research (Days 23–27)
1. Execution engine (order submission, fill tracking, reconciliation)
2. Execution strategy selector (passive vs aggressive logic)
3. Partial fill handler + cancel/repost logic
4. Fill model (queue-aware)
5. Execution quality attribution (separate from signal quality)
6. Risk manager (all hard limits + dynamic sizing)
7. Kill switches
8. Paper trading mode (full pipeline with simulated fills)
9. CLI: `quant report pnl`, `quant report positions`, `quant report execution-quality`

### Phase 8: Advanced Strategies (Days 28–33)
1. Strategy 3: Book Imbalance
2. Strategy 4: Large Trade Reaction
3. Strategy 5: Stale Book Exploitation
4. Strategy 6: Resolution Convergence
5. Strategy 8: Microprice Dislocation
6. All in shadow mode first → promote based on research factory validation

### Phase 9: Production Hardening (Days 34–38)
1. Full integration testing
2. Crash recovery testing (kill process, restart, verify state)
3. Latency optimization (profile and remove bottlenecks)
4. Stress testing (simulated adverse conditions)
5. Security audit (key handling, API exposure)
6. Monitoring alerts
7. Walk-forward validation of ALL strategies
8. Parameter sensitivity analysis of ALL strategies

---

## VALIDATION CRITERIA

The system is NOT complete until ALL of the following are demonstrated:

### Core
- [ ] Full replay: `replay(ledger) → identical state`
- [ ] Cold restart from ledger replay in < 30 seconds
- [ ] All CLI reports produce structured, parseable JSON output

### Research Factory
- [ ] Hypothesis registry contains at least 10 registered hypotheses
- [ ] Walk-forward validation runs and produces per-period OOS results
- [ ] Parameter sweep produces sensitivity surfaces with cliff detection
- [ ] Ablation study identifies critical vs non-critical features for at least one strategy
- [ ] Decay detector produces trend analysis with estimated halflife

### Strategy Validation
- [ ] At least one strategy shows positive EV in paper trading (>30 trades, p < 0.05)
- [ ] Every strategy has walk-forward OOS Sharpe > 0.5
- [ ] Every strategy survives ±20% parameter perturbation
- [ ] Every strategy has regime-conditional performance breakdown

### Portfolio
- [ ] Cross-strategy covariance matrix computed and updated daily
- [ ] Capital allocation reflects marginal Sharpe contribution
- [ ] Exposure netting functional across correlated markets

### Execution
- [ ] Latency breakdown is measurable and logged for every trade
- [ ] Execution quality attribution separates signal alpha from execution alpha
- [ ] Fill model predicts fill probability within 20% accuracy
- [ ] Implementation shortfall computed for every trade

### Market Structure
- [ ] Cross-market consistency checker identifies violations in real-time
- [ ] Semantic market clustering groups related markets correctly
- [ ] Stale-price propagation model has calibrated lag estimates

### Risk
- [ ] Kill switch tested: triggers correctly on simulated drawdown
- [ ] Portfolio-level drawdown control enforces tiered response
- [ ] Max correlated exposure limits enforced

### Statistical Standards
- [ ] No strategy promoted without p < 0.05, n ≥ 30, OOS Sharpe > 0.5
- [ ] All PnL claims accompanied by confidence intervals
- [ ] Multiple testing correction applied when testing > 5 hypotheses

---

## OPERATING PRINCIPLES

1. **Measure before you optimize.** If you can't quantify the edge, it doesn't exist.
2. **Shadow before you trade.** Every strategy runs in paper mode until statistically validated.
3. **Decompose every PnL.** Signal alpha, execution alpha, costs, luck. Know each one.
4. **Distrust observed profits.** Compute t-statistics. Compute significance. Ask: "Would this survive out of sample?"
5. **Kill strategies fast.** If a strategy cannot prove its edge in 30 trades, it probably doesn't have one.
6. **Assume adversarial conditions.** Liquidity will disappear. Prices will move against you. Regimes will change. Alpha will decay. Plan for all of it.
7. **Log everything.** The answer to every future question is in the logs.
8. **Portfolio-level thinking.** Individual strategy PnL matters less than portfolio Sharpe. A mediocre uncorrelated strategy beats a strong correlated one.
9. **Separate signal from execution.** They are different problems with different solutions. Never confuse them.
10. **Continuous research.** The market evolves. Strategies decay. The system must discover new edges faster than old ones disappear.
11. **Parameter humility.** If your strategy only works at parameter X = 0.6342, you don't have a strategy — you have a coincidence.
12. **Opportunity cost discipline.** Every dollar of capital has a next-best use. Deploy it only when the current opportunity exceeds that.

---

## ANTI-PATTERNS TO AVOID

- ❌ Building a web dashboard before the core works
- ❌ Optimizing execution before measuring where edge comes from
- ❌ Adding strategies before the ledger, counterfactual engine, and research factory work
- ❌ Using a database when files suffice
- ❌ Copy-trading without delay analysis and statistical validation
- ❌ Computing PnL without accounting for fees, slippage, and implementation shortfall
- ❌ Running live before paper trading validates the strategy with p < 0.05
- ❌ Hardcoding parameters that should be configurable and sensitivity-tested
- ❌ Ignoring the complement gap (YES + NO ≠ 1.0 is free information)
- ❌ Treating execution as a solved problem — it is an ongoing research problem
- ❌ Allocating equal capital to all strategies — marginal Sharpe contribution determines allocation
- ❌ Testing on a single train/test split — walk-forward is mandatory
- ❌ Promoting a strategy without multiple testing correction when testing many hypotheses
- ❌ Conflating signal quality with execution quality in PnL reports
- ❌ Ignoring regime dependency — a strategy that only works in one regime is fragile
- ❌ Deploying a strategy that is parameter-sensitive near a cliff
- ❌ Trusting backtest results without OOS validation
- ❌ Treating all wallet signals as equal — some wallets have NO edge after our delay
- ❌ Ignoring cross-market consistency — probability axiom violations are structural alpha

---

END OF MASTER PROMPT v2. IMPLEMENT EXACTLY AS SPECIFIED.
