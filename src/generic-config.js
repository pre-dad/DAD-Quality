import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { RunError } from './core.js';

// The contract a target repository supplies so the generic-web adapter can
// provision and explore it without any compiled-in, application-specific
// knowledge. It is intentionally small: everything the adapter needs to build,
// start, reach and (optionally) seed the application, and nothing executable
// beyond the commands the operator already trusts in their own repository.
//
// Two provisioning modes are supported, chosen by `provision.mode`:
//   - "compose":  a Docker Compose file the adapter brings up; the named service
//                 publishes a loopback port the adapter waits on.
//   - "command":  a build command then a long-running start command that serve
//                 the application on a loopback port the adapter waits on.
//
// Actors are declared, never inferred: an anonymous visitor is always valid, and
// a repository may declare cookie-backed sessions plus an optional seed command
// that establishes their fixture state. The adapter never fabricates credentials.

const RELATIVE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w./-]{1,200}$/;
// A single leading slash only: "//host" would resolve to another origin.
const HEALTH_PATH = /^\/(?!\/)[\w./?=&%-]{0,199}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const COOKIE_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

function assert(condition, message) {
  if (!condition) throw new RunError(message);
}

function onlyFields(value, allowed, where) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `atm.config.json: ${where} must be an object.`);
  const extra = Object.keys(value).filter(k => !allowed.includes(k));
  assert(extra.length === 0, `atm.config.json: ${where} has unsupported field(s): ${extra.join(', ')}.`);
}

function validateCommand(value, where) {
  assert(
    Array.isArray(value) && value.length >= 1 && value.length <= 32,
    `atm.config.json: ${where} must be a 1-32 element argv array.`,
  );
  for (const part of value)
    assert(
      typeof part === 'string' && part.length >= 1 && part.length <= 400,
      `atm.config.json: ${where} entries must be non-empty strings.`,
    );
}

function validateProvision(provision) {
  onlyFields(
    provision,
    ['mode', 'composeFile', 'service', 'port', 'build', 'start', 'workingDir', 'healthPath', 'startupTimeoutMs'],
    'provision',
  );
  assert(
    ['compose', 'command'].includes(provision.mode),
    'atm.config.json: provision.mode must be "compose" or "command".',
  );
  assert(
    typeof provision.healthPath === 'string' && HEALTH_PATH.test(provision.healthPath),
    'atm.config.json: provision.healthPath must be a loopback-relative path beginning with "/".',
  );
  if (provision.startupTimeoutMs !== undefined)
    assert(
      Number.isInteger(provision.startupTimeoutMs) &&
        provision.startupTimeoutMs >= 1000 &&
        provision.startupTimeoutMs <= 600_000,
      'atm.config.json: provision.startupTimeoutMs must be an integer 1000-600000.',
    );
  if (provision.workingDir !== undefined)
    assert(
      typeof provision.workingDir === 'string' && RELATIVE.test(provision.workingDir),
      'atm.config.json: provision.workingDir must be a repo-relative path.',
    );

  if (provision.mode === 'compose') {
    assert(
      typeof provision.composeFile === 'string' && RELATIVE.test(provision.composeFile),
      'atm.config.json: provision.composeFile must be a repo-relative path.',
    );
    assert(
      typeof provision.service === 'string' && provision.service.length >= 1 && provision.service.length <= 100,
      'atm.config.json: provision.service must name the published service.',
    );
    assert(
      Number.isInteger(provision.port) && provision.port >= 1 && provision.port <= 65535,
      'atm.config.json: provision.port must be the container port the service exposes.',
    );
    assert(
      provision.build === undefined && provision.start === undefined,
      'atm.config.json: compose mode does not take build/start commands.',
    );
  } else {
    if (provision.build !== undefined) validateCommand(provision.build, 'provision.build');
    validateCommand(provision.start, 'provision.start');
    assert(
      provision.composeFile === undefined && provision.service === undefined,
      'atm.config.json: command mode does not take composeFile/service.',
    );
    assert(
      provision.port === undefined ||
        (Number.isInteger(provision.port) && provision.port >= 1 && provision.port <= 65535),
      'atm.config.json: provision.port, when set, must be a valid port.',
    );
  }
}

