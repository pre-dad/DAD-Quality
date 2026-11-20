import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { RunError } from './core.js';
import { validateGenericConfig } from './generic-config.js';

// Deterministic, LLM-free onboarding: inspect a repository's real build/run
// artifacts and derive a starter atm.config.json the generic-web adapter can
// use. The output is a best-effort DRAFT the human reviews — we read the repo's
// actual files (compose, Dockerfile, package.json, framework manifests) and
// derive the provision block from them, never asking a model to invent one, and
// never fabricating credentialed actors or a seed command (a machine cannot
// know a real session). Detection only READS under repoDir and WRITES config;
// it never executes the repository's commands or makes network calls.

const PREFERRED_WEB_PORTS = [80, 443, 3000, 8080, 8000, 5000, 4000, 8888];
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
// Services that are infrastructure, not the application under test. Matched
// against the service name and its `image:` so detection does not pick a
// database/cache/broker as the web entrypoint.
const DATASTORE =
  /\b(postgres|postgresql|mysql|mariadb|redis|memcache|memcached|mongo|mongodb|rabbitmq|kafka|elasticsearch|opensearch|clickhouse|cassandra|minio|localstack|zookeeper|nats|etcd|mailpit|mailhog|maildev|adminer|pgadmin|phpmyadmin|redisinsight)\b/i;
const DATASTORE_PORTS = new Set([5432, 3306, 6379, 27017, 11211, 5672, 9092, 2181, 2379, 55432, 1025, 8025, 1143]);

async function tryRead(dir, name) {
  try {
    return await readFile(path.join(dir, name), 'utf8');
  } catch {
    return null;
  }
}

async function exists(dir, name) {
  try {
    await access(path.join(dir, name));
    return true;
  } catch {
    return false;
  }
}

/**
 * Container port of one compose port entry: `80`, `8080:80`, `127.0.0.1:8080:80`,
 * `"8080:80/tcp"`. The container port is always the last segment.
 * @param {string} entry
 */
function containerPort(entry) {
  const spec = entry
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\/\w+$/, '');
  const last = spec.split(':').pop() ?? '';
  return /^\d{1,5}$/.test(last) ? Number(last) : null;
}

/**
 * Extract published "host:container" port mappings per service from a compose
 * file using targeted line parsing (no YAML dependency). Handles the common
 * `ports:` block forms: `- "8080:80"`, `- 8080:80`, and inline `ports: ["H:C"]`.
 * Returns [{ service, container, file }] for services that publish a port.
 * Best-effort: unusual shapes are skipped, letting other signals take over.
 * @param {string} text
 * @param {string} file
 */
