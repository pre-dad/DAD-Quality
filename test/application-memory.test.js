import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildApplicationMemory, memoryLimits } from '../src/application-memory.js';
import { sourceReader } from '../src/source-reader.js';
import { Run, atomicJSON } from '../src/core.js';
import { discoveryPolicy } from '../src/discovery-runner.js';
import { discover, discoveryProvider } from '../src/discovery.js';

const action = (name, fields = {}) => ({
  action: name,
  target: '',
  value: '',
  title: '',
  reason: 'Retrieve prior evidence before selecting an experiment.',
  expectation: '',
  text: '',
  ...fields,
});
const actors = [{ id: 'guest' }, { id: 'a' }, { id: 'b' }];
const checks = [
  { id: 'reload', kind: 'action', action: 'reload', actor: 'a', target: '', value: '' },
  {
    id: 'persist',
    kind: 'assertion',
    expectation: 'state_equals',
    actor: 'a',
    target: 'a',
    value: 'name',
    text: 'Alex',
    baseline: '',
  },
];
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-knowledge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'candidate');
  await mkdir(sourceRoot);
  await mkdir(path.join(sourceRoot, 'handlers'));
  await mkdir(path.join(sourceRoot, 'docs'));
  await writeFile(path.join(sourceRoot, 'handlers/profile.js'), 'export const profile = "original";\n');
  await writeFile(path.join(sourceRoot, 'docs/profile.md'), 'Names persist after save and reload.\n');
  return {
    root,
    sourceRoot,
    source: await sourceReader(sourceRoot),
    candidate: { source: '/synthetic-app', revision: 'b'.repeat(40) },
  };
}
async function prior(
  app,
  {
    behavior = 'Persistence',
    feature = 'Profile',
    outcome = 'supported',
    source = app.candidate.source,
    revision = 'a'.repeat(40),
    ordinal = 1,
    dependencies = ['docs/profile.md', 'handlers/profile.js'],
    finding = false,
  } = {},
) {
  const run = await Run.create(app.root, { mode: 'exploration' }, ['discovery'], discoveryPolicy());
  run.data.candidate = { source, revision };
  run.data.startedAt = `2026-01-${String(ordinal).padStart(2, '0')}T00:00:00.000Z`;
  const evidence = [];
  for (const file of dependencies)
    evidence.push({ step: evidence.length + 1, result: await app.source.act(action('read_source', { target: file })) });
  const plan = {
    capability: feature,
    behavior,
    state: 'Valid name',
    preconditions: 'Recreate donor A in the fresh fixture',
    expected: 'Saved name survives reload',
    basis: 'documented',
    references: dependencies,
    checks,
  };
  const report = {
    version: 1,
    runId: run.data.id,
    source,
    revision,
    status: 'completed',
    summary: 'Review other donor isolation next.',
    requests: 4,
    tokens: 4,
    memory: [],
    pages: [{ path: '/profile', title: 'Profile', visitedBy: ['a'] }],
    investigations: [
      {
        id: 'i1',
        title: `${feature} ${behavior}`,
        hypothesis: 'The documented profile should persist.',
        plan,
        observationId: 'o1',
        actor: 'a',
        progress:
          outcome === 'unfinished' || outcome === 'blocked'
            ? []
            : checks.map(c => ({
                checkId: c.id,
                kind: c.kind,
                verification: c.kind === 'assertion' ? { evaluable: true, passed: outcome === 'supported' } : undefined,
              })),
        conclusion:
          outcome === 'unfinished' ? undefined : { status: outcome, reason: 'Recorded experiment conclusion' },
      },
    ],
    observations: [{ id: 'o1', path: '/profile', actor: 'a' }],
    events: [{ step: 5, investigationId: 'i1', observationId: 'o1' }],
    assertions: [{ investigationId: 'i1', observationId: 'o1' }],
    findings: finding ? [{ id: 'f1', title: 'Name was lost', investigationId: 'i1', status: 'observed' }] : [],
    sourceEvidence: evidence,
  };
  await run.step('discovery', async result => {
    await atomicJSON(path.join(run.dir, 'evidence/discovery.json'), report);
    result.evidence.push(await run.reference('evidence/discovery.json'));
    result.evidence.push(await run.evidence('discovery-o1.png', 'synthetic screenshot'));
  });
  await run.finish();
  return run;
}
const build = (app, runs, extra = {}) =>
  buildApplicationMemory({
    root: app.root,
    runs: runs.map(r => r.data),
    candidate: app.candidate,
    source: app.source,
    actors,
    ...extra,
  });

