import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { get as httpGet } from 'node:http';
import { Run, RunError } from '../src/core.js';
import { Dashboard, createDashboardServer, resolveRevision } from '../src/dashboard.js';
import { collectFindings, compareRuns, listRuns, normalizeFailure, readRun } from '../src/history.js';

const SHA = 'a'.repeat(40);
async function directory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-dashboard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
export async function fixture(
  root,
  {
    status = 'failed',
    startedAt = '2026-10-09T12:00:00.000Z',
    summary = 'Expected authorization rejection.',
    log = '--- FAIL: TestAuthorization (0.03s)\nExpected 403, received 200',
  } = {},
) {
  const run = await Run.create(root, { adapter: 'impactgraph', trigger: 'fixture' }, ['api-tests']);
  run.data.startedAt = startedAt;
  run.data.candidate = { revision: SHA, source: '/synthetic/DAD-Main' };
  await run.step('api-tests', async result => {
    result.evidence.push(await run.evidence('api-tests.log', log));
    if (status !== 'passed') throw new RunError(summary, status);
  });
  await run.finish();
  return run;
}

test('findings deduplicate test failures across runs and preserve assessments', async t => {
  const root = await directory(t);
  const first = await fixture(root),
    second = await fixture(root, {
      startedAt: '2026-10-09T13:00:00.000Z',
      log: '--- FAIL: TestAuthorization (0.20s)\nExpected 403, received 200',
    });
  const { runs } = await listRuns(root);
  let findings = await collectFindings(root, runs);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].occurrences.length, 2);
  const id = findings[0].id;
  findings = await collectFindings(root, runs, {
    [id]: {
      disposition: 'resolved',
      updatedAt: '2026-10-09T12:30:00.000Z',
      severity: 'high',
      note: 'Previous fix.',
      audit: [],
    },
  });
  assert.equal(findings[0].disposition, 'reopened');
  assert.equal(findings[0].severity, 'high');
  assert.equal((await readRun(root, first.data.id)).decision.status, 'failed');
  assert.equal(compareRuns(second.data, first.data).changes.length, 0);
  const third = await fixture(root, { status: 'passed', startedAt: '2026-10-09T14:00:00.000Z' });
  assert.equal(compareRuns(third.data, second.data).changes[0].improved, true);
  assert.equal((await collectFindings(root, (await listRuns(root)).runs))[0].latestCheckPassed, true);
});

test('failure fingerprints ignore ephemeral host ports and run IDs', () => {
  assert.equal(
    normalizeFailure('http://staff.localhost:43100 atm-20261009120000-aaaaaaaa'),
    normalizeFailure('http://staff.localhost:49999 atm-20261009130000-bbbbbbbb'),
  );
});

