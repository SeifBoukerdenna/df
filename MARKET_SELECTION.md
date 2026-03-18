# MARKET SELECTION & EDGE TARGETING

## The Problem Most Trading Systems Ignore

Most Polymarket trading systems treat all markets identically. They run the same strategies, with the same parameters, across every available market. This is fundamentally wrong. A political market that updates once every few minutes and a bot-dominated crypto market that updates multiple times per second are completely different trading environments. Running the same strategy on both is like using a fishing rod and a harpoon interchangeably.

The single most important question the system must answer before generating any signal is: **where do we have a structural advantage right now?** If the answer is "nowhere," the correct action is to do nothing. Capital preservation in the absence of edge is not passivity — it is discipline.

This module sits above strategy generation. It determines which markets are worth trading before any strategy logic fires. Every strategy is conditioned on market classification. No signal is generated for a market that has not been classified as exploitable at our latency and cost structure.

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

**Complement gap persistence.** When YES_ask + NO_ask deviates from 1.0, how long does the deviation last before being corrected? Measured as `complement_gap_half_life_ms` — the time for a gap to decay to 50% of its initial magnitude. Markets where gaps persist for 30+ seconds are arbitrageable at our latency. Markets where gaps close in under 3 seconds are dominated by faster participants.

**Complement gap frequency.** How often do executable gaps appear? A market might have persistent gaps but they only occur twice a day — not worth monitoring continuously. Compute `gaps_per_hour` where a gap is defined as `|YES_ask + NO_ask - 1.0| > 2 * fee_rate`.

**Complement gap size distribution.** What is the typical magnitude of exploitable gaps? If the median gap is 0.5 cents after fees, the expected profit per trade is negligible even if the strategy is correct.

### Participant Structure

**Wallet concentration.** Compute the Herfindahl-Hirschman Index (HHI) of trading volume by wallet address over the last 7 days. High HHI (> 0.15) means a small number of wallets dominate the market. This has implications for both signal quality (one dominant wallet's trades are more informative) and adverse selection risk (you're likely trading against a sophisticated counterparty).

**Dominant wallet presence.** Does any single wallet account for more than 20% of volume? If so, identify and classify that wallet. Trading in a market dominated by a sophisticated arbitrageur is fundamentally different from trading in a market with dispersed retail flow.

**Bot vs. human ratio.** Estimate the fraction of trades placed by automated systems. Indicators: consistent sub-second response times, round-number sizing, systematic order patterns. High bot ratios (> 70%) suggest the market is already being efficiently arbitraged. Low bot ratios suggest inefficiencies may persist longer.

### Latency Sensitivity

**Latency-EV decay curve.** For each market, estimate how much expected value is lost per second of execution delay. This is computed from historical data: for each observable trade by tracked wallets, simulate entry at delays of 5, 10, 15, 20, 30, 60 seconds and compute the expected PnL at each delay. The resulting curve tells us the maximum latency at which the market is still profitable for us.

**Breakeven latency.** The delay at which expected PnL crosses zero. Markets with breakeven latency under 5 seconds are untradeable for us. Markets with breakeven latency above 30 seconds are ideal.

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

**What this means:** These markets are driven by narrative and sentiment, not by fast information. Prices adjust slowly. Stale quotes persist. Retail participants dominate. This is the most fertile ground for a system operating at 10–30 second latency.

**Allowed strategies:**
- Wallet-following (swing wallets with long holding periods)
- Complement arbitrage (gaps persist long enough to execute)
- Stale book exploitation (high staleness makes this viable)
- Cross-market consistency arbitrage (slow price propagation)
- Resolution convergence (slow final price adjustment)

**Not allowed:**
- Microprice dislocation (insufficient trade frequency)
- Book imbalance (insufficient updates to detect meaningful shifts)

### Type 2: Event-Driven / Mid-Speed

**Characteristics:**
- `avg_update_interval_ms` between 2000 and 10000
- `trade_rate_per_min` between 2 and 15
- Trade flow is bursty (high coefficient of dispersion)
- Volume spikes correlated with external events
- `wallet_concentration_hhi` between 0.10 and 0.25

**What this means:** These markets alternate between quiet periods and intense activity around events. Edge exists during transitions — when new information arrives and the market is adjusting. The system must be ready to act during activity bursts and conserve capital during quiet periods.

