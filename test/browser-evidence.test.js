import test from 'node:test';
import assert from 'node:assert/strict';
import { retainEvidence } from '../src/browser.js';

function fixture() {
  const written = [];
  const adapter = {
    run: {
      async evidence(name, content) {
        written.push({ name, content });
        return { path: `evidence/${name}` };
      },
    },
  };
  return { adapter, result: { evidence: [] }, written };
}

test('retainEvidence propagates a capture error when the journey succeeded', async () => {
  const { adapter, result } = fixture();
  await assert.rejects(
    retainEvidence(adapter, result, 'trace', false, async () => {
      throw new Error('tracing.stop failed');
    }),
    /tracing\.stop failed/,
  );
});

test('retainEvidence records a capture error instead of masking the journey failure', async () => {
  const { adapter, result, written } = fixture();
  await retainEvidence(adapter, result, 'trace', true, async () => {
    throw new Error('tracing.stop failed');
  });
  assert.deepEqual(written, [{ name: 'trace-capture-error.txt', content: 'tracing.stop failed' }]);
  assert.equal(result.evidence.length, 1);
});
