# PROMPT PLAYBOOK — COPY/PASTE INTO CLAUDE CODE

Phase 1 complete. Start from Phase 2.
Use /model to switch between opus-4-6 and sonnet-4-6 as marked.

---
## PHASE 2: INTELLIGENCE LAYER
---

/clear
/model sonnet-4-6

### PROMPT 10 [SONNET]

Review the existing code in src/ — read @src/state/types.ts, @src/ingestion/types.ts, @src/state/world_state.ts, @src/ledger/ledger.ts, @src/main.ts. Then read @SPEC.md Modules 2, 7, and 14, and @MARKET_SELECTION.md. Confirm you understand the existing architecture before we proceed. List any interface changes or additions needed in the existing type files to support the intelligence layer. Do NOT write code yet.

---

/model opus-4-6

### PROMPT 11 [OPUS]

Implement the full market graph and classification system. Replace the stub in src/ingestion/market_graph_builder.ts with full semantic clustering using text_similarity. Build MarketGraph with typed edges (same_event, complementary, correlated, causal, semantic), compute price_correlation per pair, track staleness_propagation_lag_ms per pair (when market A moves, how long until B adjusts). Build MarketCluster objects with consistency_score. Rebuild every 5 minutes and on market creation/resolution. Then implement src/analytics/market_classifier.ts from @MARKET_SELECTION.md — compute ALL market features: avg spread (absolute + bps), spread stability (CV), update frequency, book staleness, trade frequency, avg trade size, depth (1% and 5%), depth concentration (Herfindahl across levels), queue depth at best, complement gap half-life, complement gap frequency, wallet concentration HHI, dominant wallet detection (>20% share), bot ratio estimate, trade arrival rate distribution (Poisson vs bursty). Classify into Type 1 (slow/narrative), Type 2 (event-driven), Type 3 (bot-dominated). Compute market_efficiency_score with the quadratic weighting formula. Reclassify every 60 seconds and on regime change. Build the EdgeMap. Write tests with synthetic markets that should classify into each type.

> git commit -am "Phase 2.1: market graph, clustering, and classification"

---

### PROMPT 12 [OPUS]

Implement src/analytics/consistency_checker.ts — all four consistency check types from @SPEC.md Module 14. (1) Exhaustive partition: markets for each candidate in an event must sum to ~1.0. (2) Subset/superset: P(by_December) >= P(by_June). (3) Conditional: P(win_general) <= P(win_primary). (4) Temporal: same question at different horizons must be monotonic. For each violation: compute raw magnitude, executable magnitude after spreads and fees, whether it's tradeable at current book depth, and a concrete multi-leg trade plan. Emit 'consistency_violation' events with full context. Track violation persistence — how long each violation lasts before correcting. This data is critical for determining whether consistency arb is viable at our latency.

> git commit -am "Phase 2.2: cross-market consistency checker"

---

### PROMPT 13 [OPUS]

Implement the stale-price propagation model as a continuous measurement system. For each pair of related markets in MarketGraph: whenever market A's mid-price moves by more than 1 standard deviation, record A's move timestamp and magnitude. Then monitor when B begins to adjust. Compute propagation_lag = B_adjustment_start - A_move_time. Store the full distribution of propagation lags per pair. Compute: median_lag, p25_lag, p75_lag, exploitability flag (median_lag > estimated_execution_time). Also measure propagation_efficiency — what fraction of A's move eventually appears in B? Store all propagation data as timeseries in data/analysis/propagation/. This runs continuously in the background.

> git commit -am "Phase 2.3: stale-price propagation measurement"

---

### PROMPT 14 [OPUS]

Implement the wallet intelligence data collection layer. src/ingestion/wallet_listener.ts — subscribe to on-chain events for a configurable list of tracked wallet addresses using ethers.js v6 WebSocket provider (NOT REST polling — we need real-time detection). Normalize to WalletTransaction with block_number, gas_price, precise timestamp. Emit 'wallet_trade' events. Reconnection with exponential backoff. Write raw events to data/raw_events/. Then update src/state/world_state.ts to maintain WalletState per tracked wallet — accumulate trades, compute running stats on each new trade: total trades, win rate, holding period distribution, PnL, Sharpe, Sortino, max drawdown, trade size distribution, market concentration, active hours histogram, trade clustering score. The wallet data pipeline must be running and accumulating history from this moment forward.

