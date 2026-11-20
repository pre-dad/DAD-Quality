import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyEvidence, RunError } from './core.js';
import { hashPolicy } from './policy.js';
import { defaultPerformanceProfile, validatePerformanceProfile } from './performance-config.js';

const targets = [
  { name: 'spend', path: '/api/donor/public/spend', signedIn: false },
  { name: 'dashboard', path: '/api/donor/me/dashboard', signedIn: true },
  { name: 'gifts', path: '/api/donor/me/gifts?offset=0', signedIn: true },
];
function environmentFingerprint(docker = {}) {
  return {
    kind: process.env.GITHUB_ACTIONS === 'true' ? 'github-actions' : 'local',
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    memoryGiB: Math.round(os.totalmem() / 1024 ** 3),
    nodeMajor: process.versions.node.split('.')[0],
    docker,
  };
}
const round = n => Math.round(n * 1000) / 1000;
export function metrics(samples, elapsedMs) {
  const times = samples.map(s => s.ms).sort((a, b) => a - b);
  const percentile = p => (times.length ? round(times[Math.ceil(times.length * p) - 1]) : null);
  const errors = samples.filter(s => s.error).length;
  return {
    requests: samples.length,
    errors,
    timeouts: samples.filter(s => s.error === 'timeout').length,
    errorRate: samples.length ? errors / samples.length : null,
    throughput: round((samples.length * 1000) / elapsedMs),
    successfulThroughput: round(((samples.length - errors) * 1000) / elapsedMs),
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    statuses: Object.fromEntries(
      [...new Set(samples.map(s => s.status))].map(status => [status, samples.filter(s => s.status === status).length]),
    ),
  };
}

// Fixed GET routes, literal loopback transport, no redirects, bounded response
// bodies and a wall-clock request deadline that includes body consumption.
function request(origin, target, cookie, agent, timeoutMs, signal) {
  const started = performance.now();
  return new Promise(resolve => {
    let done = false,
      status = 0,
      size = 0,
      chunks = [],
      timer;
    const finish = error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ target: target.name, status, error, ms: performance.now() - started });
    };
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: origin.port,
        path: target.path,
        method: 'GET',
        agent,
        headers: { Host: origin.host, Accept: 'application/json', ...(target.signedIn ? { Cookie: cookie } : {}) },
      },
      res => {
        status = res.statusCode;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 262144) {
            finish('oversized');
            res.destroy();
            req.destroy();
          } else chunks.push(chunk);
        });
        res.on('error', () => finish('transport'));
        res.on('end', () => {
          let valid = false;
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            valid =
              body !== null &&
              typeof body === 'object' &&
              (target.name === 'spend'
                ? Array.isArray(body.categories)
                : target.name === 'gifts'
                  ? Array.isArray(body.gifts)
                  : typeof body.state === 'string');
          } catch {
            /* malformed, wrong-shape or HTML responses fail */
          }
          finish(status !== 200 ? 'status' : valid ? null : 'invalid-json');
        });
      },
    );
    const abort = () => {
      finish('canceled');
      req.destroy();
    };
    req.on('error', () => finish('transport'));
    timer = setTimeout(() => {
      finish('timeout');
      req.destroy();
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    else req.end();
  });
}

export async function measurePerformance({ origin, cookies, profile, environment, signal }) {
  validatePerformanceProfile(profile);
  const url = new URL(origin);
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Performance requests require a run-owned loopback origin.');
  if (!Array.isArray(cookies) || !cookies.length || cookies.some(c => !/^dad_donor_session=[A-Za-z0-9_-]+$/.test(c)))
    throw new Error('Invalid synthetic load sessions.');
  const report = {
    schemaVersion: 1,
    profile: structuredClone(profile),
    workloadDigest: hashPolicy(profile),
    environment,
    environmentDigest: hashPolicy(environment),
    startedAt: new Date().toISOString(),
    completed: false,
    phases: [],
  };
  const agent = new http.Agent({ keepAlive: true, maxSockets: 32, maxTotalSockets: 32 });
  try {
    for (const phase of profile.phases) {
      if (signal?.aborted) break;
      const samples = [],
        started = performance.now();
      let issued = 0;
      await Promise.all(
        Array.from({ length: phase.concurrency }, async () => {
          while (
            !signal?.aborted &&
            performance.now() - started < phase.durationMs &&
            issued < profile.maxRequestsPerPhase
          ) {
            const index = issued++;
            // Cycle donors independently of the 3-route mix.
            samples.push(
              await request(
                url,
                targets[index % targets.length],
                cookies[Math.floor(index / targets.length) % cookies.length],
                agent,
                profile.requestTimeoutMs,
                signal,
              ),
            );
            if (profile.thinkMs)
              await delay(
                Math.min(profile.thinkMs, Math.max(0, phase.durationMs - (performance.now() - started))),
                undefined,
                { signal },
              ).catch(() => {});
          }
        }),
      );
      const elapsedMs = performance.now() - started;
      report.phases.push({
        ...phase,
        elapsedMs: round(elapsedMs),
        capped: issued >= profile.maxRequestsPerPhase,
        ...metrics(samples, elapsedMs),
        endpoints: Object.fromEntries(
          targets.map(t => [
            t.name,
            metrics(
              samples.filter(s => s.target === t.name),
              elapsedMs,
            ),
          ]),
        ),
      });
    }
    report.completed =
      !signal?.aborted && report.phases.length === profile.phases.length && !report.phases.some(p => p.capped);
  } finally {
    agent.destroy();
  }
  report.finishedAt = new Date().toISOString();
  report.assessment = assessPerformance(report);
  return report;
}

