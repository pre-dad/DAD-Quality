import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Run } from '../src/core.js';
import { GenericWebAdapter } from '../src/targets/generic/index.js';
import { resolveTarget, isRegisteredAdapter } from '../src/targets/index.js';
import { discoveryPolicy } from '../src/discovery-runner.js';
import { validatePolicy } from '../src/policy.js';

// A command-mode adapter whose start command is replaced by an in-process HTTP
// server, so the deploy -> health -> fixture -> cleanup lifecycle is exercised
// without Docker or an external application. This mirrors how BenchmarkAdapter
// is tested.
class InProcessGenericAdapter extends GenericWebAdapter {
  constructor(run, options) {
    super(run, options);
    this.server = undefined;
  }
  async startCommand() {
    this.server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><title>Sample</title><body><h1>Sample app</h1><a href="/about">About</a></body>');
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => resolve(undefined));
    });
  }
  async cleanup(result) {
    await new Promise(resolve => (this.server ? this.server.close(resolve) : resolve(undefined)));
    return super.cleanup(result);
  }
}

async function makeRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-generic-repo-'));
  const repo = path.join(root, 'repo');
  await mkdir(repo, { recursive: true });
  const config = {
    schemaVersion: 1,
    name: 'sample-command',
    provision: { mode: 'command', start: ['node', 'server.js'], healthPath: '/', startupTimeoutMs: 5000 },
    actors: [{ id: 'guest', description: 'Anonymous visitor', entry: '/' }],
  };
  await writeFile(path.join(repo, 'atm.config.json'), JSON.stringify(config, null, 2));
  await writeFile(path.join(repo, 'server.js'), '// placeholder\n');
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@atm.invalid');
  git('config', 'user.name', 'ATM Test');
  git('add', '-A');
  git('commit', '-q', '-m', 'sample');
  return { root, repo };
}

test('generic-web target resolves and its discovery policy is valid', () => {
  const target = resolveTarget('generic-web');
  assert.equal(typeof target.adapterFactory, 'function');
  assert.equal(target.policyId, 'generic-web-discovery');
  assert.equal(target.adapterId, 'generic-web');
  assert.equal(isRegisteredAdapter('generic-web'), true);
  const policy = discoveryPolicy('generic-web');
  assert.equal(policy.definition.id, 'generic-web-discovery');
  assert.equal(policy.definition.adapter, 'generic-web');
  // The policy must pass the strict validator (foundation phases, severities, exceptions).
  assert.doesNotThrow(() => validatePolicy(policy.definition));
});

test('generic-web adapter runs the command lifecycle: snapshot, deploy, health, fixture, cleanup', async t => {
  const { root, repo } = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = path.join(root, 'runs');
  const run = await Run.create(output, { mode: 'exploration' }, [
    'snapshot',
    'docker',
    'build',
    'database',
    'deploy',
    'discovery',
    'cleanup',
  ]);
  const adapter = new InProcessGenericAdapter(run, { repo, signal: new AbortController().signal });
  t.after(() => adapter.server?.close());

  // snapshot archives the committed source and loads atm.config.json from it.
  const snap = { evidence: [] };
  await adapter.snapshot(snap);
  assert.equal(adapter.config.name, 'sample-command');
  assert.ok(snap.evidence.some(e => e.path === 'evidence/atm-config.json'));
  assert.ok(snap.evidence.some(e => e.path === 'evidence/candidate.json'));

  // docker/build/database are not-applicable in command mode but still record evidence.
  const docker = { evidence: [] };
  await adapter.docker(docker);
  assert.ok(docker.evidence.some(e => e.path === 'evidence/docker.log'));
  assert.ok(docker.evidence.some(e => e.path === 'evidence/compose-version.log'));
  const build = { evidence: [] };
  await adapter.build(build);
  assert.ok(build.evidence.some(e => e.path === 'evidence/build-api.log'));
  assert.ok(build.evidence.some(e => e.path === 'evidence/build-web.log'));
  const db = { evidence: [] };
  await adapter.database(db);
  assert.ok(db.evidence.some(e => e.path === 'evidence/migrations.log'));

  // deploy starts the (in-process) server and waits on the health path.
  const deploy = { evidence: [] };
  await adapter.deploy(deploy);
  const origin = new URL(adapter.publicOrigin);
  assert.equal(origin.protocol, 'http:');
  assert.equal(origin.hostname, '127.0.0.1');
  assert.ok(origin.port);
  assert.equal(origin.pathname, '/');
  assert.ok(deploy.evidence.some(e => e.path === 'evidence/readiness.log'));

  // The app is reachable at the public origin.
  const response = await fetch(adapter.publicOrigin);
  assert.ok(response.ok);
  await response.body?.cancel();

  // discoveryFixture returns the declared actors.
  const actors = await adapter.discoveryFixture();
  assert.deepEqual(
    actors.map(a => a.id),
    ['guest'],
  );
  assert.equal(actors[0].cookie, undefined);

  // cleanup stops the server and records evidence.
  const clean = { evidence: [] };
  await adapter.cleanup(clean);
  assert.ok(clean.evidence.some(e => e.path === 'evidence/cleanup.log'));
  await assert.rejects(fetch(adapter.publicOrigin));
});