> git commit -am "Phase 2.4: real-time wallet tracking and stats"

---

### PROMPT 15 [OPUS]

Implement src/wallet_intel/classifier.ts — classify each tracked wallet into sniper/arbitrageur/swing/market_maker/noise using the criteria from @SPEC.md Module 7. Include: holding period distribution analysis, return distribution with bootstrap confidence intervals, timing pattern detection (hour-of-day, day-of-week, event-correlation), market concentration Herfindahl index, trade clustering detection, t-test for performance significance vs random (p < 0.05). Output classification with confidence score. IMPORTANT: also build the delay analysis engine — src/wallet_intel/delay_analysis.ts. For each wallet, for each historical trade: simulate entry at delays [1, 2, 3, 5, 7, 10, 15, 20, 30, 60] seconds. Compute per (wallet, delay): mean PnL with 95% CI, t-statistic, information ratio. Output: the full wallet_delay_curve. This is the single most important analytical output — it tells us exactly which wallets are profitable at our actual latency.

> git commit -am "Phase 2.5: wallet classifier and delay analysis engine"

---

### PROMPT 16 [OPUS]

Implement src/wallet_intel/scorer.ts — WalletScore with weighted components: delayed_profitability at our target latency 0.35, consistency 0.20, statistical_significance 0.15, raw_profitability 0.10, regime_robustness 0.10, sample_size 0.05, recency 0.05. Output: follow/shadow_only/ignore/fade recommendation. For "follow" wallets: compute optimal follow parameters — optimal delay, min trade size to follow, max allocation per follow, allowed market types, expected PnL per follow with 90% CI. Then implement src/wallet_intel/regime_conditional.ts — compute wallet performance per detected regime. Some wallets only have edge in event-driven regimes. Store per-regime WalletStats.

> git commit -am "Phase 2.6: wallet scoring and regime-conditional analysis"

---

### PROMPT 17 [OPUS]

Implement the full regime detector — replace the stub in src/state/regime_detector.ts. Compute features: average spread z-score across all active markets, volume z-score, wallet activity z-score (number of tracked wallets actively trading), market resolution rate (resolutions per hour), new market creation rate. Classify into: normal, high_volatility, low_liquidity, event_driven, resolution_clustering. Build regime transition matrix P(regime_j | regime_i). Track average regime duration. Log all regime changes to the ledger. This must run every 60 seconds and update WorldState.regime.

> git commit -am "Phase 2.7: regime detector"

---

### PROMPT 18 [OPUS]

Implement the feature extraction engine — src/research/feature_engine.ts. This is the training data factory for the entire research pipeline. Define all features from @SPEC.md Module 11: book_imbalance_l1, book_imbalance_l5, microprice_deviation, spread_z_score, volume_z_score_1h, staleness_ms, complement_gap_executable, autocorrelation_1m, large_trade_imbalance_5m, wallet_heat_score (number and quality of tracked wallets active in this market right now), consistency_violation_magnitude, time_to_resolution_hours, volatility_ratio_1h_24h, queue_depth_ratio, trade_arrival_rate_z, book_fragility (depth concentration), spread_regime (tight/normal/wide vs own history), gas_price_z_score. Every 60 seconds, for every active market with volume_24h > $1000, compute all features and write FeatureSnapshot to data/features/ as JSONL. Include placeholders for forward_return_1m, forward_return_5m, forward_return_1h — these get filled in retrospectively. This data accumulates from now onward.

> git commit -am "Phase 2.8: feature extraction engine"

---

/model sonnet-4-6

### PROMPT 19 [SONNET]

Wire everything into main.ts. The system should now run as a pure observation platform: ingestion → state updates → market classification → consistency checking → propagation measurement → wallet tracking → feature extraction → all logged to ledger. No signals, no execution, no strategies. Add CLIs: "quant report markets" (full classification), "quant report markets --edge-only" (EdgeMap), "quant report wallets --sort=delayed_pnl --min-trades=20", "quant report consistency", "quant report regime", "quant report propagation" (top exploitable pairs by lag). Run tsc, run all tests, verify everything runs cleanly.

