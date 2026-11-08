import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { cleanEnvironment, command } from '../../process.js';
import { digest, RunError } from '../../core.js';
import { ProvisioningAdapter } from '../base.js';
import { loadGenericConfig } from '../../generic-config.js';

const requiredFiles = ['atm.config.json'];

// A container- or command-provisioned adapter for arbitrary web applications.
// Unlike DadAdapter it compiles in no application knowledge: build/start/health
// and actors come from the repository's atm.config.json. It satisfies the same
// phase contract the discovery runner and exploration policy require
// (snapshot/docker/build/database/deploy/cleanup), marking phases that do not
// apply to a given config as not-applicable while still recording their
// policy-required evidence, exactly as BenchmarkAdapter does.
export class GenericWebAdapter extends ProvisioningAdapter {
  /**
   * @param {any} run
   * @param {{repo: string, revision?: string, signal?: AbortSignal, configFile?: string}} options
   */
  constructor(run, { configFile, ...options }) {
    super(run, options);
    this.configFile = configFile ?? 'atm.config.json';
    /** @type {import('../../generic-config.js').GenericConfig | undefined} */
    this.config = undefined;
    /** @type {import('node:child_process').ChildProcess | undefined} */
    this.process = undefined;
  }

  async snapshot(result) {
    const outcome = await super.snapshot(result, {
      requiredFiles,
      requireMessage: file => `Generic target requires ${file} at the repository root.`,
      source: this.repo,
    });
    // The config lives in the archived (committed) source, never the working tree.
    this.config = await loadGenericConfig(this.source, this.configFile);
    this.run.data.candidate.application = this.config.name;
    result.evidence.push(await this.run.evidence('atm-config.json', JSON.stringify(this.config, null, 2)));
    return { summary: `${outcome.summary} Loaded atm.config.json for "${this.config.name}".` };
  }

  async docker(result) {
    if (this.config.provision.mode !== 'compose')
      return this.notApplicable(
        result,
        ['docker.log', 'compose-version.log'],
        'Command-provisioned target: Docker not used.',
      );
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
    this.publicOrigin = `http://127.0.0.1:${this.port}`;
    // The run-owned compose file maps the declared container port to the loopback
    // port the browser explores. It references the target's committed compose file.
    const generated = {
      include: [path.join(this.source, this.config.provision.composeFile)],
      services: {
        [this.config.provision.service]: {
          ports: [`127.0.0.1:${this.port}:${this.config.provision.port}`],
        },
      },
    };
    await writeFile(this.file, JSON.stringify(generated, null, 2), { mode: 0o600 });
    this.run.data.environment = {
      docker: JSON.parse(resources.stdout),
      publicOrigin: this.publicOrigin,
      mode: 'compose',
      composeSha256: digest(JSON.stringify(generated)),
    };
    return { summary: 'Docker ready; loopback port allocated and mapped to the declared service.' };
  }

  async build(result) {
    if (this.config.provision.mode !== 'compose')
      return this.notApplicable(
        result,
        ['build-api.log', 'build-web.log'],
        'Command-provisioned target: images built by the start command, if any.',
      );
    await this.composeRun(result, 'build-api', ['build', this.config.provision.service], {
      timeout: 1_800_000,
      failureStatus: 'failed',
    });
    // The generic contract declares a single published service; the second
    // required evidence log records that no separate web image is built.
    result.evidence.push(
      await this.run.evidence('build-web.log', 'Not applicable: generic target publishes one service.'),
    );
    this.run.data.candidate.images = {};
    return { summary: 'Application image built from the declared compose service.' };
  }

  database(result) {
    // Generic targets own their data lifecycle inside their own compose/start;
    // the adapter does not impose a database model. The phase is recorded as
    // not-applicable so its policy-required evidence still exists.
    return this.notApplicable(
      result,
      ['migrations.log', 'test-migrations.log'],
      'Generic target: data lifecycle is owned by the application, not the harness.',
    );
  }

