import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectConfig, parseComposePorts } from '../src/detect.js';
import { validateGenericConfig } from '../src/generic-config.js';
import { main } from '../src/cli.js';

async function repo(t, files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atm-detect-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return dir;
}

test('parseComposePorts extracts published container ports across the common forms', () => {
  const text = `services:
  web:
    image: nginx
    ports:
      - "8080:80"
  api:
    ports: ["9000:9000"]
  db:
    image: postgres
`;
  const ports = parseComposePorts(text, 'compose.yaml');
  assert.deepEqual(
    ports.map(p => ({ service: p.service, container: p.container })),
    [
      { service: 'web', container: 80 },
      { service: 'api', container: 9000 },
    ],
  );
});

test('parseComposePorts reads the container port from IP-bound, protocol and bare forms', () => {
  const text = `services:
  a:
    ports:
      - "127.0.0.1:8080:80"
  b:
    ports:
      - 8080:81/tcp
  c:
    ports:
      - 82
  d:
    ports: ["127.0.0.1:9000:83"]
`;
  assert.deepEqual(
    parseComposePorts(text, 'compose.yaml').map(p => [p.service, p.container]),
    [
      ['a', 80],
      ['b', 81],
      ['c', 82],
      ['d', 83],
    ],
  );
});

test('detect prefers an explicit port flag over a host:port elsewhere in the script', async t => {
  const dir = await repo(t, {
    'package.json': JSON.stringify({ scripts: { start: 'node --inspect=0.0.0.0:9229 server.js --port 4100' } }),
  });
  assert.equal((await detectConfig(dir)).provision.port, 4100);
});

test('detect treats 8081 as an ordinary application port', async t => {
  const dir = await repo(t, {
    'compose.yaml': 'services:\n  app:\n    build: .\n    ports:\n      - "8081:8081"\n',
  });
  assert.equal((await detectConfig(dir)).provision.port, 8081);
});

test('detect prefers a web-ish compose service and derives compose mode', async t => {
  const dir = await repo(t, {
    'compose.yaml': `services:
  worker:
    ports:
      - "7000:7000"
  web:
    ports:
      - "8080:80"
`,
  });
  const config = await detectConfig(dir);
  assert.equal(config.provision.mode, 'compose');
  assert.equal(config.provision.service, 'web');
  assert.equal(config.provision.port, 80);
  assert.equal(config.provision.composeFile, 'compose.yaml');
  // Always a validated draft with exactly one anonymous actor.
  assert.deepEqual(validateGenericConfig(config), config);
  assert.equal(config.actors.length, 1);
  assert.equal(config.actors[0].cookie, undefined);
});

test('detect derives Node command mode, npm ci when a lockfile is present, and a port from the script', async t => {
  const dir = await repo(t, {
    'package.json': JSON.stringify({ name: 'demo', scripts: { start: 'next start -p 4000' } }),
    'package-lock.json': '{}',
  });
  const config = await detectConfig(dir);
  assert.equal(config.provision.mode, 'command');
  assert.deepEqual(config.provision.build, ['npm', 'ci']);
  assert.deepEqual(config.provision.start, ['npm', 'run', 'start']);
  assert.equal(config.provision.port, 4000);
});

test('detect falls back to npm install without a lockfile and defaults the Node port to 3000', async t => {
  const dir = await repo(t, {
    'package.json': JSON.stringify({ name: 'demo', scripts: { dev: 'vite' } }),
  });
  const config = await detectConfig(dir);
  assert.deepEqual(config.provision.build, ['npm', 'install']);
  assert.deepEqual(config.provision.start, ['npm', 'run', 'dev']);
  assert.equal(config.provision.port, 3000);
});

test('detect recognizes a Django project via manage.py', async t => {
  const dir = await repo(t, { 'manage.py': '#!/usr/bin/env python\n', 'requirements.txt': 'django\n' });
  const config = await detectConfig(dir);
  assert.equal(config.provision.mode, 'command');
  assert.deepEqual(config.provision.build, ['pip', 'install', '-r', 'requirements.txt']);
  assert.equal(config.provision.port, 8000);
  assert.ok(config.provision.start.includes('runserver'));
});

test('detect parses a Procfile web line', async t => {
  const dir = await repo(t, { Procfile: 'web: gunicorn app:app -b 0.0.0.0:8888\nworker: celery\n' });
  const config = await detectConfig(dir);
  assert.equal(config.provision.mode, 'command');
  assert.equal(config.provision.port, 8888);
  assert.equal(config.provision.start[0], 'gunicorn');
});

test('detect fails with an actionable message when no web entrypoint is recognizable', async t => {
  const dir = await repo(t, { 'README.md': '# just docs\n' });
  await assert.rejects(detectConfig(dir), /Could not detect how to build and start this app/);
});

test('detect compose signal is tried and named even when it publishes no port', async t => {
  const dir = await repo(t, { 'docker-compose.yml': 'services:\n  db:\n    image: postgres\n' });
  await assert.rejects(detectConfig(dir), /compose \(docker-compose.yml\)/);
});

test('CLI detect writes a config, refuses to overwrite without --force, and --print writes nothing', async t => {
  const dir = await repo(t, {
    'package.json': JSON.stringify({ name: 'demo', scripts: { start: 'node server.js' } }),
  });
  const logs = [];
  const oldLog = console.log;
  t.after(() => {
    console.log = oldLog;
  });
  console.log = v => logs.push(v);

  let code = await main(['detect', '--repo', dir]);
  assert.equal(code, 0);
  const written = JSON.parse(await readFile(path.join(dir, 'atm.config.json'), 'utf8'));
  assert.equal(written.schemaVersion, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(validateGenericConfig(written))), written);

  // Second run without --force is refused.
  await assert.rejects(main(['detect', '--repo', dir]), /already exists; pass --force/);

  // --force overwrites.
  code = await main(['detect', '--repo', dir, '--force']);
  assert.equal(code, 0);

  // --print to a repo with no config writes nothing.
  const fresh = await repo(t, {
    'package.json': JSON.stringify({ name: 'x', scripts: { start: 'node s.js' } }),
  });
  logs.length = 0;
  code = await main(['detect', '--repo', fresh, '--print']);
  assert.equal(code, 0);
  await assert.rejects(readFile(path.join(fresh, 'atm.config.json'), 'utf8'), /ENOENT/);
  assert.ok(logs.some(l => typeof l === 'string' && l.includes('"schemaVersion": 1')));
});

test('detect skips datastore services and picks the real web service', async t => {
  const dir = await repo(t, {
    'docker-compose.yml': `services:
  postgres:
    image: postgres:16
    ports:
      - "55432:5432"
  app:
    build: .
    ports:
      - "8080:8080"
`,
  });
  const config = await detectConfig(dir);
  assert.equal(config.provision.mode, 'compose');
  assert.equal(config.provision.service, 'app');
  assert.equal(config.provision.port, 8080);
});

test('a compose that publishes only a datastore has no web entrypoint and falls through to failure', async t => {
  const dir = await repo(t, {
    'docker-compose.yml': `services:
  db:
    image: postgres:16
    ports:
      - "5432:5432"
`,
  });
  await assert.rejects(detectConfig(dir), /Could not detect/);
});

test('CLI detect requires --repo', async () => {
  await assert.rejects(main(['detect']), /detect --repo \/path\/to\/repo/);
});
