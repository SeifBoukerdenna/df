# COMPLETE PROMPT PLAYBOOK — POLYMARKET QUANT PLATFORM

Every prompt you will give Claude Code, in exact order, from start to finish.
Each prompt is numbered. Run them one at a time. Commit after each group.
Switch to Sonnet for items marked [SONNET]. Use Opus for everything else.

---

## PHASE 1: FOUNDATION (Days 1–3)

You already completed:
> ✅ PROMPT 0: Read @SPEC.md thoroughly. Then create a detailed implementation plan for Phase 1 (Foundation — Days 1-3) only. Include the exact files you'll create, the order you'll create them, and what each file contains. Do NOT write any code yet. Just the plan.

Now execute it:

---

### PROMPT 1 [SONNET]
```
Create package.json with type "module", tsconfig.json with strict mode and ES2022 target, and the three config files (config/default.json, config/paper.json, config/production.json) exactly as described in the Phase 1 plan. Also create all empty data/ directories with .gitkeep files: data/ledger/, data/raw_events/, data/snapshots/, data/research/, data/features/, data/analysis/. Create a .gitignore that ignores node_modules, dist, data/*/*.jsonl, data/*/*.json (but not .gitkeep), .env, and *.sha256.
```

> `git commit -am "Phase 1.1: project scaffolding and config"`

---

### PROMPT 2 [SONNET]
```
Implement src/utils/logger.ts — Pino-based structured JSON logger with child logger factory function. Then src/utils/config.ts — loads and deep-merges config files based on NODE_ENV, validates required fields, reads secrets from env vars only. Then src/utils/time.ts — now(), nowHr(), elapsed(), msToISODate(), dayKey() exactly as planned. Run the TypeScript compiler to verify no errors.
```

> `git commit -am "Phase 1.2: logger, config, time utilities"`

---

### PROMPT 3 [OPUS]
```
Implement src/utils/math.ts with all functions from the plan: clamp, vwap, weightedMid (microprice), bookDepthWithin, imbalance, multiLevelImbalance. Then implement src/utils/statistics.ts with ALL functions: mean, variance, stddev, tTest (one-sample one-tailed), cohensD, bootstrapCI (10k iterations default), rollingWindow, rollingMean, rollingStddev, rollingSharpe, linearRegression (with slope t-stat and p-value), zScore, percentileRank, bonferroniCorrection, benjaminiHochberg. This is the most important utility file in the system — every function must be mathematically correct. After writing, create tests/unit/statistics.test.ts and tests/unit/math.test.ts with the test cases from the plan. Run the tests and fix any failures.
```

> `git commit -am "Phase 1.3: math and statistics libraries with tests"`

---

### PROMPT 4 [SONNET]
```
Implement src/utils/text_similarity.ts with tokenize, tfidf, cosineSimilarity, jaccardSimilarity, and marketSimilarity. Then create all three type definition files: src/ingestion/types.ts, src/state/types.ts, src/ledger/types.ts — containing every interface from @SPEC.md Modules 1, 2, and 5 respectively. Make sure all types are exported and cross-reference correctly. Run tsc to verify no errors.
```

> `git commit -am "Phase 1.4: text similarity, all type definitions"`

---

### PROMPT 5 [OPUS]
```
Implement the ledger system. src/ledger/ledger.ts — Ledger class with append (synchronous appendFileSync), automatic daily rotation, SHA-256 checksum generation per rotated file, monotonic sequence numbers. src/ledger/replay.ts — replay (async iterable line-by-line), verifyChecksum, replayAll (all files in date order), reconstructState. Then create tests/unit/ledger.test.ts testing: valid JSONL output, monotonic seq_num, replay recovery, checksum verification (valid and tampered), daily rotation. Run all tests.
```

> `git commit -am "Phase 1.5: ledger with replay and checksum verification"`

---

### PROMPT 6 [OPUS]
```
Implement state management. First src/state/derived_metrics.ts with all compute functions: computeMicroprice, computeImbalance, computeMultiLevelImbalance, computeLiquidityScore, computeComplementGap, computeComplementGapExecutable, computeRollingAutocorrelation. Then src/state/market_state.ts with createEmptyMarketState, updateBookFromSnapshot (recomputes ALL derived metrics), updateBookFromTrade, computeVolatility. Then src/state/regime_detector.ts as a stub returning "normal". Then src/state/world_state.ts — the WorldState class with updateMarket, updateMarketFromTrade, getMarket, getAllMarkets, serialize, saveToDisk, loadFromDisk. State updates must be synchronous and atomic per-market. Create tests/unit/state.test.ts testing microprice computation, imbalance, complement gap with fees, and serialize/load round-trip. Run all tests.
```

