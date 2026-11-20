import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discover, discoveryProvider, validateDiscoveryAction, evaluateExpectation } from '../src/discovery.js';
import { discoveryPolicy, executeDiscovery } from '../src/discovery-runner.js';
import { discoveryMemory, readDiscovery } from '../src/discovery-report.js';
import { validatePolicy } from '../src/policy.js';
import { evaluateRelease } from '../src/release.js';
import { Run } from '../src/core.js';
import { collectFindings } from '../src/history.js';

const signal = new AbortController().signal;
const action = (kind, fields = {}) => ({
  action: kind,
  target: '',
  value:
    kind === 'investigate'
      ? JSON.stringify({
          capability: 'Observed feature',
          behavior: 'Investigate behavior',
          state: 'Initial state',
          preconditions: 'Supplied fixture',
          expected: 'UI matches its promise',
          basis: 'observed',
          references: [],
          checks: [
            { id: 'reload', kind: 'action', action: 'reload', actor: 'guest', target: '', value: '' },
            {
              id: 'welcome',
              kind: 'assertion',
              expectation: 'text_absent',
              actor: 'guest',
              target: '',
              value: '',
              text: 'Welcome',
              baseline: '',
            },
          ],
        })
      : '',
  title: '',
  reason: 'Investigate observed behavior',
  expectation: '',
  text: '',
  ...fields,
});
const observation = {
  id: 'o1',
  actor: 'guest',
  path: '/',
  text: 'Welcome',
  textTruncated: false,
  serverErrors: [],
  pageErrors: [],
};
const blank = () => ({
  status: 'running',
  requests: 0,
  tokens: 0,
  pages: [],
  events: [],
  observations: [],
  investigations: [],
  findings: [],
  memory: [],
});
const fakeBrowser = () => ({
  observe: async () => observation,
  pages: () => [{ path: '/', title: 'Home', visitedBy: ['guest'] }],
  act: async () => {},
  reproduce: async () => ({ status: 'reproduced', observation }),
});

test('a duplicate report is not replayed and is reported as already reported', async () => {
  let reproductions = 0;
  const decisions = [
    action('investigate', { title: 'Understand the home page' }),
    action('report', { title: 'Missing welcome', expectation: 'text_absent', text: 'Welcome' }),
    action('report', { title: 'Missing welcome', expectation: 'text_absent', text: 'Welcome' }),
    action('finish'),
  ];
  const report = blank();
  await discover({
    provider: async () => ({ action: decisions.shift(), tokens: 20 }),
    browser: {
      ...fakeBrowser(),
      reproduce: async () => {
        reproductions++;
        return { status: 'reproduced', observation };
      },
    },
    report,
    signal,
  });
  assert.equal(reproductions, 1);
  assert.equal(report.findings.length, 1);
  assert.ok(report.events.some(e => e.outcome === 'Already reported.'));
});

test('discovery chooses goals through decisions, rejects unsupported reports and never treats finish as release approval', async () => {
  const decisions = [
    action('finish'),
    action('investigate', { title: 'Understand the home page' }),
    action('report', { title: 'Missing welcome', expectation: 'text_present', text: 'Welcome' }),
    action('reload'),
    action('verify', { target: 'welcome' }),
    action('report_check', { title: 'Unexpected welcome', target: 'welcome' }),
    action('conclude', { value: 'refuted' }),
    action('finish'),
  ];
  const report = blank();
  await discover({
    provider: async input => {
      assert.equal(Object.hasOwn(input, 'goal'), false);
      return { action: decisions.shift(), tokens: 20 };
    },
    browser: fakeBrowser(),
    report,
    signal,
  });
  assert.equal(report.status, 'completed');
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].status, 'reproduced');
  assert.equal(report.findings[0].needsReview, true);
  assert.equal(report.investigations[0].title, 'Understand the home page');
  assert.match(report.events[0].outcome, /before finishing/);
  assert.match(report.events[2].outcome, /Rejected/);
});

