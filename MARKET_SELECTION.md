# MARKET SELECTION & EDGE TARGETING

## The Problem Most Trading Systems Ignore

Most Polymarket trading systems treat all markets identically. They run the same strategies, with the same parameters, across every available market. This is fundamentally wrong. A political market that updates once every few minutes and a bot-dominated crypto market that updates multiple times per second are completely different trading environments. Running the same strategy on both is like using a fishing rod and a harpoon interchangeably.

The single most important question the system must answer before generating any signal is: **where do we have a structural advantage right now?** If the answer is "nowhere," the correct action is to do nothing. Capital preservation in the absence of edge is not passivity — it is discipline.

This module sits above strategy generation. It determines which markets are worth trading before any strategy logic fires. Every strategy is conditioned on market classification. No signal is generated for a market that has not been classified as exploitable given our current execution capabilities.

---

## Latency as a Variable, Not a Constraint

The system targets a detection-to-order latency of 1–3 seconds through WebSocket-first ingestion, event-driven state updates, and a tight execution path. This is NOT a fixed constraint — it is a continuously measured and optimized variable.

The actual measured latency determines which strategies are viable in which markets. As latency improves, the set of exploitable markets and strategies expands. The market classification system must use **measured latency**, not assumed latency, in all eligibility calculations.

Key metric: `measured_detection_to_order_p50` — the 50th percentile of actual detection-to-order latency over the last hour. This value is used in all strategy eligibility checks and EV calculations.

---

## Market Feature Extraction

For every active market, the system continuously computes the following features. These are not optional — they are the inputs to market classification and must be updated every 60 seconds or on significant state change.

### Spread Characteristics

**Average spread (absolute and basis points).** The raw cost of crossing the book. A market with a 5-cent spread on a $0.50 token costs 10% round-trip just in spread. Many Polymarket markets have spreads this wide or wider. The system must know the exact cost of participation before considering any trade.

**Spread stability.** A market where the spread oscillates between 1 cent and 8 cents is fundamentally different from one with a stable 3-cent spread. High spread volatility means execution costs are unpredictable. Compute the standard deviation of spread observations over the last hour. Markets with `spread_cv > 0.5` (coefficient of variation) are flagged as unstable.

**Spread regime.** Classify each market's current spread as tight (below 25th percentile of its own history), normal (25th–75th), or wide (above 75th). Strategies that require tight spreads must only fire when the spread regime is tight.

### Book Dynamics

**Update frequency.** How often does the order book change? Measured as `avg_update_interval_ms` — the mean time between book snapshots that differ from the previous snapshot. A market that updates every 500ms is being actively managed by bots. A market that updates every 30 seconds has stale resting orders that may be exploitable.

**Book staleness.** The time elapsed since the last book change. This is distinct from update frequency — a market might normally update every 2 seconds but currently hasn't changed in 45 seconds. Current staleness above 2x the average update interval is a signal worth acting on.

**Order book depth.** Total size available within 1% and 5% of the mid-price, on each side. Thin books (depth < $500 within 1%) cannot absorb meaningful trades without impact. The system must know the maximum trade size that can be executed without moving the market more than X basis points.

**Depth concentration.** Is the available liquidity spread across many price levels, or concentrated at a single level? Concentrated depth is fragile — one cancel wipes out the entire level. Compute `depth_herfindahl` across the top 5 price levels on each side. High concentration (> 0.5) means the book is fragile.

**Queue depth at best.** How much size is resting at the current best bid and ask? This determines how long a passive order would need to wait to fill. Combined with the trade arrival rate, this gives an estimated fill time.

### Trade Activity

**Trade frequency.** Trades per minute over the last hour. Markets with fewer than 1 trade per 5 minutes are too illiquid for most short-term strategies. Markets with more than 10 trades per minute are active enough for microstructure strategies.

**Average trade size.** The typical notional value of a single trade. This indicates participant type — small average sizes suggest retail; large average sizes suggest institutional or bot activity.

