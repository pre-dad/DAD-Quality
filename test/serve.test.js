import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const serve = new URL('../src/serve.js', import.meta.url).pathname;

for (const [name, args, message] of [
  ['a missing repository', [], /Use: npm start/],
  ['an out-of-range port', ['--repo', '.', '--port', '70000'], /Port must be between 1 and 65535/],
  [
    '--config without generic-web',
    ['--repo', '.', '--config', 'x.json'],
    /--config applies only to --target generic-web/,
  ],
]) {
  test(`serve reports ${name} as a message with a failing exit code, not a stack trace`, async () => {
    const error = await promisify(execFile)(process.execPath, [serve, ...args]).then(
      () => assert.fail('serve must exit non-zero'),
      e => e,
    );
    assert.equal(error.code, 1);
    assert.match(error.stderr, message);
    assert.doesNotMatch(error.stderr, /\n\s+at /);
  });
}