> `git commit -am "Phase 1.6: state management with derived metrics"`

---

### PROMPT 7 [OPUS]
```
Implement ingestion layer. src/ingestion/market_metadata.ts — MarketMetadataFetcher that polls Polymarket REST API, handles pagination, diffs on subsequent fetches, emits market_created and market_resolved events. src/ingestion/book_poller.ts — BookPoller with configurable polling interval, computes all derived book fields (mid, spread, vwap, depth), retry logic with exponential backoff, stale data detection. src/ingestion/clob_websocket.ts — ClobWebSocket with reconnection (exponential backoff 1s-60s), heartbeat monitoring (30s timeout), sequence tracking, deduplication cache, pre-trade book snapshot attachment, raw event persistence to JSONL. src/ingestion/market_graph_builder.ts as a stub returning empty graph. All classes should emit typed events using Node EventEmitter. Create tests/integration/ingestion.test.ts with a mock WebSocket server testing state updates, reconnection, and deduplication.
```

> `git commit -am "Phase 1.7: ingestion layer (websocket, book poller, metadata)"`

---

### PROMPT 8 [SONNET]
```
Implement src/analytics/reports.ts with reportHealth and reportState functions as described in the plan. Then implement src/main.ts — the entry point that wires WorldState, BookPoller, ClobWebSocket, MarketMetadataFetcher, and Ledger together. Event flow: ingestion events → state updates → ledger writes. Include graceful shutdown on SIGINT/SIGTERM. Register Commander.js CLI commands: "quant report health" and "quant report state" with --json and --market flags. Run tsc to verify clean build. Run all tests.
```

> `git commit -am "Phase 1.8: CLI, reports, main entry point — Phase 1 complete"`

---

### PROMPT 9 [SONNET]
```
Run the full test suite. List any failures. Then run tsc with no errors. Then verify the ledger replay round-trip: create a test that writes 100 entries to the ledger, replays them, and asserts every entry matches. Verify the state serialize/load round-trip with a populated WorldState. Fix any issues found.
```

> `git commit -am "Phase 1.9: full validation pass"`

---

## PHASE 2: WALLET INTELLIGENCE (Days 4–6)

### PROMPT 10 [OPUS]
```
/clear
Read @SPEC.md Module 7 (Wallet Intelligence) and the existing code in src/. Create a detailed implementation plan for Phase 2 (Wallet Intelligence) only. Include exact files, creation order, data models, and what each file contains. Do NOT write code yet.
```

---

### PROMPT 11 [SONNET]
```
Implement src/wallet_intel/types.ts with all wallet intelligence interfaces from @SPEC.md Module 7: WalletScore, WalletDelayResult, WalletClassification. Make sure they reference the WalletState and WalletStats types already defined in src/state/types.ts.
```

> `git commit -am "Phase 2.1: wallet intelligence types"`

---

### PROMPT 12 [OPUS]
```
Implement src/ingestion/wallet_listener.ts — listens for on-chain wallet transactions for tracked wallet addresses. Uses ethers.js v6 to subscribe to events. Normalizes transactions into WalletTransaction type. Emits 'wallet_trade' events. Includes reconnection logic and gap detection. Writes raw events to data/raw_events/. Wire it into src/main.ts alongside existing ingestion components.
```

> `git commit -am "Phase 2.2: wallet transaction listener"`

---

### PROMPT 13 [OPUS]
```
Implement src/wallet_intel/classifier.ts — wallet classification pipeline. For each tracked wallet: compute holding period distribution, return distribution with bootstrap CIs, timing patterns (hour-of-day, day-of-week), market concentration (Herfindahl index), trade clustering score. Classify into sniper/arbitrageur/swing/market_maker/noise based on the thresholds in SPEC.md Module 7. Include t-test for statistical significance of wallet performance vs random. Confidence = f(sample_size, consistency, regime_stability). Write tests in tests/unit/wallet_classifier.test.ts with synthetic wallet trade histories that should classify correctly into each type.
```

> `git commit -am "Phase 2.3: wallet classifier with statistical tests"`

---

### PROMPT 14 [OPUS]
```
Implement src/wallet_intel/delay_analysis.ts — for each wallet and each historical trade, simulate entry at delays [5, 10, 15, 20, 30, 60, 120, 300] seconds. Compute mean delayed PnL per (wallet, delay) with 95% CI, t-statistic, optimal delay, and delay sensitivity. Output: wallet_delay_curve mapping wallet+delay to {mean_pnl, ci_low, ci_high, t_stat, n_trades}. Then implement src/wallet_intel/scorer.ts — WalletScore computation with all components: raw_profitability, delayed_profitability (highest weight), consistency, statistical_significance, sample_size, recency, regime_robustness. Output recommendation: follow/shadow_only/ignore/fade with follow_parameters. Write tests for delay analysis using synthetic price series where the correct answer is known.
```