> git commit -am "Phase 2.9: full intelligence layer wired and running"

---

START THE SYSTEM. Let it run continuously collecting data. Proceed to Phase 3 while data accumulates.

---
## PHASE 3: EDGE DISCOVERY
---

/clear
/model sonnet-4-6

### PROMPT 20 [SONNET]

Review the existing code in src/ — read @src/state/types.ts, @src/analytics/market_classifier.ts, @src/wallet_intel/scorer.ts, @src/analytics/consistency_checker.ts. Then read @SPEC.md Module 11 (Alpha Research Factory) and Module 3 (Strategy Engine). Confirm you understand the existing architecture. Do NOT write code yet.

---

/model opus-4-6

### PROMPT 21 [OPUS]

Implement the research framework core. src/research/types.ts — all interfaces: Hypothesis, HypothesisTestResult, ParameterSweep, ParameterSensitivity, AblationResult, WalkForwardConfig, WalkForwardResult, DecayMonitor. Then src/research/hypothesis_registry.ts — hypotheses as first-class objects with full lifecycle (registered → collecting_data → testing → validated/rejected → promoted/retired). Persist to data/research/hypotheses.json. Pre-register hypotheses:
  H1: "Complement gaps exceeding 2x fees persist long enough to capture at sub-5s latency"
  H2: "Top-quartile swing wallets remain profitable after 3s execution delay"
  H3: "Cross-market probability violations > 3% revert toward consistency within 24h"
  H4: "Stale book prices in markets with propagation lag > 5s can be profitably swept"
  H5: "Order book imbalance at levels 2-5 predicts 1-minute returns with IC > 0.03"
  H6: "Large trades (>2σ) in mid-liquidity markets show mean reversion within 60s"
  H7: "Microprice deviation from mid > 0.5*spread predicts mid-price direction"
  H8: "Wallet trade clustering (dormant wallet suddenly active) predicts direction"
  H9: "Markets approaching resolution with price 0.85-0.95 undervalue the likely outcome"
  H10: "New market listings are mispriced relative to consistency with existing markets"
  H11: "Market maker inventory rebalancing flows are non-informational and mean-revert"
  H12: "Event-driven regime transitions create 5-minute windows of elevated consistency violations"
Log all hypothesis lifecycle events to ledger.

> git commit -am "Phase 3.1: research framework and hypothesis registry"

---

### PROMPT 22 [OPUS]

Implement the strategy engine framework. src/strategy/types.ts — TradeSignal with: ev_estimate, ev_confidence_interval, ev_after_costs, signal_strength, expected_holding_period_ms, correlation_with_existing, regime_assumption, decay_model (half_life_ms + ev_at_t function), kill_conditions. KillCondition types: time_elapsed, price_moved, spread_widened, book_thinned, regime_changed, ev_decayed. Then src/strategy/engine.ts — receives WorldState + EdgeMap from market_classifier, iterates all enabled strategies, each strategy only runs on markets where it passes eligibility (from market_classifier), collects signals, logs signal_generated or signal_filtered to ledger. Full shadow mode support. The engine calls each strategy with the relevant market state and expects back TradeSignal[] or empty array.

> git commit -am "Phase 3.2: strategy engine framework"

---

### PROMPT 23 [OPUS]

Implement Strategy 1 — Latency-Aware Wallet Following (src/strategy/wallet_follow.ts). For each wallet_trade event from a wallet scored as "follow": (1) Look up wallet's delay curve — what is expected PnL at our actual execution latency? (2) Check wallet classification — skip if sniper and our latency > wallet's edge halflife; follow swing traders; fade market makers (reverse signal). Snipers and arbitrageurs ARE followable if their delay curve shows positive edge at our measured latency. (3) Compute: EV_delayed = wallet_historical_edge_at_price - price_impact(our_delay) - spread_cost - fees. (4) Only emit signal if EV_delayed > min_threshold AND t-stat of delayed PnL > 1.5. (5) Check market eligibility from market_classifier. (6) Compute signal decay: halflife from the wallet's delay curve slope. (7) Regime check: only follow if wallet has positive edge in current regime. Track: follow_ev_pre_delay, follow_ev_post_delay, follow_hit_rate, regime_conditional_pnl, signal_decay_accuracy.

