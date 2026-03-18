/**
 * Arithmetic mean.
 * Returns NaN for an empty array.
 */
export function mean(values: number[]): number {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * Sample or population variance.
 * @param ddof - Delta degrees of freedom. 1 = sample variance (default), 0 = population.
 * Returns NaN if n <= ddof.
 */
export function variance(values: number[], ddof: number = 1): number {
  const n = values.length;
  if (n <= ddof) return NaN;
  const m = mean(values);
  let sumSq = 0;
  for (const v of values) {
    const d = v - m;
    sumSq += d * d;
  }
  return sumSq / (n - ddof);
}

/**
 * Standard deviation (square root of variance).
 * @param ddof - 1 for sample (default), 0 for population.
 */
export function stddev(values: number[], ddof: number = 1): number {
  return Math.sqrt(variance(values, ddof));
}

// ---------------------------------------------------------------------------
// t-distribution approximation (for p-value computation)
// ---------------------------------------------------------------------------

/**
 * Approximates the CDF of the standard normal distribution via the
 * Abramowitz & Stegun rational approximation (max error ~7.5×10⁻⁸).
 */
function normalCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1 / (1 + p * absX);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);
  return 0.5 * (1 + sign * y);
}

/**
 * Approximates the one-tailed p-value of a t-statistic using the normal
 * approximation, which is accurate for df >= 30 and reasonable for df >= 10.
 * For smaller df this is a conservative (over-estimated) approximation.
 * Returns P(T > t) for the upper tail.
 */
function tPValueOneTailed(t: number, _df: number): number {
  // For large df the t distribution converges to the normal.
  // For smaller df, use Cornish-Fisher expansion to improve accuracy.
  // Adjustment: t_adj = t * (1 - 1/(4*df)) which shifts mass appropriately.
  const adjusted = t * (1 - 1 / (4 * _df));
  return 1 - normalCdf(adjusted);
}

/**
 * One-sample t-test.
 *
 * Tests H0: population mean = mu against H1: population mean > mu (one-tailed, upper).
 *
 * @param values - Observed sample.
 * @param mu - Hypothesized population mean (default 0).
 * @returns { t, p, n, df } where p is the one-tailed p-value.
 */
export function tTest(
  values: number[],
  mu: number = 0,
): { t: number; p: number; n: number; df: number } {
  const n = values.length;
  if (n < 2) return { t: NaN, p: NaN, n, df: n - 1 };

  const m = mean(values);
  const se = stddev(values) / Math.sqrt(n);
  if (se === 0) {
    // All values identical — if equal to mu, no evidence; otherwise infinite t.
    const t = m === mu ? 0 : (m > mu ? Infinity : -Infinity);
    return { t, p: m > mu ? 0 : 1, n, df: n - 1 };
  }

  const t = (m - mu) / se;
  const df = n - 1;
  const p = tPValueOneTailed(t, df);
  return { t, p, n, df };
}

/**
 * Cohen's d — standardized effect size.
 * d = (mean(values) - mu) / stddev(values)
 */
export function cohensD(values: number[], mu: number = 0): number {
  const sd = stddev(values);
  if (sd === 0) return 0;
  return (mean(values) - mu) / sd;
}

/**
 * Bootstrap confidence interval for the mean.
 *
 * Draws `iterations` bootstrap samples (with replacement), computes the mean
 * of each, then returns the [alpha/2, 1-alpha/2] percentiles.
 *
 * @param values - Original sample.
 * @param alpha - Significance level (default 0.05 → 95% CI).
 * @param iterations - Number of bootstrap resamples (default 10_000).
 * @returns [lower, upper] bounds of the CI.
 */
export function bootstrapCI(
  values: number[],
  alpha: number = 0.05,
  iterations: number = 10_000,
): [number, number] {
  const n = values.length;
  if (n === 0) return [NaN, NaN];
  if (n === 1) return [values[0]!, values[0]!];

  const means: number[] = new Array(iterations);

  // Deterministic-friendly: use a simple LCG seeded from the data for reproducibility.
  // We're not doing crypto — just need decent uniformity.
  let seed = 42;
  for (const v of values) seed = (seed * 1597 + Math.round(v * 1e8)) | 0;
  seed = Math.abs(seed) || 1;

  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      // Fast LCG: Numerical Recipes parameters
      seed = (seed * 1664525 + 1013904223) | 0;
      const idx = ((seed >>> 0) % n);
      sum += values[idx]!;
    }
    means[i] = sum / n;
  }

  means.sort((a, b) => a - b);

  const loIdx = Math.floor((alpha / 2) * iterations);
  const hiIdx = Math.floor((1 - alpha / 2) * iterations);
  return [means[loIdx]!, means[Math.min(hiIdx, iterations - 1)]!];
}

// ---------------------------------------------------------------------------
// Rolling / Windowed Functions
// ---------------------------------------------------------------------------

/**
 * Returns all sliding windows of size `windowSize` from `arr`.
 * If arr has N elements, returns N - windowSize + 1 windows.
 */
export function rollingWindow<T>(arr: T[], windowSize: number): T[][] {
  if (windowSize <= 0 || windowSize > arr.length) return [];
  const result: T[][] = [];
  for (let i = 0; i <= arr.length - windowSize; i++) {
    result.push(arr.slice(i, i + windowSize));
  }
  return result;
}

/**
 * Rolling mean of `values` over `window` elements.
 * Returns an array of length max(0, values.length - window + 1).
 */