> `git commit -am "Phase 2.4: delay analysis and wallet scoring"`

---

### PROMPT 15 [SONNET]
```
Implement src/wallet_intel/regime_conditional.ts — computes wallet performance broken down by regime. Stores per-regime WalletStats. Updates WalletState.regime_performance map. Then update src/state/wallet_state.ts (or create it) to integrate wallet trades into WalletState, update WalletStats on each new trade, and trigger reclassification when sample size thresholds are crossed. Wire wallet intelligence into main.ts. Add CLI command: "quant report wallets --sort=delayed_pnl --min-trades=30". Run all tests.
```

> `git commit -am "Phase 2.5: regime-conditional wallet analysis, CLI — Phase 2 complete"`

---

## PHASE 3: MARKET STRUCTURE (Days 7–9)

### PROMPT 16 [OPUS]
```
/clear
Read @SPEC.md Module 14 (Deep Market Structure) and @MARKET_SELECTION.md. Review existing code in src/. Create a detailed implementation plan for Phase 3 (Market Structure — market graph, consistency checks, regime detection, stale-price propagation, feature extraction, AND the market classification/edge targeting system from MARKET_SELECTION.md). Do NOT write code yet.
```

---

### PROMPT 17 [OPUS]
```
Replace the stub in src/ingestion/market_graph_builder.ts with the full implementation. Semantic clustering using text_similarity utilities. Build MarketGraph with edges (same_event, complementary, correlated, causal, semantic relationships), compute price_correlation and staleness_propagation_lag_ms per pair. Build MarketCluster objects with consistency_score. Rebuild every 5 minutes or on market creation/resolution. Write tests with synthetic related markets that should cluster together.
```

> `git commit -am "Phase 3.1: market graph builder with semantic clustering"`

---

### PROMPT 18 [OPUS]
```
Implement src/analytics/consistency_checker.ts — all four consistency check types from SPEC Module 14. Exhaustive partition (candidate probabilities sum to 1.0), subset/superset (P(by_Dec) >= P(by_June)), conditional (P(win_general) <= P(win_primary)), temporal monotonicity. For each violation: compute magnitude, executable violation after fees, tradeability flag, and trade plan with legs. Run checks across all market clusters continuously. Emit 'consistency_violation' events. Add CLI: "quant report consistency". Write tests with synthetic market clusters that have known violations.
```

> `git commit -am "Phase 3.2: cross-market consistency checker"`

---

### PROMPT 19 [OPUS]
```
Replace the stub in src/state/regime_detector.ts with the full implementation. Compute regime features: avg_spread_z_score, volume_z_score, wallet_activity_z_score, resolution_rate, new_market_rate. Classify into: normal, high_volatility, low_liquidity, event_driven, resolution_clustering. Track transition matrix and regime duration. Log regime changes to ledger. Run every 60 seconds. Wire into WorldState.regime. Add CLI: "quant report regime".
```

> `git commit -am "Phase 3.3: regime detector"`

---

### PROMPT 20 [OPUS]
```
Implement the stale-price propagation model. For each pair of related markets in the MarketGraph: when market A moves significantly (>1σ), record timestamps for A's move and B's adjustment. Build distribution of propagation_lag per pair. Flag exploitable pairs where median lag > our execution latency. Store propagation_lag_timeseries. This feeds into Strategy 5 (stale book exploitation) in Phase 5.
```

> `git commit -am "Phase 3.4: stale-price propagation model"`

---

### PROMPT 21 [OPUS]
```
Implement the feature extraction engine. src/research/feature_engine.ts — define all FeatureDefinition objects from SPEC Module 11: book_imbalance_l1, book_imbalance_l5, microprice_deviation, spread_z_score, volume_z_score_1h, staleness_ms, complement_gap_executable, autocorrelation_1m, large_trade_imbalance_5m, wallet_heat_score, consistency_violation_magnitude, time_to_resolution_hours, volatility_ratio_1h_24h, queue_depth_ratio, trade_arrival_rate_z. Every 60 seconds, for every active market, compute all features and store as FeatureSnapshot in data/features/ as JSONL. Forward returns (1m, 5m, 1h) filled in retrospectively. This is the training data for the research factory.
```

> `git commit -am "Phase 3.5: feature extraction engine"`

---

