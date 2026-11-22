import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Run, RunError } from '../src/core.js';
import { collectFindings } from '../src/history.js';
import {
  planEvidenceUploads,
  planLedgerWrites,
  planRun,
  syncRun,
  repoFromSource,
  readConfig,
  isDryRun,
} from '../scripts/aws-sync-run.js';

const REPO = 'pre-dad/DAD-Main';
const SOURCE = `github:${REPO}`;
const SHA = 'a'.repeat(40);
const BUCKET = 'atm-evidence-test';
const TABLE = 'atm-findings-staging';

// Build a finished run on disk with one failing check carrying a .log evidence
// file, so collectFindings produces a stable finding. Mirrors history.test.js.
async function buildRun(root) {
  const run = await Run.create(root, {}, ['api-tests']);
  run.data.candidate = { source: SOURCE, revision: SHA };
  await run.step('api-tests', async result => {
    result.evidence = [await run.evidence('api-tests.log', '--- FAIL: TestAuthorization\nregression detected\n')];
    throw new RunError('Authorization regression', 'failed');
  });
  await run.finish();
  return run;
}

test('repoFromSource strips the github: transport prefix', () => {
  assert.equal(repoFromSource(SOURCE), REPO);
  assert.throws(() => repoFromSource('gitlab:x/y'), /Unsupported candidate.source/);
  assert.throws(() => repoFromSource(undefined), /candidate.source is required/);
});

test('readConfig reads bucket and table from the injected environment', () => {
  const env = { ATM_EVIDENCE_BUCKET: BUCKET, ATM_FINDINGS_TABLE: TABLE, ATM_ENV: 'staging' };
  assert.deepEqual(readConfig(env), { bucket: BUCKET, table: TABLE });
  assert.throws(() => readConfig({ ATM_FINDINGS_TABLE: TABLE }), /ATM_EVIDENCE_BUCKET/);
  assert.throws(() => readConfig({ ATM_EVIDENCE_BUCKET: BUCKET }), /ATM_FINDINGS_TABLE/);
});

test('evidence content types follow the extension and default to binary', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-sync-types-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await buildRun(root);
  run.data.results[0].evidence = [
    'evidence/a.log',
    'evidence/b.txt',
    'evidence/c.zip',
    'evidence/d.png',
    'evidence/e.bin',
  ].map(file => ({ path: file }));
  const types = Object.fromEntries(
    planEvidenceUploads(run.data, { bucket: BUCKET }).map(u => [u.key.split('/').pop(), u.contentType]),
  );
  assert.deepEqual(types, {
    'run.json': 'application/json',
    'report.html': 'text/html; charset=utf-8',
    'a.log': 'text/plain; charset=utf-8',
    'b.txt': 'text/plain; charset=utf-8',
    'c.zip': 'application/zip',
    'd.png': 'image/png',
    'e.bin': 'application/octet-stream',
  });
});

test('isDryRun honors ATM_SYNC_DRY_RUN', () => {
  assert.equal(isDryRun({ ATM_SYNC_DRY_RUN: '1' }), true);
  assert.equal(isDryRun({ ATM_SYNC_DRY_RUN: 'true' }), true);
  assert.equal(isDryRun({}), false);
});

test('planEvidenceUploads keys objects as <repo>/<sha>/<run-id>/<name> under the bucket', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-sync-s3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await buildRun(root);
  const uploads = planEvidenceUploads(run.data, { bucket: BUCKET, runRoot: root });
  const prefix = `${REPO}/${SHA}/${run.data.id}`;

  // Every planned object lands in the injected bucket under the design layout.
  for (const upload of uploads) assert.equal(upload.bucket, BUCKET);
  const keys = uploads.map(u => u.key);
  assert.ok(keys.includes(`${prefix}/run.json`), 'run.json uploaded');
  assert.ok(keys.includes(`${prefix}/report.html`), 'report.html uploaded');
  assert.ok(keys.includes(`${prefix}/evidence/api-tests.log`), 'evidence uploaded');
  // No key escapes the run prefix.
  for (const key of keys) assert.ok(key.startsWith(`${prefix}/`), `${key} within prefix`);
  // The planner resolves the on-disk source path for the live uploader.
  const manifest = uploads.find(u => u.key.endsWith('/run.json'));
  assert.equal(manifest.sourcePath, path.join(root, run.data.id, 'run.json'));
  assert.equal(manifest.contentType, 'application/json');

  const noSha = { ...run.data, candidate: { source: SOURCE } };
  assert.throws(() => planEvidenceUploads(noSha, { bucket: BUCKET }), /full SHA/);
});