**Trade arrival rate distribution.** Is trade flow steady (Poisson-like) or bursty (clustered)? Bursty markets have exploitable event-driven patterns. Compute the coefficient of dispersion of inter-trade arrival times. Values significantly above 1.0 indicate clustering.

### Complement Gap Dynamics

**Complement gap persistence.** When YES_ask + NO_ask deviates from 1.0, how long does the deviation last before being corrected? Measured as `complement_gap_half_life_ms` — the time for a gap to decay to 50% of its initial magnitude. At sub-3s execution latency, gaps that persist for 3+ seconds become capturable. Track the full distribution, not just the median.

**Complement gap frequency.** How often do executable gaps appear? A market might have persistent gaps but they only occur twice a day — not worth monitoring continuously. Compute `gaps_per_hour` where a gap is defined as `|YES_ask + NO_ask - 1.0| > 2 * fee_rate`.

**Complement gap size distribution.** What is the typical magnitude of exploitable gaps? If the median gap is 0.5 cents after fees, the expected profit per trade is negligible even if the strategy is correct.

### Participant Structure

**Wallet concentration.** Compute the Herfindahl-Hirschman Index (HHI) of trading volume by wallet address over the last 7 days. High HHI (> 0.15) means a small number of wallets dominate the market. This has implications for both signal quality (one dominant wallet's trades are more informative) and adverse selection risk (you're likely trading against a sophisticated counterparty).

**Dominant wallet presence.** Does any single wallet account for more than 20% of volume? If so, identify and classify that wallet. Trading in a market dominated by a sophisticated arbitrageur is fundamentally different from trading in a market with dispersed retail flow.

**Bot vs. human ratio.** Estimate the fraction of trades placed by automated systems. Indicators: consistent sub-second response times, round-number sizing, systematic order patterns. High bot ratios indicate the market is being actively maintained — but NOT necessarily that all edge is competed away. At sub-3s latency, many bot-dominated markets still have exploitable patterns (their bots have predictable behavior that can be modeled).

### Latency Sensitivity

**Latency-EV decay curve.** For each market, estimate how much expected value is lost per second of execution delay. This is computed from historical data: for each observable trade by tracked wallets, simulate entry at delays of 1, 2, 3, 5, 10, 15, 30 seconds and compute the expected PnL at each delay. The resulting curve tells us the maximum latency at which the market is still profitable for us.

**Breakeven latency.** The delay at which expected PnL crosses zero. Markets with breakeven latency under our measured `detection_to_order_p50` are untradeable for the relevant strategy. Markets with breakeven latency above 3x our measured latency are comfortable. Markets between 1x and 3x our latency require careful execution optimization.

**Edge halflife.** The delay at which PnL decays to 50% of zero-delay PnL. This determines the urgency classification of signals from this market.

---

## Market Classification

Based on the features above, every market is assigned to one of three types. Classification is not a label — it is a set of constraints that determine which strategies are allowed to operate.

### Type 1: Slow / Narrative-Driven

**Characteristics:**
- `avg_update_interval_ms > 10000` (book changes less than every 10 seconds)
- `book_staleness_ms_avg > 15000`
- `spread_bps_avg > 300` (spreads wider than 3%)
- `trade_rate_per_min < 2`
- `wallet_concentration_hhi < 0.10` (dispersed participation)
- `bot_ratio < 0.3`

**What this means:** These markets are driven by narrative and sentiment, not by fast information. Prices adjust slowly. Stale quotes persist. Retail participants dominate. This is fertile ground across nearly all strategy types.

**Allowed strategies:**
- Wallet-following (all wallet types — even snipers may have persistent edge here)
- Complement arbitrage (gaps persist long enough to execute comfortably)
- Stale book exploitation (high staleness makes this highly viable)
- Cross-market consistency arbitrage (slow price propagation)
- Resolution convergence (slow final price adjustment)
- New market listing (mispricing persists longer)
- Cascade detection (herding behavior more common among retail participants)

**Not allowed:**
- Microprice dislocation (insufficient trade frequency to generate meaningful signals)

### Type 2: Event-Driven / Mid-Speed