### PROMPT 22 [OPUS]
```
Implement the market classification and edge targeting system from @MARKET_SELECTION.md. Create src/analytics/market_classifier.ts — compute all market features (avg spread, spread stability, update frequency, trade frequency, book depth, staleness, complement gap persistence/half-life, wallet concentration HHI, bot ratio estimate, latency-EV decay curve, breakeven latency). Classify each market into Type 1 (slow/narrative), Type 2 (event-driven), Type 3 (HFT/bot-dominated). Compute market_efficiency_score with the weighted formula from the doc. Define strategy eligibility functions per market type. Reclassify every 60 seconds and on regime change. Build the EdgeMap showing where we have structural advantage right now. Add CLI: "quant report markets" and "quant report markets --edge-only". Run all tests.
```

> `git commit -am "Phase 3.6: market classification and edge targeting — Phase 3 complete"`

---

## PHASE 4: RESEARCH FACTORY CORE (Days 10–13)

### PROMPT 23 [OPUS]
```
/clear
Read @SPEC.md Module 11 (Alpha Research Factory). Review existing code in src/research/. Create a detailed implementation plan for Phase 4 (Research Factory — hypothesis registry, walk-forward validation, parameter sweep, ablation, significance testing, decay detection, experiment lifecycle). Do NOT write code yet.
```

---

### PROMPT 24 [OPUS]
```
Implement src/research/types.ts with all research interfaces: Hypothesis, HypothesisTestResult, ParameterSweep, AblationResult, WalkForwardConfig, WalkForwardResult, Experiment, ExperimentResult, DecayMonitor, ParameterSensitivity. Then implement src/research/hypothesis_registry.ts — a registry that stores hypotheses as first-class objects, tracks their lifecycle (registered → collecting_data → testing → validated/rejected → promoted/retired), persists to data/research/hypotheses.json. Pre-register the 10+ hypotheses from the strategies in the SPEC (book imbalance predicts returns, wallet follow has delayed edge, complement gaps are arbitrageable, etc). Log all hypothesis events to the ledger.
```

> `git commit -am "Phase 4.1: hypothesis registry with pre-registered hypotheses"`

---

### PROMPT 25 [OPUS]
```
Implement src/research/walk_forward.ts — walk-forward validation framework. Takes a strategy's signal generator function and historical feature data. Splits into rolling train/test windows (configurable: default 14-day train, 7-day test, 7-day step). For each window: train parameters, generate signals on test set, compute test Sharpe/PnL/hit_rate. Returns array of WalkForwardResult. Flags if avg OOS degradation > 50% (likely overfit) or any single OOS period has Sharpe < -0.5 (regime-sensitive). Must span at least 3 regime periods. Write tests with synthetic data where a known-good strategy passes and a known-overfit strategy fails.
```

> `git commit -am "Phase 4.2: walk-forward validation framework"`

---

### PROMPT 26 [OPUS]
```
Implement src/research/parameter_sweep.ts — grid search over parameter values for a given strategy. For each parameter value: run walk-forward validation, record Sharpe/PnL/n_trades/hit_rate. Identify optimal value, compute sensitivity (std of Sharpe across values), detect cliff risk (Sharpe collapses at adjacent values). Then implement src/research/ablation.ts — remove each feature/condition one at a time, re-run walk-forward, measure Sharpe delta. Flag critical features (removal causes >50% Sharpe drop) and concentration risks. Write tests.
```

> `git commit -am "Phase 4.3: parameter sweep and ablation framework"`

---

### PROMPT 27 [OPUS]
```
Implement src/research/significance_tests.ts — the 7-point validation gate from SPEC Module 11. A strategy must pass ALL of: (1) t-test p < 0.05 one-tailed, (2) n >= 30, (3) Cohen's d > 0.2, (4) OOS Sharpe > 0.5, (5) survives ±20% parameter perturbation, (6) profitable in 2/3 of regimes, (7) profitable after fees+slippage+latency. Returns "significant_edge" / "marginal_edge" / "no_edge" / "negative_edge" / "insufficient_data". Include bonferroni correction when testing multiple hypotheses simultaneously. Then implement src/research/decay_detector.ts — tracks rolling 7-day Sharpe timeseries per strategy, fits linear regression for slope, estimates halflife and zero-crossing, recommends healthy/monitor/reduce_allocation/retire. Include automatic retirement triggers from the SPEC.
```

> `git commit -am "Phase 4.4: significance testing and decay detection"`

---