export function assessPerformance(report) {
  const reasons = [],
    { criteria } = report.profile;
  if (!report.completed)
    return { status: 'inconclusive', reasons: ['Workload interrupted or request safety cap reached.'] };
  for (const phase of report.phases.filter(p => p.name !== 'warmup')) {
    if (phase.requests < criteria.minRequests || Object.values(phase.endpoints).some(e => e.requests === 0))
      return { status: 'inconclusive', reasons: [`${phase.name}: insufficient samples.`] };
    for (const [name, m] of [['overall', phase], ...Object.entries(phase.endpoints)]) {
      if (criteria.maxP95Ms !== null && m.p95Ms > criteria.maxP95Ms)
        reasons.push(`${phase.name}/${name}: p95 latency exceeds ${criteria.maxP95Ms} ms.`);
      if (criteria.maxErrorRate !== null && m.errorRate > criteria.maxErrorRate)
        reasons.push(`${phase.name}/${name}: error rate exceeds ${criteria.maxErrorRate}.`);
    }
  }
  return {
    status: reasons.length
      ? 'exceeded'
      : criteria.maxP95Ms === null && criteria.maxErrorRate === null
        ? 'observed'
        : 'within-budget',
    reasons,
  };
}

export function comparePerformance(current, baseline) {
  if (
    !baseline ||
    !current.completed ||
    !baseline.completed ||
    current.workloadDigest !== baseline.workloadDigest ||
    current.environmentDigest !== baseline.environmentDigest ||
    [current, baseline].some(r => r.assessment.status === 'inconclusive')
  )
    return { comparable: false, reason: 'No complete baseline with matching workload and environment.', changes: [] };
  const changes = [];
  for (const p of current.phases.filter(p => p.name !== 'warmup')) {
    const b = baseline.phases.find(v => v.name === p.name);
    if (!b) return { comparable: false, reason: 'Baseline phases differ.', changes: [] };
    for (const [endpoint, m, before] of [
      ['overall', p, b],
      ...Object.keys(p.endpoints).map(k => [k, p.endpoints[k], b.endpoints[k]]),
    ]) {
      const p95DeltaMs = round(m.p95Ms - before.p95Ms),
        throughputDelta = round(m.successfulThroughput - before.successfulThroughput);
      const r = current.profile.regression;
      const regression =
        (m.p95Ms > before.p95Ms * r.p95Ratio && p95DeltaMs >= r.minP95IncreaseMs) ||
        (before.successfulThroughput > 0 && m.successfulThroughput < before.successfulThroughput * r.throughputRatio) ||
        (m.errorRate > before.errorRate &&
          m.errorRate - before.errorRate >=
            (r.errorRateIncrease ?? defaultPerformanceProfile.regression.errorRateIncrease));
      changes.push({
        phase: p.name,
        endpoint,
        p95DeltaMs,
        throughputDelta,
        errorRateDelta: m.errorRate - before.errorRate,
        regression,
      });
    }
  }
  return { comparable: true, regression: changes.some(c => c.regression), changes };
}

