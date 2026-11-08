# Generic web target (`--target generic-web`)

Autonomous discovery runs against DAD-Main by default, but the discovery agent
itself is application-agnostic: it explores whatever web application the harness
provisions. The `generic-web` target lets a repository describe how to build,
start and reach its application — and which actors to explore it as — in a small
`atm.config.json`, so discovery can run against any web app without compiled-in,
application-specific code.

```sh
npm run explore -- --target generic-web --repo /path/to/your-app --model YOUR_MODEL
```

Only committed source is used (the config is read from the archived revision, not
the working tree). The adapter satisfies the same exploration phase contract as
every other target (`snapshot`, `docker`, `build`, `database`, `deploy`,
`discovery`, `cleanup`); phases that do not apply to a given config are recorded
as not-applicable with their required evidence still present.

## `atm.config.json`

Place `atm.config.json` at the repository root (or pass `--config <repo-relative
path>`). Two provisioning modes are supported.

## Generate a starter config (`detect`)

You do not have to write `atm.config.json` by hand. `detect` inspects a
repository's real build/run artifacts — a Docker Compose file, `package.json`,
`manage.py`, a `Procfile`, `config.ru` — and derives a validated starter config:

```sh
npm run atm -- detect --repo /path/to/your-app            # writes atm.config.json
npm run atm -- detect --repo /path/to/your-app --print    # preview, writes nothing
npm run atm -- detect --repo /path/to/your-app --force     # overwrite an existing file
```

Detection is deterministic and uses no model: it reads the repository's own files
and derives the `provision` block from them (Keel's principle — derive from the
real artifact, don't trust a declaration). The output always passes the schema
validator, or `detect` fails with a message naming the signals it looked for
rather than writing a half-config. It emits exactly one anonymous `visitor`
actor; you add authenticated actors and an optional `seed` command by hand, since
a machine cannot derive a real session. Review the generated file before running
`explore`.

### Compose mode

The adapter brings up a Docker Compose file the repository provides and maps the
named service's container port to a loopback port the agent explores.

```json
{
  "schemaVersion": 1,
  "name": "my-app",
  "provision": {
    "mode": "compose",
    "composeFile": "docker-compose.yml",
    "service": "web",
    "port": 8080,
    "healthPath": "/"
  },
  "actors": [{ "id": "guest", "description": "Anonymous visitor", "entry": "/" }]
}
```

### Command mode

The adapter runs an optional build command, then a long-running start command
that serves the application on a loopback port passed as `PORT`. The process runs with a minimal environment (`PATH`, `HOME`, `TMPDIR`, `PORT`), not the operator's credentials.

```json
{
  "schemaVersion": 1,
  "name": "my-app",
  "provision": {
    "mode": "command",
    "build": ["npm", "ci"],
    "start": ["npm", "start"],
    "healthPath": "/health",
    "startupTimeoutMs": 60000
  },
  "actors": [
    { "id": "guest", "description": "Anonymous visitor", "entry": "/" },
    {
      "id": "member",
      "description": "Signed-in member",
      "entry": "/app",
      "cookie": "synthetic-session-value",
      "cookieName": "session"
    }
  ]
}
```

## Fields

- `schemaVersion` — must be `1`.
- `name` — a short identifier for the application (recorded in run evidence).
- `provision.mode` — `compose` or `command`.
- `provision.healthPath` — a loopback-relative path (begins with `/`) the adapter
  polls until it answers `2xx`/`3xx` before discovery starts.
- `provision.startupTimeoutMs` — optional readiness deadline (1000–600000,
  default 120000).
- Compose mode: `composeFile` (repo-relative), `service` (the published
  service), `port` (the container port that service exposes).
- Command mode: `start` (required argv array), `build` (optional argv array),
  `workingDir` (optional repo-relative directory the commands run in).
- `actors` — 1–8 declared actors. At least one must be anonymous (no `cookie`).
  A cookie-backed actor supplies a synthetic session `cookie` and the `cookieName`
  of the application's own session cookie (required — the harness applies no
  target-specific default). The harness never fabricates credentials; you declare them.
- `seed` — optional argv array run once before discovery to establish fixture
  state (in compose mode it runs via `docker compose run` against the service).

## Boundaries

The generic target inherits the same isolation and evidence guarantees as the
DAD target: committed source only, loopback-only ingress, redacted logs, hashed
evidence, fail-closed assessment. As with every target, this is intended for
**trusted application source with synthetic data** — Docker builds and start
commands execute repository code. Use a dedicated isolated host before pointing
it at untrusted repositories.

The generic target owns no database model: data lifecycle and any clean-fixture
replay belong to the application's own compose/start. Without a replay fixture,
discovery still runs — it simply cannot auto-replay a mutation-dependent finding
(the same limitation the in-process benchmark target documents).