> git commit -am "Phase 3.3: wallet-following strategy"

---

### PROMPT 24 [OPUS]

Implement Strategy 2 — Cross-Market Consistency Arbitrage (src/strategy/cross_market_consistency.ts). Uses consistency_checker to find probability axiom violations. For exhaustive partitions where sum > 1.0 + fees: sell the most overpriced leg. For sum < 1.0 - fees: buy the most underpriced leg. For subset/superset violations: trade toward the structural bound. Edge = violation_magnitude × estimated_reversion_speed - total_execution_cost. Include: (1) violation persistence filter — only trade violations that have persisted > N seconds (calibrate from collected data), (2) multi-leg execution plan with worst-case if one leg fails, (3) market eligibility — all legs must have sufficient depth, (4) kill condition if violation narrows below breakeven.

Then implement Strategy 3 — Complement Arbitrage (src/strategy/complement_arb.ts). Monitor complement_gap_executable. When gap < -(2*fee_rate + slippage_buffer): generate two-leg BUY signal. Key additions: (1) gap persistence tracking — only trade if gap has existed for > 2 book updates (filters noise), (2) leg slip probability from historical book volatility — skip if P(second_leg_miss) > 0.05, (3) depth check on both sides, (4) compute exact expected profit including realistic slippage per leg.

> git commit -am "Phase 3.4: consistency arb and complement arb strategies"

---

### PROMPT 25 [OPUS]

Implement Strategy 4 — Stale Book Propagation (src/strategy/stale_book.ts). Uses the propagation model from Phase 2. When market A (the leader) moves significantly AND market B (the laggard) has not yet adjusted AND the propagation lag distribution says median_lag > our execution time: trade B in the expected direction. Edge = correlation × A_move_magnitude × (1 - propagation_efficiency) - execution_costs. Include: (1) confidence filter — only trade if the pair has > 30 observed propagation events, (2) direction confidence — correlation must be > 0.5, (3) staleness confirmation — B's book must actually be stale (staleness_ms > 2x avg update interval), (4) size based on historical edge magnitude at this lag, (5) kill condition: cancel if B's book updates before our fill.

Then implement Strategy 5 — Book Imbalance (src/strategy/book_imbalance.ts). Multi-level imbalance using levels 2-5 (not just top of book — top of book is too easily manipulated). Enter in direction of imbalance when |imbalance_weighted| > threshold. Exit on mean reversion or 5-minute time limit. Market eligibility: volume_24h > $50k, trades/hour > 10, update_interval < 5s, spread < 500bps. Size proportional to imbalance magnitude × available depth.

> git commit -am "Phase 3.5: stale book propagation and book imbalance strategies"

---

### PROMPT 26 [OPUS]

Implement Strategy 6 — Large Trade Reaction (src/strategy/large_trade_reaction.ts). Detect trades > 2σ of market's size distribution. Build a per-market impact/reversion model: for each large trade, measure price at T+5s, T+15s, T+30s, T+60s, T+5m. Classify as momentum (impact persists) or reversion (impact fades). Compute reversion probability conditional on: book state before trade (thin vs deep), time of day, trade direction (buys vs sells), market type. Only trade when the model has > 20 calibration events for that market. If reversion: fade after impact. If momentum: follow immediately.

Then implement Strategy 7 — Microprice Dislocation (src/strategy/microprice_dislocation.ts). When microprice (size-weighted mid) diverges from raw mid by > 0.5 × spread: enter in microprice direction, exit when mid converges or 2-minute timeout. Very short-term. Market eligibility: trade_rate > 10/min, spread < 200bps, update_interval < 2s, market_type != "hft_bot_dominated".

> git commit -am "Phase 3.6: large trade reaction and microprice strategies"

---

### PROMPT 27 [OPUS]

