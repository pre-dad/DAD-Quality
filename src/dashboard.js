import { modelConfig } from './model-provider.js';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, unlink, open, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJSON, now, redact, verifyEvidence } from './core.js';
import { command } from './process.js';
import { executeRun } from './runner.js';
import { executeDiscovery } from './discovery-runner.js';
import { discoveryDetail } from './discovery-report.js';
import { listRuns, readRun, summarize, compareRuns, collectFindings } from './history.js';
import { performanceDetail } from './performance.js';
import { assessRelease, releaseInputs } from './release.js';
import { loadPolicy } from './policy.js';
import { resolveTarget } from './targets/index.js';

const assets = fileURLToPath(new URL('../web/', import.meta.url));
const MAX_BODY = 16_384;
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function resolveRevision(repo, revision) {
  if (typeof revision !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/@^~+-]{0,199}$/.test(revision))
    throw new HttpError(400, 'Enter a valid commit, branch, or tag.');
  try {
    const { stdout } = await command('git', ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], {
      cwd: repo,
      timeout: 10_000,
    });
    const sha = stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error();
    return sha;
  } catch {
    throw new HttpError(400, 'That revision does not resolve to a local commit. Fetch it into the checkout first.');
  }
}

async function jsonBody(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new HttpError(415, 'Use application/json.');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'Request must be a JSON object.');
  }
}