**Allowed strategies:**
- Wallet-following (conditional on burst detection)
- Large trade reaction (activity bursts create impact/reversion)
- Complement arbitrage (during event transitions, gaps widen temporarily)
- Cross-market consistency (event information hits different markets at different speeds)
- Book imbalance (during active periods only)

**Not allowed:**
- Stale book exploitation (book updates too frequently during active periods)
- Microprice dislocation (only viable during active periods, and those periods are also when competition is fiercest)

### Type 3: HFT / Bot-Dominated

**Characteristics:**
- `avg_update_interval_ms < 2000` (book changes multiple times per second)
- `spread_bps_avg < 100` (tight spreads, already competed down)
- `book_staleness_ms_avg < 3000`
- `wallet_concentration_hhi > 0.25` (few dominant participants)
- `bot_ratio > 0.7`
- `complement_gap_half_life_ms < 5000` (gaps close almost instantly)

**What this means:** Fast, sophisticated participants have already competed away most of the edge. Spreads are tight because market makers are actively managing their quotes. Complement gaps close within seconds. Any strategy that depends on speed will lose to the incumbents. Any strategy that depends on stale prices will find no stale prices.

**Allowed strategies:**
- None at our latency, UNLESS:
  - The system identifies a specific structural inefficiency that persists despite bot activity (rare, log if found)
  - A regime shift temporarily disrupts the bot ecosystem (e.g., smart contract upgrade, API outage)

**Capital allocation: zero under normal conditions.** These markets are traps for slower participants. The system must recognize them and stay away.

---

## Market Efficiency Score

Each market receives a single efficiency score that summarizes how exploitable it is at our operational latency. This score drives capital allocation.

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
- Score 0.0–0.3: **Highly inefficient.** Prioritize. Allocate maximum capital. Multiple strategies viable.
- Score 0.3–0.5: **Moderately inefficient.** Selective strategies only. Moderate capital.
- Score 0.5–0.7: **Moderately efficient.** Only high-conviction signals. Limited capital.
- Score 0.7–1.0: **Highly efficient.** Avoid. Zero allocation unless structural exception identified.

The efficiency score is NOT a binary filter. It is an input to the capital allocation function. Capital scales inversely with efficiency: more capital flows to less efficient markets because that is where our structural advantage is greatest.

---

## Strategy Conditioning Rules

Every strategy in the system has a market eligibility function. No signal is generated unless the target market passes the eligibility check.

