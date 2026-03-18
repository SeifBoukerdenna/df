import { describe, it, expect } from 'vitest';
import {
  mean,
  variance,
  stddev,
  tTest,
  cohensD,
  bootstrapCI,
  rollingWindow,
  rollingMean,
  rollingStddev,
  rollingSharpe,
  linearRegression,
  zScore,
  percentileRank,
  bonferroniCorrection,
  benjaminiHochberg,
} from '../../src/utils/statistics.js';

// ---------------------------------------------------------------------------
// Basic descriptives
// ---------------------------------------------------------------------------

describe('mean', () => {
  it('computes arithmetic mean', () => {
    expect(mean([1, 2, 3, 4, 5])).toBeCloseTo(3, 10);
  });

  it('returns NaN for empty array', () => {
    expect(mean([])).toBeNaN();
  });

  it('handles single element', () => {
    expect(mean([42])).toBe(42);
  });

  it('handles negative values', () => {
    expect(mean([-2, 0, 2])).toBeCloseTo(0, 10);
  });
});

describe('variance', () => {
  it('computes sample variance (ddof=1)', () => {
    // [2, 4, 4, 4, 5, 5, 7, 9] → mean=5, sample var=4.571...
    const data = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(variance(data)).toBeCloseTo(4.571428571, 5);
  });

  it('computes population variance (ddof=0)', () => {
    const data = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(variance(data, 0)).toBeCloseTo(4.0, 5);
  });

  it('returns NaN for single element with ddof=1', () => {
    expect(variance([5])).toBeNaN();
  });

  it('returns 0 for constant array (ddof=0)', () => {
    expect(variance([3, 3, 3], 0)).toBe(0);
  });
});

describe('stddev', () => {
  it('is square root of variance', () => {
    const data = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(stddev(data)).toBeCloseTo(Math.sqrt(4.571428571), 5);
  });
});

// ---------------------------------------------------------------------------
// t-Test
// ---------------------------------------------------------------------------

describe('tTest', () => {
  it('detects significantly positive mean', () => {
    // 10 values with clear positive mean
    const data = [1.2, 1.5, 0.8, 1.1, 1.3, 0.9, 1.4, 1.0, 1.6, 1.2];
    const result = tTest(data);

    // Mean ≈ 1.2, testing H0: mean=0, should have large positive t
    expect(result.t).toBeGreaterThan(5);
    expect(result.p).toBeLessThan(0.001);
    expect(result.n).toBe(10);
    expect(result.df).toBe(9);
  });

  it('returns high p-value for data centered around mu', () => {
    const data = [-0.1, 0.1, -0.05, 0.05, -0.02, 0.02, 0.0, -0.03, 0.04, -0.01];
    const result = tTest(data, 0);
    expect(result.p).toBeGreaterThan(0.2);
  });

  it('computes correct t-statistic for known example', () => {
    // 5 samples: [4, 5, 6, 7, 8] → mean=6, std=√2.5≈1.5811, se=√(2.5/5)≈0.7071
    // t = (6-0)/0.7071 ≈ 8.485
    const data = [4, 5, 6, 7, 8];
    const result = tTest(data, 0);
    expect(result.t).toBeCloseTo(8.485, 2);
  });

  it('handles all-identical values equal to mu', () => {
    const result = tTest([5, 5, 5, 5, 5], 5);
    expect(result.t).toBe(0);
  });

  it('returns NaN for single element', () => {
    const result = tTest([5]);
    expect(result.t).toBeNaN();
  });

  it('tests against non-zero mu', () => {
    const data = [10.1, 10.3, 9.9, 10.0, 10.2];
    const result = tTest(data, 10);
    expect(result.t).toBeGreaterThan(0);
    // Mean is exactly 10.1, close to mu=10 with some variance
    // t should be moderate, p should not be extremely small
    expect(result.p).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// Cohen's d
// ---------------------------------------------------------------------------

describe('cohensD', () => {
  it('computes correct effect size', () => {
    // [4, 5, 6, 7, 8] mean=6, stddev(sample)=√2.5≈1.5811
    // d = (6-0)/1.5811 ≈ 3.795
    const data = [4, 5, 6, 7, 8];
    expect(cohensD(data, 0)).toBeCloseTo(6 / Math.sqrt(2.5), 5);
  });

  it('returns 0 for all-identical values', () => {
    expect(cohensD([5, 5, 5])).toBe(0);
  });

  it('can detect small effect', () => {
    // mean ≈ 0.2, sd ≈ 1 → d ≈ 0.2
    const data = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 0.7 : -0.3));
    // mean = 0.2, values alternate 0.7/-0.3
    const d = cohensD(data, 0);
    expect(d).toBeCloseTo(0.2 / stddev(data), 5);
  });
});

// ---------------------------------------------------------------------------
// Bootstrap CI
// ---------------------------------------------------------------------------

describe('bootstrapCI', () => {
  it('produces CI that contains the sample mean', () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const [lo, hi] = bootstrapCI(data, 0.05, 10_000);
    const m = mean(data);
    expect(lo).toBeLessThanOrEqual(m);
    expect(hi).toBeGreaterThanOrEqual(m);
  });

  it('produces narrower CI with more data', () => {
    const small = [1, 2, 3, 4, 5];
    const large = Array.from({ length: 100 }, (_, i) => (i % 5) + 1);
    const [loS, hiS] = bootstrapCI(small, 0.05, 10_000);
    const [loL, hiL] = bootstrapCI(large, 0.05, 10_000);
    expect(hiS - loS).toBeGreaterThan(hiL - loL);
  });

  it('returns single value for single element', () => {
    const [lo, hi] = bootstrapCI([42]);
    expect(lo).toBe(42);
    expect(hi).toBe(42);
  });

  it('returns NaN for empty array', () => {
    const [lo, hi] = bootstrapCI([]);
    expect(lo).toBeNaN();
    expect(hi).toBeNaN();
  });

  it('95% CI is wider than 90% CI', () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const [lo95, hi95] = bootstrapCI(data, 0.05, 10_000);
    const [lo90, hi90] = bootstrapCI(data, 0.10, 10_000);
    expect(hi95 - lo95).toBeGreaterThanOrEqual(hi90 - lo90 - 0.01); // small epsilon for randomness
  });
});