### PROMPT 28 [SONNET]
```
Implement src/research/regime_analyzer.ts — breaks down strategy performance per detected regime. For each strategy × regime combination, compute Sharpe, hit rate, and n_trades. Flag strategies that only work in one regime. Then wire the full experiment lifecycle together: hypothesis → collect data → test (walk-forward + significance) → validate/reject → promote to strategy / retire. Add CLI commands: "quant report research", "quant report sensitivity --strategy=<id>", "quant report decay --strategy=all". Implement the exploration vs exploitation budget from SPEC. Run all tests.
```

> `git commit -am "Phase 4.5: regime analyzer, experiment lifecycle — Phase 4 complete"`

---

## PHASE 5: STRATEGY ENGINE + SHADOW (Days 14–18)

### PROMPT 29 [OPUS]
```
/clear
Read @SPEC.md Module 3 (Strategy Engine) and Module 6 (Shadow/Counterfactual Engine). Review existing code. Create a detailed implementation plan for Phase 5 — strategy engine framework, three initial strategies in shadow mode, and the counterfactual engine. Do NOT write code yet.
```

---

### PROMPT 30 [OPUS]
```
Implement src/strategy/types.ts with TradeSignal (including ev_confidence_interval, decay_model, regime_assumption, correlation_with_existing), KillCondition, StrategyConfig, StrategyPortfolio. Then implement src/strategy/engine.ts — the strategy engine framework. Receives WorldState, iterates all enabled strategies, collects signals, validates against market eligibility (from market_classifier), deduplicates, attaches decay models, and routes to the portfolio construction layer (or directly to execution in Phase 5, before portfolio layer exists in Phase 6). Supports shadow mode per-strategy. Logs all signals to ledger (signal_generated or signal_filtered).
```

> `git commit -am "Phase 5.1: strategy engine framework"`

---

### PROMPT 31 [OPUS]
```
Implement src/strategy/wallet_follow.ts — Strategy 1: Latency-Aware Wallet Following. Uses WalletScore and delay analysis to decide whether to follow. Checks wallet classification (skip snipers and arbitrageurs, follow swing, fade market makers). Computes EV_delayed = wallet_edge - price_impact(delay) - spread_cost - fees. Only emits signal if EV_delayed > threshold. Regime-conditional (only follows wallets with positive edge in current regime). Signal decay model with wallet-specific halflife computed from historical price impact curves. Adaptive threshold: stops following if wallet's delayed-PnL declining over last 20 trades. Tracks all metrics from the SPEC. Must respect market eligibility from market_classifier.
```

> `git commit -am "Phase 5.2: latency-aware wallet following strategy"`

---

### PROMPT 32 [OPUS]
```
Implement src/strategy/complement_arb.ts — Strategy 2: Complement Arbitrage. Monitors complement_gap_executable across all markets. When gap exceeds fee threshold: generates two-leg signal (buy YES + buy NO). Computes expected_leg_slip_probability per market from historical book volatility. Skips if P(second_leg_slip) > 0.1. Tracks arb_gap_persistence_ms — skips markets where gaps close faster than our execution latency. Logs all metrics: opportunities detected, executed, leg slip rate, realized PnL.
```

> `git commit -am "Phase 5.3: complement arbitrage strategy"`

---

### PROMPT 33 [OPUS]
```
Implement src/strategy/cross_market_consistency.ts — Strategy 7: Cross-Market Consistency Arbitrage. Uses consistency_checker to find probability axiom violations across market clusters. Builds event trees, identifies most mispriced leg. Trades toward consistency. Edge = violation magnitude × (1/time_to_resolution) - costs. Requires cluster with 3+ markets, violation > 2x fee cost, sufficient liquidity on at least 2 legs.
```

> `git commit -am "Phase 5.4: cross-market consistency arbitrage strategy"`

---

### PROMPT 34 [OPUS]
```
Implement src/counterfactual/shadow_engine.ts and src/counterfactual/viability.ts and src/counterfactual/attribution.ts. For every signal generated: simulate ideal execution (0 latency, 0 slippage, 0 fees), simulate realistic execution, simulate pure signal quality (0 latency but real costs). Decompose into: edge_gross, cost_latency, cost_slippage, cost_fees, cost_gas, cost_market_impact, edge_net. Compute signal_alpha vs execution_alpha. Build viability matrix: strategy × latency bucket → profitable? Compute parameter sensitivity: PnL at ±10% threshold and ±50% size. Detect edge trend over time (growing or decaying). Add CLIs: "quant report counterfactual --strategy=<id>", "quant report viability", "quant report attribution --period=7d". Run all tests.
```

> `git commit -am "Phase 5.5: counterfactual engine with attribution — Phase 5 complete"`

---

## PHASE 6: PORTFOLIO CONSTRUCTION (Days 19–22)