**Characteristics:**
- `avg_update_interval_ms` between 2000 and 10000
- `trade_rate_per_min` between 2 and 15
- Trade flow is bursty (high coefficient of dispersion)
- Volume spikes correlated with external events
- `wallet_concentration_hhi` between 0.10 and 0.25

**What this means:** These markets alternate between quiet periods and intense activity around events. Edge exists during transitions — when new information arrives and the market is adjusting. The system must be ready to act during activity bursts and conserve capital during quiet periods.

**Allowed strategies:**
- Wallet-following (conditional on burst detection — wallet signals during quiet periods may be more informative)
- Large trade reaction (activity bursts create impact/reversion patterns)
- Complement arbitrage (during event transitions, gaps widen temporarily)
- Cross-market consistency (event information hits different markets at different speeds)
- Book imbalance (during active periods only)
- Microprice dislocation (during active periods when trade frequency is sufficient)
- Cascade detection (cascades are most common during event-driven flow)
- Stale book exploitation (correlated markets may lag during transitions)

**Not allowed:**
- None categorically excluded — but each strategy must verify market-specific eligibility during quiet periods

### Type 3: HFT / Bot-Dominated

**Characteristics:**
- `avg_update_interval_ms < 2000` (book changes multiple times per second)
- `spread_bps_avg < 100` (tight spreads, already competed down)
- `book_staleness_ms_avg < 3000`
- `wallet_concentration_hhi > 0.25` (few dominant participants)
- `bot_ratio > 0.7`
- `complement_gap_half_life_ms < 3000` (gaps close within seconds)

**What this means:** Fast, sophisticated participants actively manage this market. Spreads are tight. Complement gaps close quickly. However, at sub-3s execution latency, these markets are NOT necessarily off-limits. The key question is not "are bots present?" but "do any strategies have positive expected value after accounting for the competitive dynamics?"

**Conditionally allowed strategies (must pass stricter viability checks):**
- Complement arbitrage — ONLY if gap persistence at the 75th percentile exceeds our execution latency. Even in bot-dominated markets, occasional gaps persist due to bots going offline, upgrades, or competing priorities.
- Wallet-following — ONLY for dominant wallets with edge halflife > 3x our latency. In concentrated markets, following the dominant wallet may actually work because their trades move the market predictably.
- Book imbalance — ONLY if historical backtesting shows IC > 0.03 after costs in this specific market.
- Large trade reaction — ONLY if the impact/reversion model has n > 30 calibration events.

