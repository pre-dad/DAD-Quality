export const defaultPerformanceProfile = {
  version: 1,
  workload: 'donor-reads-v1',
  requestTimeoutMs: 1500,
  thinkMs: 25,
  maxRequestsPerPhase: 10000,
  phases: [
    { name: 'warmup', durationMs: 3000, concurrency: 2 },
    { name: 'baseline', durationMs: 10000, concurrency: 2 },
    { name: 'burst', durationMs: 10000, concurrency: 12 },
    { name: 'recovery', durationMs: 10000, concurrency: 2 },
  ],
  criteria: { minRequests: 20, maxP95Ms: null, maxErrorRate: null },
  regression: { p95Ratio: 1.5, minP95IncreaseMs: 20, throughputRatio: 0.75, errorRateIncrease: 0.01 },
};
const keys = (value, allowed, optional = []) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(k => !allowed.includes(k) && !optional.includes(k)) ||
    allowed.some(k => !(k in value))
  )
    throw new Error('Invalid performance profile fields.');
};
const integer = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
export function validatePerformanceProfile(profile) {
  keys(profile, [
    'version',
    'workload',
    'requestTimeoutMs',
    'thinkMs',
    'maxRequestsPerPhase',
    'phases',
    'criteria',
    'regression',
  ]);
  if (
    profile.version !== 1 ||
    profile.workload !== 'donor-reads-v1' ||
    !integer(profile.requestTimeoutMs, 50, 5000) ||
    !integer(profile.thinkMs, 0, 1000) ||
    !integer(profile.maxRequestsPerPhase, 1, 10000)
  )
    throw new Error('Unsupported performance workload or limits.');
  if (!Array.isArray(profile.phases) || profile.phases.map(p => p.name).join() !== 'warmup,baseline,burst,recovery')
    throw new Error('Performance requires warmup, baseline, burst and recovery in order.');
  for (const phase of profile.phases) {
    keys(phase, ['name', 'durationMs', 'concurrency']);
    if (!integer(phase.durationMs, 100, 60000) || !integer(phase.concurrency, 1, 32))
      throw new Error('Invalid performance phase bounds.');
  }
  if (
    profile.phases.reduce((sum, p) => sum + p.durationMs, 0) > 120000 ||
    profile.phases[2].concurrency <= profile.phases[1].concurrency ||
    profile.phases[3].concurrency !== profile.phases[1].concurrency
  )
    throw new Error('Invalid burst or recovery shape.');
  keys(profile.criteria, ['minRequests', 'maxP95Ms', 'maxErrorRate']);
  const { minRequests, maxP95Ms, maxErrorRate } = profile.criteria;
  if (
    !integer(minRequests, 1, profile.maxRequestsPerPhase) ||
    !(maxP95Ms === null || (Number.isFinite(maxP95Ms) && maxP95Ms > 0 && maxP95Ms <= 60000)) ||
    !(maxErrorRate === null || (Number.isFinite(maxErrorRate) && maxErrorRate >= 0 && maxErrorRate <= 1))
  )
    throw new Error('Invalid performance acceptance criteria.');
  keys(profile.regression, ['p95Ratio', 'minP95IncreaseMs', 'throughputRatio'], ['errorRateIncrease']);
  const r = profile.regression;
  if (
    !(
      Number.isFinite(r.p95Ratio) &&
      r.p95Ratio > 1 &&
      r.p95Ratio <= 10 &&
      Number.isFinite(r.minP95IncreaseMs) &&
      r.minP95IncreaseMs >= 0 &&
      r.minP95IncreaseMs <= 60000 &&
      Number.isFinite(r.throughputRatio) &&
      r.throughputRatio > 0 &&
      r.throughputRatio < 1 &&
      (r.errorRateIncrease === undefined ||
        (Number.isFinite(r.errorRateIncrease) && r.errorRateIncrease >= 0 && r.errorRateIncrease <= 1))
    )
  )
    throw new Error('Invalid regression criteria.');
  return profile;
}
