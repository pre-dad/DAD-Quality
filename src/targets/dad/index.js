import { writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { command } from '../../process.js';
import { digest, RunError } from '../../core.js';
import { replayFixture } from '../../discovery-fixture.js';
import { ProvisioningAdapter } from '../base.js';
import { composeDefinition, nginxConf } from './compose.js';
import { buildServices, cleanupLogServices, database, owner, requiredFiles } from './config.js';
import {
  discoveryFixture,
  discoveryStateSql,
  donorFixtureSql,
  performanceFixture,
  replayRestoreSql,
  roleSetupSql,
  verifyDonorSql,
  verifyStaffSql,
} from './sql.js';

export class DadAdapter extends ProvisioningAdapter {
  /**
   * @param {any} run
   * @param {{repo: string, revision?: string, sourceIdentity?: string, signal?: AbortSignal}} options
   */
  constructor(run, { sourceIdentity, ...options }) {
    super(run, options);
    if (sourceIdentity && !/^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceIdentity))
      throw new Error('Invalid GitHub source identity.');
    this.sourceIdentity = sourceIdentity;
  }
  snapshot(result) {
    return super.snapshot(result, {
      requiredFiles,
      requireMessage: file => `DAD adapter requires ${file}.`,
      source: this.sourceIdentity ?? this.repo,
    });
  }
  async docker(result) {
    await this.logged(result, 'docker', 'docker', ['info', '--format', '{{.ServerVersion}}']);
    await this.logged(result, 'compose-version', 'docker', ['compose', 'version']);
    const resources = await command(
      'docker',
      [
        'info',
        '--format',
        '{"version":{{json .ServerVersion}},"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}},"architecture":{{json .Architecture}}}',
      ],
      { signal: this.signal },
    );
    this.port = await this.freePort();
    this.publicOrigin = `http://localhost:${this.port}`;
    this.staffOrigin = `http://staff.localhost:${this.port}`;
    this.password = randomBytes(24).toString('hex');
    this.apiPassword = randomBytes(24).toString('hex');
    this.staffPassword = randomBytes(24).toString('hex');
    const config = composeDefinition(this);
    // Runtime credentials are private, never linked in reports. These are run-local only.
    await writeFile(this.file, JSON.stringify(config, null, 2), { mode: 0o600 });
    await writeFile(path.join(this.run.dir, 'nginx.conf'), nginxConf, { mode: 0o600 });
    this.run.data.environment = {
      docker: JSON.parse(resources.stdout),
      publicOrigin: this.publicOrigin,
      staffOrigin: this.staffOrigin,
      outboundNetwork: 'internal Docker network',
      integrations: 'Stripe, SMTP and push disabled',
      composeSha256: digest(JSON.stringify(config)),
    };
    return { summary: 'Docker ready; unique project and loopback port allocated.' };
  }
  async build(result) {
    for (const [service, file] of buildServices) {
      const args = [
        'build',
        '--label',
        `atm.run=${this.id}`,
        '--label',
        `org.opencontainers.image.revision=${this.run.data.candidate.revision}`,
        '-f',
        path.join(this.source, file),
      ];
      if (service === 'web')
        args.push(
          '--build-arg',
          `DONOR_PUBLIC_ORIGIN=${this.publicOrigin}`,
          '--build-arg',
          `DONOR_STAFF_ORIGIN=${this.staffOrigin}`,
        );
      if (this.run.data.options.mode !== 'exploration')
        await this.logged(
          result,
          `build-${service}-checks`,
          'docker',
          [...args, '--target', 'build', '-t', `${this.id}/${service}-checks:local`, this.source],
          { timeout: 900_000, failureStatus: 'failed' },
        );
      await this.logged(
        result,
        `build-${service}`,
        'docker',
        [...args, '-t', `${this.id}/${service}:local`, this.source],
        { timeout: 900_000, failureStatus: 'failed' },
      );
    }
    this.run.data.candidate.images = {};
    for (const service of ['api', 'web']) {
      const image = await command(
        'docker',
        ['image', 'inspect', `${this.id}/${service}:local`, '--format', '{{.Id}}'],
        { signal: this.signal },
      );
      this.run.data.candidate.images[service] = image.stdout.trim();
    }
    return { summary: 'Application images built from the archived revision.' };
  }
  async sql(query) {
    return this.execSql({ service: 'postgres', user: owner, db: database }, query);
  }
  async database(result) {
    this.created = true;
    await this.composeRun(result, 'database-start', [
      'up',
      '-d',
      '--wait',
      '--wait-timeout',
      '90',
      'postgres',
      ...(this.run.data.options.mode === 'exploration' ? [] : ['test-postgres']),
    ]);
    await this.composeRun(result, 'migrations', ['run', '--rm', '-T', 'migrate'], { failureStatus: 'failed' });
    // Passwords are generated hexadecimal strings, never supplied by users or a model.
    await this.sql(roleSetupSql({ apiPassword: this.apiPassword, staffPassword: this.staffPassword }));
    if (this.run.data.options.mode !== 'exploration')
      await this.composeRun(
        result,
        'test-migrations',
        [
          'run',
          '--rm',
          '-T',
          '-e',
          `DONOR_GO_DATABASE_URL=postgresql://atm_owner:${this.password}@test-postgres/donor_go?sslmode=disable`,
          'migrate',
        ],
        { failureStatus: 'failed' },
      );
    else
      result.evidence.push(
        await this.run.evidence(
          'test-migrations.log',
          'Not applicable: exploration uses only the application database.',
        ),
      );
    return {
      summary:
        this.run.data.options.mode === 'exploration'
          ? 'Disposable application database migrated; application processes use separate roles.'
          : 'Disposable application and integration-test databases migrated; application processes use separate roles.',
    };
  }
  async suite(result, name) {
    await this.composeRun(result, name, ['run', '--rm', '-T', name], {
      timeout: 900_000,
      failureStatus: 'failed',
    });
    return {
      summary:
        name === 'api-tests'
          ? 'Go vet and race-enabled backend tests passed.'
          : 'Frontend lint, unit tests and type checks passed.',
    };
  }
  async deploy(result) {
    await this.composeRun(result, 'deploy', ['up', '-d', '--wait', '--wait-timeout', '120', 'api', 'web', 'ingress'], {
      timeout: 180_000,
    });
    const { stdout } = await this.compose([
      'exec',
      '-T',
      'web',
      'node',
      '-e',
      `fetch('http://127.0.0.1:3000/').then(r=>{console.log(r.status);if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))`,
    ]);
    result.evidence.push(await this.run.evidence('readiness.log', stdout));
    const response = await fetch(this.publicOrigin, {
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(10_000)].filter(Boolean)),
      redirect: 'manual',
    });
    if (response.status !== 200) throw new RunError(`Published ingress returned HTTP ${response.status}.`);
    await response.body?.cancel();
    return { summary: 'API database readiness and production web health passed.' };
  }
  async invitation() {
    const { stdout } = await this.compose([
      'run',
      '--rm',
      '-T',
      'staff',
      '--email',
      'administrator@atm.invalid',
      '--name',
      'ATM Administrator',
    ]);
    const invitation = stdout.match(/http:\/\/\S+\/staff\/activate#token=\S+/)?.[0];
    if (!invitation || new URL(invitation).origin !== this.staffOrigin)
      throw new RunError('Staff bootstrap returned no valid run-scoped invitation.');
    return invitation;
  }
  async verifyStaff() {
    const { stdout } = await this.sql(verifyStaffSql());
    const value = stdout.split('\n').find(line => line.startsWith('{'));
    if (!value) throw new RunError('Database verifier returned no result.');
    const state = JSON.parse(value);
    if (state.staff !== 1 || state.passkeys !== 1 || state.active_sessions < 1 || state.revoked_sessions < 1)
      throw new RunError('Persisted staff, passkey, or session invariants failed.', 'failed');
    return state;
  }
  async donorFixture() {
    // Only generated UUIDs and hexadecimal hashes enter SQL. The fixture is
    // synthetic setup, not evidence that email delivery or gift checkout works.
    const donor = randomUUID(),
      other = randomUUID();
    const token = randomBytes(32).toString('base64url'),
      sibling = randomBytes(32).toString('base64url');
    await this.sql(donorFixtureSql({ donor, other, token, sibling }));
    return { donor, other, links: [token, sibling].map(value => `${this.publicOrigin}/account/claim#token=${value}`) };
  }
  async verifyDonor({ signedOut = false } = {}) {
    const { stdout } = await this.sql(verifyDonorSql());
    const value = stdout.split('\n').find(line => line.startsWith('{'));
    if (!value) throw new RunError('Donor database verifier returned no result.');
    const state = JSON.parse(value);
    if (
      state.claimed !== 1 ||
      state.consumed_links !== 2 ||
      state.sessions !== 1 ||
      state.active_sessions !== (signedOut ? 0 : 1) ||
      state.revoked_sessions !== (signedOut ? 1 : 0) ||
      state.other_claimed !== 0 ||
      state.other_sessions !== 0
    )
      throw new RunError('Persisted donor claim, link, or session invariants failed.', 'failed');
    return state;
  }
  async discoveryFixture() {
    const { statements, actors } = discoveryFixture();
    await this.sql(statements);
    return actors;
  }
  async discoveryState() {
    // Fixed projection for fixture identities: no arbitrary SQL, session tokens or hashes.
    const { stdout } = await this.sql(discoveryStateSql());
    const value = stdout.split('\n').find(line => line.startsWith('{'));
    if (!value) throw new RunError('Discovery state verifier returned no result.');
    return JSON.parse(value);
  }
  async discoveryReplayFixture() {
    if (this.run.data.options.mode !== 'exploration' || !this.created || !/^atm-[0-9]{14}-[a-f0-9]{8}$/.test(this.id))
      throw new RunError('Fixture replay requires a run-owned exploration database.');
    return replayFixture({
      // Restart the proxy too: Docker can assign new app addresses after a stop.
      // Its healthcheck must observe the upstream before exploration resumes.
      stop: () => this.compose(['stop', '--timeout', '10', 'ingress', 'api', 'web']),
      start: async () => {
        await this.compose(['up', '-d', '--wait', '--wait-timeout', '90', 'api', 'web']);
        await this.compose(['up', '-d', '--wait', '--wait-timeout', '90', 'ingress']);
      },
      snapshot: async () =>
        (
          await this.compose(
            ['exec', '-T', 'postgres', 'pg_dump', '-U', owner, '-d', database, '--clean', '--if-exists', '--no-owner'],
            { maxBytes: 32_000_000 },
          )
        ).stdout,
      restore: data => this.sql(replayRestoreSql(data)),
      inspect: () => this.discoveryState(),
    });
  }
  async performanceFixture() {
    // Separate from the authentication journeys; no email or payment processor.
    // Each donor has a full first page and ten additional synthetic gifts.
    const { statements, cookies } = performanceFixture();
    await this.sql(statements);
    return cookies;
  }
  async cleanup(result) {
    if (this.created) {
      // Cleanup gets its own deadline and is not canceled with the run.
      try {
        const logs = await this.compose(['logs', '--no-color', '--tail', '150', ...cleanupLogServices], {
          timeout: 20_000,
        });
        result.evidence.push(await this.run.evidence('services.log', logs.stdout + logs.stderr));
      } catch {
        /* Removal must still run if log collection fails. */
      }
      await this.composeRun(result, 'cleanup', ['down', '--volumes', '--remove-orphans', '--timeout', '10'], {
        timeout: 90_000,
      });
    } else {
      result.evidence.push(await this.run.evidence('cleanup.log', 'No application environment was created.'));
    }
    return { summary: 'Run-owned containers and ephemeral databases removed. Images and evidence retained locally.' };
  }
}