### PROMPT 35 [OPUS]
```
/clear
Read @SPEC.md Module 12 (Portfolio Construction Layer). Review existing code. Create a detailed implementation plan for Phase 6. Do NOT write code yet.
```

---

### PROMPT 36 [OPUS]
```
Implement src/portfolio/types.ts with all portfolio interfaces: CovarianceModel, MarketCorrelationGraph, CapitalAllocation, PortfolioDecision, PortfolioSummary, RebalanceAction. Then implement src/portfolio/covariance_estimator.ts — rolling 30-day return covariance between all active strategies, correlation matrix, eigenvalue decomposition for concentration risk, effective_n computation, high correlation pair flagging (>0.7). Also build the cross-market correlation graph with cluster assignments and exposure per cluster.
```

> `git commit -am "Phase 6.1: covariance estimator and correlation graph"`

---

### PROMPT 37 [OPUS]
```
Implement src/portfolio/capital_allocator.ts — computes marginal Sharpe contribution per strategy (portfolio Sharpe with vs without each strategy), ranks by marginal_sharpe × confidence_scalar, allocates proportionally subject to min 5% / max 40% per strategy. Then implement src/portfolio/exposure_netter.ts — before submitting new orders, checks existing positions in same or correlated markets, nets opposing positions, enforces max cluster exposure (25% of capital). Then implement src/portfolio/rebalancer.ts — triggers rebalance when allocation deviates >5% from target, on strategy promotion/retirement, or on regime change.
```

> `git commit -am "Phase 6.2: capital allocation, exposure netting, rebalancer"`

---

### PROMPT 38 [OPUS]
```
Implement src/portfolio/portfolio_constructor.ts — the main portfolio construction layer that sits between strategy engine and execution. Receives all signals, runs covariance check, applies capital allocation, filters signals that don't improve portfolio Sharpe, applies position sizing with all dynamic sizing adjustments (kelly, confidence, regime, correlation penalty, drawdown penalty from SPEC Module 9). Implements portfolio-level drawdown tiers (0-3% normal, 3-5% reduce 30%, 5-8% reduce 60%, 8-12% stop new trades, 12-15% close all). Implements opportunity cost check (only deploy if EV_new > EV_alternative + switching_cost). Logs PortfolioDecision to ledger. Add CLI: "quant report portfolio". Wire into the strategy engine → execution pipeline in main.ts. Run all tests.
```

> `git commit -am "Phase 6.3: portfolio constructor — Phase 6 complete"`

---

## PHASE 7: EXECUTION ENGINE + RESEARCH (Days 23–27)

### PROMPT 39 [OPUS]
```
/clear
Read @SPEC.md Module 4 (Execution Engine) and Module 13 (Adversarial Execution Research). Review existing code. Create a detailed implementation plan for Phase 7. Do NOT write code yet.
```

---

### PROMPT 40 [OPUS]
```
Implement src/execution/types.ts with ExecutionRecord, ExecutionPlan, ExecutionSimulation, FillModel, ExecutionQualityAttribution. Then implement src/execution/fill_model.ts — queue-aware fill modeling per market: fill probability at best/mid, avg time to fill, queue position estimation, trade arrival rate model (Poisson parameter), incoming trade size distribution. Build from historical data, validate predicted vs actual fill rates, update hourly.
```

> `git commit -am "Phase 7.1: execution types and fill model"`

---

### PROMPT 41 [OPUS]
```
Implement src/execution/execution_strategy_selector.ts — decides passive vs aggressive execution. Computes signal decay rate, expected passive fill time, opportunity cost (decay × wait time), crossing cost (spread/2 + impact). If opportunity_cost > crossing_cost → immediate cross. If spread tight and book stable → passive limit at mid. If scheduled urgency → TWAP split. Returns ExecutionPlan with reasoning. Then implement src/execution/partial_fill_handler.ts — on partial fill: check remaining size viability, check if signal EV still positive, check if past halflife, decide repost/cancel/cross. Then implement src/execution/cancel_repost.ts — every 2 seconds: repost if not at best price, cancel if book thinned >50%, cancel if spread widened >2x.
```

> `git commit -am "Phase 7.2: execution strategy selection, partial fills, cancel/repost"`

---

### PROMPT 42 [OPUS]
```
Implement src/execution/executor.ts — the main execution engine. Receives orders from portfolio constructor. Pre-trade analysis (book state, expected fill, cost estimate). Validates (market active, risk limits, dedup by signal_id). Selects execution strategy. Submits order via Polymarket CLOB API. Monitors fill with the partial fill and cancel/repost handlers. Post-trade analysis (actual vs expected). Records ExecutionRecord to ledger. Implements TWAP scheduling for thin liquidity (from SPEC Module 13). Never exceeds risk limits under race conditions (check-then-act with locks). Then implement src/execution/reconciliation.ts — position reconciliation after every fill, startup reconciliation of pending orders.
```

