import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { command } from '../process.js';
import { digest, RunError } from '../core.js';

/**
 * The contract the discovery runner consumes. Adapters satisfy it structurally;
 * container-backed targets can extend ProvisioningAdapter for the shared
 * Docker, compose and git helpers.
 *
 * The runner constructs an adapter once, assigns `signal` before each phase,
 * calls `snapshot`, `docker`, `build`, `database` and `deploy` in order until one
 * is not ready, then runs discovery against `publicOrigin`. `cleanup` always
 * runs, even when nothing was provisioned. Each phase method records its own
 * evidence on the phase result; discovery evidence belongs to the runner.
 *
 * @typedef {object} Actor
 * @property {string} id
 * @property {string} description
 * @property {string} entry         Loopback-relative entry path.
 * @property {string} [cookie]      Session cookie value; omitted for anonymous actors.
 * @property {string} [cookieName]
 *
 * @typedef {object} Fixture
 * @property {() => Promise<() => Promise<void>>} [replay]  Swaps in the pristine fixture and returns a restore function.
 * @property {() => Promise<unknown>} [inspect]  Read-only projection of approved fixture state.
 *
 * @typedef {object} DiscoveryTargetAdapter
 * @property {string} publicOrigin
 * @property {AbortSignal} signal
 * @property {(result: object) => unknown} snapshot
 * @property {(result: object) => unknown} docker
 * @property {(result: object) => unknown} build
 * @property {(result: object) => unknown} database
 * @property {(result: object) => unknown} deploy
 * @property {(result: object) => unknown} cleanup
 * @property {() => Promise<Actor[]> | Actor[]} discoveryFixture
 * @property {() => Promise<Fixture> | Fixture | undefined} [discoveryReplayFixture]
 * @property {string} [source]  Absolute path to the archived source the agent may read.
 */

export class ProvisioningAdapter {
  /**
   * @param {any} run
   * @param {{repo: string, revision?: string, signal?: AbortSignal}} options
   */
  constructor(run, { repo, revision = 'HEAD', signal }) {
    this.run = run;
    this.id = run.data.id;
    this.repo = path.resolve(repo);
    this.revision = revision;
    this.signal = signal;
    this.source = path.join(run.dir, 'source');
    this.file = path.join(run.dir, 'compose.json');
    this.created = false;
  }

  async freePort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(undefined));
    });
    const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
    await new Promise(resolve => server.close(() => resolve(undefined)));
    return port;
  }

  async logged(result, label, binary, args, options = {}) {
    try {
      const output = await command(binary, args, { signal: this.signal, ...options });
      result.evidence.push(await this.run.evidence(`${label}.log`, output.stdout + output.stderr));
      return output;
    } catch (error) {
      result.evidence.push(
        await this.run.evidence(`${label}.log`, `${error.stdout ?? ''}${error.stderr ?? ''}\n${error.message}`),
      );
      throw error;
    }
  }

  compose(args, options = {}) {
    return command('docker', ['compose', '-p', this.id, '-f', this.file, ...args], { signal: this.signal, ...options });
  }

  composeRun(result, label, args, options) {
    return this.logged(result, label, 'docker', ['compose', '-p', this.id, '-f', this.file, ...args], options);
  }

  execSql({ service, user, db }, query) {
    return this.compose(['exec', '-T', service, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', user, '-d', db, '-At'], {
      input: query,
    });
  }

  async snapshot(result, { requiredFiles, requireMessage, source }) {
    const { stdout } = await command(
      'git',
      ['rev-parse', '--verify', '--end-of-options', `${this.revision}^{commit}`],
      {
        cwd: this.repo,
        signal: this.signal,
      },
    );
    const revision = stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(revision)) throw new RunError('Invalid source revision.');
    const tree = await command('git', ['ls-tree', '-r', '-z', '--name-only', revision], {
      cwd: this.repo,
      signal: this.signal,
    });
    const files = tree.stdout.split('\0').filter(Boolean);
    if (files.some(f => /(^|\/)\.env(?:\.|$)/.test(f) && !f.endsWith('.example')))
      throw new RunError('Snapshot refuses tracked environment files containing potential credentials.');
    for (const file of requiredFiles) {
      if (!files.includes(file)) throw new RunError(requireMessage(file));
    }
    await mkdir(this.source, { mode: 0o700 });
    const archive = path.join(this.run.dir, 'source.tar');
    await command('git', ['archive', '--format=tar', `--output=${archive}`, revision], {
      cwd: this.repo,
      signal: this.signal,
    });
    await command('tar', ['-xf', archive, '-C', this.source], { signal: this.signal });
    const changes = await command('git', ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-z', revision], {
      cwd: this.repo,
      signal: this.signal,
    });
    const worktree = await command('git', ['status', '--porcelain'], { cwd: this.repo, signal: this.signal });
    this.run.data.candidate = {
      revision,
      sourceArchiveSha256: digest(await readFile(archive)),
      source,
      changedFiles: changes.stdout.split('\0').filter(Boolean).slice(0, 500),
      excludesWorkingTreeChanges: true,
      workingTreeDirty: Boolean(worktree.stdout.trim()),
    };
    result.evidence.push(await this.run.evidence('candidate.json', JSON.stringify(this.run.data.candidate, null, 2)));
    return {
      summary: `Archived committed revision ${revision.slice(0, 12)}; working tree and environment files excluded.`,
    };
  }
}