Implement the counterfactual engine. src/counterfactual/shadow_engine.ts — for EVERY signal generated by any strategy: (1) Record ideal_entry_price (price at signal time, zero latency), (2) Simulate realistic entry at price after our expected execution delay, (3) Compute ideal_pnl (zero costs), signal_quality_pnl (zero latency but real costs), actual_pnl (all costs). (4) Decompose: edge_gross, cost_latency, cost_slippage, cost_fees, cost_market_impact, edge_net. (5) Signal vs execution attribution: is this signal right but we can't capture it, or is the signal wrong? (6) Viability at different latencies: {1s: true, 2s: true, 5s: true, 10s: false, ...}. (7) Parameter sensitivity: PnL at ±10% threshold, ±50% size.

src/counterfactual/attribution.ts — aggregate attribution per strategy per time period. Per strategy: avg_ideal_pnl, avg_actual_pnl, signal_alpha, execution_alpha, cost_breakdown_pct.

Add CLIs: "quant report counterfactual --strategy=<id>", "quant report viability", "quant report attribution --period=7d".

> git commit -am "Phase 3.7: counterfactual engine with full attribution"

---

/model sonnet-4-6

### PROMPT 28 [SONNET]

Implement paper trading execution. src/execution/executor.ts — when config.paper_mode is true: simulate fills at best ask/bid + slippage estimate based on actual book depth (sweep the book for our size, use VWAP as fill price). Account for fees. Record full ExecutionRecord to ledger with all timestamps and cost decomposition. src/execution/reconciliation.ts — track open positions, compute unrealized PnL. Wire the full pipeline in main.ts: ingestion → state → market_classifier → strategy_engine → paper_execution → ledger → counterfactual. Register all 7 strategies in shadow mode. Add CLIs: "quant report pnl --period=24h --by=strategy --significance", "quant report positions --show-ev". Run tsc, run all tests, verify pipeline end-to-end.

> git commit -am "Phase 3.8: paper trading pipeline — Phase 3 complete"

---

STOP. Let shadow trading run for 5-7 days collecting data. Run daily:
  $ quant report pnl --period=24h --by=strategy --significance
  $ quant report attribution --period=24h
  $ quant report viability
  $ quant report markets --edge-only
  $ quant report wallets --sort=delayed_pnl --min-trades=20

Do NOT proceed until at least one strategy has: positive paper PnL after costs, t-stat > 1.5, n > 20 shadow trades.

---
## PHASE 4: VALIDATION & EXECUTION
---

/clear
/model sonnet-4-6

### PROMPT 29 [SONNET]

Review existing code in src/ — read @src/strategy/engine.ts, @src/execution/executor.ts, @src/counterfactual/shadow_engine.ts, @src/research/hypothesis_registry.ts. Then read @SPEC.md Module 11 (Research Factory validation sections) and Module 4 (Execution Engine). Confirm you understand the existing architecture. Do NOT write code yet.

---

/model opus-4-6

### PROMPT 30 [OPUS]

Implement the validation pipeline. src/research/walk_forward.ts — walk-forward out-of-sample testing. Rolling windows: 7-day train, 3-day test, 3-day step. For each window: optimize parameters on train, generate signals on test, compute test Sharpe/PnL/hit_rate/n_trades. Return array of WalkForwardResult. Flags: avg OOS degradation > 50% (likely overfit), any single OOS Sharpe < -0.5 (regime-sensitive), fewer than 3 regime periods spanned (insufficient diversity). Must process the FeatureSnapshot timeseries from data/features/ as input.

Then src/research/significance_tests.ts — the 7-point validation gate:
  (1) t-test of mean PnL per trade > 0, p < 0.05 one-tailed
  (2) n >= 30 trades (or n >= 20 with p < 0.01 for rare strategies)
  (3) Cohen's d > 0.2
  (4) Walk-forward OOS Sharpe > 0.5
  (5) Survives ±20% perturbation of all key parameters (no Sharpe cliff)
  (6) Profitable in at least 2 of 3 most common regimes
  (7) Profitable after realistic fees + slippage + actual measured latency
Returns: significant_edge / marginal_edge / no_edge / insufficient_data.
Apply Benjamini-Hochberg correction when testing multiple strategies simultaneously.

> git commit -am "Phase 4.1: walk-forward validation and significance testing"

---

### PROMPT 31 [OPUS]