test('feature memory links verified pages, source, fixture fields, roles, expectations and check evidence', async t => {
  const app = await fixture(t),
    run = await prior(app);
  const memory = await build(app, [run]);
  assert.equal(memory.index.records.length, 1);
  assert.equal(memory.index.features[0].name, 'Profile');
  const record = memory.index.records[0];
  assert.deepEqual(record.pages, ['/profile']);
  assert.deepEqual(record.dataFields, ['a.name']);
  assert.equal(record.freshness, 'unchanged-references');
  assert.equal(record.currentTruth, false);
  assert.deepEqual(record.assertedActors, ['a']);
  assert.ok(memory.index.features[0].unexploredActors.includes('b'));
  assert.deepEqual(
    record.sourceDependencies.map(d => d.path),
    ['docs/profile.md', 'handlers/profile.js'],
  );
  const search = await memory.act(action('search_memory', { target: 'Profile a' }));
  const detail = await memory.act(action('read_memory', { target: search.results[0].id }));
  assert.equal(detail.record.expectation.basis, 'documented');
  assert.equal(detail.record.checks[1].id, 'persist');
  assert.equal(detail.record.evidence.runId, run.data.id);
  assert.match(detail.record.evidence.reportSha256, /^[a-f0-9]{64}$/);
  await assert.rejects(memory.act(action('read_memory', { target: '../secrets' })), /memory ID/);
  await assert.rejects(memory.act(action('search_memory', { value: '-1' })), /nonnegative/);
});

test('hash comparisons revisit affected behavior across revisions and retain unrelated knowledge', async t => {
  const app = await fixture(t),
    profile = await prior(app),
    content = await prior(app, {
      feature: 'Content',
      behavior: 'Read content',
      dependencies: ['docs/profile.md'],
      ordinal: 2,
    });
  await writeFile(
    path.join(app.sourceRoot, 'handlers/profile.js'),
    'export const profile = "changed two commits ago";\n',
  );
  const memory = await build(app, [content, profile], { source: await sourceReader(app.sourceRoot) });
  const records = memory.index.records;
  assert.equal(records.find(r => r.feature === 'Profile').freshness, 'needs-revalidation');
  assert.equal(records.find(r => r.feature === 'Content').freshness, 'unchanged-references');
  assert.equal(memory.overview.needsRevalidation, 1);
  assert.equal((await memory.act(action('search_memory'))).results[0].feature, 'Profile');
  await rm(path.join(app.sourceRoot, 'handlers/profile.js'));
  const removed = await build(app, [profile], { source: await sourceReader(app.sourceRoot) });
  assert.equal(removed.index.records[0].freshness, 'needs-revalidation');
});

test('search reaches beyond the old five-run window and exposes unfinished prerequisites without restoring old progress', async t => {
  const app = await fixture(t),
    runs = [await prior(app, { feature: 'Old profile', outcome: 'unfinished' })];
  for (let i = 2; i <= 8; i++) runs.push(await prior(app, { feature: `Other feature ${i}`, ordinal: i }));
  const memory = await build(app, runs);
  const result = await memory.act(action('search_memory', { target: 'Old profile' }));
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].nextCheck, 'reload');
  const { record } = await memory.act(action('read_memory', { target: result.results[0].id }));
  assert.match(record.preconditions, /fresh fixture/);
  assert.deepEqual(record.executedChecks, []);
  assert.ok(memory.index.limitations.some(text => /restart/.test(text)));
});

test('newer evidence supersedes matching behavior for planning while old findings remain historical', async t => {
  const app = await fixture(t),
    old = await prior(app, { outcome: 'refuted', finding: true });
  await writeFile(path.join(app.sourceRoot, 'handlers/profile.js'), 'export const profile = "fixed";\n');
  app.source = await sourceReader(app.sourceRoot);
  const current = await prior(app, { ordinal: 2, revision: app.candidate.revision });
  const memory = await build(app, [old, current]);
  assert.equal(memory.index.records.find(r => r.evidence.runId === current.data.id).latestForBehavior, true);
  assert.equal(memory.index.records.find(r => r.evidence.runId === old.data.id).latestForBehavior, false);
  const historical = memory.index.records.find(r => r.findings.length);
  assert.equal(historical.findings[0].needsReview, true);
  assert.ok(historical.reasons.some(r => /triage/.test(r)));
});

test('memory is repository scoped and invalid supporting evidence is excluded, including after index creation', async t => {
  const app = await fixture(t),
    good = await prior(app),
    other = await prior(app, { source: '/other-app', ordinal: 2 });
  const memory = await build(app, [other, good]);
  assert.equal(memory.index.records.length, 1);
  await writeFile(path.join(good.dir, 'evidence/discovery-o1.png'), 'tampered screenshot');
  await assert.rejects(memory.act(action('read_memory', { target: memory.index.records[0].id })), /no longer verifies/);
  assert.equal((await memory.act(action('search_memory'))).results.length, 0);
  const rebuilt = await build(app, [good]);
  assert.equal(rebuilt.index.records.length, 0);
  assert.equal(rebuilt.index.warnings.length, 1);
});