function validateActors(actors) {
  assert(
    Array.isArray(actors) && actors.length >= 1 && actors.length <= 8,
    'atm.config.json: actors must be a 1-8 element array.',
  );
  const ids = new Set();
  let anonymous = 0;
  for (const actor of actors) {
    onlyFields(actor, ['id', 'description', 'entry', 'cookie', 'cookieName'], 'actors[]');
    assert(
      typeof actor.id === 'string' && ID.test(actor.id),
      'atm.config.json: each actor needs a lowercase id (letters, digits, hyphens).',
    );
    assert(!ids.has(actor.id), `atm.config.json: duplicate actor id "${actor.id}".`);
    ids.add(actor.id);
    assert(
      typeof actor.description === 'string' && actor.description.length >= 1 && actor.description.length <= 200,
      `atm.config.json: actor "${actor.id}" needs a description.`,
    );
    assert(
      typeof actor.entry === 'string' && HEALTH_PATH.test(actor.entry),
      `atm.config.json: actor "${actor.id}" entry must be a loopback-relative path beginning with "/".`,
    );
    if (actor.cookie === undefined) {
      anonymous++;
      assert(actor.cookieName === undefined, `atm.config.json: actor "${actor.id}" has a cookieName but no cookie.`);
    } else {
      assert(
        typeof actor.cookie === 'string' && actor.cookie.length >= 1 && actor.cookie.length <= 4096,
        `atm.config.json: actor "${actor.id}" cookie must be a non-empty string.`,
      );
      // A generic app's session cookie name is not knowable; require it explicitly
      // rather than falling back to any target-specific default.
      assert(
        typeof actor.cookieName === 'string' && COOKIE_NAME.test(actor.cookieName),
        `atm.config.json: actor "${actor.id}" with a cookie must declare its cookieName (the app's session cookie).`,
      );
    }
  }
  assert(anonymous >= 1, 'atm.config.json: at least one anonymous actor (no cookie) is required.');
}

/**
 * Validate a parsed atm.config.json object, returning a normalized, frozen copy.
 * Throws RunError with a specific message on any violation.
 * @param {unknown} raw
 * @returns {import('./generic-config.js').GenericConfig}
 */
export function validateGenericConfig(raw) {
  onlyFields(raw, ['schemaVersion', 'name', 'provision', 'actors', 'seed'], 'root');
  const config = /** @type {any} */ (raw);
  assert(config.schemaVersion === 1, 'atm.config.json: schemaVersion must be 1.');
  assert(
    typeof config.name === 'string' && /^[\w .-]{1,80}$/.test(config.name),
    'atm.config.json: name must be a short identifier.',
  );
  validateProvision(config.provision);
  validateActors(config.actors);
  if (config.seed !== undefined) validateCommand(config.seed, 'seed');
  return /** @type {GenericConfig} */ (
    Object.freeze({
      schemaVersion: 1,
      name: config.name,
      provision: Object.freeze({ ...config.provision }),
      actors: Object.freeze(config.actors.map(a => Object.freeze({ ...a }))),
      seed: config.seed ? Object.freeze([...config.seed]) : undefined,
    })
  );
}

/**
 * Read and validate atm.config.json from a directory (the archived source root).
 * @param {string} dir
 * @param {string} [file]
 */
export async function loadGenericConfig(dir, file = 'atm.config.json') {
  assert(RELATIVE.test(file), 'atm.config.json: config path must be repo-relative.');
  let text;
  try {
    text = await readFile(path.join(dir, file), 'utf8');
  } catch {
    throw new RunError(`Generic target requires ${file} at the repository root; none was found.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new RunError(`atm.config.json is not valid JSON: ${error.message}`);
  }
  return validateGenericConfig(parsed);
}

/**
 * @typedef {object} GenericProvision
 * @property {'compose' | 'command'} mode
 * @property {string} healthPath
 * @property {string} [composeFile]
 * @property {string} [service]
 * @property {number} [port]
 * @property {string[]} [build]
 * @property {string[]} [start]
 * @property {string} [workingDir]
 * @property {number} [startupTimeoutMs]
 *
 * @typedef {object} GenericActor
 * @property {string} id
 * @property {string} description
 * @property {string} entry
 * @property {string} [cookie]
 * @property {string} [cookieName]
 *
 * @typedef {object} GenericConfig
 * @property {1} schemaVersion
 * @property {string} name
 * @property {GenericProvision} provision
 * @property {GenericActor[]} actors
 * @property {string[]} [seed]
 */
