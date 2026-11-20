import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, symlink, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { Run, digest } from '../src/core.js';
import { loadPolicy } from '../src/policy.js';
import { assessRelease } from '../src/release.js';
import {
  emptyLedger,
  validateLedger,
  prepareProposal,
  publishProposal,
  decryptBundle,
  extractBundle,
  mergeFindings,
} from '../src/ci.js';

const source = 'github:example/DAD-Main',
  revision = 'a'.repeat(40);
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const checkResult = (run, id) => run.results.find(r => r.id === id);
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-ci-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = await loadPolicy();
  const run = await Run.create(
    root,
    { revision },
    policy.definition.checks.filter(c => c.required).map(c => c.id),
    policy,
  );
  run.data.candidate = {
    source,
    revision,
    sourceArchiveSha256: 'b'.repeat(64),
    images: { api: `sha256:${'c'.repeat(64)}`, web: `sha256:${'d'.repeat(64)}` },
  };
  for (const check of policy.definition.checks) {
    const evidence = [];
    for (const name of check.evidence) evidence.push(await run.evidence(name, 'private synthetic detail'));
    run.data.results.push({
      id: check.id,
      status: 'passed',
      summary: 'private synthetic detail',
      finishedAt: run.data.startedAt,
      evidence,
    });
  }
  await run.finish();
  const ledger = emptyLedger(source);
  const prepare = (state = ledger) =>
    prepareProposal({ run, ledger: state, publicKey: keys.publicKey, execution: '100:1' });
  const publish = (result, extra = {}) =>
    publishProposal({
      ledger,
      ...result,
      source,
      execution: '100:1',
      revision,
      artifactId: '200',
      artifactDigest: 'e'.repeat(64),
      ...extra,
    });
  return { root, run, ledger, prepare, publish };
}

test('CI encrypts only declared evidence and publishes a candidate-bound receipt', async t => {
  const { root, run, prepare, publish } = await fixture(t);
  await writeFile(path.join(run.dir, 'compose.json'), 'never upload credentials');
  await writeFile(path.join(run.dir, 'source.tar'), 'never upload source');
  const result = await prepare();
  assert.equal(result.proposal.eligible, true);
  assert.ok(!result.bundle.includes('private synthetic detail'));
  assert.ok(!JSON.stringify(result.proposal).includes('private synthetic detail'));
  const decoded = decryptBundle(result.bundle, keys.privateKey);
  assert.equal(decoded.files['compose.json'], undefined);
  assert.equal(decoded.files['source.tar'], undefined);
  assert.equal(Buffer.from(decoded.files['evidence/candidate.json'], 'base64').toString(), 'private synthetic detail');
  const ledger = publish(result);
  assert.equal(ledger.sequence, 1);
  assert.equal(ledger.receipts[0].eligible, true);
  assert.equal(ledger.receipts[0].bundleSha256, digest(result.bundle));
  const output = path.join(root, 'decrypted');
  await extractBundle(result.bundle, keys.privateKey, output);
  assert.equal(await readFile(path.join(output, 'evidence/candidate.json'), 'utf8'), 'private synthetic detail');
  assert.equal((await assessRelease(root, run.data, { directory: output })).eligible, true);
  await assert.rejects(extractBundle(result.bundle, keys.privateKey, output), /EEXIST/);
});

test('encrypted evidence rejects corruption and the wrong recipient', async t => {
  const { prepare } = await fixture(t);
  const { bundle } = await prepare();
  const altered = JSON.parse(bundle);
  const bytes = Buffer.from(altered.data, 'base64');
  bytes[0] ^= 1;
  altered.data = bytes.toString('base64');
  assert.throws(() => decryptBundle(JSON.stringify(altered), keys.privateKey));
  const wrong = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => decryptBundle(bundle, wrong.privateKey));
});

test('failed runs persist findings; a later pass cannot erase them', async t => {
  const { run, prepare, publish } = await fixture(t);
  checkResult(run.data, 'api-tests').status = 'failed';
  await run.save();
  const failed = await prepare();
  assert.equal(failed.proposal.eligible, false);
  const ledger = publish(failed);
  assert.equal(ledger.findings.length, 1);
  assert.equal(ledger.findings[0].severity, 'unassessed');
  assert.equal('title' in ledger.findings[0], false);
  checkResult(run.data, 'api-tests').status = 'passed';
  await run.save();
  const passing = await prepare(ledger);
  assert.equal(passing.proposal.eligible, false);
  assert.deepEqual(passing.proposal.findings, ledger.findings);
});