Implement src/research/parameter_sweep.ts — grid search over parameter values. For each value: run walk-forward, record Sharpe/PnL/n_trades/hit_rate. Identify optimal, compute sensitivity (std of Sharpe across values), detect cliff risk. Then src/research/ablation.ts — remove each feature/condition one at a time, measure Sharpe delta. Flag critical dependencies. Then src/research/decay_detector.ts — track rolling 7-day Sharpe per strategy, regress against time, estimate halflife and zero-crossing. Automatic retirement recommendations: healthy/monitor/reduce/retire. Retirement triggers: rolling 21-day Sharpe < 0.0, or < 0.5 for 3 consecutive periods, or estimated zero-crossing < 14 days. Write tests for each component.

Run the FULL validation pipeline on every candidate strategy from shadow trading data. Produce a validation report. Add CLIs: "quant report research", "quant report sensitivity --strategy=<id>", "quant report decay --strategy=all".

> git commit -am "Phase 4.2: parameter sweep, ablation, decay detection, full validation"

---

### PROMPT 32 [OPUS]

Build the real execution engine. src/execution/executor.ts — upgrade from paper-only to support live execution via Polymarket CLOB API. Order submission with idempotent signal_id nonce. Order type selection logic: (1) Compute signal decay rate from decay_model. (2) Compute expected passive fill time from book state. (3) Compute opportunity cost = decay_rate × passive_fill_time. (4) Compute crossing cost = spread/2 + estimated impact (VWAP sweep of our size vs best price). (5) If opportunity_cost > crossing_cost → immediate cross. If spread < 2% and book stable > 5s → passive limit at mid. If thin liquidity → split into smaller chunks (iceberg). For multi-leg strategies (complement arb, consistency arb): submit both legs near-simultaneously, monitor both, cancel all if any leg fails within 5 seconds.

Implement fill monitoring: poll order status, handle partial fills (if >60% filled keep position, if <60% and signal still valid repost, if signal expired cancel). Cancel/repost logic: every 2s check if order is at best price, cancel if book thinned >50% or spread widened >2x. Position reconciliation after every fill and on startup.

> git commit -am "Phase 4.3: real execution engine"

---

### PROMPT 33 [OPUS]

Implement risk management. src/risk/risk_manager.ts — INITIAL conservative limits: max position per market 5%, max total exposure 40%, max daily loss 2%, max drawdown 5%, max single trade loss 1%, max correlated exposure 15%, max strategy concentration 30%, max single-event exposure 10%. ALSO implement a hard USD cap: max_trade_size_usd configurable, default $25. This cap exists independent of all percentage-based limits.

src/risk/position_sizer.ts — start with fractional Kelly (quarter-Kelly) using the strategy's validated Sharpe and hit rate. Multiply by: confidence_scalar = min(1.0, t_stat/2.0) × min(1.0, n_trades/50), regime_scalar, drawdown_scalar = max(0.25, 1.0 - drawdown/max_drawdown). Final size = min(kelly_size, max_trade_size_usd, percentage_limits).

src/risk/kill_switch.ts — all switches: daily_loss, drawdown, strategy_loss_streak_10, execution_failure_rate_50pct, data_staleness_60s, regime_unknown. CTRL+C and "quant kill" cancel all open orders immediately.

Wire into execution pipeline. Add "quant preflight" command that checks: wallet balance, env vars set, risk limits configured, kill switches armed, connectivity to Polymarket API.

> git commit -am "Phase 4.4: risk management with conservative training wheels"

---

/model sonnet-4-6

### PROMPT 34 [SONNET]

Wire the full live-capable pipeline in main.ts. When paper_mode false: ingestion → state → market_classifier → strategy_engine → execution → ledger → counterfactual. When starting with paper_mode false, show startup banner: wallet address, balance, enabled strategies (list each with its validation status), risk limits, max trade size USD, and require user to type "CONFIRM". Add config/live-conservative.json: paper_mode false, only strategies that passed the 7-point gate enabled, conservative risk limits, max_trade_size_usd: 25. Run tsc, run all tests, verify paper trading still works, verify preflight passes.

> git commit -am "Phase 4.5: live trading pipeline and preflight"