export async function readPerformance(directory, run) {
  const result = run.results.find(r => r.id === 'performance');
  if (!result) return null;
  if (!result.finishedAt && !result.evidence?.length) return null;
  if ((await verifyEvidence(directory, { results: [result] })).length)
    throw new Error('Performance evidence integrity failed.');
  const ref = result.evidence?.find(e => e.path === 'evidence/performance.json');
  if (!ref) throw new Error('Performance report missing.');
  const report = JSON.parse(await readFile(path.join(directory, ref.path), 'utf8'));
  validatePerformanceProfile(report.profile);
  if (
    report.schemaVersion !== 1 ||
    report.workloadDigest !== hashPolicy(report.profile) ||
    report.environmentDigest !== hashPolicy(report.environment) ||
    !Array.isArray(report.phases) ||
    typeof report.completed !== 'boolean' ||
    !['observed', 'within-budget', 'exceeded', 'inconclusive'].includes(report.assessment?.status)
  )
    throw new Error('Invalid performance report.');
  if (
    hashPolicy(report.profile) !==
    hashPolicy(run.policy?.definition?.checks.find(c => c.id === 'performance')?.profile ?? {})
  )
    throw new Error('Performance report differs from recorded policy.');
  if (report.completed && report.phases.map(p => p.name).join() !== 'warmup,baseline,burst,recovery')
    throw new Error('Missing performance phases.');
  for (const phase of report.phases) {
    if (
      !report.profile.phases.some(
        p => p.name === phase.name && p.concurrency === phase.concurrency && p.durationMs === phase.durationMs,
      ) ||
      !Number.isFinite(phase.elapsedMs) ||
      phase.elapsedMs <= 0 ||
      !phase.endpoints ||
      Object.keys(phase.endpoints).sort().join() !==
        targets
          .map(target => target.name)
          .sort()
          .join()
    )
      throw new Error('Invalid performance phase.');
    for (const m of [phase, ...Object.values(phase.endpoints)]) {
      if (
        !Number.isSafeInteger(m.requests) ||
        m.requests < 0 ||
        !Number.isSafeInteger(m.timeouts) ||
        m.timeouts < 0 ||
        m.timeouts > m.requests ||
        !Number.isSafeInteger(m.errors) ||
        m.errors < 0 ||
        m.errors > m.requests ||
        !Number.isFinite(m.throughput) ||
        m.throughput < 0 ||
        !Number.isFinite(m.successfulThroughput) ||
        m.successfulThroughput < 0 ||
        (m.requests > 0 &&
          (!Number.isFinite(m.errorRate) ||
            m.errorRate < 0 ||
            m.errorRate > 1 ||
            ['p50Ms', 'p95Ms', 'p99Ms'].some(k => !Number.isFinite(m[k]) || m[k] < 0)))
      )
        throw new Error('Invalid performance metrics.');
    }
  }
  if (hashPolicy(report.assessment) !== hashPolicy(assessPerformance(report)))
    throw new Error('Performance assessment mismatch.');
  return report;
}

export async function performanceDetail(root, run, history) {
  try {
    const report = await readPerformance(path.join(root, run.id), run);
    if (!report) return null;
    const result = {
      report,
      advisory: !run.required.includes('performance'),
      comparison: comparePerformance(report, null),
    };
    for (const prior of history.filter(
      r =>
        r.id !== run.id &&
        r.startedAt < run.startedAt &&
        r.finishedAt &&
        !r.canceledAt &&
        r.candidate?.source === run.candidate?.source &&
        r.options?.adapter === run.options?.adapter,
    )) {
      let baseline;
      try {
        baseline = await readPerformance(path.join(root, prior.id), prior);
      } catch {
        result.comparison.reason = 'Earlier performance evidence is invalid; no comparison shown.';
        return result;
      }
      const comparison = comparePerformance(report, baseline);
      if (comparison.comparable)
        return { ...result, comparison: { ...comparison, baselineId: prior.id, revision: prior.candidate.revision } };
    }
    return result;
  } catch (error) {
    return { error: error.message };
  }
}

export async function performanceCheck(adapter, result, profile) {
  const cookies = await adapter.performanceFixture();
  const report = await measurePerformance({
    origin: adapter.publicOrigin,
    cookies,
    profile,
    environment: environmentFingerprint(adapter.run.data.environment?.docker),
    signal: adapter.signal,
  });
  result.evidence.push(await adapter.run.evidence('performance.json', JSON.stringify(report, null, 2)));
  result.performance = { status: report.assessment.status, phaseCount: report.phases.length };
  if (report.assessment.status === 'inconclusive') throw new RunError(report.assessment.reasons.join(' '));
  if (report.assessment.status === 'exceeded') throw new RunError(report.assessment.reasons.join(' '), 'failed');
  return {
    summary: `Performance ${report.assessment.status}: baseline, burst and recovery recorded. ${result.required ? 'Required' : 'Advisory'}; synthetic donor reads only.`,
  };
}
