import test from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Run, atomicJSON } from '../src/core.js';
import { loadPolicy, hashPolicy, validatePolicy } from '../src/policy.js';
import { discoveryPolicy } from '../src/discovery-runner.js';
import { evaluateRelease, assessRelease } from '../src/release.js';
import { Dashboard } from '../src/dashboard.js';
import { main } from '../src/cli.js';
import { collectFindings, listRuns } from '../src/history.js';
import { syntheticRun } from './synthetic-run.js';

const fixture = t =>
  syntheticRun(t, { prefix: 'atm-policy-', options: { adapter: 'impactgraph' }, source: '/synthetic/DAD-Main' });

test('policy rejects unsupported handlers, weakened contracts, duplicate checks and exception overrides', async () => {
  const { definition } = await loadPolicy();
  for (const [mutate, message] of [
    [
      p => {
        p.checks[0].id = 'shell';
      },
      /Unsupported check or timeout/,
    ],
    [
      p => {
        p.checks[0].evidence = [];
      },
      /Missing or invalid evidence contract: snapshot/,
    ],
    [
      p => {
        p.checks.push(p.checks[0]);
      },
      /nonempty and unique/,
    ],
    [
      p => {
        p.checks[0].required = false;
      },
      /Required foundation check missing: snapshot/,
    ],
    [
      p => {
        p.checks[0].timeoutMs = -1;
      },
      /Unsupported check or timeout/,
    ],
    [
      p => {
        p.checks.find(c => c.scenario).scenario.version = 999;
      },
      /Unsupported scenario version: staff-journey/,
    ],
    [
      p => {
        p.exceptions.mode = 'allow';
      },
      /Release exceptions are not supported/,
    ],
    [
      p => {
        p.findings.blockingSeverities = ['high'];
      },
      /Invalid blocking severities/,
    ],
    [
      p => {
        p.scope = 'production';
      },
      /Unsupported policy identity, version, adapter or scope/,
    ],
    [
      p => {
        p.checks[0].command = 'arbitrary';
      },
      /Invalid or unsupported policy fields/,
    ],
  ]) {
    const value = structuredClone(definition);
    mutate(value);
    assert.throws(() => validatePolicy(value), message);
  }
});

test('policy identity accepts any registered adapter but still rejects unregistered ones', () => {
  const base = discoveryPolicy('dad').definition;
  const registered = structuredClone(base);
  registered.adapter = 'impactgraph';
  assert.doesNotThrow(() => validatePolicy(registered));
  const unregistered = structuredClone(base);
  unregistered.adapter = 'unregistered-xyz';
  assert.throws(() => validatePolicy(unregistered), /adapter/);
});

test('effective policy snapshots distinguish advisory and required AI without altering the base file', async () => {
  const original = await loadPolicy(),
    advisory = await loadPolicy(undefined, { ai: true }),
    required = await loadPolicy(undefined, { requireAI: true });
  assert.equal(advisory.definition.checks.find(c => c.id === 'ai-public-journey').required, false);
  assert.equal(required.definition.checks.find(c => c.id === 'ai-public-journey').required, true);
  assert.equal(new Set([original.digest, advisory.digest, required.digest]).size, 3);
  assert.equal((await loadPolicy()).digest, original.digest);
  assert.equal(hashPolicy({ b: 1, a: 2 }), hashPolicy({ a: 2, b: 1 }));
});

test('completed passing policy is eligible locally and assessments are reproducible', async t => {
  const { root, run } = await fixture(t);
  const first = await assessRelease(root, run.data);
  assert.equal(first.eligible, true);
  assert.equal(first.productionAuthorized, false);
  assert.deepEqual(await assessRelease(root, run.data), first);
});

test('incomplete, canceled, forged policy and missing result evidence cannot authorize acceptance', async t => {
  const { run } = await fixture(t);
  for (const [mutate, reason] of [
    [
      r => {
        delete r.finishedAt;
      },
      'Run is incomplete.',
    ],
    [
      r => {
        r.canceledAt = r.startedAt;
      },
      'Run was canceled.',
    ],
    [
      r => {
        r.policy.definition.version = '9.0.0';
      },
      'Policy snapshot hash mismatch',
    ],
    [
      r => {
        r.required.pop();
      },
      'Required checks differ from the recorded policy',
    ],
    [
      r => {
        r.results[0].evidence = [];
      },
      'snapshot: required evidence missing or duplicated: candidate.json',
    ],
    [
      r => {
        delete r.results[0].finishedAt;
      },
      'snapshot: no completion record.',
    ],
    [
      r => {
        r.results.push(r.results[0]);
      },
      'snapshot: Missing, duplicate, or invalid result.',
    ],
    [
      r => {
        r.candidate.images = {};
      },
      'Built application image identities are missing.',
    ],
    [
      r => {
        r.policy = { version: 1 };
      },
      'Invalid or unsupported policy fields',
    ],
  ]) {
    const candidate = structuredClone(run.data);
    mutate(candidate);
    const assessment = evaluateRelease(candidate);
    assert.equal(assessment.eligible, false);
    assert.ok(
      assessment.reasons.some(r => r.includes(reason)),
      `${reason} not in ${JSON.stringify(assessment.reasons)}`,
    );
  }
});

