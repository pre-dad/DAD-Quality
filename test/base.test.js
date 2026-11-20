import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProvisioningAdapter } from '../src/targets/base.js';

function fakeRun(id = 'atm-base-test') {
  const writes = [];
  return {
    writes,
    dir: `/tmp/${id}`,
    data: { id },
    async evidence(relative, content) {
      writes.push({ relative, content });
      return { path: `evidence/${relative}`, sha256: 'x'.repeat(64), bytes: content.length };
    },
  };
}

test('logged writes the label.log evidence on success and appends the reference', async () => {
  const run = fakeRun();
  const adapter = new ProvisioningAdapter(run, { repo: '/synthetic' });
  const result = { evidence: [] };
  const output = await adapter.logged(result, 'phase', process.execPath, ['-e', 'process.stdout.write("ok")']);
  assert.equal(output.stdout, 'ok');
  assert.equal(run.writes.length, 1);
  assert.equal(run.writes[0].relative, 'phase.log');
  assert.equal(run.writes[0].content, 'ok');
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].path, 'evidence/phase.log');
});

test('logged still writes the label.log evidence on failure and rethrows', async () => {
  const run = fakeRun();
  const adapter = new ProvisioningAdapter(run, { repo: '/synthetic' });
  const result = { evidence: [] };
  await assert.rejects(
    adapter.logged(result, 'broken', process.execPath, ['-e', 'process.stderr.write("boom");process.exit(1)']),
  );
  assert.equal(run.writes.length, 1);
  assert.equal(run.writes[0].relative, 'broken.log');
  assert.match(run.writes[0].content, /boom/);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].path, 'evidence/broken.log');
});

test('compose commands are always scoped to the run-owned project and file', async () => {
  const run = fakeRun('atm-run-123');
  const adapter = new ProvisioningAdapter(run, { repo: '/synthetic' });
  let captured;
  adapter.logged = async (result, label, binary, args, options) => {
    captured = { result, label, binary, args, options };
    return { stdout: '', stderr: '' };
  };
  const result = { evidence: [] };
  const opts = { failureStatus: 'failed' };
  await adapter.composeRun(result, 'database-start', ['up', '-d', '--wait', 'postgres'], opts);
  assert.equal(captured.label, 'database-start');
  assert.equal(captured.binary, 'docker');
  assert.deepEqual(captured.args, [
    'compose',
    '-p',
    'atm-run-123',
    '-f',
    '/tmp/atm-run-123/compose.json',
    'up',
    '-d',
    '--wait',
    'postgres',
  ]);
  assert.equal(captured.options, opts);
  assert.equal(captured.result, result);
});

async function gitRepo(t, files) {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'atm-base-repo-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, name)), { recursive: true });
    await writeFile(path.join(repo, name), content);
  }
  const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=true', ...args], { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  return repo;
}

async function snapshotOf(t, repo, requiredFiles = []) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atm-base-run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const run = { ...fakeRun(), dir };
  run.data = { id: 'atm-base-test' };
  const adapter = new ProvisioningAdapter(run, { repo });
  await adapter.snapshot({ evidence: [] }, { requiredFiles, requireMessage: f => `missing ${f}`, source: dir });
  return run.data.candidate;
}

test('snapshot refuses a tracked .env under a non-ASCII directory that git quotes', async t => {
  const repo = await gitRepo(t, { 'é/.env': 'SECRET=1\n', 'app.js': '' });
  await assert.rejects(snapshotOf(t, repo), /tracked environment files/);
});

test('snapshot reports non-ASCII changed files and finds required non-ASCII paths', async t => {
  const repo = await gitRepo(t, { 'é/app.js': '', '.env.example': '' });
  const candidate = await snapshotOf(t, repo, ['é/app.js']);
  assert.deepEqual([...candidate.changedFiles].sort(), ['.env.example', 'é/app.js']);
});
