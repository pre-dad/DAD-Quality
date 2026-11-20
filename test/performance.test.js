import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syntheticRun } from './synthetic-run.js';
import {
  measurePerformance,
  metrics,
  comparePerformance,
  readPerformance,
  performanceDetail,
} from '../src/performance.js';
import { defaultPerformanceProfile, validatePerformanceProfile } from '../src/performance-config.js';
import { loadPolicy, validatePolicy, hashPolicy } from '../src/policy.js';
import { collectFindings } from '../src/history.js';
import { Run } from '../src/core.js';
import { evaluateRelease } from '../src/release.js';

const body = JSON.stringify({ categories: [], total_minor: 0, state: 'ready', gifts: [] });
const cookies = ['dad_donor_session=synthetic'];
const profile = () => ({
  ...structuredClone(defaultPerformanceProfile),
  thinkMs: 5,
  requestTimeoutMs: 150,
  phases: defaultPerformanceProfile.phases.map(p => ({
    ...p,
    concurrency: p.name === 'burst' ? 4 : 2,
    durationMs: 300,
  })),
  criteria: { minRequests: 3, maxP95Ms: 50, maxErrorRate: 0 },
});
async function server(t, handler) {
  const app = http.createServer(handler);
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    app.closeAllConnections();
    return new Promise(resolve => app.close(resolve));
  });
  return `http://127.0.0.1:${app.address().port}`;
}

test('metrics count failed attempts, nearest-rank percentiles, throughput and empty samples', () => {
  const value = metrics(
    [
      { ms: 10, error: null, status: 200 },
      { ms: 100, error: 'timeout', status: 0 },
    ],
    1000,
  );
  assert.equal(value.p50Ms, 10);
  assert.equal(value.p95Ms, 100);
  assert.equal(value.p99Ms, 100);
  assert.equal(value.throughput, 2);
  assert.equal(value.successfulThroughput, 1);
  assert.equal(value.errorRate, 0.5);
  assert.equal(value.timeouts, 1);
  assert.equal(metrics([], 100).p95Ms, null);
});

test('real HTTP load detects slow bodies, error responses and candidate regressions', async t => {
  let slow = false,
    failing = false;
  const origin = await server(t, (req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.cookie, req.url.includes('/public/') ? undefined : cookies[0]);
    res.writeHead(failing ? 503 : 200, { 'content-type': 'application/json' });
    res.write(body.slice(0, 1));
    setTimeout(() => res.end(body.slice(1)), slow ? 300 : 1);
  });
  // The budget sits far from both responses, so a busy machine's scheduling delay
  // cannot move a fast run over it or a slow run under it.
  const base = profile();
  const options = {
    origin,
    cookies,
    profile: {
      ...base,
      requestTimeoutMs: 1000,
      phases: base.phases.map(p => ({ ...p, durationMs: p.name === 'warmup' ? 100 : 500 })),
      criteria: { ...base.criteria, maxP95Ms: 150 },
    },
    environment: { host: 'fixture' },
  };
  const fast = await measurePerformance(options);
  assert.equal(fast.assessment.status, 'within-budget');
  slow = true;
  const degraded = await measurePerformance(options);
  assert.equal(degraded.assessment.status, 'exceeded');
  assert.ok(degraded.phases[1].p95Ms >= 250);
  assert.equal(comparePerformance(degraded, fast).regression, true);
  failing = true;
  const broken = await measurePerformance(options);
  assert.equal(broken.phases[1].errorRate, 1);
  assert.ok(broken.assessment.reasons.some(r => r.includes('error rate')));
  assert.equal(comparePerformance({ ...degraded, environmentDigest: 'different-host' }, fast).comparable, false);
  assert.equal(comparePerformance({ ...degraded, workloadDigest: 'different-load' }, fast).comparable, false);
});

test('timeouts, cancellation, redirects and safety caps do not masquerade as completed good load', async t => {
  let mode = 'hang',
    redirected = 0;
  const origin = await server(t, (req, res) => {
    if (req.url === '/redirected') redirected++;
    if (mode === 'redirect') {
      res.writeHead(302, { location: '/redirected' });
      res.end();
    }
    if (mode === 'fast') res.end(body);
  });
  const options = { origin, cookies, profile: profile(), environment: {} };
  const stalled = await measurePerformance(options);
  assert.ok(stalled.phases[1].timeouts > 0);
  assert.equal(stalled.assessment.status, 'exceeded');
  mode = 'redirect';
  const redirect = await measurePerformance(options);
  assert.equal(redirect.phases[1].errorRate, 1);
  assert.equal(redirected, 0);
  mode = 'fast';
  const cappedProfile = profile();
  cappedProfile.maxRequestsPerPhase = 3;
  assert.equal((await measurePerformance({ ...options, profile: cappedProfile })).assessment.status, 'inconclusive');
  const canceled = await measurePerformance({ ...options, signal: AbortSignal.timeout(30) });
  assert.equal(canceled.completed, false);
  assert.equal(canceled.assessment.status, 'inconclusive');
  await assert.rejects(measurePerformance({ ...options, origin: 'https://example.com' }), /loopback/);
  await assert.rejects(measurePerformance({ ...options, origin: `${origin}/redirected` }), /loopback/);
});

