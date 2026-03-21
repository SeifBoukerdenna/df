// ---------------------------------------------------------------------------
// Counterfactual Attribution
//
// Aggregates shadow engine records per strategy per time period.
// Answers: where is the edge going? What fraction is signal vs execution?
// ---------------------------------------------------------------------------

import { mean } from '../utils/statistics.js';
import {
  getRecordsByStrategy,
  getAllRecords,
  type ShadowRecord,
} from './shadow_engine.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StrategyAttribution {
  strategy_id: string;
  period_start: number;
  period_end: number;
  total_signals: number;
  resolved_signals: number;

  // PnL averages
  avg_ideal_pnl: number;
  avg_actual_pnl: number;
  total_ideal_pnl: number;
  total_actual_pnl: number;

  // Alpha decomposition
  signal_alpha: number;               // avg ideal_pnl — is the signal right?
  execution_alpha: number;            // avg (actual_pnl - ideal_pnl) — can we capture it?

  // Cost breakdown as percentage of gross edge
  cost_breakdown_pct: {
    latency_pct: number;
    slippage_pct: number;
    fees_pct: number;
    market_impact_pct: number;
  };

  // Cost breakdown absolute
  cost_breakdown_abs: {
    avg_latency: number;
    avg_slippage: number;
    avg_fees: number;
    avg_market_impact: number;
  };

  // Signal quality
  signal_accuracy: number;            // fraction where signal was correct
  avg_signal_strength: number;

  // Attribution buckets
  attribution_counts: {
    good_signal_good_exec: number;
    good_signal_bad_exec: number;
    bad_signal_good_exec: number;
    bad_signal_bad_exec: number;
  };

  // Parameter sensitivity summary
  robust_signal_pct: number;          // fraction with robust sensitivity
}

export interface AggregateAttribution {
  period_start: number;
  period_end: number;
  strategies: StrategyAttribution[];
  portfolio_signal_alpha: number;
  portfolio_execution_alpha: number;
  portfolio_avg_ideal_pnl: number;
  portfolio_avg_actual_pnl: number;
  total_signals: number;
  total_resolved: number;
}

// ---------------------------------------------------------------------------
// Time period helpers
// ---------------------------------------------------------------------------

const PERIOD_DURATIONS: Record<string, number> = {
  '1d': 86_400_000,
  '7d': 604_800_000,
  '14d': 1_209_600_000,
  '30d': 2_592_000_000,
};

export function parsePeriod(period: string): number {
  const ms = PERIOD_DURATIONS[period];
  if (ms !== undefined) return ms;

  // Try to parse "Nd" format
  const match = period.match(/^(\d+)d$/);
  if (match) return parseInt(match[1]!, 10) * 86_400_000;

  return PERIOD_DURATIONS['7d']!; // default 7 days
}

// ---------------------------------------------------------------------------
// Attribution computation
// ---------------------------------------------------------------------------