test('invalid decisions, cancellation and resource exhaustion retain partial investigation evidence', async () => {
  for (const invalid of [
    null,
    action('eval'),
    { ...action('reload'), code: 'x' },
    action('fill', { value: 'x'.repeat(501) }),
    action('report', { title: 'x' }),
  ])
    assert.throws(() => validateDiscoveryAction(invalid));
  let report = blank();
  await discover({
    provider: async () => ({ action: action('reload'), tokens: 1 }),
    browser: fakeBrowser(),
    report,
    signal,
    maxRequests: 2,
  });
  assert.equal(report.status, 'budget-exhausted');
  assert.equal(report.events.length, 2);
  report = blank();
  await discover({
    provider: async () => ({ action: action('reload'), tokens: 100001 }),
    browser: fakeBrowser(),
    report,
    signal,
  });
  assert.equal(report.status, 'budget-exhausted');
  assert.equal(report.events.length, 0);
  report = blank();
  let calls = 0;
  await discover({
    provider: async () => {
      calls++;
      return { action: action('reload'), tokens: 100000 };
    },
    browser: fakeBrowser(),
    report,
    signal,
  });
  assert.equal(report.status, 'budget-exhausted');
  assert.equal(calls, 1);
  report = blank();
  await discover({
    provider: async () => {
      throw new Error('Provider unavailable');
    },
    browser: fakeBrowser(),
    report,
    signal,
  });
  assert.equal(report.status, 'inconclusive');
  assert.equal(report.observations.length, 1);
  assert.equal(report.requests, 1);
  report = blank();
  await discover({ provider: async () => assert.fail(), browser: fakeBrowser(), report, signal: AbortSignal.abort() });
  assert.equal(report.status, 'canceled');
});

test('independent expectations distinguish missing evidence from observed mismatches', () => {
  assert.equal(
    evaluateExpectation(action('report', { expectation: 'text_present', text: 'Welcome' }), observation).passed,
    true,
  );
  assert.equal(
    evaluateExpectation(action('report', { expectation: 'text_present', text: 'Missing' }), {
      ...observation,
      textTruncated: true,
    }).evaluable,
    false,
  );
  assert.equal(
    evaluateExpectation(action('report', { expectation: 'no_server_error' }), {
      ...observation,
      serverErrors: [{ status: 500 }],
    }).passed,
    false,
  );
});

test('Responses request has no predefined goal, caps output, disables storage and requires token accounting', async () => {
  let payload;
  const provider = discoveryProvider({
    apiKey: 'test-secret',
    model: 'test-model',
    fetchImpl: async (url, request) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      payload = JSON.parse(request.body);
      return {
        ok: true,
        json: async () => ({
          status: 'completed',
          usage: { total_tokens: 17 },
          output: [
            { type: 'function_call', name: 'investigate_application', arguments: JSON.stringify(action('reload')) },
          ],
        }),
      };
    },
  });
  const input = { observation, history: [], investigations: [], memory: [], remaining: {}, signal };
  assert.equal((await provider(input)).tokens, 17);
  assert.equal(payload.store, false);
  assert.equal(payload.tools[0].strict, true);
  assert.equal(payload.max_output_tokens, 2000);
  assert.equal(Object.hasOwn(JSON.parse(payload.input), 'goal'), false);
  const failing = discoveryProvider({
    apiKey: 'test-secret',
    model: 'test-model',
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  await assert.rejects(failing(input), /HTTP 401/);
});

test('exploration policy cannot approve releases or execute predefined suites; cleanup always runs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-discover-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.doesNotThrow(() => validatePolicy(discoveryPolicy().definition));
  const calls = [];
  const run = await executeDiscovery({
    repo: root,
    output: root,
    provider: async () => ({ action: action('reload'), tokens: 1 }),
    adapterFactory: () =>
      Object.fromEntries(
        ['snapshot', 'docker', 'build', 'database', 'deploy', 'cleanup'].map(id => [
          id,
          async () => {
            calls.push(id);
            if (id === 'build') throw new Error('Build unavailable');
          },
        ]),
      ),
  });
  assert.deepEqual(calls, ['snapshot', 'docker', 'build', 'cleanup']);
  assert.equal(evaluateRelease(run.data).status, 'not-applicable');
  assert.equal(run.data.release.eligible, false);
});

test('exploration persists partial reports, safely redacts JSON and cleans up after provider failure', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-discovery-partial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let closed = false,
    cleaned = false;
  const run = await executeDiscovery({
    repo: root,
    output: root,
    provider: async () => {
      throw new Error('Provider failed');
    },
    adapterFactory: run => ({
      snapshot: async () => {
        run.data.candidate = { source: '/app', revision: 'a'.repeat(40) };
      },
      docker: async () => {},
      build: async () => {},
      database: async () => {},
      deploy: async () => {},
      discoveryFixture: async () => [],
      cleanup: async () => {
        cleaned = true;
      },
    }),
    browserFactory: async () => ({
      ...fakeBrowser(),
      observe: async () => ({ ...observation, text: 'Cookie: synthetic-secret' }),
      close: async () => {
        closed = true;
      },
    }),
  });
  const report = await readDiscovery(root, run.data);
  assert.equal(report.status, 'inconclusive');
  assert.equal(report.observations[0].text, 'Cookie: [REDACTED]');
  assert.equal(closed, true);
  assert.equal(cleaned, true);
  assert.equal(run.data.results.find(r => r.id === 'discovery').status, 'inconclusive');
});