---

### PROMPT 35 [SONNET]

Security check before going live. Verify: (1) private key loaded from env var POLYMARKET_PRIVATE_KEY only, (2) no keys in git history (run git log --all -p | grep -i private), (3) idempotent order submission tested, (4) kill switch tested — simulate a drawdown and verify it triggers, (5) $25 max trade size cap is enforced and cannot be overridden by strategy logic, (6) graceful shutdown cancels all open orders.

> git commit -am "Phase 4.6: security and preflight checks — Phase 4 complete"

---

STOP. Pre-live checklist:
  $ quant report research   (which strategies passed 7-point gate?)
  $ quant preflight          (all checks pass?)
  Wallet funded with $100-200?
  Kill switches tested?
  Max trade size cap enforced?

Do NOT go live unless at least one strategy passed the gate and preflight passes.

---
## PHASE 5: GO LIVE
---

Fund wallet with $100-200. Set POLYMARKET_PRIVATE_KEY in .env.
Run: NODE_ENV=live-conservative npm start
Type CONFIRM at the prompt. Monitor:
  Every 2h first 24h: $ quant report positions
  Every 6h: $ quant report pnl --period=6h --by=strategy
  Daily: $ quant report attribution --period=24h

After 5+ days of live trading, proceed:

---

/clear
/model sonnet-4-6

### PROMPT 36 [SONNET]

Review existing code in src/ — read @src/execution/executor.ts, @src/counterfactual/attribution.ts, @src/risk/risk_manager.ts. Read @SPEC.md Module 13 (Adversarial Execution Research). We now have real execution data. Run "quant report pnl --period=5d --by=strategy --significance" and "quant report attribution --period=5d" and tell me what you see before we write any code.

---

/model opus-4-6

### PROMPT 37 [OPUS]

Implement src/execution/execution_research.ts — the full adversarial execution research layer. ExecutionQualityAttribution: separate signal quality (hit rate, avg EV, Sharpe) from execution quality (implementation shortfall decomposed into timing cost, impact cost, spread cost, adverse selection cost, partial fill cost). Compute: total PnL, PnL from signal alpha, PnL lost to execution, breakdown of execution losses. Estimate PnL under passive-only, aggressive-only, and optimal execution. Then implement src/execution/fill_model.ts — build a fill probability model from real execution data: fill rate by price level, avg time to fill, queue position estimation, trade arrival rate model. Use this to improve the execution strategy selector's passive vs aggressive decision. Add CLI: "quant report execution-quality --period=7d".

> git commit -am "Phase 5.1: execution research from real data"

---

### PROMPT 38 [OPUS]

Based on the execution research findings, optimize the execution path. If the data shows passive execution causes significant adverse selection cost → bias toward aggressive. If crossing the spread costs more than signal decay → bias toward passive. Implement the refined execution_strategy_selector using the calibrated fill model. Then: if any strategy shows positive signal_alpha but negative edge_net due to execution costs → investigate whether execution improvements can flip it positive. Adjust parameters. Re-validate with the research pipeline. Document findings.

> git commit -am "Phase 5.2: execution optimization from real data"

---

STOP. After 7-10 days live:
  $ quant report pnl --period=10d --by=strategy --significance
  $ quant report attribution --period=10d
  $ quant report execution-quality --period=10d
  $ quant report decay --strategy=all

Is aggregate net PnL positive? Which strategies contributing vs dragging?
If positive → proceed to Phase 6.
If signal_alpha positive but edge_net negative → fix execution first.
If signal_alpha negative → redesign strategies with more data.

---
## PHASE 6: SCALE
---

/clear
/model sonnet-4-6

### PROMPT 39 [SONNET]

Review existing code in src/ — read @src/risk/risk_manager.ts, @src/risk/position_sizer.ts, @src/strategy/engine.ts. Read @SPEC.md Module 12 (Portfolio Construction). We have validated live strategies with real PnL. Confirm you understand the current architecture before we build the portfolio layer. Do NOT write code yet.

---

/model opus-4-6

### PROMPT 40 [OPUS]