test('generic-web snapshot fails clearly when atm.config.json is absent', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-generic-norepo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  await mkdir(repo, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  await writeFile(path.join(repo, 'README.md'), '# no config\n');
  git('init', '-q');
  git('config', 'user.email', 'test@atm.invalid');
  git('config', 'user.name', 'ATM Test');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  const run = await Run.create(path.join(root, 'runs'), { mode: 'exploration' }, ['snapshot']);
  const adapter = new GenericWebAdapter(run, { repo, signal: new AbortController().signal });
  await assert.rejects(adapter.snapshot({ evidence: [] }), /requires atm.config.json/);
});

test('waitForHealth throws when the app never becomes ready', async t => {
  const { root, repo } = await makeRepo();
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = await Run.create(path.join(root, 'runs'), { mode: 'exploration' }, ['snapshot', 'deploy']);
  // A generic adapter whose start command does nothing: health never answers.
  class DeadAdapter extends GenericWebAdapter {
    async startCommand() {
      /* no server */
    }
  }
  const adapter = new DeadAdapter(run, { repo, signal: new AbortController().signal });
  await adapter.snapshot({ evidence: [] });
  // Shorten the deadline so the test is fast.
  adapter.config = { ...adapter.config, provision: { ...adapter.config.provision, startupTimeoutMs: 1000 } };
  const result = { evidence: [] };
  await assert.rejects(adapter.deploy(result), /did not become ready/);
  assert.ok(result.evidence.some(e => e.path === 'evidence/readiness.log'));
});

test('the real start command gets a clean environment, PORT, and its whole process group is stopped', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-generic-start-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const out = path.join(root, 'env.json');
  const script =
    'const fs=require("node:fs");fs.writeFileSync(process.argv[1],JSON.stringify({port:process.env.PORT,secret:process.env.ATM_TEST_SECRET??null}));' +
    'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}).unref();' +
    'setInterval(()=>{},1000);';
  const adapter = new GenericWebAdapter(
    { dir: root, data: { id: 'run-x', candidate: {} }, evidence: async name => name },
    { repo: root, revision: 'HEAD' },
  );
  adapter.config = { provision: { mode: 'command', start: [process.execPath, '-e', script, out] } };
  adapter.source = root;
  adapter.port = 4321;
  process.env.ATM_TEST_SECRET = 'must-not-leak';
  t.after(() => delete process.env.ATM_TEST_SECRET);
  await adapter.startCommand();
  for (let i = 0; i < 50 && !(await readFile(out, 'utf8').catch(() => '')); i++)
    await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), { port: '4321', secret: null });
  const { pid } = adapter.process;
  await adapter.cleanup({ evidence: [] });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.throws(() => process.kill(-pid, 0), { code: 'ESRCH' });
});