function computeStrategyAttribution(
  strategyId: string,
  periodStart: number,
  periodEnd: number,
): StrategyAttribution {
  const allRecords = getRecordsByStrategy(strategyId);
  const inPeriod = allRecords.filter(
    r => r.signal_timestamp >= periodStart && r.signal_timestamp < periodEnd,
  );
  const resolved = inPeriod.filter(r => r.resolved);

  const empty: StrategyAttribution = {
    strategy_id: strategyId,
    period_start: periodStart,
    period_end: periodEnd,
    total_signals: inPeriod.length,
    resolved_signals: 0,
    avg_ideal_pnl: 0,
    avg_actual_pnl: 0,
    total_ideal_pnl: 0,
    total_actual_pnl: 0,
    signal_alpha: 0,
    execution_alpha: 0,
    cost_breakdown_pct: { latency_pct: 0, slippage_pct: 0, fees_pct: 0, market_impact_pct: 0 },
    cost_breakdown_abs: { avg_latency: 0, avg_slippage: 0, avg_fees: 0, avg_market_impact: 0 },
    signal_accuracy: 0,
    avg_signal_strength: 0,
    attribution_counts: {
      good_signal_good_exec: 0,
      good_signal_bad_exec: 0,
      bad_signal_good_exec: 0,
      bad_signal_bad_exec: 0,
    },
    robust_signal_pct: 0,
  };

  if (resolved.length === 0) return empty;

  const avgIdeal = mean(resolved.map(r => r.ideal_pnl));
  const avgActual = mean(resolved.map(r => r.actual_pnl));
  const totalIdeal = resolved.reduce((s, r) => s + r.ideal_pnl, 0);
  const totalActual = resolved.reduce((s, r) => s + r.actual_pnl, 0);

  const avgLatency = mean(resolved.map(r => r.cost_latency));
  const avgSlippage = mean(resolved.map(r => r.cost_slippage));
  const avgFees = mean(resolved.map(r => r.cost_fees));
  const avgImpact = mean(resolved.map(r => r.cost_market_impact));

  const totalCost = avgLatency + avgSlippage + avgFees + avgImpact;
  const costDenom = totalCost > 0 ? totalCost : 1;

  const attrCounts = {
    good_signal_good_exec: 0,
    good_signal_bad_exec: 0,
    bad_signal_good_exec: 0,
    bad_signal_bad_exec: 0,
  };
  for (const r of resolved) {
    attrCounts[r.attribution]++;
  }

  const robustCount = resolved.filter(r => r.sensitivity.robust).length;

  return {
    strategy_id: strategyId,
    period_start: periodStart,
    period_end: periodEnd,
    total_signals: inPeriod.length,
    resolved_signals: resolved.length,
    avg_ideal_pnl: avgIdeal,
    avg_actual_pnl: avgActual,
    total_ideal_pnl: totalIdeal,
    total_actual_pnl: totalActual,
    signal_alpha: avgIdeal,
    execution_alpha: avgActual - avgIdeal,
    cost_breakdown_pct: {
      latency_pct: avgLatency / costDenom,
      slippage_pct: avgSlippage / costDenom,
      fees_pct: avgFees / costDenom,
      market_impact_pct: avgImpact / costDenom,
    },
    cost_breakdown_abs: {
      avg_latency: avgLatency,
      avg_slippage: avgSlippage,
      avg_fees: avgFees,
      avg_market_impact: avgImpact,
    },
    signal_accuracy: resolved.filter(r => r.signal_correct).length / resolved.length,
    avg_signal_strength: mean(resolved.map(r => r.signal_strength)),
    attribution_counts: attrCounts,
    robust_signal_pct: robustCount / resolved.length,
  };
}

/**
 * Generate attribution report for all strategies or a specific one.
 */
export function reportAttribution(
  periodMs: number,
  nowMs: number,
  strategyId?: string,
): AggregateAttribution {
  const periodEnd = nowMs;
  const periodStart = nowMs - periodMs;

  // Discover all strategies that have records
  const allRecords = getAllRecords();
  const strategyIds = strategyId
    ? [strategyId]
    : Array.from(new Set(allRecords.map(r => r.strategy_id)));

  const strategies = strategyIds.map(sid =>
    computeStrategyAttribution(sid, periodStart, periodEnd),
  );

  const allResolved = strategies.flatMap(s => {
    const recs = getRecordsByStrategy(s.strategy_id);
    return recs.filter(r =>
      r.resolved && r.signal_timestamp >= periodStart && r.signal_timestamp < periodEnd,
    );
  });

  return {
    period_start: periodStart,
    period_end: periodEnd,
    strategies,
    portfolio_signal_alpha: allResolved.length > 0
      ? mean(allResolved.map(r => r.ideal_pnl))
      : 0,
    portfolio_execution_alpha: allResolved.length > 0
      ? mean(allResolved.map(r => r.actual_pnl)) - mean(allResolved.map(r => r.ideal_pnl))
      : 0,
    portfolio_avg_ideal_pnl: allResolved.length > 0
      ? mean(allResolved.map(r => r.ideal_pnl))
      : 0,
    portfolio_avg_actual_pnl: allResolved.length > 0
      ? mean(allResolved.map(r => r.actual_pnl))
      : 0,
    total_signals: strategies.reduce((s, st) => s + st.total_signals, 0),
    total_resolved: strategies.reduce((s, st) => s + st.resolved_signals, 0),
  };
}