test('planLedgerWrites builds create-if-absent + guarded reopen conditional writes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-sync-ddb-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await buildRun(root);
  const findings = await collectFindings(root, [run.data]);
  assert.ok(findings.length >= 1, 'a finding was produced');
  const writes = planLedgerWrites(findings, { table: TABLE, repo: REPO });

  for (const [index, write] of writes.entries()) {
    const finding = findings[index];
    assert.equal(write.create.TableName, TABLE);
    assert.equal(write.update.TableName, TABLE);
    // PK = source#<repo>, SK = finding#<24-char id>.
    assert.equal(write.create.Item.PK, `source#${REPO}`);
    assert.equal(write.create.Item.SK, `finding#${finding.id}`);
    assert.match(finding.id, /^[a-f0-9]{24}$/);
    assert.equal(write.update.Key.PK, `source#${REPO}`);
    assert.equal(write.update.Key.SK, `finding#${finding.id}`);
    // Create is strictly create-if-absent.
    assert.equal(write.create.ConditionExpression, 'attribute_not_exists(PK) AND attribute_not_exists(SK)');
    // The by-status GSI 'status' attribute is set on the item.
    assert.equal(write.create.Item.status, finding.disposition);
    // Update is guarded so a concurrent run cannot move lastSeen backward.
    assert.match(write.update.ConditionExpression, /attribute_exists\(PK\)/);
    assert.match(write.update.ConditionExpression, /lastSeen < :lastSeen/);
    assert.equal(write.update.ExpressionAttributeValues[':lastSeen'], finding.lastSeen);
    // The normal update must not overwrite operator triage with the run's 'untriaged'.
    assert.doesNotMatch(write.update.UpdateExpression, /disposition|#status/);
    assert.equal(write.update.ExpressionAttributeNames, undefined);
    assert.equal(write.update.ExpressionAttributeValues[':status'], undefined);
    assert.equal(write.update.ExpressionAttributeValues[':disposition'], undefined);
    // Occurrences accumulate across runs instead of being replaced by this run's count.
    assert.match(write.update.UpdateExpression, /ADD occurrences :occurrences/);
    assert.doesNotMatch(write.update.UpdateExpression, /occurrences = /);
    assert.equal(write.update.ExpressionAttributeValues[':occurrences'], finding.occurrences.length);
  }
});

test('planLedgerWrites reopens only a stored resolved or dismissed finding', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-sync-reopen-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await buildRun(root);
  const findings = await collectFindings(root, [run.data]);
  const [write] = planLedgerWrites(findings, { table: TABLE, repo: REPO });
  assert.equal(write.reopen.Key.SK, `finding#${findings[0].id}`);
  assert.match(write.reopen.ConditionExpression, /disposition IN \(:resolved, :dismissed\)/);
  assert.match(write.reopen.ConditionExpression, /lastSeen < :lastSeen/);
  assert.match(write.reopen.UpdateExpression, /reopenedAt = :lastSeen/);
  assert.equal(write.reopen.ExpressionAttributeValues[':reopened'], 'reopened');
  assert.equal(write.reopen.ExpressionAttributeValues[':resolved'], 'resolved');
  assert.equal(write.reopen.ExpressionAttributeValues[':dismissed'], 'dismissed');
});

test('syncRun reopens before it advances an existing finding and tolerates failed guards', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-sync-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await buildRun(root);
  const calls = [];
  const conditional = Object.assign(new Error('guard'), { name: 'ConditionalCheckFailedException' });
  const clients = {
    s3: { send: async () => ({}) },
    ddb: {
      send: async command => {
        calls.push(command.constructor.name);
        if (command.constructor.name === 'PutCommand') throw conditional;
        if (command.input.UpdateExpression.startsWith('SET disposition')) throw conditional;
        return {};
      },
    },
  };
  const plan = await syncRun({
    runRoot: root,
    runId: run.data.id,
    config: { bucket: BUCKET, table: TABLE },
    clients,
  });
  assert.equal(calls.length, plan.ledgerWrites.length * 3);
  assert.deepEqual(calls.slice(0, 3), ['PutCommand', 'UpdateCommand', 'UpdateCommand']);
});

test('planRun composes S3 + ledger plans from a finished run without touching AWS', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-sync-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await buildRun(root);
  const plan = await planRun({ runRoot: root, runId: run.data.id, config: { bucket: BUCKET, table: TABLE } });
  assert.equal(plan.repo, REPO);
  assert.ok(plan.uploads.length >= 3);
  assert.ok(plan.ledgerWrites.length >= 1);
  // run.json on disk is unchanged (ATM core storage is read-only here).
  const onDisk = JSON.parse(await readFile(path.join(root, run.data.id, 'run.json'), 'utf8'));
  assert.equal(onDisk.id, run.data.id);
});