**Wallet-following** requires:
- `breakeven_latency_ms > 20000` (our latency must be below the strategy's breakeven)
- `market_type != "hft_bot_dominated"`
- The specific wallet being followed has positive delayed PnL in this market's type

**Complement arbitrage** requires:
- `complement_gap_half_life_ms > execution_latency_ms * 2` (gap must persist at least 2x our execution time)
- `complement_gap_frequency > 0.5 per hour` (gaps must appear often enough to justify monitoring)
- Both YES and NO books have sufficient depth to execute both legs

**Book imbalance** requires:
- `trade_rate_per_min > 5` (enough activity for imbalance to be meaningful)
- `avg_update_interval_ms < 5000` (book must be actively maintained)
- `spread_bps_avg < 500` (spread must be tight enough that the predicted move exceeds crossing cost)

**Stale book exploitation** requires:
- `book_staleness_ms_avg > 15000` (books must actually go stale)
- A correlated market exists that updates faster (propagation lag is exploitable)
- `staleness_propagation_lag > execution_latency_ms`

**Microprice dislocation** requires:
- `trade_rate_per_min > 10`
- `spread_bps_avg < 200`
- `avg_update_interval_ms < 2000`
- `market_type == "event_driven"` during active periods only

**Large trade reaction** requires:
- `trade_rate_per_min > 3` (need enough baseline activity to calibrate impact model)
- Historical impact/reversion model calibrated with n > 20 large trades

**Cross-market consistency** requires:
- Market belongs to a cluster with 3+ related markets
- `cluster_consistency_violation > fee_cost * 2` (violation must exceed round-trip cost)
- At least 2 legs of the trade have sufficient liquidity

---

## Capital Allocation by Market Efficiency

The portfolio construction layer allocates capital across markets using the efficiency score as a primary input:

```
market_capital_weight(m) = (1 - efficiency_score(m))^2 × liquidity_scalar(m)

where liquidity_scalar = min(1.0, available_depth / target_position_size)

normalized_allocation(m) = market_capital_weight(m) / sum(all market_capital_weights)

max_allocation_per_market = min(normalized_allocation * total_capital, 10% of total_capital)
```

The squaring of `(1 - efficiency_score)` is deliberate. It creates a strong preference for the least efficient markets. A market with efficiency 0.2 gets 16x the allocation weight of a market with efficiency 0.8.

The liquidity scalar prevents allocating capital to markets where we cannot actually deploy it. A deeply inefficient market with $200 of book depth is not useful regardless of its efficiency score.

---

## Dynamic Reclassification

Markets are not static. A slow, narrative-driven market can become event-driven within minutes when news breaks. A bot-dominated market can become exploitable when a major participant goes offline.

**Reclassification triggers:**

1. **Scheduled:** Every 60 seconds, recompute all features and reclassify all markets.

2. **Regime change:** When the global regime detector identifies a shift (e.g., normal → event_driven), immediately reclassify all markets.

3. **Anomaly detection:** When any single feature deviates by more than 2σ from its rolling mean for a specific market, trigger immediate reclassification of that market. Examples:
   - Sudden volume spike in a normally quiet market
   - Spread collapse in a normally wide market
   - New dominant wallet appearing in a market

4. **Market lifecycle events:** On new market creation or approaching resolution, immediately classify/reclassify.

**Reclassification must be logged.** Every time a market changes classification, record the old type, new type, triggering features, and timestamp. This data feeds back into the research factory to answer: "Do classification changes predict profitable opportunities?"

---

## The Core Question

The system must maintain a real-time answer to:

> **"Where do we have structural advantage right now?"**

This is not a philosophical question. It has a concrete, computable answer:

```typescript
interface EdgeMap {
  timestamp: number;
  markets_with_edge: {
    market_id: string;
    market_type: string;
    efficiency_score: number;
    viable_strategies: string[];
    estimated_edge_per_trade: number;
    capital_allocated: number;
    confidence: number;
  }[];
  markets_without_edge: number;       // count of markets classified as unexploitable
  total_exploitable_capital: number;
  idle_capital: number;               // capital with no viable deployment
  recommendation: "trade_actively" | "trade_selectively" | "reduce_exposure" | "do_not_trade";
}
```

**Decision logic:**

- If `markets_with_edge.length > 0` AND at least one has `confidence > 0.7`: **trade actively**.
- If `markets_with_edge.length > 0` but all have `confidence < 0.7`: **trade selectively** with reduced sizing.
- If `markets_with_edge.length == 0` but regime is transitioning: **reduce exposure** and wait for reclassification.
- If `markets_with_edge.length == 0` and regime is stable: **do not trade.** Park capital. Wait. The worst trade is one placed in a market where you have no edge.

This edge map is published every 60 seconds. It is the single most important output of this module. Every other module in the system — strategy engine, portfolio construction, execution — depends on it.

---

## CLI Report

```bash
$ quant report markets
```

Outputs a JSON report containing:
- All active markets with full feature vectors
- Classification (type 1/2/3) with confidence
- Efficiency score
- Viable strategies per market
- Current edge map
- Reclassification history (last 24 hours)
- Capital allocation by market

```bash
$ quant report markets --edge-only
```

Outputs only markets where the system currently identifies structural advantage. This is the operational view — what should we be trading right now?

```bash
$ quant report markets --history --market=<market_id>
```

Outputs the classification and efficiency history for a specific market over time. Useful for understanding how a market's exploitability changes around events.

---

## Why This Module Matters More Than Strategy Design

A brilliant strategy applied to the wrong market produces zero PnL. A simple strategy applied to the right market — one where you have structural latency advantage, where prices are stale, where gaps persist, where competition is thin — produces consistent profit.

The highest-leverage improvement to any Polymarket trading system is not better strategies. It is better market selection. This module ensures the system never wastes capital competing in markets where faster or better-funded participants have already eliminated the edge.

The system's competitive advantage is not speed. It is intelligence about where speed matters and where it doesn't.