export class Dashboard {
  constructor({
    repo,
    root = '.atm/runs',
    executor = executeRun,
    explorer = executeDiscovery,
    resolve = resolveRevision,
    model = process.env.ATM_MODEL,
    providerName = process.env.ATM_PROVIDER ?? 'openai',
    policy,
    target = 'dad',
    configFile,
  }) {
    // Validate the target name up front so an unknown target fails at construction.
    resolveTarget(target);
    this.target = target;
    this.configFile = configFile;
    this.repo = path.resolve(repo);
    this.root = path.resolve(root);
    this.model = model;
    this.providerName = providerName;
    modelConfig({ providerName, model });
    this.executor = executor;
    this.explorer = explorer;
    this.resolve = resolve;
    this.policyFile = policy;
    this.active = null;
    this.state = {
      watch: { enabled: false, revision: 'HEAD', lastRevision: null, updatedAt: null, error: null },
      triage: {},
    };
    this.control = path.join(this.root, '.dashboard');
    this.mutations = Promise.resolve();
    this.starting = false;
    this.closing = false;
  }
  async initialize() {
    this.policy = await loadPolicy(this.policyFile);
    await mkdir(this.control, { recursive: true, mode: 0o700 });
    this.root = await realpath(this.root);
    this.control = path.join(this.root, '.dashboard');
    this.lock = path.join(this.control, 'server.lock');
    try {
      const file = await open(this.lock, 'wx', 0o600);
      await file.writeFile(String(process.pid));
      await file.close();
    } catch (error) {
      if (error.code === 'EEXIST')
        throw new Error(
          `Another dashboard may own this history. Stop it before restarting. If it crashed, remove ${this.lock}.`,
        );
      throw error;
    }
    try {
      const saved = JSON.parse(await readFile(path.join(this.control, 'state.json'), 'utf8'));
      if (!saved.watch || typeof saved.watch.enabled !== 'boolean' || !saved.triage || typeof saved.triage !== 'object')
        throw new Error('Invalid dashboard state.');
      if (saved.repo !== this.repo)
        throw new Error('This run directory belongs to another repository. Choose a separate --output directory.');
      this.state = saved;
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await unlink(this.lock);
        throw error;
      }
    }
    this.state.repo = this.repo;
  }
  async mutate(action) {
    const work = this.mutations.then(async () => {
      const value = await action();
      await atomicJSON(path.join(this.control, 'state.json'), this.state);
      return value;
    });
    this.mutations = work.catch(() => {});
    return work;
  }
  async history() {
    return listRuns(this.root);
  }
  async detail(id) {
    const run = await readRun(this.root, id);
    const history = await this.history();
    const { runs } = history;
    const baseline = runs.find(
      r =>
        r.id !== run.id &&
        r.startedAt < run.startedAt &&
        r.finishedAt &&
        r.candidate?.source === run.candidate?.source &&
        r.options?.adapter === run.options?.adapter,
    );
    const issues = await verifyEvidence(path.join(this.root, run.id), run);
    const inputs = await releaseInputs(this.root, history);
    const release = await assessRelease(this.root, run, { inputs, evidenceIssues: issues });
    return {
      run,
      release,
      discovery: await discoveryDetail(this.root, run),
      performance: await performanceDetail(this.root, run, runs),
      summary: summarize(run, this.active?.id),
      comparison: compareRuns(run, baseline),
      integrity: { status: issues.length ? 'invalid' : 'verified', issues },
    };
  }
  async snapshot() {
    const history = await this.history();
    const { runs, warnings } = history;
    const inputs = await releaseInputs(this.root, history);
    return {
      project: {
        name: path.basename(this.repo),
        repo: this.repo,
        target: this.target,
        profile: this.target === 'dad' ? 'DAD · local acceptance' : `${this.target} · discovery`,
        policy: { id: this.policy.definition.id, version: this.policy.definition.version, digest: this.policy.digest },
        aiConfigured: modelConfig({ providerName: this.providerName, model: this.model }).configured,
        provider: this.providerName,
        model: this.model ?? null,
      },
      runs: runs.map(run => summarize(run, this.active?.id)),
      findings: inputs.findings,
      warnings,
      latestRelease: runs[0] ? await assessRelease(this.root, runs[0], { inputs }) : null,
      active: this.active
        ? { id: this.active.id, revision: this.active.revision, cancelRequested: this.active.controller.signal.aborted }
        : null,
      starting: this.starting,
      watch: this.state.watch,
      lastLaunchError: this.lastLaunchError ?? null,
    };
  }
  async start({ revision = 'HEAD', ai = false, requireAI = false, mode = 'validation', trigger = 'dashboard' } = {}) {
    if (this.closing || this.active || this.starting)
      throw new HttpError(409, 'A validation is already active. Wait for cleanup before starting another.');
    if (typeof ai !== 'boolean' || typeof requireAI !== 'boolean') throw new HttpError(400, 'Invalid AI options.');
    if (!['validation', 'exploration'].includes(mode)) throw new HttpError(400, 'Invalid run mode.');
    if (mode === 'validation' && this.target !== 'dad')
      throw new HttpError(
        400,
        'Release validation is available only for the dad target; use exploration for this codebase.',
      );
    if (mode === 'exploration' && (ai || requireAI))
      throw new HttpError(400, 'Discovery does not use predefined AI journeys.');
    if (
      (ai || requireAI || mode === 'exploration') &&
      !modelConfig({ providerName: this.providerName, model: this.model }).configured
    )
      throw new HttpError(
        400,
        `Configure ${modelConfig({ providerName: this.providerName }).keyVariable} and ATM_MODEL on the dashboard process first.`,
      );
    this.starting = true;
    try {
      const sha = await this.resolve(this.repo, revision);
      if (this.closing) throw new HttpError(409, 'Dashboard is shutting down.');
      const controller = new AbortController();
      const active = { id: null, revision: sha, controller };
      this.active = active;
      this.lastLaunchError = null;
      let created;
      const ready = new Promise(resolve => {
        created = resolve;
      });
      active.completion = Promise.resolve()
        .then(() =>
          (mode === 'exploration' ? this.explorer : this.executor)({
            repo: this.repo,
            revision: sha,
            output: this.root,
            policy: this.policyFile,
            ai,
            requireAI,
            model: this.model,
            providerName: this.providerName,
            trigger,
            signal: controller.signal,
            ...(mode === 'exploration' ? { target: this.target, configFile: this.configFile } : {}),
            onCreated: run => {
              active.id = run.data.id;
              created();
            },
          }),
        )
        .catch(error => {
          this.lastLaunchError = redact(error.message);
        })
        .finally(() => {
          if (this.active === active) this.active = null;
          created();
        });
      await ready;
      if (!active.id) throw new HttpError(500, this.lastLaunchError ?? 'Runner could not create a run.');
      return { id: active.id, revision: sha };
    } finally {
      this.starting = false;
    }
  }
  cancel(id) {
    if (!this.active || this.active.id !== id) throw new HttpError(409, 'This run is not active in this dashboard.');
    this.active.controller.abort();
  }
  async setWatch(enabled, revision) {
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'Invalid watch setting.');
    const sha = enabled ? await this.resolve(this.repo, revision) : null;
    return this.mutate(() => {
      this.state.watch = {
        enabled,
        revision: enabled ? revision : this.state.watch.revision,
        lastRevision: sha ?? this.state.watch.lastRevision,
        updatedAt: now(),
        error: null,
      };
      return this.state.watch;
    });
  }
  async tick() {
    if (!this.state.watch.enabled || this.active || this.starting || this.closing || this.ticking) return;
    this.ticking = true;
    const watched = { ...this.state.watch };
    try {
      const sha = await this.resolve(this.repo, watched.revision);
      if (!this.state.watch.enabled || this.state.watch.updatedAt !== watched.updatedAt) return;
      if (sha === this.state.watch.lastRevision) return;
      const launched = await this.start({ revision: sha, trigger: 'commit-watch' });
      await this.mutate(() => {
        if (this.state.watch.updatedAt === watched.updatedAt) {
          this.state.watch.lastRevision = launched.revision;
          this.state.watch.error = null;
        }
      });
    } catch (error) {
      await this.mutate(() => {
        if (this.state.watch.updatedAt === watched.updatedAt) this.state.watch.error = redact(error.message);
      });
    } finally {
      this.ticking = false;
    }
  }
  async triage(id, patch) {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new HttpError(404, 'Finding not found.');
    const { runs } = await this.history();
    const findings = await collectFindings(this.root, runs, this.state.triage);
    if (!findings.some(f => f.id === id)) throw new HttpError(404, 'Finding not found.');
    if (
      !['untriaged', 'confirmed', 'resolved', 'dismissed'].includes(patch.disposition) ||
      !['unassessed', 'low', 'medium', 'high', 'critical'].includes(patch.severity) ||
      typeof patch.note !== 'string' ||
      patch.note.length > 2000
    )
      throw new HttpError(400, 'Invalid triage fields.');
    if (['resolved', 'dismissed'].includes(patch.disposition) && !patch.note.trim())
      throw new HttpError(400, 'Add a reason before resolving or dismissing a finding.');
    if (
      findings.find(f => f.id === id).check === 'discovery' &&
      patch.disposition === 'confirmed' &&
      !patch.note.trim()
    )
      throw new HttpError(400, 'Explain why the expected behavior is correct before confirming an agent hypothesis.');
    return this.mutate(() => {
      const previous = this.state.triage[id];
      const entry = {
        disposition: patch.disposition,
        severity: patch.severity,
        note: redact(patch.note.trim()),
        updatedAt: now(),
      };
      this.state.triage[id] = { ...entry, audit: [...(previous?.audit ?? []), entry] };
      return this.state.triage[id];
    });
  }
  async close() {
    this.closing = true;
    if (this.active) {
      const pending = this.active;
      pending.controller.abort();
      await pending.completion;
    }
    await this.mutations;
    await unlink(this.lock).catch(() => {});
  }
}

