import test from 'node:test';
import assert from 'node:assert/strict';
import { DadAdapter } from '../src/targets/dad/index.js';
import { composeDefinition } from '../src/targets/dad/compose.js';

test('runtime isolates database and disables external integrations', () => {
  const config = composeDefinition({
    id: 'atm-test',
    port: 43123,
    password: 'owner',
    apiPassword: 'api',
    staffPassword: 'staff',
  });
  assert.equal(config.networks.isolated.internal, true);
  assert.equal(config.services.postgres.ports, undefined);
  assert.equal(config.services['test-postgres'].ports, undefined);
  assert.equal(config.services.web.ports, undefined);
  assert.deepEqual(config.services.ingress.ports, ['127.0.0.1:43123:8080']);
  for (const service of Object.values(config.services)) {
    assert.equal(service.env_file, undefined);
    assert.equal(service.environment?.STRIPE_SECRET_KEY, undefined);
    assert.equal(service.environment?.DONOR_SMTP_HOST, undefined);
  }
  assert.equal(config.services.api.environment.DONOR_GO_DATABASE_URL, undefined);
  assert.equal(config.services.api.environment.DONOR_ALLOW_OWNER_CONNECTION, undefined);
  assert.match(config.services['api-tests'].environment.TEST_DATABASE_URL, /\/donor_go\?/);
  assert.match(config.services['api-tests'].environment.TEST_DATABASE_URL, /@test-postgres\//);
  assert.match(config.services.api.environment.DONOR_API_DATABASE_URL, /\/dad_atm\?/);
});

test('donor verifier rejects extra sessions, unconsumed links and changes to another donor', async () => {
  const adapter = new DadAdapter({ data: { id: 'fixture' }, dir: '/tmp/fixture' }, { repo: '/synthetic' });
  const good = {
    claimed: 1,
    consumed_links: 2,
    sessions: 1,
    active_sessions: 1,
    revoked_sessions: 0,
    other_claimed: 0,
    other_sessions: 0,
  };
  let state = good;
  adapter.sql = async query => {
    assert.match(query, /^BEGIN READ ONLY;/);
    assert.match(query, /ROLLBACK;/);
    return { stdout: `BEGIN\n${JSON.stringify(state)}\nROLLBACK` };
  };
  assert.deepEqual(await adapter.verifyDonor(), good);
  for (const [key, value] of [
    ['claimed', 0],
    ['consumed_links', 1],
    ['sessions', 2],
    ['active_sessions', 0],
    ['other_claimed', 1],
    ['other_sessions', 1],
  ]) {
    state = { ...good, [key]: value };
    await assert.rejects(adapter.verifyDonor(), error => error.status === 'failed');
  }
  state = { ...good, active_sessions: 0, revoked_sessions: 1 };
  await adapter.verifyDonor({ signedOut: true });
  state = good;
  await assert.rejects(adapter.verifyDonor({ signedOut: true }), error => error.status === 'failed');
});

test('discovery fixture authenticates donors with the dad_donor_session cookie name', async () => {
  const adapter = new DadAdapter({ data: { id: 'fixture' }, dir: '/tmp/fixture' }, { repo: '/synthetic' });
  adapter.sql = async () => ({ stdout: '' });
  const actors = await adapter.discoveryFixture();
  const authenticated = actors.filter(a => a.cookie);
  assert.equal(authenticated.length, 2);
  for (const actor of authenticated) assert.equal(actor.cookieName, 'dad_donor_session');
  assert.equal(actors.find(a => a.id === 'guest').cookieName, undefined);
});

const ID = 'atm-20260101000000-0a1b2c3d';

function stubbedAdapter(mode) {
  const run = {
    dir: `/tmp/${ID}`,
    data: { id: ID, options: { mode }, candidate: {} },
    async evidence(relative, content) {
      return { path: `evidence/${relative}`, sha256: 'x'.repeat(64), bytes: content.length };
    },
  };
  const adapter = new DadAdapter(run, { repo: '/synthetic' });
  adapter.password = 'OWNERPW';
  const logged = [],
    composed = [];
  adapter.logged = async (_result, label, _binary, args, options) => {
    logged.push({ label, args, options });
    return { stdout: '', stderr: '' };
  };
  adapter.compose = (args, options) => {
    composed.push({ args, options });
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  return { adapter, logged, composed };
}

test('acceptance migrates the application and integration-test databases, failing the check on migration errors', async () => {
  const { adapter, logged } = stubbedAdapter('validation');
  const result = { evidence: [] };
  await adapter.database(result);
  const start = logged.find(c => c.label === 'database-start');
  assert.deepEqual(start.args.slice(-2), ['postgres', 'test-postgres']);
  const migrations = logged.filter(c => c.label === 'migrations' || c.label === 'test-migrations');
  assert.equal(migrations.length, 2);
  for (const call of migrations) assert.equal(call.options.failureStatus, 'failed');
  assert.ok(
    logged
      .find(c => c.label === 'test-migrations')
      .args.includes('DONOR_GO_DATABASE_URL=postgresql://atm_owner:OWNERPW@test-postgres/donor_go?sslmode=disable'),
  );
  assert.equal(adapter.created, true, 'cleanup must remove a partially started environment');
});

test('exploration starts only the application database and still records the policy-required test-migrations evidence', async () => {
  const { adapter, logged } = stubbedAdapter('exploration');
  const result = { evidence: [] };
  await adapter.database(result);
  assert.equal(logged.find(c => c.label === 'database-start').args.at(-1), 'postgres');
  assert.equal(
    logged.some(c => c.label === 'test-migrations'),
    false,
  );
  assert.ok(result.evidence.some(e => e.path === 'evidence/test-migrations.log'));
});

test('suite failures are product failures rather than inconclusive infrastructure', async () => {
  const { adapter, logged } = stubbedAdapter('validation');
  await adapter.suite({ evidence: [] }, 'api-tests');
  assert.equal(logged[0].options.failureStatus, 'failed');
});

test('SQL runs without psqlrc and stops at the first failing statement', async () => {
  const { adapter, composed } = stubbedAdapter('validation');
  await adapter.sql('SELECT 1');
  const [{ args, options }] = composed;
  assert.ok(args.includes('-X'));
  assert.equal(args[args.indexOf('-v') + 1], 'ON_ERROR_STOP=1');
  assert.deepEqual(args.slice(args.indexOf('-U'), args.indexOf('-U') + 4), ['-U', 'atm_owner', '-d', 'dad_atm']);
  assert.equal(options.input, 'SELECT 1');
});

test('cleanup removes containers and volumes even when log collection fails', async () => {
  const { adapter, logged } = stubbedAdapter('validation');
  adapter.created = true;
  adapter.compose = () => Promise.reject(new Error('logs unavailable'));
  await adapter.cleanup({ evidence: [] });
  const down = logged.find(c => c.label === 'cleanup');
  assert.ok(down.args.includes('down'));
  assert.ok(down.args.includes('--volumes'));
  assert.ok(down.args.includes('--remove-orphans'));
});

test('DadAdapter accepts only GitHub owner/repo source identities', () => {
  const run = { data: { id: 'fixture' }, dir: '/tmp/fixture' };
  assert.equal(
    new DadAdapter(run, { repo: '/synthetic', sourceIdentity: 'github:owner/repo-1.x' }).sourceIdentity,
    'github:owner/repo-1.x',
  );
  assert.equal(new DadAdapter(run, { repo: '/synthetic' }).sourceIdentity, undefined);
  for (const value of [
    'owner/repo',
    'github:owner',
    'github:owner/repo/extra',
    'github:ow ner/repo',
    'https://github.com/o/r',
    'github:owner/repo\n',
  ])
    assert.throws(
      () => new DadAdapter(run, { repo: '/synthetic', sourceIdentity: value }),
      /Invalid GitHub source identity/,
      value,
    );
});
