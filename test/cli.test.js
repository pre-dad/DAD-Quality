import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.js';

const providerVariables = ['ATM_PROVIDER', 'ATM_MODEL', 'OPENAI_API_KEY', 'TINKER_API_KEY'];
function withoutProviderEnvironment(t) {
  const saved = Object.fromEntries(providerVariables.map(name => [name, process.env[name]]));
  for (const name of providerVariables) delete process.env[name];
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

// The CLI is codebase-agnostic. --target/--repo are first-class; only the
// real constraints remain (validation is dad-only, benchmark is the sole repo-less target).

test('run is rejected for non-dad targets because only dad ships an acceptance policy', async () => {
  await assert.rejects(
    main(['run', '--repo', '/path/to/repo', '--target', 'generic-web']),
    /release validation.*only for --target dad/i,
  );
});

test('explore on a non-dad target is accepted past the target guard and stops at model configuration', async t => {
  withoutProviderEnvironment(t);
  await assert.rejects(
    main(['explore', '--repo', '/path/to/repo', '--target', 'generic-web']),
    /Configure OPENAI_API_KEY and --model or ATM_MODEL for openai/,
  );
});

test('an unknown target errors before provisioning', async () => {
  await assert.rejects(main(['explore', '--repo', '/path/to/repo', '--target', 'nope']), /Unknown target: nope/);
});

test('--repo is required for dad and generic-web but not benchmark', async t => {
  withoutProviderEnvironment(t);
  await assert.rejects(main(['explore', '--target', 'generic-web']), /--repo .*only --target benchmark needs no repo/i);
  await assert.rejects(main(['run']), /--repo/);
  // benchmark needs no repo: it passes the repo guard and fails later (model config).
  await assert.rejects(
    main(['explore', '--target', 'benchmark']),
    /Configure OPENAI_API_KEY and --model or ATM_MODEL for openai/,
  );
});

test('--config is rejected unless the target is generic-web', async () => {
  await assert.rejects(
    main(['explore', '--repo', '/path/to/repo', '--target', 'dad', '--config', 'atm.config.json']),
    /--config applies only to --target generic-web/,
  );
});

test('usage error names a generic repo path, not DAD-Main', async () => {
  await assert.rejects(main(['bogus']), error => {
    assert.match(error.message, /--repo \/path\/to\/repo/);
    assert.doesNotMatch(error.message, /DAD-Main/);
    return true;
  });
});