Implement src/portfolio/covariance_estimator.ts — rolling 14-day return covariance across strategies. Correlation matrix, eigenvalue decomposition, effective_n. Flag redundant strategy pairs (correlation > 0.6). Then src/portfolio/capital_allocator.ts — marginal Sharpe contribution per strategy, proportional allocation with min 5%/max 40%. Then src/portfolio/exposure_netter.ts — net opposing positions, enforce max cluster exposure 25%. Then src/portfolio/portfolio_constructor.ts — sits between strategy engine and execution. Applies covariance check, capital allocation, dynamic sizing, portfolio drawdown tiers (0-3% normal, 3-5% reduce 30%, 5-8% reduce 60%, 8-12% halt, 12-15% close all). Opportunity cost check: only deploy capital if EV_new > EV_alternative + switching_cost. Log PortfolioDecision to ledger. Wire into pipeline. Add CLI: "quant report portfolio".

> git commit -am "Phase 6.1: portfolio construction layer"

---

### PROMPT 41 [OPUS]

Progressively relax risk limits based on accumulated evidence. If 14+ days of positive PnL with p < 0.05: increase max position to 8%, max exposure to 60%, max daily loss to 3%, remove the USD cap (let position sizer determine size using quarter-Kelly). Upgrade position sizer from quarter-Kelly to half-Kelly if strategy Sharpe > 1.0 with n > 50 trades. Implement the exploration vs exploitation budget: exploration_pct = max(5%, min(20%, 1 - portfolio_sharpe/target_sharpe)). Exploration capital runs shadow strategies, exploitation capital runs validated live strategies.

> git commit -am "Phase 6.2: progressive risk limit relaxation"

---

### PROMPT 42 [OPUS]

Implement remaining strategies. src/strategy/cascade_detection.ts — detect information cascades (3+ wallets same direction within 60 seconds without external catalyst). Fade the overshoot after burst subsides. Filter: bot_ratio < 0.7, at least 10 historical cascade events for calibration. src/strategy/new_market_listing.ts — monitor for new market creation, immediately run consistency checks vs related markets, trade mispricings in first 24h. src/strategy/resolution_convergence.ts — markets with price 0.85-0.95 where convergence is slower than model predicts for this category. All in shadow mode initially. Run through the research pipeline. Promote those that pass the 7-point gate.

> git commit -am "Phase 6.3: additional strategies"

---

/model sonnet-4-6

### PROMPT 43 [SONNET]

Implement automatic strategy lifecycle management. Decay detector runs continuously — when a live strategy's rolling 21-day Sharpe drops below 0.3 for 2 consecutive weeks: automatically reduce allocation by 50%. When it drops below 0.0: automatically pause and alert. When a shadow strategy passes the 7-point gate: automatically promote to live with minimum allocation. Capital freed from retired strategies flows to the exploration budget or to top-performing strategies via the capital allocator. Log all lifecycle events to ledger.

> git commit -am "Phase 6.4: automatic strategy lifecycle — Phase 6 complete"

---
## PHASE 7: HARDENING
---

/clear
/model opus-4-6

### PROMPT 44 [OPUS]

Review the entire codebase. Run the full test suite. Identify any module where tests are missing or inadequate. Write additional tests for: (1) every risk limit being enforced correctly, (2) kill switch triggering on simulated drawdown, (3) portfolio-level drawdown tiers, (4) ledger replay producing identical state, (5) cold restart from ledger in < 30 seconds, (6) paper trading end-to-end pipeline. Crash recovery: start → run N events → kill → restart → replay → verify state matches. Network failure: disconnect WebSocket → verify reconnection → verify no duplicate orders → verify graceful degradation. Fix all failures.

> git commit -am "Phase 7.1: comprehensive testing"

---

/model sonnet-4-6

### PROMPT 45 [SONNET]

Security audit: no keys in code/git, secrets from env only, idempotent submissions, safe shutdown. Performance profiling: 1000 events/sec synthetic load test, identify bottlenecks, verify no memory leaks over extended operation. Create README.md with architecture overview, setup instructions, CLI reference, and operational runbook. Run final validation against all criteria in @SPEC.md validation section. Print pass/fail for each item.

> git commit -am "Phase 7.2: security, performance, documentation — PROJECT COMPLETE"