export function parseComposePorts(text, file) {
  const lines = text.split(/\r?\n/);
  const results = [];
  const images = new Map();
  let service = null;
  let serviceIndent = -1;
  let inPorts = false;
  let portsIndent = -1;

  const indentOf = l => l.length - l.trimStart().length;

  let inServices = false;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = indentOf(raw);
    const trimmed = raw.trim();

    if (/^services\s*:/.test(trimmed) && indent === 0) {
      inServices = true;
      continue;
    }
    if (!inServices) continue;
    // A top-level key (indent 0) that is not `services:` ends the services block.
    if (indent === 0 && !/^services\s*:/.test(trimmed)) {
      inServices = false;
      continue;
    }

    // A service header: `name:` nested directly under services.
    if (/^[\w.-]+\s*:\s*$/.test(trimmed) && (serviceIndent === -1 || indent <= serviceIndent)) {
      service = trimmed.replace(/\s*:\s*$/, '');
      serviceIndent = indent;
      inPorts = false;
      continue;
    }
    if (!service) continue;

    // Record the service image so the picker can skip datastores.
    const image = /^image\s*:\s*(.+)$/.exec(trimmed);
    if (image) images.set(service, image[1].trim().replace(/^["']|["']$/g, ''));

    // Inline `ports: ["8080:80"]`
    const inline = /^ports\s*:\s*\[(.+)\]\s*$/.exec(trimmed);
    if (inline) {
      const container = containerPort(inline[1].split(',')[0]);
      if (container) results.push({ service, container, file });
      continue;
    }
    if (/^ports\s*:\s*$/.test(trimmed)) {
      inPorts = true;
      portsIndent = indent;
      continue;
    }
    if (inPorts) {
      if (indent <= portsIndent && !trimmed.startsWith('-')) {
        inPorts = false;
      } else if (trimmed.startsWith('-')) {
        const container = containerPort(trimmed.slice(1));
        if (container) results.push({ service, container, file });
      }
    }
  }
  return results.map(r => ({ ...r, image: images.get(r.service) }));
}

function isDatastore(entry) {
  return (
    DATASTORE.test(entry.service) ||
    (entry.image && DATASTORE.test(entry.image)) ||
    DATASTORE_PORTS.has(entry.container)
  );
}

function pickWebService(ports) {
  // Prefer actual application services; a compose file that publishes only
  // datastore ports has no web entrypoint we can explore.
  const candidates = ports.filter(p => !isDatastore(p));
  if (candidates.length === 0) return null;
  for (const p of PREFERRED_WEB_PORTS) {
    const hit = candidates.find(x => x.container === p);
    if (hit) return hit;
  }
  return candidates[0];
}

/** Find the first EXPOSE port in a Dockerfile. */
function dockerfileExpose(text) {
  const m = /^\s*EXPOSE\s+(\d{1,5})/im.exec(text);
  return m ? Number(m[1]) : null;
}

/** Find a port literal in a command string (e.g. "next start -p 4000", "runserver 0.0.0.0:8000"). */
function portFromScript(script) {
  const flag = /(?:-p|--port|PORT=)\s*=?\s*(\d{2,5})\b/.exec(script);
  if (flag) return Number(flag[1]);
  const colon = /:(\d{2,5})\b/.exec(script);
  return colon ? Number(colon[1]) : null;
}

/**
 * Inspect a repository directory and derive a validated starter config.
 * @param {string} repoDir
 * @returns {Promise<import('./generic-config.js').GenericConfig>}
 */
export async function detectConfig(repoDir) {
  const tried = [];
  const name = path.basename(path.resolve(repoDir)).slice(0, 80) || 'app';
  const visitor = { id: 'visitor', description: 'Anonymous visitor', entry: '/' };

  // 1. Docker Compose — the most reliable signal, derived from the real file.
  for (const file of COMPOSE_FILES) {
    const text = await tryRead(repoDir, file);
    if (!text) continue;
    tried.push(`compose (${file})`);
    const chosen = pickWebService(parseComposePorts(text, file));
    if (chosen)
      return finalize({
        name,
        provision: {
          mode: 'compose',
          composeFile: file,
          service: chosen.service,
          port: chosen.container,
          healthPath: '/',
        },
        actors: [visitor],
      });
  }

  // 2. Node — package.json with a start/dev script.
  const pkgText = await tryRead(repoDir, 'package.json');
  if (pkgText) {
    tried.push('node (package.json)');
    let pkg;
    try {
      pkg = JSON.parse(pkgText);
    } catch {
      pkg = null;
    }
    const scripts = pkg?.scripts ?? {};
    const startName = scripts.start ? 'start' : scripts.serve ? 'serve' : scripts.dev ? 'dev' : null;
    if (startName) {
      const hasLock = (await exists(repoDir, 'package-lock.json')) || (await exists(repoDir, 'npm-shrinkwrap.json'));
      const dockerfile = await tryRead(repoDir, 'Dockerfile');
      const port = portFromScript(scripts[startName]) ?? (dockerfile ? dockerfileExpose(dockerfile) : null) ?? 3000;
      return finalize({
        name,
        provision: {
          mode: 'command',
          build: hasLock ? ['npm', 'ci'] : ['npm', 'install'],
          start: ['npm', 'run', startName],
          port,
          healthPath: '/',
        },
        actors: [visitor],
      });
    }
  }

  // 3. Python Django — manage.py.
  if (await exists(repoDir, 'manage.py')) {
    tried.push('python (manage.py)');
    const hasReq = await exists(repoDir, 'requirements.txt');
    return finalize({
      name,
      provision: {
        mode: 'command',
        ...(hasReq ? { build: ['pip', 'install', '-r', 'requirements.txt'] } : {}),
        start: ['python', 'manage.py', 'runserver', '0.0.0.0:8000'],
        port: 8000,
        healthPath: '/',
      },
      actors: [visitor],
    });
  }

  // 4. Procfile web: line.
  const procfile = await tryRead(repoDir, 'Procfile');
  if (procfile) {
    tried.push('procfile');
    const web = /^web\s*:\s*(.+)$/im.exec(procfile);
    if (web) {
      const argv = web[1].trim().split(/\s+/).slice(0, 32);
      return finalize({
        name,
        provision: {
          mode: 'command',
          start: argv,
          port: portFromScript(web[1]) ?? 8080,
          healthPath: '/',
        },
        actors: [visitor],
      });
    }
  }

  // 5. Ruby on Rails.
  if ((await exists(repoDir, 'config.ru')) && (await exists(repoDir, 'Gemfile'))) {
    tried.push('ruby (config.ru + Gemfile)');
    return finalize({
      name,
      provision: {
        mode: 'command',
        build: ['bundle', 'install'],
        start: ['bundle', 'exec', 'rails', 'server', '-b', '0.0.0.0', '-p', '3000'],
        port: 3000,
        healthPath: '/',
      },
      actors: [visitor],
    });
  }

  throw new RunError(
    `Could not detect how to build and start this app. Looked for: ${
      tried.length ? tried.join(', ') : 'compose, package.json, manage.py, Procfile, config.ru'
    }. Write atm.config.json by hand — see docs/generic-target.md.`,
  );
}

// Validate before returning so detect can never emit a config explore would reject.
function finalize(draft) {
  return validateGenericConfig({ schemaVersion: 1, ...draft });
}