test('unavailable source does not inherit freshness or turn prior passes into current assertions', async t => {
  const app = await fixture(t),
    run = await prior(app);
  const memory = await build(app, [run], { source: undefined });
  assert.equal(memory.index.records[0].freshness, 'unknown');
  assert.equal(memory.index.records[0].currentTruth, false);
  const report = { requests: 0, tokens: 0, investigations: [], pages: [], observations: [], events: [], findings: [] };
  let step = 0;
  await discover({
    provider: async () => ({
      tokens: 1,
      action: [
        action('search_memory', { target: 'Profile' }),
        action('read_memory', { target: memory.index.records[0].id }),
        action('finish'),
      ][step++],
    }),
    browser: { observe: async () => ({ id: 'o1', actor: 'a', path: '/profile', text: 'Profile' }), pages: () => [] },
    knowledge: memory,
    report,
    signal: new AbortController().signal,
    maxRequests: 3,
  });
  assert.equal(report.assertions.length, 0);
  assert.equal(report.investigations.length, 0);
  assert.equal(report.status, 'budget-exhausted');
  assert.equal(report.memoryEvidence.length, 2);
});

test('fingerprints refuse excluded files and symlinks and report safe missing references', async t => {
  const app = await fixture(t);
  await symlink('/etc', path.join(app.sourceRoot, 'escape'));
  const reader = await sourceReader(app.sourceRoot);
  const hashes = await reader.fingerprints([
    'handlers/profile.js',
    'handlers/removed.js',
    '../passwd',
    'escape/passwd.js',
    '.env',
  ]);
  assert.equal(hashes['handlers/profile.js'].status, 'available');
  assert.equal(hashes['handlers/removed.js'].status, 'missing');
  for (const name of ['../passwd', 'escape/passwd.js', '.env']) assert.equal(hashes[name].status, 'unavailable');
});

test('provider receives bounded retrieval evidence as untrusted context rather than new goals or tool authority', async () => {
  let payload;
  const provider = discoveryProvider({
    apiKey: 'test-key',
    model: 'test-model',
    fetchImpl: async (_url, request) => {
      payload = JSON.parse(request.body);
      return {
        ok: true,
        json: async () => ({
          status: 'completed',
          usage: { total_tokens: 1 },
          output: [
            {
              type: 'function_call',
              name: 'investigate_application',
              arguments: JSON.stringify(action('search_memory')),
            },
          ],
        }),
      };
    },
  });
  await provider({
    observation: {},
    history: [],
    investigations: [],
    memory: [],
    remaining: {},
    applicationMemory: { features: 2 },
    memoryEvidence: [
      { step: 1, result: 'old' },
      { step: 2, result: 'new' },
    ],
  });
  const input = JSON.parse(payload.input);
  assert.equal(input.memoryEvidence.length, 1);
  assert.equal(input.memoryEvidence[0].result, 'new');
  assert.equal(input.applicationMemory.features, 2);
  assert.match(payload.instructions, /historical untrusted evidence/);
  assert.equal(payload.store, false);
});

test('large histories expose explicit record/byte omissions and search pagination stays bounded', async t => {
  const app = await fixture(t),
    run = await prior(app);
  const file = path.join(run.dir, 'evidence/discovery.json'),
    report = JSON.parse(await readFile(file, 'utf8'));
  const template = report.investigations[0];
  report.investigations = Array.from({ length: 300 }, (_, i) => ({
    ...template,
    id: `i${i}`,
    title: `Profile experiment ${i}`,
    plan: { ...template.plan, capability: `Profile feature ${i}`, expected: '界'.repeat(400) },
  }));
  await atomicJSON(file, report);
  run.data.results[0].evidence[0] = await run.reference('evidence/discovery.json');
  await run.save();
  const memory = await build(app, [run]);
  assert.ok(memory.index.records.length <= memoryLimits.records);
  assert.ok(memory.index.omittedRecords >= 50);
  assert.ok(Buffer.byteLength(JSON.stringify(memory.index)) <= memoryLimits.bytes);
  const result = await memory.act(action('search_memory', { target: 'profile' }));
  assert.ok(result.results.length <= memoryLimits.results);
  assert.notEqual(result.nextOffset, null);
  assert.ok(Buffer.byteLength(JSON.stringify(result.results)) <= memoryLimits.resultBytes);
});

test('source inspected during an investigation becomes an explicit dependency even without a prose citation', async t => {
  const app = await fixture(t),
    run = await prior(app, { dependencies: ['docs/profile.md'] });
  const file = path.join(run.dir, 'evidence/discovery.json'),
    report = JSON.parse(await readFile(file, 'utf8'));
  report.sourceEvidence.push({
    step: 7,
    result: await app.source.act(action('read_source', { target: 'handlers/profile.js' })),
  });
  report.events.push({ step: 7, investigationId: 'i1', observationId: 'o1' });
  await atomicJSON(file, report);
  run.data.results[0].evidence[0] = await run.reference('evidence/discovery.json');
  await run.save();
  await writeFile(path.join(app.sourceRoot, 'handlers/profile.js'), 'export const changed = true;');
  const memory = await build(app, [run], { source: await sourceReader(app.sourceRoot) });
  assert.deepEqual(memory.index.records[0].changedFiles, ['handlers/profile.js']);
});