export async function createDashboardServer(options) {
  const dashboard = new Dashboard(options);
  await dashboard.initialize();
  const csrf = randomBytes(32).toString('hex');
  let origin;
  function json(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    try {
      if (request.headers.host !== new URL(origin).host)
        throw new HttpError(403, 'Invalid dashboard host. Use the printed local URL.');
      if (request.headers.origin && request.headers.origin !== origin)
        throw new HttpError(403, 'Cross-origin access is blocked.');
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site access is blocked.');
      const url = new URL(request.url, origin),
        route = url.pathname;
      if (request.method !== 'GET') {
        const token = request.headers['x-atm-token'];
        if (
          request.headers.origin !== origin ||
          typeof token !== 'string' ||
          !/^[a-f0-9]{64}$/.test(token) ||
          !timingSafeEqual(Buffer.from(token), Buffer.from(csrf))
        )
          throw new HttpError(403, 'Refresh the dashboard before making changes.');
      }
      if (request.method === 'GET' && route === '/api/state')
        return json(response, 200, { ...(await dashboard.snapshot()), csrf });
      if (request.method === 'POST' && route === '/api/runs')
        return json(response, 202, await dashboard.start(await jsonBody(request)));
      if (request.method === 'PATCH' && route === '/api/watch') {
        const body = await jsonBody(request);
        return json(response, 200, await dashboard.setWatch(body.enabled, body.revision ?? 'HEAD'));
      }
      const finding = /^\/api\/findings\/([a-f0-9]{24})$/.exec(route);
      if (finding && request.method === 'PATCH')
        return json(response, 200, await dashboard.triage(finding[1], await jsonBody(request)));
      const cancel = /^\/api\/runs\/([^/]+)\/cancel$/.exec(route);
      if (cancel && request.method === 'POST') {
        dashboard.cancel(cancel[1]);
        return json(response, 202, { cancelRequested: true });
      }
      const detail = /^\/api\/runs\/([^/]+)$/.exec(route);
      if (detail && request.method === 'GET') {
        return json(response, 200, await dashboard.detail(detail[1]));
      }
      const artifact = /^\/evidence\/([^/]+)\/([A-Za-z0-9_.-]+)$/.exec(route);
      if (artifact && request.method === 'GET') {
        const [, id, name] = artifact;
        const run = await readRun(dashboard.root, id);
        const entry = run.results.flatMap(r => r.evidence ?? []).find(e => e.path === `evidence/${name}`);
        if (!entry) throw new HttpError(404, 'Evidence is not listed in this run.');
        const directory = await realpath(path.join(dashboard.root, id, 'evidence'));
        if (directory !== path.join(dashboard.root, id, 'evidence'))
          throw new HttpError(403, 'Evidence symlinks are not served.');
        const file = path.join(directory, name),
          metadata = await lstat(file);
        if (!metadata.isFile() || metadata.size > 32_000_000)
          throw new HttpError(413, 'Evidence cannot be previewed. Open the local run directory.');
        const type = name.endsWith('.png')
          ? 'image/png'
          : name.endsWith('.json')
            ? 'application/json'
            : name.endsWith('.zip')
              ? 'application/zip'
              : 'text/plain; charset=utf-8';
        response.setHeader('Content-Type', type);
        if (name.endsWith('.zip')) response.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        return response.end(await readFile(file));
      }
      const staticFiles = {
        '/': ['index.html', 'text/html; charset=utf-8'],
        '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
        '/style.css': ['style.css', 'text/css; charset=utf-8'],
      };
      if (request.method === 'GET' && Object.hasOwn(staticFiles, route)) {
        const [file, type] = staticFiles[route];
        response.setHeader('Content-Type', type);
        return response.end(await readFile(path.join(assets, file)));
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      json(response, error.status ?? (error.code === 'ENOENT' ? 404 : 500), {
        error: redact(error.message),
      });
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 4310, '127.0.0.1', () => resolve(undefined));
    });
  } catch (error) {
    await dashboard.close();
    throw error;
  }
  origin = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;
  const timer = setInterval(() => {
    void dashboard.tick().catch(error => {
      dashboard.lastLaunchError = redact(error.message);
    });
  }, options.watchInterval ?? 15_000);
  const close = async () => {
    clearInterval(timer);
    const stopped = new Promise(resolve => {
      server.close(resolve);
      server.closeIdleConnections();
    });
    await dashboard.close();
    await stopped;
  };
  return { dashboard, server, origin, close };
}