**Not allowed without exceptional evidence:**
- Stale book (books are not stale enough)
- Microprice (competitive dynamics eliminate microprice signals before we can act)
- Cascade detection (bots don't herd — humans do)

**Capital allocation: reduced but not zero.** These markets receive lower efficiency-weighted allocation, but are not blanket-excluded. The system must continuously test whether edge exists and deploy capital where it does, regardless of market type.

---

## Market Efficiency Score

Each market receives a single efficiency score that summarizes how exploitable it is given our current execution capabilities. This score drives capital allocation.

```
market_efficiency_score = weighted_sum(
  0.25 × normalized(1 / spread_bps_avg),           // tighter spread → more efficient
  0.20 × normalized(1 / avg_update_interval_ms),    // faster updates → more efficient
  0.20 × normalized(1 / complement_gap_half_life),   // faster gap closure → more efficient
  0.15 × normalized(wallet_concentration_hhi),        // more concentrated → more efficient
  0.10 × normalized(1 / book_staleness_ms_avg),      // less stale → more efficient
  0.10 × normalized(bot_ratio)                        // more bots → more efficient
)
```

Scale: 0.0 (completely inefficient) to 1.0 (perfectly efficient).

**Interpretation:**
- Score 0.0–0.3: **Highly inefficient.** Prioritize. Maximum capital weight. Multiple strategies viable.
- Score 0.3–0.5: **Moderately inefficient.** Selective strategies. Moderate capital weight.
- Score 0.5–0.7: **Moderately efficient.** High-conviction signals only. Reduced capital weight.
- Score 0.7–1.0: **Highly efficient.** Low capital weight. Only strategies with demonstrated edge in this specific market (validated by walk-forward testing with n > 30).

The efficiency score is NOT a binary filter. It is an input to the capital allocation function. Capital scales inversely with efficiency: more capital flows to less efficient markets because that is where structural advantage is greatest — but capital is not zero for any market where a validated strategy has demonstrated edge.

---

## Strategy Conditioning Rules

Every strategy in the system has a market eligibility function. No signal is generated unless the target market passes the eligibility check. Eligibility checks use `measured_detection_to_order_p50` (our actual measured latency), NOT a hardcoded assumption.

**Wallet-following** requires:
- `breakeven_latency_ms > measured_detection_to_order_p50 * 1.5` (safety margin)
- The specific wallet being followed has positive delayed PnL at our measured latency in this market's type
- Wallet's edge halflife > measured_detection_to_order_p50

**Complement arbitrage** requires:
- `complement_gap_half_life_ms > measured_detection_to_order_p50 * 2` (gap must persist at least 2x our execution time)
- `complement_gap_frequency > 0.5 per hour` (gaps must appear often enough to justify monitoring)
- Both YES and NO books have sufficient depth to execute both legs at our target size
- `expected_leg_slip_probability < 0.05` (low risk of second leg failure)

**Book imbalance** requires:
- `trade_rate_per_min > 5` (enough activity for imbalance to be meaningful)
- `avg_update_interval_ms < 5000` (book must be actively maintained)
- `spread_bps_avg < 500` (spread must be tight enough that the predicted move exceeds crossing cost)

**Stale book exploitation** requires:
- Market has a related market in the MarketGraph that updates faster
- `staleness_propagation_lag_median > measured_detection_to_order_p50` (we can act before the stale market updates)
- Correlation between the pair > 0.5
- At least 30 observed propagation events for calibration

**Microprice dislocation** requires:
- `trade_rate_per_min > 10`
- `spread_bps_avg < 200`
- `avg_update_interval_ms < 2000`
- Historical IC of microprice signal > 0.03 in this market

**Large trade reaction** requires:
- `trade_rate_per_min > 3` (need enough baseline activity to calibrate impact model)
- Historical impact/reversion model calibrated with n > 20 large trades in this specific market

**Cross-market consistency** requires:
- Market belongs to a cluster with 3+ related markets
- `cluster_consistency_violation > fee_cost * 2` (violation must exceed round-trip cost)
- At least 2 legs of the trade have sufficient liquidity

**Cascade detection** requires:
- `bot_ratio < 0.7` (cascades are a human behavioral phenomenon)
- At least 10 observed cascade events in this market's category for calibration
- Historical cascade fade profitability is positive with t-stat > 1.0

**New market listing** requires:
- Market created within the last 24 hours
- At least one related market exists in the MarketGraph for consistency comparison
- Sufficient liquidity to execute (book depth > $200 within 2%)

**Resolution convergence** requires:
- `time_to_resolution < 72 hours`
- Price is in the convergence zone (> 0.85 or < 0.15)
- Convergence speed is slower than the model predicts for this market category

---

## Capital Allocation by Market Efficiency

The portfolio construction layer allocates capital across markets using the efficiency score as a primary input:

```
market_capital_weight(m) = (1 - efficiency_score(m))^2 × liquidity_scalar(m) × edge_evidence_scalar(m)

where:
  liquidity_scalar = min(1.0, available_depth / target_position_size)
  edge_evidence_scalar = max(0.1, min(1.0, validated_strategy_count / 2))
    // markets with more validated strategies get higher weight
    // even markets with 0 validated strategies get 0.1 (exploration budget)

normalized_allocation(m) = market_capital_weight(m) / sum(all market_capital_weights)

max_allocation_per_market = min(normalized_allocation * total_capital, 10% of total_capital)
```

The quadratic weighting `(1 - efficiency)²` creates a strong preference for less efficient markets. The `edge_evidence_scalar` ensures capital flows to markets where strategies have been validated, while maintaining a minimum exploration budget for markets that haven't been tested yet.

---

## Dynamic Reclassification

Markets are not static. A slow, narrative-driven market can become event-driven within minutes when news breaks. A bot-dominated market can become exploitable when a major participant goes offline.

**Reclassification triggers:**

1. **Scheduled:** Every 60 seconds, recompute all features and reclassify all markets.

2. **Regime change:** When the global regime detector identifies a shift (e.g., normal → event_driven), immediately reclassify all markets.

3. **Anomaly detection:** When any single feature deviates by more than 2σ from its rolling mean for a specific market, trigger immediate reclassification. Examples: sudden volume spike in a normally quiet market, spread collapse in a normally wide market, new dominant wallet appearing.

4. **Market lifecycle events:** On new market creation or approaching resolution, immediately classify/reclassify.

5. **Latency change:** When `measured_detection_to_order_p50` changes by more than 20%, recalculate all strategy eligibility thresholds. Improved latency may open new markets; degraded latency may close them.

**Reclassification must be logged.** Every time a market changes classification, record the old type, new type, triggering features, and timestamp. This data feeds back into the research factory to answer: "Do classification changes predict profitable opportunities?"

---

## The Core Question

The system must maintain a real-time answer to:

> **"Where do we have structural advantage right now?"**

This is not a philosophical question. It has a concrete, computable answer:

```typescript
interface EdgeMap {
  timestamp: number;
  measured_latency_p50_ms: number;     // our current actual latency
  markets_with_edge: {
    market_id: string;
    market_type: string;
    efficiency_score: number;
    viable_strategies: string[];
    estimated_edge_per_trade: number;
    estimated_edge_confidence: number;   // t-stat or similar
    capital_allocated: number;
    breakeven_latency_ms: number;        // how much latency headroom we have
  }[];
  markets_without_edge: number;
  total_exploitable_capital: number;
  idle_capital: number;
  recommendation: "trade_actively" | "trade_selectively" | "reduce_exposure" | "do_not_trade";
}
```

**Decision logic:**

- If `markets_with_edge.length > 0` AND at least one has validated strategy (passed significance gate): **trade actively**.
- If `markets_with_edge.length > 0` but all strategies are in shadow mode only: **trade selectively** (shadow only, collect data).
- If `markets_with_edge.length == 0` but regime is transitioning: **reduce exposure** and wait for reclassification.
- If `markets_with_edge.length == 0` and regime is stable: **do not trade.** Park capital. Wait. The worst trade is one placed in a market where you have no edge.

This edge map is published every 60 seconds. It is the single most important output of this module. Every other module — strategy engine, portfolio construction, execution — depends on it.

---

## CLI Report

```bash
$ quant report markets
```
Outputs a JSON report containing: all active markets with full feature vectors, classification (type 1/2/3) with confidence, efficiency score, viable strategies per market, current edge map, reclassification history (last 24 hours), capital allocation by market.

```bash
$ quant report markets --edge-only
```
Outputs only markets where the system currently identifies structural advantage. This is the operational view — what should we be trading right now?

```bash
$ quant report markets --history --market=<market_id>
```
Outputs the classification and efficiency history for a specific market over time.

```bash
$ quant report markets --latency-impact
```
Outputs: for each strategy, how many additional markets become eligible if latency improves by 10%, 25%, 50%. This guides latency optimization priorities — optimize the path that unlocks the most edge.

---

## Why This Module Matters More Than Strategy Design

A brilliant strategy applied to the wrong market produces zero PnL. A simple strategy applied to the right market — one where you have structural advantage, where prices are stale, where gaps persist, where competition is thin — produces consistent profit.

The highest-leverage improvement to any Polymarket trading system is not better strategies. It is better market selection. This module ensures the system never wastes capital competing in markets where it has no edge, while aggressively deploying capital in markets where it does.

The system's competitive advantage is not raw speed — dedicated HFT operations will always be faster on specific markets. The advantage is intelligence about where our speed is sufficient, where structural inefficiencies exist that speed alone cannot capture (consistency violations, wallet behavior, regime transitions), and where capital should flow to maximize risk-adjusted returns across the full opportunity set.