> `git commit -am "Phase 7.3: execution engine with reconciliation"`

---

### PROMPT 43 [OPUS]
```
Implement src/execution/execution_research.ts — the adversarial execution research layer. Computes ExecutionQualityAttribution: separates signal quality (hit rate, avg EV, Sharpe) from execution quality (implementation shortfall, timing cost, impact cost, spread cost). Decomposes PnL into pnl_from_signal_alpha and pnl_lost_to_execution with breakdown (to latency, slippage, fees, partial fills, adverse selection). Estimates PnL if passive-only, aggressive-only, and optimal execution. Book sweep simulation before large orders. Add CLI: "quant report execution-quality --period=7d".
```

> `git commit -am "Phase 7.4: execution research layer"`

---

### PROMPT 44 [OPUS]
```
Implement src/risk/risk_manager.ts — enforces all hard limits from SPEC Module 9 (max position 10%, max exposure 80%, max daily loss 5%, max drawdown 15%, max single trade 2%, max correlated 25%, max strategy concentration 40%, max single-event 20%). Then src/risk/position_sizer.ts — full dynamic sizing: half-Kelly, confidence adjustment, regime adjustment, correlation penalty, drawdown penalty. Then src/risk/kill_switch.ts — all kill switches (daily_loss_5pct, drawdown_15pct, strategy_loss_streak_10, execution_failure_rate_50pct, data_staleness_60s, regime_unknown). CTRL+C / "quant kill" cancels all orders and stops trading. Then src/risk/correlation_monitor.ts and src/risk/drawdown_tracker.ts. Wire everything into the execution pipeline in main.ts. Add CLI: "quant report pnl --period=24h --by=strategy --significance", "quant report positions --show-ev". Run all tests.
```

> `git commit -am "Phase 7.5: risk management, kill switches — Phase 7 complete"`

---

### PROMPT 45 [SONNET]
```
Set up paper trading mode. When config.paper_mode is true, the execution engine simulates fills based on current book state instead of submitting real orders. Simulated fills account for spread, estimated slippage based on book depth, and fees. All other systems (ledger, counterfactual, risk) operate normally. Verify paper trading works end-to-end: ingestion → state → strategy → portfolio → execution (simulated) → ledger. Run full test suite.
```

> `git commit -am "Phase 7.6: paper trading mode"`

---

## PHASE 8: ADVANCED STRATEGIES (Days 28–33)

### PROMPT 46 [OPUS]
```
/clear
Read @SPEC.md Module 3 strategies 3-6 and 8. Review existing strategy framework in src/strategy/. Implement all remaining strategies, each as a separate file. For each: implement entry/exit rules, sizing logic, risk constraints, EV reasoning, market eligibility check, and signal decay model.
```

---

### PROMPT 47 [OPUS]
```
Implement src/strategy/book_imbalance.ts — Strategy 3: Book Imbalance Mean Reversion. Multi-level imbalance (levels 2-5, not just top of book). Enter in direction of imbalance when |imbalance| > threshold. Exit on mean reversion or time limit. Size proportional to imbalance magnitude × liquidity. Only fires in markets with volume_24h > $50k and trades/hour > 10. Uses market eligibility: requires trade_rate > 5/min, update_interval < 5s, spread < 500bps.
```

> `git commit -am "Phase 8.1: book imbalance strategy"`

---

### PROMPT 48 [OPUS]
```
Implement src/strategy/large_trade_reaction.ts — Strategy 4. Detects trades > 2σ of market size distribution. Per-market model: measures price at T+10s, T+30s, T+60s, T+5m. Classifies momentum vs reversion conditional on book state, time of day, trade direction. Requires calibrated impact/reversion model with n > 20 large trades.
```

> `git commit -am "Phase 8.2: large trade reaction strategy"`

---

### PROMPT 49 [OPUS]
```
Implement src/strategy/stale_book.ts — Strategy 5. Uses stale-price propagation model from Phase 3. When a correlated market moves and the target market's book hasn't updated, sweep the stale side. Requires staleness > 30s, correlated market has moved, propagation_lag > our execution latency. Then implement src/strategy/microprice_dislocation.ts — Strategy 8. When |microprice - mid| > 0.5 × spread, enter in microprice direction, exit when mid converges. Very short-term. Only in liquid markets (trade_rate > 10/min, spread < 200bps, update_interval < 2s).
```