test('missing and modified files block reassessment despite a saved passing verdict', async t => {
  const { root, run } = await fixture(t);
  run.data.release = await assessRelease(root, run.data);
  await run.save();
  const report = await readFile(path.join(run.dir, 'run.json'), 'utf8');
  await writeFile(path.join(run.dir, 'evidence/donor-verification.json'), 'changed');
  let assessment = await assessRelease(root, run.data);
  assert.equal(assessment.eligible, false);
  assert.match(assessment.reasons.join('\n'), /changed evidence/);
  await rm(path.join(run.dir, 'evidence/donor-verification.json'));
  assessment = await assessRelease(root, run.data);
  assert.match(assessment.reasons.join('\n'), /missing evidence/);
  assert.equal(await readFile(path.join(run.dir, 'run.json'), 'utf8'), report);
});

test('open findings block only their source; resolution cannot waive a failed check', async t => {
  const { run } = await fixture(t);
  const finding = {
    id: 'e'.repeat(24),
    source: run.data.candidate.source,
    severity: 'high',
    disposition: 'confirmed',
    lastSeen: run.data.startedAt,
  };
  assert.equal(evaluateRelease(run.data, { findings: [finding] }).eligible, false);
  assert.equal(evaluateRelease(run.data, { findings: [{ ...finding, source: '/different/repo' }] }).eligible, true);
  assert.equal(evaluateRelease(run.data, { findings: [{ ...finding, severity: 'unassessed' }] }).eligible, false);
  assert.equal(evaluateRelease(run.data, { findings: [{ ...finding, disposition: 'resolved' }] }).eligible, true);
  run.data.results[0].status = 'failed';
  run.data.results[0].summary = 'Snapshot failed';
  assert.equal(evaluateRelease(run.data, { findings: [{ ...finding, disposition: 'resolved' }] }).eligible, false);
});

test('CLI and dashboard agree on current assessment and leave historical evidence untouched', async t => {
  const { root, run } = await fixture(t);
  run.data.release = await assessRelease(root, run.data);
  await run.save();
  const original = await readFile(path.join(run.dir, 'run.json'), 'utf8');
  const failed = await Run.create(root, { adapter: 'impactgraph' }, ['donor-claim-journey']);
  failed.data.candidate = { ...run.data.candidate };
  failed.data.results = [
    {
      id: 'donor-claim-journey',
      status: 'failed',
      summary: 'Replay allowed',
      finishedAt: new Date().toISOString(),
      evidence: [],
    },
  ];
  await failed.finish();
  const dashboard = new Dashboard({ repo: run.data.candidate.source, root });
  await dashboard.initialize();
  t.after(() => dashboard.close());
  const detail = await dashboard.detail(run.data.id);
  assert.equal(detail.release.eligible, false);
  assert.equal(detail.run.release.eligible, true);
  const stdout = [],
    oldLog = console.log;
  let code;
  try {
    console.log = value => stdout.push(value);
    code = await main(['inspect', path.join(run.dir, 'run.json')]);
  } finally {
    console.log = oldLog;
  }
  assert.equal(code, 3);
  assert.deepEqual(JSON.parse(stdout.join('')).release, detail.release);
  const { runs } = await listRuns(root);
  const [finding] = await collectFindings(root, runs);
  await dashboard.triage(finding.id, {
    disposition: 'resolved',
    severity: 'high',
    note: 'Synthetic regression fixture resolved.',
  });
  assert.equal((await assessRelease(root, run.data)).eligible, true);
  assert.equal(await readFile(path.join(run.dir, 'run.json'), 'utf8'), original);
});

test('corrupt finding state fails closed instead of silently forgetting blockers', async t => {
  const { root, run } = await fixture(t);
  await mkdir(path.join(root, '.dashboard'));
  await atomicJSON(path.join(root, '.dashboard/state.json'), {
    triage: { bad: { disposition: 'resolved', severity: 'critical', note: '' } },
  });
  const result = await assessRelease(root, run.data);
  assert.equal(result.eligible, false);
  assert.match(result.reasons.join('\n'), /Finding assessments/);
});

test('agent hypotheses need human confirmation before affecting an otherwise eligible candidate', async t => {
  const { run } = await fixture(t);
  const hypothesis = {
    id: 'hypothesis',
    source: run.data.candidate.source,
    check: 'discovery',
    severity: 'high',
    disposition: 'untriaged',
    lastSeen: run.data.startedAt,
  };
  assert.equal(evaluateRelease(run.data, { findings: [hypothesis] }).eligible, true);
  assert.equal(evaluateRelease(run.data, { findings: [{ ...hypothesis, disposition: 'confirmed' }] }).eligible, false);
  assert.equal(evaluateRelease(run.data, { findings: [{ ...hypothesis, disposition: 'resolved' }] }).eligible, true);
  assert.equal(evaluateRelease(run.data, { findings: [{ ...hypothesis, check: 'api-tests' }] }).eligible, false);
});
