# Agent guide — DAD-Quality (ATM)

Local release-acceptance + bounded AI exploration runner. Start with these; this file
only adds what they do not say.

- **[README.md](README.md)** — what it is, how to run, the checks, the versioned policy,
  and the "Repository conventions" section (working docs go in git-ignored `docs/working/`).
- **[docs/discovery.md](docs/discovery.md)**, **[docs/generic-target.md](docs/generic-target.md)** —
  the discovery engine and the generic (codebase-agnostic) target + `atm.config.json`.
- Cross-repo system docs live in the separate **DAD-Docs** repo.
- **[Shared agent workflow](https://github.com/pre-dad/DAD-Docs/blob/dev/conventions/agent-workflow.md)** —
  read DAD-Docs for skill setup, routing, and independent-review boundaries. Keep
  shared procedures there; this guide owns repo-local commands and constraints.

## The gate (run before every push; CI runs the same)

```sh
npm run check        # syntax of every script
npm run typecheck    # checkJs over src, scripts, dashboard frontend
npm run lint         # biome, --error-on-warnings (even "info" fails)
npm test             # full suite incl. a Docker fixture (slow)
```

Fast single file: `node --test test/<file>.test.js`. `npm run format` fixes most lint,
but **unused imports and useless `continue` must be hand-fixed**.

## Branch and push discipline

- Work on `dev`; ship via `dev` → PR → `main`. Never push to `main` directly.
- Run `git commit` and `git push` as two separate commands (a long message can trip the
  push-target safety scan when chained).

## Code comments

- Comments explain **why** (a constraint, a trade-off, a non-obvious behavior), not what the
  code already says.
- No commented-out code (git keeps history). A `TODO` names a tracked issue.

## Gotchas not written in the docs

- **Do not break the DAD policy digest.** The `dad` target's acceptance policy is the
  reference; every generalization change must leave its digest test unchanged.
- **Adapters are phase-ID-stable.** A new discovery-target adapter must present exactly
  the phase IDs `policy.js validatePolicy` hardcodes
  (`snapshot, docker, build, database, deploy, discovery, cleanup`) with their fixed
  evidence; phases that don't apply are recorded `not-applicable` **with** their required
  evidence (the BenchmarkAdapter pattern), never omitted. Register via
  `src/targets/index.js`.
- **`detect` is deterministic (no model).** It derives `atm.config.json` from the repo's
  real artifacts and skips datastore + dev-infra services (postgres/redis/mailpit/…) so it
  picks the real web entrypoint. Output always passes `validateGenericConfig`.
- **JSDoc typing traps:** a bare `object` typedef hides fields from TS (type the
  sub-fields); `Object.freeze` makes arrays readonly (needs a cast); a union-typed options
  object must not pass a key one branch lacks.
- **Dashboard explore tests need a dummy `OPENAI_API_KEY`** in the env (and restore it) to
  pass the AI-config guard. Repo tests use `os.tmpdir()` for fixtures by convention.
- **A dependency used in the product path** (not just tests) moves
  `devDependencies` → `dependencies`; reconcile the lock with
  `npm install --package-lock-only`.
- **Packaging:** the `package.json` `files` allowlist is authoritative over `.npmignore`.
  `web/` must be listed (the dashboard loads `../web/...`); list specific published docs,
  not the whole `docs/` dir, to avoid sweeping in `docs/working/`. Verify with
  `npm pack --dry-run`.