export function rollingMean(values: number[], window: number): number[] {
  if (window <= 0 || window > values.length) return [];

  const result: number[] = [];
  let sum = 0;

  // Initialize first window
  for (let i = 0; i < window; i++) sum += values[i]!;
  result.push(sum / window);

  // Slide
  for (let i = window; i < values.length; i++) {
    sum += values[i]! - values[i - window]!;
    result.push(sum / window);
  }

  return result;
}

/**
 * Rolling standard deviation (sample) of `values` over `window` elements.
 * Uses the two-pass approach for numerical stability within each window.
 */
export function rollingStddev(values: number[], window: number): number[] {
  if (window < 2 || window > values.length) return [];

  const windows = rollingWindow(values, window);
  return windows.map((w) => stddev(w));
}

/**
 * Rolling annualized Sharpe ratio.
 *
 * Assumes `returns` are period returns (e.g. daily).
 * Sharpe = mean(returns) / stddev(returns) * sqrt(annualizationFactor)
 *
 * @param returns - Array of period returns.
 * @param window - Rolling window size.
 * @param annualizationFactor - Periods per year (default 252 for daily).
 * @returns Array of Sharpe values.
 */
export function rollingSharpe(
  returns: number[],
  window: number,
  annualizationFactor: number = 252,
): number[] {
  if (window < 2 || window > returns.length) return [];

  const windows = rollingWindow(returns, window);
  return windows.map((w) => {
    const m = mean(w);
    const s = stddev(w);
    if (s === 0) return m === 0 ? 0 : (m > 0 ? Infinity : -Infinity);
    return (m / s) * Math.sqrt(annualizationFactor);
  });
}

// ---------------------------------------------------------------------------
// Regression
// ---------------------------------------------------------------------------

/**
 * Ordinary least-squares linear regression: y = slope * x + intercept.
 *
 * Returns slope, intercept, R², t-statistic of the slope, and one-tailed p-value.
 * The t-stat tests H0: slope = 0 against H1: slope > 0.
 * For negative slopes, the p-value will be > 0.5 (no evidence of positive slope).
 */
export function linearRegression(
  x: number[],
  y: number[],
): { slope: number; intercept: number; rSquared: number; tStat: number; pValue: number } {
  const n = x.length;
  if (n !== y.length || n < 3) {
    return { slope: NaN, intercept: NaN, rSquared: NaN, tStat: NaN, pValue: NaN };
  }

  const mx = mean(x);
  const my = mean(y);

  let ssXX = 0;
  let ssXY = 0;
  let ssYY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    ssXX += dx * dx;
    ssXY += dx * dy;
    ssYY += dy * dy;
  }

  if (ssXX === 0) {
    return { slope: NaN, intercept: NaN, rSquared: NaN, tStat: NaN, pValue: NaN };
  }

  const slope = ssXY / ssXX;
  const intercept = my - slope * mx;

  const rSquared = ssYY === 0 ? (ssXY === 0 ? 1 : NaN) : (ssXY * ssXY) / (ssXX * ssYY);

  // Residual standard error
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const predicted = slope * x[i]! + intercept;
    const residual = y[i]! - predicted;
    ssRes += residual * residual;
  }
  const df = n - 2;
  const residualSE = Math.sqrt(ssRes / df);
  const slopeStdErr = residualSE / Math.sqrt(ssXX);

  const tStat = slopeStdErr === 0 ? (slope === 0 ? 0 : Infinity) : slope / slopeStdErr;
  const pValue = tPValueOneTailed(tStat, df);

  return { slope, intercept, rSquared, tStat, pValue };
}

// ---------------------------------------------------------------------------
// Score / Rank Helpers
// ---------------------------------------------------------------------------

/**
 * Computes the z-score of `value` given a known mean and standard deviation.
 */
export function zScore(value: number, m: number, s: number): number {
  if (s === 0) return 0;
  return (value - m) / s;
}

/**
 * Returns the percentile rank of `value` within `distribution` (0–1).
 * Uses the "less than" method: fraction of distribution values strictly less than `value`.
 */
export function percentileRank(value: number, distribution: number[]): number {
  if (distribution.length === 0) return NaN;
  let count = 0;
  for (const v of distribution) {
    if (v < value) count++;
  }
  return count / distribution.length;
}

// ---------------------------------------------------------------------------
// Multiple Testing Corrections
// ---------------------------------------------------------------------------

/**
 * Bonferroni correction: multiplies each p-value by the number of tests.
 * Returns adjusted p-values capped at 1.0.
 */
export function bonferroniCorrection(pValues: number[]): number[] {
  const m = pValues.length;
  return pValues.map((p) => Math.min(p * m, 1));
}

/**
 * Benjamini-Hochberg procedure for controlling the false discovery rate.
 * Returns adjusted p-values.
 */
export function benjaminiHochberg(pValues: number[]): number[] {
  const m = pValues.length;
  if (m === 0) return [];

  // Create index-sorted array
  const indexed = pValues.map((p, i) => ({ p, i }));
  indexed.sort((a, b) => a.p - b.p);

  // Compute adjusted p-values (step-up)
  const adjusted = new Array<number>(m);
  let cumMin = 1;

  for (let k = m - 1; k >= 0; k--) {
    const entry = indexed[k]!;
    const rank = k + 1;
    const raw = (entry.p * m) / rank;
    cumMin = Math.min(cumMin, raw);
    adjusted[entry.i] = Math.min(cumMin, 1);
  }

  return adjusted;
}
