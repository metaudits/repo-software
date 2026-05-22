// Small-sample statistics utilities.
//
// We have platforms with as few as n=3 sampled clients. The normal approximation
// (z=1.96 for 95% CI) UNDER-COVERS at small n; the right move is Student's t
// with df = n-1. For df ≥ 30 the t crit collapses to 1.96 and either is fine.
//
// To avoid pulling in a stats library we ship a hardcoded table of two-tailed
// 97.5% t critical values for df = 1..120 (verified against scipy.stats.t.ppf).
// Anything above df=120 we treat as 1.96. Linear interpolation between table
// entries handles non-integer df from Welch's correction in two-sample tests.

// scipy.stats.t.ppf(0.975, df) for df = 1..120
const T_975 = [
  // df=1..10
   12.706,  4.303,  3.182,  2.776,  2.571,  2.447,  2.365,  2.306,  2.262,  2.228,
  // df=11..20
    2.201,  2.179,  2.160,  2.145,  2.131,  2.120,  2.110,  2.101,  2.093,  2.086,
  // df=21..30
    2.080,  2.074,  2.069,  2.064,  2.060,  2.056,  2.052,  2.048,  2.045,  2.042,
  // df=31..40
    2.040,  2.037,  2.035,  2.032,  2.030,  2.028,  2.026,  2.024,  2.023,  2.021,
  // df=41..50
    2.020,  2.018,  2.017,  2.015,  2.014,  2.013,  2.012,  2.011,  2.010,  2.009,
  // df=51..60
    2.008,  2.007,  2.006,  2.005,  2.004,  2.003,  2.002,  2.002,  2.001,  2.000,
  // df=61..70
    2.000,  1.999,  1.998,  1.998,  1.997,  1.997,  1.996,  1.995,  1.995,  1.994,
  // df=71..80
    1.994,  1.993,  1.993,  1.993,  1.992,  1.992,  1.991,  1.991,  1.990,  1.990,
  // df=81..90
    1.990,  1.989,  1.989,  1.989,  1.988,  1.988,  1.988,  1.987,  1.987,  1.987,
  // df=91..100
    1.986,  1.986,  1.986,  1.986,  1.985,  1.985,  1.985,  1.984,  1.984,  1.984,
  // df=101..120
    1.984,  1.984,  1.983,  1.983,  1.983,  1.983,  1.983,  1.982,  1.982,  1.982,
    1.982,  1.982,  1.981,  1.981,  1.981,  1.981,  1.981,  1.980,  1.980,  1.980,
];

const Z_975 = 1.960;

export function tInv975(df) {
  if (!isFinite(df) || df <= 0) return Z_975;
  if (df >= T_975.length) return Z_975;
  // Linear interpolation handles non-integer df from Welch's correction.
  const lo = Math.floor(df);
  const hi = Math.ceil(df);
  if (lo === hi) return T_975[lo - 1] ?? Z_975;
  const tLo = T_975[lo - 1] ?? Z_975;
  const tHi = T_975[hi - 1] ?? Z_975;
  return tLo + (tHi - tLo) * (df - lo);
}

// Welch–Satterthwaite degrees of freedom for the difference of two independent
// means. Use this when CI-ing Δ-vs-baseline so the (small-n − large-n) pair
// gets honest df, not just min(n1,n2)−1.
//
//   df ≈ (s1²/n1 + s2²/n2)² / ( (s1²/n1)²/(n1-1) + (s2²/n2)²/(n2-1) )
//
// Caller passes in SE = s/sqrt(n) for each group; we invert to get s²/n = SE².
export function welchDF(se1, n1, se2, n2) {
  const v1 = se1 * se1;     // s1²/n1
  const v2 = se2 * se2;
  const num = (v1 + v2) ** 2;
  const den = (v1 * v1) / Math.max(n1 - 1, 1) + (v2 * v2) / Math.max(n2 - 1, 1);
  if (den <= 0) return Math.min(n1, n2) - 1;
  return num / den;
}