// ---------------------------------------------------------------------------
// Rolling functions
// ---------------------------------------------------------------------------

describe('rollingWindow', () => {
  it('returns correct number of windows', () => {
    expect(rollingWindow([1, 2, 3, 4, 5], 3)).toHaveLength(3);
  });

  it('returns correct window contents', () => {
    expect(rollingWindow([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
  });

  it('returns empty for window larger than array', () => {
    expect(rollingWindow([1, 2], 5)).toEqual([]);
  });

  it('returns empty for window size 0', () => {
    expect(rollingWindow([1, 2, 3], 0)).toEqual([]);
  });
});

describe('rollingMean', () => {
  it('computes correct rolling means', () => {
    const result = rollingMean([1, 2, 3, 4, 5], 3);
    expect(result).toHaveLength(3);
    expect(result[0]).toBeCloseTo(2, 10);
    expect(result[1]).toBeCloseTo(3, 10);
    expect(result[2]).toBeCloseTo(4, 10);
  });

  it('returns single value when window equals array length', () => {
    const result = rollingMean([2, 4, 6], 3);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeCloseTo(4, 10);
  });

  it('returns empty for window larger than array', () => {
    expect(rollingMean([1, 2], 5)).toEqual([]);
  });
});

describe('rollingStddev', () => {
  it('computes rolling standard deviations', () => {
    const data = [1, 2, 3, 4, 5];
    const result = rollingStddev(data, 3);
    expect(result).toHaveLength(3);
    // stddev([1,2,3]) = 1.0
    expect(result[0]).toBeCloseTo(1.0, 10);
    expect(result[1]).toBeCloseTo(1.0, 10);
    expect(result[2]).toBeCloseTo(1.0, 10);
  });

  it('returns empty for window < 2', () => {
    expect(rollingStddev([1, 2, 3], 1)).toEqual([]);
  });
});

describe('rollingSharpe', () => {
  it('computes rolling Sharpe ratios', () => {
    // Constant positive returns → infinite Sharpe (stddev=0)
    const constantReturns = [0.01, 0.01, 0.01, 0.01, 0.01];
    const result = rollingSharpe(constantReturns, 3, 252);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(Infinity);
  });

  it('gives higher Sharpe for higher mean-to-vol ratio', () => {
    // Low vol, positive mean
    const goodReturns = [0.02, 0.03, 0.02, 0.03, 0.02, 0.03];
    // High vol, same mean
    const badReturns = [0.10, -0.05, 0.08, -0.03, 0.10, -0.05];
    const goodSharpe = rollingSharpe(goodReturns, 4, 252);
    const badSharpe = rollingSharpe(badReturns, 4, 252);
    expect(goodSharpe[0]!).toBeGreaterThan(badSharpe[0]!);
  });

  it('returns empty for window < 2', () => {
    expect(rollingSharpe([0.01, 0.02], 1)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Linear regression
// ---------------------------------------------------------------------------

describe('linearRegression', () => {
  it('fits a perfect line', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10]; // y = 2x
    const result = linearRegression(x, y);
    expect(result.slope).toBeCloseTo(2.0, 10);
    expect(result.intercept).toBeCloseTo(0.0, 10);
    expect(result.rSquared).toBeCloseTo(1.0, 10);
  });

  it('computes significant t-stat for clear linear trend', () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const y = x.map((v) => v * 0.5 + 1); // y = 0.5x + 1
    const result = linearRegression(x, y);
    expect(result.slope).toBeCloseTo(0.5, 10);
    expect(result.intercept).toBeCloseTo(1.0, 10);
    expect(result.tStat).toBeGreaterThan(10);
    expect(result.pValue).toBeLessThan(0.001);
  });

  it('returns non-significant t-stat for flat data', () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const y = [5.1, 4.9, 5.0, 5.2, 4.8, 5.1, 4.9, 5.0, 5.2, 4.8];
    const result = linearRegression(x, y);
    expect(Math.abs(result.slope)).toBeLessThan(0.1);
    expect(result.pValue).toBeGreaterThan(0.1);
  });

  it('returns NaN for fewer than 3 points', () => {
    const result = linearRegression([1, 2], [3, 4]);
    expect(result.slope).toBeNaN();
  });

  it('returns NaN when x has zero variance', () => {
    const result = linearRegression([5, 5, 5], [1, 2, 3]);
    expect(result.slope).toBeNaN();
  });

  it('computes R² for noisy data', () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const y = [2.1, 3.9, 6.2, 7.8, 10.1, 12.3, 13.9, 16.1, 18.0, 20.2]; // y ≈ 2x with noise
    const result = linearRegression(x, y);
    expect(result.rSquared).toBeGreaterThan(0.99);
    expect(result.slope).toBeCloseTo(2.0, 0); // rough
  });
});

// ---------------------------------------------------------------------------
// zScore
// ---------------------------------------------------------------------------

describe('zScore', () => {
  it('returns 0 at the mean', () => {
    expect(zScore(5, 5, 2)).toBe(0);
  });

  it('returns 1 at one stddev above mean', () => {
    expect(zScore(7, 5, 2)).toBeCloseTo(1, 10);
  });

  it('returns negative below the mean', () => {
    expect(zScore(3, 5, 2)).toBeCloseTo(-1, 10);
  });

  it('returns 0 when stddev is 0', () => {
    expect(zScore(5, 3, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// percentileRank
// ---------------------------------------------------------------------------

describe('percentileRank', () => {
  it('returns 0 for value below all', () => {
    expect(percentileRank(0, [1, 2, 3, 4, 5])).toBe(0);
  });

  it('returns 1 for value above all', () => {
    expect(percentileRank(10, [1, 2, 3, 4, 5])).toBe(1);
  });

  it('returns 0.5 for median of even-spaced data', () => {
    // 5 values: percentile of 3 → 2 values below → 2/5 = 0.4 (strictly less than)
    expect(percentileRank(3, [1, 2, 3, 4, 5])).toBeCloseTo(0.4, 10);
  });

  it('returns NaN for empty distribution', () => {
    expect(percentileRank(5, [])).toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// Multiple testing corrections
// ---------------------------------------------------------------------------

describe('bonferroniCorrection', () => {
  it('multiplies p-values by number of tests', () => {
    const result = bonferroniCorrection([0.01, 0.03, 0.05]);
    expect(result[0]).toBeCloseTo(0.03, 10);
    expect(result[1]).toBeCloseTo(0.09, 10);
    expect(result[2]).toBeCloseTo(0.15, 10);
  });

  it('caps at 1.0', () => {
    const result = bonferroniCorrection([0.5, 0.8]);
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(1);
  });

  it('handles single test (no correction)', () => {
    expect(bonferroniCorrection([0.04])).toEqual([0.04]);
  });
});

describe('benjaminiHochberg', () => {
  it('adjusts p-values correctly', () => {
    // Classic BH example: 5 tests
    const raw = [0.005, 0.009, 0.05, 0.1, 0.5];
    const adj = benjaminiHochberg(raw);

    // Sorted p-values: 0.005, 0.009, 0.05, 0.1, 0.5
    // adj[k] = min(p[k]*m/rank, adj[k+1]) working backwards
    // rank 5: 0.5*5/5 = 0.5
    // rank 4: min(0.1*5/4, 0.5) = min(0.125, 0.5) = 0.125
    // rank 3: min(0.05*5/3, 0.125) = min(0.0833, 0.125) = 0.0833
    // rank 2: min(0.009*5/2, 0.0833) = min(0.0225, 0.0833) = 0.0225
    // rank 1: min(0.005*5/1, 0.0225) = min(0.025, 0.0225) = 0.0225

    expect(adj[0]).toBeCloseTo(0.0225, 3);
    expect(adj[1]).toBeCloseTo(0.0225, 3);
    expect(adj[2]).toBeCloseTo(0.0833, 3);
    expect(adj[3]).toBeCloseTo(0.125, 3);
    expect(adj[4]).toBeCloseTo(0.5, 3);
  });

  it('returns empty for empty input', () => {
    expect(benjaminiHochberg([])).toEqual([]);
  });

  it('does not change a single p-value', () => {
    expect(benjaminiHochberg([0.03])).toEqual([0.03]);
  });

  it('preserves original order when input is not sorted', () => {
    const raw = [0.5, 0.005, 0.1, 0.009, 0.05];
    const adj = benjaminiHochberg(raw);
    // The largest raw p-value (0.5 at index 0) should have the largest adjusted value
    expect(adj[0]).toBeCloseTo(0.5, 3);
    // The smallest raw p-value (0.005 at index 1) should have the smallest adjusted value
    expect(adj[1]).toBeCloseTo(0.0225, 3);
  });

  it('adjusted p-values never exceed 1', () => {
    const raw = [0.4, 0.6, 0.8];
    const adj = benjaminiHochberg(raw);
    for (const p of adj) {
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});
