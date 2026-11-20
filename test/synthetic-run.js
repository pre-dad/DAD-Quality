import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Run } from '../src/core.js';
import { loadPolicy } from '../src/policy.js';

// A finished run on disk with a synthetic result and evidence file for every
// check in the default policy. `status` and `summary` override a check's outcome.
export async function syntheticRun(
  t,
  {
    prefix,
    options = {},
    source,
    status = () => 'passed',
    summary = 'Synthetic pass',
    evidence = name => `Synthetic ${name}`,
  },
) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const policy = await loadPolicy();
  const run = await Run.create(
    root,
    options,
    policy.definition.checks.filter(c => c.required).map(c => c.id),
    policy,
  );
  run.data.candidate = {
    revision: 'a'.repeat(40),
    source,
    sourceArchiveSha256: 'b'.repeat(64),
    images: { api: `sha256:${'c'.repeat(64)}`, web: `sha256:${'d'.repeat(64)}` },
  };
  for (const check of policy.definition.checks) {
    const files = [];
    for (const name of check.evidence) files.push(await run.evidence(name, evidence(name)));
    run.data.results.push({
      id: check.id,
      required: check.required,
      status: status(check),
      summary: typeof summary === 'function' ? summary(check) : summary,
      startedAt: run.data.startedAt,
      finishedAt: run.data.startedAt,
      evidence: files,
    });
  }
  await run.finish();
  return { root, run, policy };
}