  async deploy(result) {
    if (this.config.provision.mode === 'compose') {
      this.created = true;
      await this.composeRun(
        result,
        'deploy',
        ['up', '-d', '--wait', '--wait-timeout', '120', this.config.provision.service],
        { timeout: 180_000 },
      );
    } else {
      this.port = await this.freePort();
      this.publicOrigin = `http://127.0.0.1:${this.port}`;
      if (this.config.provision.build)
        await this.logged(result, 'build-api', this.config.provision.build[0], this.config.provision.build.slice(1), {
          cwd: this.workingDir(),
          timeout: 1_800_000,
          failureStatus: 'failed',
        });
      await this.startCommand();
      this.run.data.environment = { publicOrigin: this.publicOrigin, mode: 'command' };
    }
    await this.waitForHealth(result);
    return { summary: `Application reachable at the declared health path.` };
  }

  workingDir() {
    return this.config.provision.workingDir ? path.join(this.source, this.config.provision.workingDir) : this.source;
  }

  // Overridable for tests: launch the long-running start command with PORT set
  // to the allocated loopback port.
  async startCommand() {
    const [bin, ...args] = this.config.provision.start;
    this.process = spawn(bin, args, {
      cwd: this.workingDir(),
      env: cleanEnvironment({ PORT: String(this.port) }),
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    this.process.on('error', () => {});
  }

  // Overridable for tests: poll the health path until it responds, bounded by
  // the configured startup timeout.
  async waitForHealth(result) {
    const url = new URL(this.config.provision.healthPath, this.publicOrigin).href;
    const deadline = Date.now() + (this.config.provision.startupTimeoutMs ?? 120_000);
    let lastError = 'no response';
    while (Date.now() < deadline) {
      this.signal?.throwIfAborted();
      try {
        const response = await fetch(url, {
          signal: AbortSignal.any([this.signal, AbortSignal.timeout(5_000)].filter(Boolean)),
          redirect: 'manual',
        });
        await response.body?.cancel();
        if (response.status >= 200 && response.status < 400) {
          result.evidence.push(await this.run.evidence('readiness.log', `${url} -> HTTP ${response.status}`));
          return;
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error.message;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    result.evidence.push(await this.run.evidence('readiness.log', `${url} never became ready: ${lastError}`));
    throw new RunError(
      `Application did not become ready at ${this.config.provision.healthPath}: ${lastError}`,
      'failed',
    );
  }

  async discoveryFixture() {
    if (this.config.seed) {
      if (this.config.provision.mode === 'compose')
        await this.compose(['run', '--rm', '-T', this.config.provision.service, ...this.config.seed]).catch(error => {
          throw new RunError(`Seed command failed: ${error.message}`, 'failed');
        });
      else
        await command(this.config.seed[0], this.config.seed.slice(1), {
          cwd: this.workingDir(),
          signal: this.signal,
        }).catch(error => {
          throw new RunError(`Seed command failed: ${error.message}`, 'failed');
        });
    }
    return this.config.actors.map(a => ({ ...a }));
  }

  async notApplicable(result, logs, summary) {
    for (const name of logs) result.evidence.push(await this.run.evidence(name, `Not applicable: ${summary}`));
    return { summary };
  }

  async cleanup(result) {
    if (this.process?.pid && this.process.exitCode === null) {
      try {
        // The start command is a process-group leader, so wrappers such as npm
        // do not leave the actual server running after the run.
        if (process.platform === 'win32') this.process.kill('SIGTERM');
        else process.kill(-this.process.pid, 'SIGTERM');
      } catch {
        /* Process may already be gone. */
      }
    }
    if (this.config?.provision.mode === 'compose' && this.created) {
      try {
        const logs = await this.compose(['logs', '--no-color', '--tail', '150'], { timeout: 20_000 });
        result.evidence.push(await this.run.evidence('services.log', logs.stdout + logs.stderr));
      } catch {
        /* Removal must still run if log collection fails. */
      }
      await this.composeRun(result, 'cleanup', ['down', '--volumes', '--remove-orphans', '--timeout', '10'], {
        timeout: 90_000,
      });
      return { summary: 'Run-owned containers removed. Images and evidence retained locally.' };
    }
    result.evidence.push(
      await this.run.evidence(
        'cleanup.log',
        this.process ? 'Start command terminated.' : 'No application environment was created.',
      ),
    );
    return { summary: 'Run-owned processes stopped; evidence retained locally.' };
  }
}