test('malformed JSON, wrong payloads and oversized responses count as failed requests', async t => {
  let payload = '{}';
  const origin = await server(t, (_req, res) => res.end(payload));
  const options = { origin, cookies, profile: profile(), environment: {} };
  for (const value of ['{}', '<html>not an API</html>', 'x'.repeat(262145)]) {
    payload = value;
    const result = await measurePerformance(options);
    assert.equal(result.phases[1].errorRate, 1);
  }
});

test('policy bounds load and requires explicit budgets before making performance required', async () => {
  const { definition } = await loadPolicy();
  const check = definition.checks.find(c => c.id === 'performance');
  assert.equal(check.required, false);
  for (const mutate of [
    p => {
      p.phases[2].concurrency = 1000;
    },
    p => {
      p.phases[0].durationMs = 3600000;
    },
    p => {
      p.url = 'https://example.com';
    },
    p => {
      p.criteria.maxP95Ms = -1;
    },
    p => {
      p.thinkMs = -1;
    },
    p => {
      p.regression.throughputRatio = 2;
    },
  ]) {
    const p = profile();
    mutate(p);
    assert.throws(() => validatePerformanceProfile(p));
  }
  check.required = true;
  assert.throws(() => validatePolicy(definition), /explicit/);
  check.profile.criteria.maxP95Ms = 300;
  check.profile.criteria.maxErrorRate = 0.01;
  validatePolicy(definition);
  check.timeoutMs = 1000;
  assert.throws(() => validatePolicy(definition), /time budget/);
  // Previous policies remain readable and eligible under their original contract.
  definition.checks = definition.checks.filter(c => c.id !== 'performance');
  definition.version = '1.0.0';
  validatePolicy(definition);
});

test('advisory failures stay visible without producing blocking findings; required failures block', async t => {
  const { root, run } = await syntheticRun(t, {
    prefix: 'atm-perf-advisory-',
    source: 'fixture',
    status: check => (check.id === 'performance' ? 'failed' : 'passed'),
    summary: 'Synthetic budget exceeded',
    evidence: () => '{}',
  });
  let findings = await collectFindings(root, [run.data]);
  assert.equal(findings.length, 0);
  assert.equal(evaluateRelease(run.data, { findings }).eligible, true);
  const check = run.data.policy.definition.checks.find(c => c.id === 'performance');
  check.required = true;
  check.profile.criteria.maxP95Ms = 50;
  check.profile.criteria.maxErrorRate = 0;
  run.data.required = run.data.policy.definition.checks.filter(c => c.required).map(c => c.id);
  run.data.policy.digest = hashPolicy({ definition: run.data.policy.definition, scenarios: run.data.policy.scenarios });
  findings = await collectFindings(root, [run.data]);
  const release = evaluateRelease(run.data, { findings });
  assert.equal(findings.length, 1);
  assert.equal(release.eligible, false);
  assert.ok(release.reasons.includes('performance: Synthetic budget exceeded'));
  assert.ok(!release.reasons.some(r => r.startsWith('Policy unavailable')));
});

test('dashboard loads only verified performance evidence and matching history', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-perf-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = await server(t, (_req, res) => res.end(body));
  const p = profile();
  const report = await measurePerformance({ origin, cookies, profile: p, environment: {} });
  const policy = await loadPolicy();
  policy.definition.checks.find(c => c.id === 'performance').profile = p;
  const runs = [];
  for (let i = 0; i < 2; i++) {
    const run = await Run.create(root, { adapter: 'impactgraph' }, [], policy);
    run.data.startedAt = `2026-10-0${i + 1}T00:00:00.000Z`;
    run.data.candidate = { source: 'fixture', revision: `${i}`.repeat(40) };
    run.data.results = [
      {
        id: 'performance',
        status: 'passed',
        finishedAt: run.data.startedAt,
        evidence: [await run.evidence('performance.json', JSON.stringify(report))],
      },
    ];
    await run.finish();
    runs.unshift(run.data);
  }
  const detail = await performanceDetail(root, runs[0], runs);
  assert.equal(detail.comparison.comparable, true);
  assert.equal(detail.comparison.baselineId, runs[1].id);
  await writeFile(path.join(root, runs[1].id, 'evidence/performance.json'), '{}');
  assert.equal((await performanceDetail(root, runs[0], runs)).comparison.comparable, false);
  await assert.rejects(readPerformance(path.join(root, runs[1].id), runs[1]), /integrity/);
});