test('dashboard rejects cross-origin writes, forged hosts, and invalid revisions', async t => {
  const root = await directory(t);
  const app = await createDashboardServer({ repo: '/synthetic/DAD-Main', root, port: 0 });
  t.after(app.close);
  const snapshot = await (await fetch(`${app.origin}/api/state`)).json();
  assert.equal(
    (
      await fetch(`${app.origin}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${app.origin}/api/watch`, {
        method: 'PATCH',
        headers: {
          Origin: 'https://attacker.invalid',
          'X-ATM-Token': snapshot.csrf,
          'Content-Type': 'application/json',
        },
        body: '{}',
      })
    ).status,
    403,
  );
  const forgedHostStatus = await new Promise((resolve, reject) => {
    httpGet(`${app.origin}/api/state`, { headers: { Host: 'attacker.invalid' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal(
    (
      await fetch(`${app.origin}/api/watch`, {
        method: 'PATCH',
        headers: { Origin: app.origin, 'X-ATM-Token': 'é'.repeat(64), 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  await assert.rejects(resolveRevision('/synthetic', '--help'), error => error.status === 400);
  await assert.rejects(resolveRevision('/synthetic', 'HEAD;rm -rf /'), error => error.status === 400);
});

test('run control pins revision, rejects concurrent launches and cancels through the runner', async t => {
  const root = await directory(t);
  let received;
  const app = await createDashboardServer({
    repo: '/synthetic/DAD-Main',
    root,
    port: 0,
    resolve: async () => SHA,
    executor: async options => {
      received = options;
      const run = await Run.create(root, {}, ['cleanup']);
      options.onCreated(run);
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      await run.step('cleanup', async () => ({ summary: 'Fixture cleanup complete.' }));
      run.data.canceledAt = new Date().toISOString();
      await run.finish();
    },
  });
  t.after(app.close);
  const state = await (await fetch(`${app.origin}/api/state`)).json();
  const headers = { Origin: app.origin, 'X-ATM-Token': state.csrf, 'Content-Type': 'application/json' };
  const response = await fetch(`${app.origin}/api/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ revision: 'main', repo: '/ignored-other-repo' }),
  });
  assert.equal(response.status, 202);
  const launched = await response.json();
  assert.equal(received.revision, SHA);
  assert.equal(received.repo, '/synthetic/DAD-Main');
  assert.equal((await fetch(`${app.origin}/api/runs`, { method: 'POST', headers, body: '{}' })).status, 409);
  const completion = app.dashboard.active.completion;
  assert.equal(
    (await fetch(`${app.origin}/api/runs/${launched.id}/cancel`, { method: 'POST', headers, body: '{}' })).status,
    202,
  );
  await completion;
  assert.equal((await readRun(root, launched.id)).decision.status, 'canceled');
  assert.equal(app.dashboard.active, null);
});

test('triage persists across restarts and evidence route serves only listed regular files', async t => {
  const root = await directory(t);
  const run = await fixture(root);
  let app = await createDashboardServer({ repo: '/synthetic/DAD-Main', root, port: 0 });
  let state = await (await fetch(`${app.origin}/api/state`)).json();
  const id = state.findings[0].id;
  const headers = { Origin: app.origin, 'X-ATM-Token': state.csrf, 'Content-Type': 'application/json' };
  assert.equal(
    (
      await fetch(`${app.origin}/api/findings/${id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ disposition: 'resolved', severity: 'high', note: '' }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(`${app.origin}/api/findings/${id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ disposition: 'confirmed', severity: 'high', note: 'Reproduced in the fixture.' }),
      })
    ).status,
    200,
  );
  assert.equal((await fetch(`${app.origin}/evidence/${run.data.id}/compose.json`)).status, 404);
  assert.equal((await fetch(`${app.origin}/api/runs/atm-00000000000000-00000000`)).status, 404);
  assert.equal((await fetch(`${app.origin}/api/runs/not-a-run-id`)).status, 404);
  assert.equal((await fetch(`${app.origin}/evidence/${run.data.id}/api-tests.log`)).status, 200);
  const original = await readFile(path.join(run.dir, 'run.json'), 'utf8');
  await app.close();
  app = await createDashboardServer({ repo: '/synthetic/DAD-Main', root, port: 0 });
  t.after(app.close);
  state = await (await fetch(`${app.origin}/api/state`)).json();
  assert.equal(state.findings[0].severity, 'high');
  assert.equal(state.findings[0].audit.length, 1);
  assert.equal(await readFile(path.join(run.dir, 'run.json'), 'utf8'), original);
  await rm(path.join(run.dir, 'evidence/api-tests.log'));
  await symlink(path.join(run.dir, 'run.json'), path.join(run.dir, 'evidence/api-tests.log'));
  assert.equal((await fetch(`${app.origin}/evidence/${run.data.id}/api-tests.log`)).status, 413);
});

test('commit watch baselines current revision, runs only new commits and survives restart', async t => {
  const root = await directory(t);
  let head = SHA,
    executions = 0;
  const options = {
    repo: '/synthetic/DAD-Main',
    root,
    resolve: async () => head,
    executor: async options => {
      executions++;
      const run = await Run.create(root, {}, ['check']);
      options.onCreated(run);
      await run.step('check', async () => ({}));
      await run.finish();
    },
  };
  let dashboard = new Dashboard(options);
  await dashboard.initialize();
  await dashboard.setWatch(true, 'main');
  await dashboard.tick();
  assert.equal(executions, 0);
  head = 'b'.repeat(40);
  await dashboard.tick();
  await dashboard.active?.completion;
  assert.equal(executions, 1);
  await dashboard.tick();
  assert.equal(executions, 1);
  await dashboard.close();
  dashboard = new Dashboard(options);
  await dashboard.initialize();
  t.after(() => dashboard.close());
  await dashboard.tick();
  assert.equal(executions, 1);
  assert.equal(dashboard.state.watch.enabled, true);
  await dashboard.setWatch(false);
  head = 'c'.repeat(40);
  await dashboard.tick();
  assert.equal(executions, 1);
});

// Phase 2: the dashboard is target-aware. A non-dad target explores only, labels its
// own profile, and threads target + configFile into the explorer.
test('a generic-web dashboard labels its profile, refuses validation, and threads target into explore', async t => {
  const root = await directory(t);
  let seen = null;
  const dashboard = new Dashboard({
    repo: '/synthetic/some-app',
    root,
    target: 'generic-web',
    configFile: 'custom.config.json',
    model: 'test-model',
    resolve: async () => SHA,
    explorer: async options => {
      seen = options;
      const run = await Run.create(root, { mode: 'exploration' }, ['discovery']);
      options.onCreated(run);
      await run.step('discovery', async () => ({}));
      await run.finish();
    },
  });
  await dashboard.initialize();
  t.after(() => dashboard.close());

  const snapshot = await dashboard.snapshot();
  assert.equal(snapshot.project.target, 'generic-web');
  assert.equal(snapshot.project.profile, 'generic-web · discovery');

  await assert.rejects(
    dashboard.start({ mode: 'validation' }),
    /Release validation is available only for the dad target/,
  );

  // Exploration requires a configured model; provide a dummy key for this assertion.
  const priorKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  t.after(() => {
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
  });
  await dashboard.start({ mode: 'exploration' });
  await dashboard.active?.completion;
  assert.equal(seen.target, 'generic-web');
  assert.equal(seen.configFile, 'custom.config.json');
});

test('an unknown dashboard target is rejected at construction', () => {
  assert.throws(() => new Dashboard({ repo: '/synthetic/x', target: 'nope' }), /Unknown target: nope/);
});