test('missing or changed evidence blocks a previously passing result', async t => {
  const { run, prepare } = await fixture(t);
  await writeFile(path.join(run.dir, 'evidence/candidate.json'), 'changed');
  assert.equal((await prepare()).proposal.eligible, false);
  await rm(path.join(run.dir, 'evidence/candidate.json'));
  const result = await prepare();
  assert.equal(result.proposal.eligible, false);
  assert.ok(decryptBundle(result.bundle, keys.privateKey).issues.length);
});

test('bundling never follows a symlink to outside evidence', async t => {
  const { root, run, prepare } = await fixture(t);
  await rm(path.join(run.dir, 'evidence'), { recursive: true });
  await mkdir(path.join(root, 'outside'));
  await symlink(path.join(root, 'outside'), path.join(run.dir, 'evidence'));
  await assert.rejects(prepare(), /symbolic link/);
});

test('publisher rejects stale state, wrong candidate, replay, missing receipt and replaced bundle', async t => {
  const { prepare, publish, ledger } = await fixture(t);
  const result = await prepare();
  for (const extra of [
    { revision: 'f'.repeat(40) },
    { source: 'github:other/repo' },
    { execution: '100:2' },
    { artifactId: '' },
    { artifactDigest: '' },
    { bundle: Buffer.from('replaced') },
    { proposal: { ...result.proposal, baseDigest: '0'.repeat(64) } },
  ])
    assert.throws(() => publish(result, extra));
  const next = publish(result);
  assert.throws(() => publish(result, { ledger: next }));
  assert.equal(ledger.sequence, 0);
});

test('invalid history fails closed, including malformed closure and duplicate findings', async t => {
  const { run, prepare, publish } = await fixture(t);
  checkResult(run.data, 'api-tests').status = 'failed';
  await run.save();
  const ledger = publish(await prepare());
  for (const change of [
    l => {
      l.schemaVersion = 0;
    },
    l => {
      delete l.findings;
    },
    l => {
      l.sequence = 0;
    },
    l => {
      l.findings.push(l.findings[0]);
    },
    l => {
      l.findings[0].disposition = 'resolved';
    },
    l => {
      l.receipts[0].artifactId = '';
    },
    l => {
      l.findings[0].title = 'accidental private detail';
    },
  ]) {
    const bad = structuredClone(ledger);
    change(bad);
    assert.throws(() => validateLedger(bad, source));
  }
});

test('resolved and dismissed findings reopen on recurrence while retries are idempotent', async t => {
  const { run, prepare, publish } = await fixture(t);
  checkResult(run.data, 'api-tests').status = 'failed';
  await run.save();
  const ledger = publish(await prepare());
  for (const disposition of ['resolved', 'dismissed']) {
    const prior = structuredClone(ledger),
      f = prior.findings[0];
    f.disposition = disposition;
    f.updatedAt = f.lastSeen;
    f.audit.push({
      at: f.lastSeen,
      actor: 'reviewer',
      disposition,
      severity: 'unassessed',
      noteDigest: 'a'.repeat(64),
    });
    assert.equal(mergeFindings(prior, [f]).findings[0].disposition, disposition);
    const next = mergeFindings(prior, [{ ...f, lastRunId: 'atm-20261010010000-12345678' }]);
    assert.equal(next.findings[0].disposition, 'reopened');
    assert.equal(next.findings[0].occurrences, 2);
  }
});

test('worker proposals cannot discard historical findings or change their severity', async t => {
  const { run, prepare, publish } = await fixture(t);
  checkResult(run.data, 'api-tests').status = 'failed';
  await run.save();
  const ledger = publish(await prepare());
  const next = await prepare(ledger);
  next.proposal.execution = '100:2';
  for (const mutate of [
    p => {
      p.findings = [];
    },
    p => {
      p.findings[0].severity = 'low';
    },
    p => {
      p.eligible = true;
    },
  ]) {
    const proposal = structuredClone(next.proposal);
    mutate(proposal);
    assert.throws(() => publish({ ...next, proposal }, { ledger, execution: '100:2' }));
  }
});
