// ---------------------------------------------------------------------------
// Hypothesis Registry — Module 11 (SPEC.md)
//
// Hypotheses are first-class objects with a full lifecycle:
//   registered → collecting_data → testing → validated/rejected → promoted/retired
//
// Persistence: data/research/hypotheses.json (loaded on init, saved on mutation).
// All lifecycle transitions are logged to the Ledger.
//
// Pre-registers 12 hypotheses covering every strategy class in SPEC.md.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { now } from '../utils/time.js';
import { getLogger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import type { Ledger } from '../ledger/ledger.js';
import type {
  Hypothesis,
  HypothesisStatus,
  HypothesisCategory,
  HypothesisTestResult,
} from '../ledger/types.js';
import type { HypothesisSerialised, HypothesisTestResultSerialised } from './types.js';

const log = getLogger('hypothesis_registry');

// ---------------------------------------------------------------------------
// Valid status transitions
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<HypothesisStatus, HypothesisStatus[]> = {
  registered: ['collecting_data', 'rejected'],
  collecting_data: ['testing', 'rejected'],
  testing: ['validated', 'rejected'],
  validated: ['promoted', 'retired'],
  rejected: [],
  promoted: ['retired'],
  retired: [],
};

// ---------------------------------------------------------------------------
// Serialisation helpers (Map ↔ plain object)
// ---------------------------------------------------------------------------

function serialiseTestResult(r: HypothesisTestResult): HypothesisTestResultSerialised {
  const regimeBreakdown: Record<string, { sharpe: number; hit_rate: number; n_trades: number }> = {};
  for (const [k, v] of r.regime_breakdown) {
    regimeBreakdown[k] = v;
  }
  return {
    hypothesis_id: r.hypothesis_id,
    tested_at: r.tested_at,
    in_sample_sharpe: r.in_sample_sharpe,
    out_of_sample_sharpe: r.out_of_sample_sharpe,
    oos_degradation: r.oos_degradation,
    t_statistic: r.t_statistic,
    p_value: r.p_value,
    effect_size: r.effect_size,
    information_coefficient: r.information_coefficient,
    hit_rate: r.hit_rate,
    avg_pnl_per_trade: r.avg_pnl_per_trade,
    avg_pnl_per_trade_after_costs: r.avg_pnl_per_trade_after_costs,
    max_drawdown: r.max_drawdown,
    parameter_sensitivity: r.parameter_sensitivity,
    regime_breakdown: regimeBreakdown,
    walk_forward_results: r.walk_forward_results,
    conclusion: r.conclusion,
  };
}

function deserialiseTestResult(s: HypothesisTestResultSerialised): HypothesisTestResult {
  const regimeBreakdown = new Map<string, { sharpe: number; hit_rate: number; n_trades: number }>();
  for (const [k, v] of Object.entries(s.regime_breakdown)) {
    regimeBreakdown.set(k, v);
  }
  return {
    hypothesis_id: s.hypothesis_id,
    tested_at: s.tested_at,
    in_sample_sharpe: s.in_sample_sharpe,
    out_of_sample_sharpe: s.out_of_sample_sharpe,
    oos_degradation: s.oos_degradation,
    t_statistic: s.t_statistic,
    p_value: s.p_value,
    effect_size: s.effect_size,
    information_coefficient: s.information_coefficient,
    hit_rate: s.hit_rate,
    avg_pnl_per_trade: s.avg_pnl_per_trade,
    avg_pnl_per_trade_after_costs: s.avg_pnl_per_trade_after_costs,
    max_drawdown: s.max_drawdown,
    parameter_sensitivity: s.parameter_sensitivity,
    regime_breakdown: regimeBreakdown,
    walk_forward_results: s.walk_forward_results,
    conclusion: s.conclusion as HypothesisTestResult['conclusion'],
  };
}

function serialiseHypothesis(h: Hypothesis): HypothesisSerialised {
  return {
    id: h.id,
    created_at: h.created_at,
    author: h.author,
    category: h.category,
    statement: h.statement,
    required_features: h.required_features,
    null_hypothesis: h.null_hypothesis,
    test_methodology: h.test_methodology,
    minimum_sample_size: h.minimum_sample_size,
    significance_level: h.significance_level,
    status: h.status,
    results: h.results ? serialiseTestResult(h.results) : null,
    promoted_to_strategy: h.promoted_to_strategy,
    rejected_reason: h.rejected_reason,
  };
}

function deserialiseHypothesis(s: HypothesisSerialised): Hypothesis {
  return {
    id: s.id,
    created_at: s.created_at,
    author: s.author as Hypothesis['author'],
    category: s.category as HypothesisCategory,
    statement: s.statement,
    required_features: s.required_features,
    null_hypothesis: s.null_hypothesis,
    test_methodology: s.test_methodology,
    minimum_sample_size: s.minimum_sample_size,
    significance_level: s.significance_level,
    status: s.status as HypothesisStatus,
    results: s.results ? deserialiseTestResult(s.results) : null,
    promoted_to_strategy: s.promoted_to_strategy,
    rejected_reason: s.rejected_reason,
  };
}

// ---------------------------------------------------------------------------
// Pre-registered hypotheses (H1–H12)
// ---------------------------------------------------------------------------

function makePreregistered(): Hypothesis[] {
  const t = now();
  const sig = config.research.significance_level;
  const minN = config.research.min_sample_size;

  return [
    {
      id: 'H1',
      created_at: t,
      author: 'system',
      category: 'structural',
      statement:
        'Complement gaps exceeding 2x fees persist long enough to capture at sub-5s latency',
      required_features: [
        'complement_gap_executable',
        'complement_gap_half_life_ms',
        'spread_avg_bps',
      ],
      null_hypothesis:
        'Complement gaps exceeding 2x fees close before a 5s-delayed order can fill',
      test_methodology:
        'Measure gap persistence distribution. For each gap > 2*fee_rate, record time-to-close. '
        + 'Simulate fill at T+3s with realistic slippage. t-test on delayed PnL, walk-forward 14/7d.',
      minimum_sample_size: minN,
      significance_level: sig,
      status: 'registered',
      results: null,
      promoted_to_strategy: null,
      rejected_reason: null,
    },
    {
      id: 'H2',
      created_at: t,
      author: 'system',
      category: 'wallet_signal',
      statement:
        'Top-quartile swing wallets remain profitable after 3s execution delay',
      required_features: [
        'wallet_delayed_pnl_3s',
        'wallet_sharpe',
        'wallet_classification',
      ],
      null_hypothesis:
        'Swing wallet edge at 3s delay is indistinguishable from zero',
      test_methodology:
        'Select wallets classified as swing with overall_score in top 25%. '
        + 'Use delay_analysis at 3s bucket. t-test mean delayed PnL > 0, bootstrap 90% CI. '
        + 'Walk-forward with 14/7d windows across regimes.',
      minimum_sample_size: minN,
      significance_level: sig,
      status: 'registered',
      results: null,
      promoted_to_strategy: null,
      rejected_reason: null,
    },
    {
      id: 'H3',
      created_at: t,
      author: 'system',
      category: 'cross_market',
      statement:
        'Cross-market probability violations > 3% revert toward consistency within 24h',
      required_features: [
        'consistency_violation_magnitude',
        'consistency_violation_duration_ms',
        'consistency_executable_violation',
      ],
      null_hypothesis:
        'Consistency violations > 3% do not revert faster than random price drift',
      test_methodology:
        'Track all ConsistencyCheck violations with magnitude > 0.03. '
        + 'Measure reversion rate and time-to-reversion from ViolationPersistence records. '
        + 'Compare reversion PnL (buy underpriced leg) vs null using t-test. Walk-forward 14/7d.',
      minimum_sample_size: minN,
      significance_level: sig,
      status: 'registered',
      results: null,
      promoted_to_strategy: null,
      rejected_reason: null,
    },
    {
      id: 'H4',
      created_at: t,
      author: 'system',
      category: 'microstructure',
      statement:
        'Stale book prices in markets with propagation lag > 5s can be profitably swept',
      required_features: [
        'staleness_ms',
        'propagation_lag_ms',
        'correlated_market_price_delta',
      ],
      null_hypothesis:
        'Stale book sweeps at markets with propagation lag > 5s produce zero or negative PnL',
      test_methodology:
        'When propagation_model reports lag > 5000ms for a pair (A,B) and A moves > 1σ: '
        + 'simulate sweeping B\'s stale side at T+measured_latency. '
        + 'Compute fill price vs subsequent fair value. t-test on net PnL, walk-forward 14/7d.',
      minimum_sample_size: minN,
      significance_level: sig,
      status: 'registered',
      results: null,
      promoted_to_strategy: null,
      rejected_reason: null,
    },
    {
      id: 'H5',
      created_at: t,
      author: 'system',
      category: 'microstructure',
      statement:
        'Order book imbalance at levels 2-5 predicts 1-minute returns with IC > 0.03',
      required_features: [
        'book_imbalance_l2_l5',
        'forward_return_1m',
        'volume_z_score_1h',
      ],
      null_hypothesis:
        'Information coefficient of L2-L5 imbalance for 1-minute returns is ≤ 0.03',
      test_methodology:
        'Compute multi-level imbalance (levels 2-5) from FeatureSnapshots. '
        + 'Rank-correlate with forward_return_1m. Filter: volume_24h > $50k, '
        + 'trade_rate > 10/hr. IC test via Fisher z-transform. Walk-forward 14/7d.',
      minimum_sample_size: minN,
      significance_level: sig,
      status: 'registered',
      results: null,
      promoted_to_strategy: null,
      rejected_reason: null,
    },
    {
      id: 'H6',
      created_at: t,
      author: 'system',
      category: 'microstructure',
      statement:
        'Large trades (>2σ) in mid-liquidity markets show mean reversion within 60s',
      required_features: [
        'large_trade_imbalance_5m',
        'forward_return_1m',
        'trade_size_z_score',
        'liquidity_score',
      ],
      null_hypothesis:
        'Price movement after >2σ trades in mid-liquidity markets is indistinguishable from drift',
      test_methodology:
        'Detect trades > 2σ of per-market size distribution in markets with '
        + 'liquidity_score 0.3–0.7. Measure price at T+10s, T+30s, T+60s. '
        + 'Test reversion (sign reversal) rate vs 50% null. Walk-forward 14/7d.',
      minimum_sample_size: minN,
      significance_level: sig,
      status: 'registered',
      results: null,
      promoted_to_strategy: null,
      rejected_reason: null,
    },
    {
      id: 'H7',
      created_at: t,
      author: 'system',
      category: 'microstructure',
      statement:
        'Microprice deviation from mid > 0.5*spread predicts mid-price direction',
      required_features: [
        'microprice_deviation',
        'spread_avg_bps',
        'forward_return_1m',
      ],
      null_hypothesis:
        'Microprice-mid deviation has zero predictive power for subsequent mid-price movement',
      test_methodology:
        'From FeatureSnapshots, select observations where |microprice - mid| > 0.5 * spread. '
        + 'Record sign of deviation vs sign of forward_return_1m. '
        + 'Binomial test on hit rate > 0.5. Walk-forward 14/7d.',
      minimum_sample_size: minN,
      significance_level: sig,
      status: 'registered',
      results: null,
      promoted_to_strategy: null,
      rejected_reason: null,
    },
    {
      id: 'H8',
      created_at: t,
      author: 'system',
      category: 'wallet_signal',
      statement:
        'Wallet trade clustering (dormant wallet suddenly active) predicts direction',
      required_features: [
        'wallet_heat_score',
        'wallet_dormancy_days',
        'forward_return_1h',
      ],
      null_hypothesis:
        'Trades by recently-dormant wallets have no directional predictive power',
      test_methodology:
        'Identify wallets dormant > 7 days that place a trade. '
        + 'Measure forward_return_1h in the direction of their trade. '
        + 't-test on mean directional return > 0. Walk-forward 14/7d.',
      minimum_sample_size: minN,
      significance_level: sig,
      status: 'registered',
      results: null,
      promoted_to_strategy: null,
      rejected_reason: null,
    },
    {
      id: 'H9',
      created_at: t,
      author: 'system',
      category: 'structural',
      statement:
        'Markets approaching resolution with price 0.85-0.95 undervalue the likely outcome',
      required_features: [
        'time_to_resolution_hours',
        'last_trade_price_yes',
        'forward_return_to_resolution',
      ],
      null_hypothesis:
        'Buying at 0.85-0.95 in pre-resolution markets yields zero excess return vs price',
      test_methodology:
        'Select markets where YES mid is 0.85-0.95 and time_to_resolution < 48h. '
        + 'Track resolution outcome. Compute return = (resolution_payout - entry_price). '
        + 't-test on mean return > 0, bootstrap 90% CI. Walk-forward rolling.',
      minimum_sample_size: minN,
      significance_level: sig,
      status: 'registered',
      results: null,
      promoted_to_strategy: null,
      rejected_reason: null,
    },
    {
      id: 'H10',
      created_at: t,
      author: 'system',
      category: 'structural',
      statement:
        'New market listings are mispriced relative to consistency with existing markets',
      required_features: [
        'time_since_listing_hours',
        'consistency_violation_magnitude',
        'consistency_executable_violation',
      ],
      null_hypothesis:
        'Consistency violations in newly listed markets (<24h) are equal in magnitude to mature markets',
      test_methodology:
        'Compare consistency violation magnitudes for markets listed < 24h vs > 7d. '
        + 'Two-sample t-test on violation size. If new markets have larger violations, '
        + 'simulate trading toward consistency and measure PnL. Walk-forward 14/7d.',
      minimum_sample_size: minN,
      significance_level: sig,
      status: 'registered',
      results: null,
      promoted_to_strategy: null,
      rejected_reason: null,
    },
    {
      id: 'H11',
      created_at: t,
      author: 'system',
      category: 'behavioral',
      statement:
        'Market maker inventory rebalancing flows are non-informational and mean-revert',
      required_features: [
        'wallet_classification',
        'mm_rebalance_detected',
        'forward_return_5m',
      ],
      null_hypothesis:
        'Price impact from market-maker-classified wallet trades does not revert within 5 minutes',
      test_methodology:
        'Identify trades by wallets classified as market_maker with high confidence. '
        + 'Measure price at trade time and T+5m. Test whether fading the MM direction '
        + 'yields positive return. t-test, walk-forward 14/7d.',
      minimum_sample_size: minN,
      significance_level: sig,
      status: 'registered',
      results: null,
      promoted_to_strategy: null,
      rejected_reason: null,
    },
    {
      id: 'H12',
      created_at: t,
      author: 'system',
      category: 'timing',
      statement:
        'Event-driven regime transitions create 5-minute windows of elevated consistency violations',
      required_features: [
        'regime_name',
        'regime_transition_age_ms',
        'consistency_violation_count',
        'consistency_violation_magnitude',
      ],
      null_hypothesis:
        'Consistency violation frequency in the 5 minutes after a regime transition '
        + 'is equal to the baseline rate',
      test_methodology:
        'Detect regime transitions to event_driven. Count consistency violations in [0,5m] '
        + 'window after transition vs baseline 1-hour rate. Poisson rate test. '
        + 'If elevated, simulate trading the violations and measure PnL. Walk-forward.',
      minimum_sample_size: minN,
      significance_level: sig,
      status: 'registered',
      results: null,
      promoted_to_strategy: null,
      rejected_reason: null,
    },
  ];
}

// ---------------------------------------------------------------------------
// HypothesisRegistry
// ---------------------------------------------------------------------------

export class HypothesisRegistry {
  private readonly hypotheses: Map<string, Hypothesis> = new Map();
  private readonly filePath: string;
  private readonly ledger: Ledger;

  constructor(ledger: Ledger) {
    this.ledger = ledger;
    this.filePath = join(config.research.dir, 'hypotheses.json');
    this.load();
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  private load(): void {
    if (!existsSync(this.filePath)) {
      log.info('No hypotheses file found — will initialise on first save');
      return;
    }

    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const arr = JSON.parse(raw) as HypothesisSerialised[];

      for (const s of arr) {
        this.hypotheses.set(s.id, deserialiseHypothesis(s));
      }

      log.info({ count: this.hypotheses.size }, 'Loaded hypotheses from disk');
    } catch (err) {
      log.error({ err }, 'Failed to load hypotheses — starting empty');
    }
  }

  private save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const arr: HypothesisSerialised[] = [];
    for (const h of this.hypotheses.values()) {
      arr.push(serialiseHypothesis(h));
    }

    writeFileSync(this.filePath, JSON.stringify(arr, null, 2) + '\n', 'utf-8');
    log.debug({ count: arr.length, path: this.filePath }, 'Saved hypotheses to disk');
  }

  // -----------------------------------------------------------------------
  // Initialisation — pre-register hypotheses that don't already exist
  // -----------------------------------------------------------------------

  /**
   * Seeds the registry with pre-registered hypotheses. Existing hypotheses
   * (loaded from disk) are never overwritten — only new IDs are inserted.
   * Each new hypothesis is logged to the ledger as `hypothesis_registered`.
   */
  initialise(): void {
    const preregistered = makePreregistered();
    let added = 0;

    for (const h of preregistered) {
      if (this.hypotheses.has(h.id)) continue;

      this.hypotheses.set(h.id, h);
      this.ledger.append({ type: 'hypothesis_registered', data: h });
      added++;
    }

    if (added > 0) {
      log.info({ added, total: this.hypotheses.size }, 'Pre-registered hypotheses');
      this.save();
    } else {
      log.info({ total: this.hypotheses.size }, 'All pre-registered hypotheses already present');
    }
  }

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  /**
   * Registers a new hypothesis (manual or system-generated).
   * Throws if a hypothesis with the same ID already exists.
   */
  register(hypothesis: Hypothesis): void {
    if (this.hypotheses.has(hypothesis.id)) {
      throw new Error(`Hypothesis ${hypothesis.id} already exists`);
    }

    if (hypothesis.status !== 'registered') {
      throw new Error(`New hypothesis must have status 'registered', got '${hypothesis.status}'`);
    }

    this.hypotheses.set(hypothesis.id, hypothesis);
    this.ledger.append({ type: 'hypothesis_registered', data: hypothesis });
    this.save();

    log.info(
      { id: hypothesis.id, category: hypothesis.category },
      `Registered hypothesis: ${hypothesis.statement.slice(0, 80)}`,
    );
  }

  // -----------------------------------------------------------------------
  // Status transitions
  // -----------------------------------------------------------------------

  /**
   * Transitions a hypothesis to a new status.
   * Validates the transition against the allowed state machine.
   * Logs every transition to the ledger as a system_event.
   */
  transition(id: string, toStatus: HypothesisStatus, reason: string): void {
    const h = this.hypotheses.get(id);
    if (!h) {
      throw new Error(`Hypothesis ${id} not found`);
    }

    const fromStatus = h.status;
    const allowed = VALID_TRANSITIONS[fromStatus];

    if (!allowed.includes(toStatus)) {
      throw new Error(
        `Invalid transition for ${id}: ${fromStatus} → ${toStatus}. `
        + `Allowed: ${allowed.join(', ') || 'none (terminal state)'}`,
      );
    }

    h.status = toStatus;

    this.ledger.append({
      type: 'system_event',
      data: {
        event: 'hypothesis_status_change',
        details: {
          hypothesis_id: id,
          from_status: fromStatus,
          to_status: toStatus,
          reason,
          timestamp: now(),
        },
      },
    });

    this.save();

    log.info(
      { id, from: fromStatus, to: toStatus, reason },
      'Hypothesis status transition',
    );
  }

  /**
   * Marks a hypothesis as collecting data. Convenience wrapper.
   */
  startCollecting(id: string): void {
    this.transition(id, 'collecting_data', 'Data collection pipeline activated');
  }

  /**
   * Marks a hypothesis as under test. Convenience wrapper.
   */
  startTesting(id: string): void {
    this.transition(id, 'testing', 'Sufficient data collected, entering test phase');
  }

  /**
   * Records test results and marks hypothesis as validated or rejected.
   * The 7-point significance gate from SPEC Module 11 determines the outcome.
   */
  recordResults(id: string, results: HypothesisTestResult): void {
    const h = this.hypotheses.get(id);
    if (!h) {
      throw new Error(`Hypothesis ${id} not found`);
    }

    if (h.status !== 'testing') {
      throw new Error(`Cannot record results for ${id} in status '${h.status}' (must be 'testing')`);
    }

    h.results = results;

    // 7-point significance gate (SPEC Module 11)
    const gates = [
      results.p_value < h.significance_level,                                // 1. t-test p < α
      results.walk_forward_results.length > 0                                // 2. n ≥ minimum
        && results.walk_forward_results.reduce((s, w) => s + w.test_trades, 0) >= h.minimum_sample_size,
      results.effect_size > 0.2,                                             // 3. Cohen's d > 0.2
      results.out_of_sample_sharpe >= config.research.min_oos_sharpe,        // 4. OOS Sharpe ≥ 0.5
      !results.parameter_sensitivity.cliff_risk                              // 5. No cliff risk
        && results.parameter_sensitivity.sensitivity < config.research.parameter_perturbation_pct,
      this.regimeRobust(results),                                            // 6. ≥ 2/3 regimes profitable
      results.avg_pnl_per_trade_after_costs > 0,                             // 7. Positive after costs
    ];

    const passed = gates.filter(Boolean).length;
    const isValidated = passed >= 7;
    const isMarginal = passed >= 5;

    if (isValidated) {
      h.status = 'validated';
      log.info({ id, passed, gates }, 'Hypothesis VALIDATED — passes all 7 gates');
    } else if (isMarginal) {
      // Marginal: validated but flagged — enters shadow trading
      h.status = 'validated';
      log.warn({ id, passed, gates }, 'Hypothesis marginally validated (5-6/7 gates)');
    } else {
      h.status = 'rejected';
      h.rejected_reason = `Failed significance gate: ${passed}/7 passed. `
        + `Conclusion: ${results.conclusion}`;
      log.info({ id, passed, gates }, 'Hypothesis REJECTED');
    }

    // Log to ledger
    this.ledger.append({
      type: 'experiment_result',
      data: {
        experiment_id: `${id}_test_${results.tested_at}`,
        hypothesis_id: id,
        completed_at: results.tested_at,
        conclusion: results.conclusion,
        promoted: false,
      },
    });

    this.ledger.append({
      type: 'system_event',
      data: {
        event: 'hypothesis_test_completed',
        details: {
          hypothesis_id: id,
          conclusion: results.conclusion,
          gates_passed: passed,
          status: h.status,
          timestamp: now(),
        },
      },
    });

    this.save();
  }

  /**
   * Promotes a validated hypothesis to a live strategy.
   */
  promote(id: string, strategyId: string): void {
    const h = this.hypotheses.get(id);
    if (!h) {
      throw new Error(`Hypothesis ${id} not found`);
    }

    if (h.status !== 'validated') {
      throw new Error(`Cannot promote ${id} from status '${h.status}' (must be 'validated')`);
    }

    h.promoted_to_strategy = strategyId;
    this.transition(id, 'promoted', `Promoted to strategy ${strategyId}`);

    this.ledger.append({
      type: 'strategy_promoted',
      data: {
        strategy_id: strategyId,
        experiment_id: `${id}_test_${h.results?.tested_at ?? 0}`,
      },
    });
  }

  /**
   * Retires a promoted or validated hypothesis.
   */
  retire(id: string, reason: string): void {
    const h = this.hypotheses.get(id);
    if (!h) {
      throw new Error(`Hypothesis ${id} not found`);
    }

    // Log strategy retirement if it was promoted
    if (h.status === 'promoted' && h.promoted_to_strategy) {
      this.ledger.append({
        type: 'strategy_retired',
        data: {
          strategy_id: h.promoted_to_strategy,
          reason,
        },
      });
    }

    this.transition(id, 'retired', reason);
  }

  /**
   * Rejects a hypothesis at any non-terminal stage.
   */
  reject(id: string, reason: string): void {
    const h = this.hypotheses.get(id);
    if (!h) {
      throw new Error(`Hypothesis ${id} not found`);
    }

    h.rejected_reason = reason;
    this.transition(id, 'rejected', reason);
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  get(id: string): Hypothesis | undefined {
    return this.hypotheses.get(id);
  }

  getAll(): Hypothesis[] {
    return [...this.hypotheses.values()];
  }

  getByStatus(status: HypothesisStatus): Hypothesis[] {
    return [...this.hypotheses.values()].filter((h) => h.status === status);
  }

  getByCategory(category: HypothesisCategory): Hypothesis[] {
    return [...this.hypotheses.values()].filter((h) => h.category === category);
  }

  count(): number {
    return this.hypotheses.size;
  }

  /** Returns a summary suitable for CLI report output. */
  summary(): {
    total: number;
    by_status: Record<HypothesisStatus, number>;
    by_category: Record<HypothesisCategory, number>;
  } {
    const byStatus: Record<string, number> = {
      registered: 0,
      collecting_data: 0,
      testing: 0,
      validated: 0,
      rejected: 0,
      promoted: 0,
      retired: 0,
    };
    const byCategory: Record<string, number> = {
      microstructure: 0,
      wallet_signal: 0,
      cross_market: 0,
      timing: 0,
      behavioral: 0,
      structural: 0,
    };

    for (const h of this.hypotheses.values()) {
      byStatus[h.status] = (byStatus[h.status] ?? 0) + 1;
      byCategory[h.category] = (byCategory[h.category] ?? 0) + 1;
    }

    return {
      total: this.hypotheses.size,
      by_status: byStatus as Record<HypothesisStatus, number>,
      by_category: byCategory as Record<HypothesisCategory, number>,
    };
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Regime robustness check: profitable in at least 2/3 of observed regimes.
   */
  private regimeRobust(results: HypothesisTestResult): boolean {
    const regimes = [...results.regime_breakdown.values()];
    if (regimes.length < 2) return false;

    const profitable = regimes.filter((r) => r.sharpe > 0 && r.n_trades >= 5).length;
    return profitable / regimes.length >= 2 / 3;
  }
}