> `git commit -am "Phase 8.3: stale book and microprice dislocation strategies"`

---

### PROMPT 50 [SONNET]
```
Register all new strategies in the strategy engine. Ensure all are set to paper_only: true by default. Register hypotheses for each in the hypothesis registry. Run all strategies in shadow mode. Verify signals are being generated, logged to ledger, and processed by the counterfactual engine. Run full test suite. Fix any issues.
```

> `git commit -am "Phase 8.4: all strategies registered in shadow mode — Phase 8 complete"`

---

## PHASE 9: PRODUCTION HARDENING (Days 34–38)

### PROMPT 51 [OPUS]
```
/clear
Review the entire codebase. Run the full test suite. Identify any module where tests are missing or inadequate. Write additional tests for: (1) every risk limit being enforced correctly, (2) kill switch triggering on simulated drawdown, (3) portfolio-level drawdown tiers, (4) ledger replay producing identical state, (5) cold restart from ledger in < 30 seconds, (6) paper trading end-to-end pipeline. Fix any failures.
```

> `git commit -am "Phase 9.1: comprehensive test coverage"`

---

### PROMPT 52 [OPUS]
```
Crash recovery testing. Write a test that: (1) starts the system, (2) runs for N simulated events, (3) kills the process, (4) restarts, (5) replays the ledger, (6) verifies state matches pre-crash state exactly. Then test: network failure simulation — disconnect WebSocket, verify exponential backoff reconnection, verify no duplicate orders submitted, verify strategies that need book data pause while wallet-follow continues. Fix any issues.
```

> `git commit -am "Phase 9.2: crash recovery and fault tolerance tests"`

---

### PROMPT 53 [OPUS]
```
Run walk-forward validation on ALL strategies using collected shadow data (or synthetic data if insufficient real data). For each strategy: verify OOS Sharpe > 0.5, verify parameter robustness at ±20%, compute regime-conditional performance breakdown. Run the full 7-point significance gate. Produce a report. For strategies that fail, document why and mark as needs_more_data or rejected.
```

> `git commit -am "Phase 9.3: strategy validation pass"`

---

### PROMPT 54 [SONNET]
```
Security audit. Verify: (1) no private keys or API keys in source code, config files, or git history, (2) all secrets loaded from env vars only, (3) idempotent order submission via signal_id, (4) no file writes outside data/ directory, (5) graceful shutdown flushes all state. Create .env.example with all required env vars documented. Update README.md with setup instructions, architecture overview, and CLI command reference.
```

> `git commit -am "Phase 9.4: security audit, README, .env.example"`

---

### PROMPT 55 [SONNET]
```
Performance profiling. Run the full pipeline with synthetic high-volume data (1000 events/second). Identify any bottlenecks. Ensure: (1) state updates complete in < 1ms per market, (2) ledger writes don't block the event loop, (3) feature extraction completes within its 60-second cycle, (4) no memory leaks over extended operation. Optimize any bottlenecks found.
```

> `git commit -am "Phase 9.5: performance optimization"`

---

### PROMPT 56 [SONNET]
```
Final validation checklist. Verify every item from the VALIDATION CRITERIA section of @SPEC.md:
- Full replay: replay(ledger) → identical state
- Cold restart from ledger replay < 30 seconds
- All CLI reports produce structured JSON
- Hypothesis registry has 10+ hypotheses
- Walk-forward validation produces per-period OOS results
- Parameter sweep with cliff detection works
- At least one strategy shows positive EV (>30 trades, p < 0.05)
- Cross-strategy covariance matrix computed daily
- Execution quality attribution separates signal from execution alpha
- Cross-market consistency checker identifies violations
- Kill switch triggers on simulated drawdown
- No strategy promoted without p < 0.05, n >= 30, OOS Sharpe > 0.5
Print a pass/fail report for each item.
```

> `git commit -am "Phase 9.6: final validation — PROJECT COMPLETE"`

---

## SESSION MANAGEMENT NOTES

- Run `/clear` at the start of each Phase (marked above)
- Run `/compact` proactively when context hits 40-50% (check with `/context`)
- If Claude makes a mistake twice, `/clear` and rewrite the prompt more precisely — don't correct in circles
- Always reference files with `@src/path/file.ts` syntax
- Commit after every numbered prompt group
- If rate limited: switch to Sonnet for [SONNET] items, wait for reset on Opus items
- If a prompt is too large for one session: split at the "Then implement..." boundaries
- After any `/clear`, start with: "Review the existing code in src/ and the architecture in @CLAUDE.md before proceeding."