test('exploration redacts secrets from the persisted summary and the check result', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-discovery-summary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await executeDiscovery({
    repo: root,
    output: root,
    provider: async () => ({ action: action('reload'), tokens: 1 }),
    adapterFactory: run => ({
      snapshot: async () => {
        run.data.candidate = { source: '/app', revision: 'a'.repeat(40) };
      },
      docker: async () => {},
      build: async () => {},
      database: async () => {},
      deploy: async () => {},
      discoveryFixture: async () => [],
      cleanup: async () => {},
    }),
    browserFactory: async () => {
      throw new Error('Launch failed: http://127.0.0.1/cb?token=abc123secret');
    },
  });
  const report = await readDiscovery(root, run.data);
  assert.doesNotMatch(report.summary, /abc123secret/);
  assert.doesNotMatch(run.data.results.find(r => r.id === 'discovery').summary, /abc123secret/);
});

test('verified memory crosses runs only within a repository; hypotheses remain reviewable and corrupt evidence is excluded', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-discover-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await Run.create(root, { mode: 'exploration' }, ['discovery'], discoveryPolicy());
  run.data.candidate = { source: '/app', revision: 'a'.repeat(40) };
  const report = {
    ...blank(),
    version: 1,
    runId: run.data.id,
    ...run.data.candidate,
    status: 'completed',
    summary: 'Explore settings next',
    pages: [{ path: '/', title: 'Home', visitedBy: ['guest'] }],
    findings: [
      { id: 'finding', title: 'Unexpected text', basis: 'UI promised otherwise', path: '/', status: 'observed' },
    ],
  };
  await run.step('discovery', async result => {
    result.evidence.push(await run.evidence('discovery.json', JSON.stringify(report)));
  });
  await run.finish();
  assert.equal((await readDiscovery(root, run.data)).summary, report.summary);
  assert.equal((await discoveryMemory(root, [run.data], { source: '/different' })).memory.length, 0);
  assert.equal((await discoveryMemory(root, [run.data], { source: '/app' })).memory.length, 1);
  const findings = await collectFindings(root, [run.data]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, 'Agent hypothesis');
  assert.equal(findings[0].latestCheckPassed, false);
  await writeFile(path.join(run.dir, 'evidence/discovery.json'), '{}');
  assert.equal((await discoveryMemory(root, [run.data], { source: '/app' })).warnings.length, 1);
  assert.equal((await collectFindings(root, [run.data])).length, 0);
});

test('changed screenshots invalidate discovery findings and carried memory even when report JSON is intact', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-discovery-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await Run.create(root, { mode: 'exploration' }, ['discovery'], discoveryPolicy());
  run.data.candidate = { source: '/app', revision: 'a'.repeat(40) };
  const report = {
    ...blank(),
    version: 1,
    runId: run.data.id,
    ...run.data.candidate,
    status: 'completed',
    findings: [{ id: 'finding', title: 'Unexpected text', basis: 'Observed UI', status: 'observed' }],
  };
  await run.step('discovery', async result => {
    result.evidence.push(await run.evidence('discovery.json', JSON.stringify(report)));
    result.evidence.push(await run.evidence('discovery-o1.png', 'Synthetic screenshot'));
  });
  await run.finish();
  assert.equal((await collectFindings(root, [run.data])).length, 1);
  await writeFile(path.join(run.dir, 'evidence/discovery-o1.png'), 'Replaced screenshot');
  await assert.rejects(readDiscovery(root, run.data), /supporting evidence is invalid/);
  assert.equal((await collectFindings(root, [run.data])).length, 0);
  const carried = await discoveryMemory(root, [run.data], run.data.candidate);
  assert.equal(carried.memory.length, 0);
  assert.equal(carried.warnings.length, 1);
});

test('invalid request caps fail before provisioning or provider configuration', async () => {
  for (const maxRequests of [0, -1, 41, 1.5, NaN])
    await assert.rejects(executeDiscovery({ maxRequests }), /request limit/);
});

test('provider rejection usage is accounted and unknown usage stays explicit', async () => {
  for (const known of [false, true]) {
    const report = blank();
    await discover({
      report,
      browser: fakeBrowser(),
      signal,
      provider: async () => {
        throw Object.assign(new Error('Invalid model action.'), known ? { tokens: 29 } : {});
      },
    });
    assert.equal(report.status, 'inconclusive');
    assert.equal(report.requests, 1);
    assert.equal(report.tokens, known ? 29 : 0);
    assert.equal(Boolean(report.usageIncomplete), !known);
  }
});
