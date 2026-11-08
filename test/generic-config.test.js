import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateGenericConfig, loadGenericConfig } from '../src/generic-config.js';

const composeConfig = () => ({
  schemaVersion: 1,
  name: 'sample-web',
  provision: { mode: 'compose', composeFile: 'docker-compose.yml', service: 'web', port: 8080, healthPath: '/' },
  actors: [{ id: 'guest', description: 'Anonymous visitor', entry: '/' }],
});

const commandConfig = () => ({
  schemaVersion: 1,
  name: 'sample-command',
  provision: { mode: 'command', build: ['npm', 'ci'], start: ['npm', 'start'], healthPath: '/health' },
  actors: [
    { id: 'guest', description: 'Anonymous visitor', entry: '/' },
    {
      id: 'member',
      description: 'Signed-in member',
      entry: '/app',
      cookie: 'synthetic-session',
      cookieName: 'session',
    },
  ],
});

test('a valid compose config normalizes and freezes', () => {
  const config = validateGenericConfig(composeConfig());
  assert.equal(config.name, 'sample-web');
  assert.equal(config.provision.mode, 'compose');
  assert.equal(config.actors.length, 1);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.provision));
  assert.ok(Object.isFrozen(config.actors[0]));
});

test('a valid command config with a cookie-backed actor passes', () => {
  const config = validateGenericConfig(commandConfig());
  assert.equal(config.provision.mode, 'command');
  assert.deepEqual(config.provision.start, ['npm', 'start']);
  assert.equal(config.actors[1].cookie, 'synthetic-session');
  assert.equal(config.actors[1].cookieName, 'session');
});

test('schemaVersion must be 1', () => {
  assert.throws(() => validateGenericConfig({ ...composeConfig(), schemaVersion: 2 }), /schemaVersion must be 1/);
});

test('unknown top-level fields are rejected', () => {
  assert.throws(() => validateGenericConfig({ ...composeConfig(), extra: true }), /unsupported field/);
});

test('provision.mode must be compose or command', () => {
  const c = composeConfig();
  c.provision = { mode: 'magic', healthPath: '/' };
  assert.throws(() => validateGenericConfig(c), /provision.mode must be/);
});

test('compose mode requires composeFile, service and container port', () => {
  const c = composeConfig();
  delete c.provision.service;
  assert.throws(() => validateGenericConfig(c), /provision.service/);
});

test('compose mode rejects build/start commands', () => {
  const c = composeConfig();
  c.provision.start = ['npm', 'start'];
  assert.throws(() => validateGenericConfig(c), /compose mode does not take/);
});

test('command mode requires a start command', () => {
  const c = commandConfig();
  delete c.provision.start;
  assert.throws(() => validateGenericConfig(c), /provision.start/);
});

test('command mode rejects composeFile/service', () => {
  const c = commandConfig();
  c.provision.service = 'web';
  assert.throws(() => validateGenericConfig(c), /command mode does not take/);
});

test('a path-traversing composeFile is rejected', () => {
  const c = composeConfig();
  c.provision.composeFile = '../../etc/passwd';
  assert.throws(() => validateGenericConfig(c), /composeFile must be a repo-relative path/);
});

test('healthPath must start with a slash', () => {
  const c = composeConfig();
  c.provision.healthPath = 'health';
  assert.throws(() => validateGenericConfig(c), /healthPath/);
});

test('a protocol-relative healthPath or actor entry cannot leave the loopback origin', () => {
  const c = composeConfig();
  c.provision.healthPath = '//169.254.169.254/latest/meta-data/';
  assert.throws(() => validateGenericConfig(c), /healthPath/);
  const d = commandConfig();
  d.actors[0].entry = '//example.com/';
  assert.throws(() => validateGenericConfig(d), /entry must be a loopback-relative path/);
});

test('at least one anonymous actor is required', () => {
  const c = commandConfig();
  c.actors = [{ id: 'member', description: 'Signed-in member', entry: '/app', cookie: 'x', cookieName: 'session' }];
  assert.throws(() => validateGenericConfig(c), /at least one anonymous actor/);
});

test('duplicate actor ids are rejected', () => {
  const c = commandConfig();
  c.actors.push({ id: 'guest', description: 'dupe', entry: '/' });
  assert.throws(() => validateGenericConfig(c), /duplicate actor id/);
});

test('a cookieName without a cookie is rejected', () => {
  const c = composeConfig();
  c.actors[0].cookieName = 'session';
  assert.throws(() => validateGenericConfig(c), /cookieName but no cookie/);
});

test('a cookie-backed actor must declare its cookieName (no target-specific default leaks in)', () => {
  const c = composeConfig();
  c.actors.push({ id: 'member', description: 'Signed-in member', entry: '/app', cookie: 'synthetic-session' });
  assert.throws(() => validateGenericConfig(c), /must declare its cookieName/);
});

test('an actor entry must be loopback-relative', () => {
  const c = composeConfig();
  c.actors[0].entry = 'https://evil.example/';
  assert.throws(() => validateGenericConfig(c), /entry must be a loopback-relative path/);
});

test('loadGenericConfig reads and validates from disk', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atm-generic-config-'));
  try {
    await writeFile(path.join(dir, 'atm.config.json'), JSON.stringify(composeConfig()));
    const config = await loadGenericConfig(dir);
    assert.equal(config.name, 'sample-web');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadGenericConfig throws a clear error when the file is absent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atm-generic-config-missing-'));
  try {
    await assert.rejects(loadGenericConfig(dir), /requires atm.config.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadGenericConfig rejects invalid JSON', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'atm-generic-config-bad-'));
  try {
    await writeFile(path.join(dir, 'atm.config.json'), '{ not json');
    await assert.rejects(loadGenericConfig(dir), /not valid JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
