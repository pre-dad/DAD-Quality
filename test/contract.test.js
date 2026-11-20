import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContract, actionMatches, contractAssertion } from '../src/experiment-contract.js';
import { discover, evaluateExpectation } from '../src/discovery.js';

const action = (kind, fields = {}) => ({
  action: kind,
  target: '',
  value: '',
  title: '',
  reason: 'Verify the declared behavior.',
  expectation: '',
  text: '',
  ...fields,
});
const requiredAction = (id, kind = 'reload', target = '', actor = 'a', value = '') => ({
  id,
  kind: 'action',
  action: kind,
  actor,
  target,
  value,
});
const requiredAssertion = (id, fields = {}) => ({
  id,
  kind: 'assertion',
  expectation: 'state_equals',
  actor: 'a',
  target: 'a',
  value: 'name',
  text: 'Changed',
  baseline: '',
  ...fields,
});
const plan = checks => ({
  capability: 'Profile',
  behavior: 'Persistence',
  state: 'Valid name',
  preconditions: 'Signed-in donor',
  expected: 'A saved name persists after reload',
  basis: 'observed',
  references: [],
  checks,
});
const investigate = checks =>
  action('investigate', { title: 'Profile persistence', value: JSON.stringify(plan(checks)) });
const observation = (fields = {}) => ({
  id: 'o1',
  actor: 'a',
  path: '/profile',
  text: 'Profile',
  controls: [{ id: 'c1', label: 'Save', identity: 'button-save' }],
  state: { a: { name: 'Changed', count: 1 }, b: { name: 'Other' } },
  ...fields,
});
const blank = () => ({
  requests: 0,
  tokens: 0,
  observations: [],
  investigations: [],
  events: [],
  findings: [],
  pages: [],
});
async function run(decisions, { act = async () => {}, observe = () => observation() } = {}) {
  const report = blank();
  let count = 0;
  await discover({
    provider: async () => ({ action: decisions.shift(), tokens: 1 }),
    browser: { observe: async () => ({ ...observe(), id: `o${++count}` }), pages: () => [], act },
    report,
    signal: new AbortController().signal,
    maxRequests: decisions.length,
  });
  return report;
}

test('contracts reject duplicate IDs, forward checkpoints, unsafe deltas, assertion-only plans and unsupported actions', () => {
  const before = { id: 'before', kind: 'checkpoint' };
  const good = [
    before,
    requiredAction('reload'),
    requiredAssertion('same', { expectation: 'state_unchanged', baseline: 'before', text: '' }),
  ];
  assert.doesNotThrow(() => validateContract(good));
  for (const checks of [
    [],
    [requiredAssertion('only')],
    [requiredAssertion('first'), requiredAction('reload')],
    [requiredAction('same'), requiredAssertion('same')],
    [
      requiredAction('reload'),
      requiredAssertion('future', { expectation: 'state_delta', baseline: 'later', text: '1' }),
      { id: 'later', kind: 'checkpoint' },
    ],
    [
      before,
      requiredAction('reload'),
      requiredAssertion('delta', { expectation: 'state_delta', baseline: 'before', text: '9007199254740992' }),
    ],
    [requiredAction('reload', 'reload', 'x'), requiredAssertion('ok')],
    [{ ...requiredAction('run'), action: 'eval' }, requiredAssertion('ok')],
    [requiredAction('reload'), { ...requiredAssertion('ok'), code: 'untrusted' }],
  ])
    assert.throws(() => validateContract(checks));
});

test('a passing unrelated assertion and an early reload cannot satisfy the declared save/reload/persist contract', async () => {
  const report = await run([
    investigate([requiredAction('save', 'click', 'Save'), requiredAction('reload'), requiredAssertion('persist')]),
    action('reload'),
    action('assert', { expectation: 'path_equals', text: '/profile' }),
    action('conclude', { value: 'supported' }),
    action('verify', { target: 'persist' }),
    action('click', { target: 'c1' }),
    action('conclude', { value: 'supported' }),
    action('reload'),
    action('verify', { target: 'persist', expectation: 'state_equals', text: 'invented override' }),
    action('conclude', { value: 'supported' }),
    action('finish'),
  ]);
  assert.match(report.events[3].outcome, /all declared/);
  assert.match(report.events[4].outcome, /next declared/);
  assert.match(report.events[6].outcome, /all declared/);
  assert.equal(report.status, 'completed');
  assert.deepEqual(
    report.investigations[0].progress.map(c => c.checkId),
    ['save', 'reload', 'persist'],
  );
  assert.equal(
    report.assertions.at(-1).action.text,
    'Changed',
    'Model overrides must not alter the declared expectation',
  );
});

test('failed browser actions and actions by another actor cannot advance contract progress', async () => {
  const checks = [requiredAction('save', 'click', 'Save'), requiredAssertion('persist')];
  let attempts = 0;
  const report = await run(
    [
      investigate(checks),
      action('click', { target: 'c1' }),
      action('verify', { target: 'persist' }),
      action('conclude', { value: 'blocked' }),
      action('finish'),
    ],
    {
      act: async () => {
        attempts++;
        throw new Error('Button unavailable');
      },
    },
  );
  assert.equal(attempts, 1);
  assert.equal(report.investigations[0].progress.length, 0);
  assert.equal(report.coverage.experiments[0].status, 'blocked');
  assert.equal(actionMatches(checks[0], action('click', { target: 'c1' }), observation({ actor: 'b' })), false);
  assert.equal(
    actionMatches(
      checks[0],
      action('click', { target: 'c1' }),
      observation({
        controls: [
          { id: 'c1', label: 'Save' },
          { id: 'c2', label: 'Save' },
        ],
      }),
    ),
    false,
  );
});

test('supplemental failures cannot refute a different declared requirement and missing evidence cannot pass it', async () => {
  const report = await run(
    [
      investigate([requiredAction('reload'), requiredAssertion('persist')]),
      action('reload'),
      action('assert', { expectation: 'text_present', text: 'Missing' }),
      action('conclude', { value: 'refuted' }),
      action('verify', { target: 'persist' }),
      action('conclude', { value: 'supported' }),
      action('conclude', { value: 'blocked' }),
      action('finish'),
    ],
    { observe: () => observation({ state: {} }) },
  );
  assert.match(report.events[3].outcome, /failed declared/);
  assert.match(report.events[4].outcome, /unavailable/);
  assert.match(report.events[5].outcome, /all declared/);
  assert.equal(report.investigations[0].progress.length, 1);
});

test('checkpoint evidence is immutable and cannot be recaptured to hide a change', async () => {
  let value = 'before';
  const checks = [
    { id: 'before', kind: 'checkpoint' },
    requiredAction('save', 'click', 'Save'),
    requiredAssertion('isolation', {
      expectation: 'state_unchanged',
      target: 'b',
      value: 'name',
      text: '',
      baseline: 'before',
    }),
  ];
  const report = await run(
    [
      investigate(checks),
      action('checkpoint', { target: 'before' }),
      action('click', { target: 'c1' }),
      action('checkpoint', { target: 'before' }),
      action('verify', { target: 'isolation' }),
      action('conclude', { value: 'refuted' }),
      action('finish'),
    ],
    {
      observe: () => observation({ state: { b: { name: value } } }),
      act: async () => {
        value = 'after';
      },
    },
  );
  assert.equal(report.checkpoints.length, 1);
  assert.match(report.events[3].outcome, /next declared checkpoint/);
  const verified = report.assertions[0].verification;
  assert.equal(verified.before, 'before');
  assert.equal(verified.actual, 'after');
  assert.equal(verified.passed, false);
  assert.equal(report.investigations[0].conclusion.status, 'refuted');
});

test('relationship assertions distinguish types, missing state and unsafe counters', () => {
  const before = observation({ id: 'before', state: { a: { count: 2, value: null } } });
  const current = observation({ state: { a: { count: 3, value: 'null' } } });
  const delta = {
    ...action('assert', { expectation: 'state_delta', target: 'a', value: 'count', text: '1' }),
    baseline: 'start',
  };
  assert.equal(evaluateExpectation(delta, current, { start: before }).passed, true);
  assert.equal(evaluateExpectation({ ...delta, text: '0' }, current, { start: before }).passed, false);
  assert.equal(evaluateExpectation(delta, current).evaluable, false);
  assert.equal(evaluateExpectation({ ...delta, value: 'missing' }, current, { start: before }).evaluable, false);
  assert.equal(
    evaluateExpectation(delta, observation({ state: { a: { count: '3' } } }), { start: before }).evaluable,
    false,
  );
  assert.equal(
    evaluateExpectation({ ...delta, expectation: 'state_unchanged', value: 'value' }, current, { start: before })
      .passed,
    false,
    'null and string null are different',
  );
});

test('field relationships bind stable identity rather than reused IDs and require matching actors', () => {
  const before = observation({
    id: 'before',
    controls: [{ id: 'c1', identity: 'name', value: 'Alex', checked: false }],
  });
  const current = observation({
    controls: [
      { id: 'c2', identity: 'name', value: 'Alex', checked: false },
      { id: 'c1', identity: 'email', value: 'Other' },
    ],
  });
  const check = { ...action('assert', { expectation: 'field_unchanged', target: 'c2' }), baseline: 'start' };
  assert.equal(evaluateExpectation(check, current, { start: before }).passed, true);
  assert.equal(
    evaluateExpectation({ ...check, expectation: 'checkbox_unchanged' }, current, { start: before }).passed,
    true,
  );
  assert.equal(evaluateExpectation(check, { ...current, actor: 'b' }, { start: before }).evaluable, false);
  assert.equal(
    evaluateExpectation(check, observation({ controls: [{ id: 'c2', identity: 'different', value: 'Alex' }] }), {
      start: before,
    }).evaluable,
    false,
  );
  assert.throws(
    () =>
      contractAssertion(requiredAssertion('name', { expectation: 'field_value', target: 'Name' }), current, {
        plan: plan([]),
      }),
    /uniquely observed/,
  );
});

test('contracts cannot be silently replaced mid-experiment; rejected plans leave the run recoverable', async () => {
  const checks = [requiredAction('reload'), requiredAssertion('persist')];
  const report = await run([
    action('investigate', { title: 'Malformed', value: '{}' }),
    investigate(checks),
    investigate([requiredAction('skip'), requiredAssertion('easy')]),
    action('reload'),
    action('verify', { target: 'persist' }),
    action('conclude', { value: 'supported' }),
    action('finish'),
  ]);
  assert.equal(report.investigations.length, 1);
  assert.match(report.events[0].outcome, /plan fields/);
  assert.match(report.events[2].outcome, /Conclude the active/);
  assert.equal(report.status, 'completed');
});

test('repeated rejected plans stop early with honest evidence and actionable tool guidance', async () => {
  const invalid = investigate([requiredAction('source', 'list_source', '.'), requiredAssertion('persist')]);
  const report = await run([invalid, invalid, invalid, invalid, action('finish')]);
  assert.equal(report.requests, 3);
  assert.equal(report.events.length, 3);
  assert.equal(report.status, 'inconclusive');
  assert.match(report.summary, /three consecutive/);
  assert.match(report.events[0].outcome, /Use source\/memory tools directly/);
  assert.equal(report.findings.length, 0);
  assert.equal(report.investigations.length, 0);
});

test('a repaired plan can recover after rejection and a non-plan action resets the rejection streak', async () => {
  const invalid = investigate([requiredAction('source', 'list_source', '.'), requiredAssertion('persist')]);
  const report = await run([
    invalid,
    invalid,
    action('reload'),
    invalid,
    investigate([requiredAction('reload'), requiredAssertion('persist')]),
    action('reload'),
    action('verify', { target: 'persist' }),
    action('conclude', { value: 'supported' }),
    action('finish'),
  ]);
  assert.equal(report.status, 'completed');
  assert.equal(report.investigations[0].conclusion.status, 'supported');
});

test('repeated attempts to replace an unfinished plan also stop without discarding it', async () => {
  const valid = investigate([requiredAction('reload'), requiredAssertion('persist')]);
  const report = await run([valid, valid, valid, valid, action('finish')]);
  assert.equal(report.requests, 4);
  assert.equal(report.status, 'inconclusive');
  assert.equal(report.investigations.length, 1);
  assert.equal(report.investigations[0].conclusion, undefined);
});

// Phase 5a: accessibility is a first-class discovery expectation.
test('a11y_clean passes with no violations, fails with violations, and is inconclusive without an audit', () => {
  const check = action('assert', { expectation: 'a11y_clean' });
  // No violations captured -> passes.
  assert.equal(evaluateExpectation(check, observation({ a11y: [] })).passed, true);
  // Violations captured -> fails, with the count as actual evidence.
  const failed = evaluateExpectation(
    check,
    observation({ a11y: [{ rule: 'color-contrast', impact: 'serious', help: 'x', targets: ['.btn'] }] }),
  );
  assert.equal(failed.evaluable, true);
  assert.equal(failed.passed, false);
  assert.equal(failed.actual, 1);
  // Audit did not run (a11y undefined) -> inconclusive, never a failure.
  assert.equal(evaluateExpectation(check, observation()).evaluable, false);
});

test('a contract may declare an a11y_clean assertion with empty target/value/text/baseline', () => {
  const checks = [
    requiredAction('reload'),
    requiredAssertion('a11y', { expectation: 'a11y_clean', target: '', value: '', text: '', baseline: '' }),
  ];
  assert.doesNotThrow(() => validateContract(checks));
});

// Phase 5b: API-level probing — response_status and json_has over a probe response.
test('response_status evaluates the captured probe status', () => {
  const check = action('assert', { expectation: 'response_status', text: '200' });
  assert.equal(evaluateExpectation(check, observation({ response: { status: 200 } })).passed, true);
  assert.equal(evaluateExpectation(check, observation({ response: { status: 404 } })).passed, false);
  // No probe response captured -> inconclusive, never a failure.
  assert.equal(evaluateExpectation(check, observation()).evaluable, false);
});

test('json_has checks a dotted key path and optional expected value', () => {
  const body = { response: { status: 200, json: { data: { id: 'abc', nested: { n: 1 } } } } };
  // Presence only (empty text).
  assert.equal(
    evaluateExpectation(action('assert', { expectation: 'json_has', target: 'data.id' }), observation(body)).passed,
    true,
  );
  // Expected value match.
  assert.equal(
    evaluateExpectation(
      action('assert', { expectation: 'json_has', target: 'data.id', text: 'abc' }),
      observation(body),
    ).passed,
    true,
  );
  assert.equal(
    evaluateExpectation(
      action('assert', { expectation: 'json_has', target: 'data.id', text: 'wrong' }),
      observation(body),
    ).passed,
    false,
  );
  // Missing key -> fails (absent), still evaluable.
  const missing = evaluateExpectation(
    action('assert', { expectation: 'json_has', target: 'data.missing' }),
    observation(body),
  );
  assert.equal(missing.evaluable, true);
  assert.equal(missing.passed, false);
  // Non-JSON body -> inconclusive.
  assert.equal(
    evaluateExpectation(
      action('assert', { expectation: 'json_has', target: 'data' }),
      observation({ response: { status: 200 } }),
    ).evaluable,
    false,
  );
});

test('a contract may declare a probe action followed by response_status / json_has', () => {
  const checks = [
    { id: 'hit', kind: 'action', action: 'probe', actor: 'a', target: '/api/health', value: '' },
    requiredAssertion('status', { expectation: 'response_status', target: '', value: '', text: '200', baseline: '' }),
    requiredAssertion('shape', { expectation: 'json_has', target: 'status', value: '', text: 'ok', baseline: '' }),
  ];
  assert.doesNotThrow(() => validateContract(checks));
});

test('probe requires a target path; response_status requires a status code; json_has requires a key', () => {
  assert.throws(
    () =>
      validateContract([
        { id: 'p', kind: 'action', action: 'probe', actor: 'a', target: '', value: '' },
        requiredAssertion('s', { expectation: 'response_status', target: '', value: '', text: '200', baseline: '' }),
      ]),
    /observed label, path or actor/,
  );
  assert.throws(
    () =>
      validateContract([
        requiredAction('reload'),
        requiredAssertion('s', { expectation: 'response_status', target: '', value: '', text: 'nope', baseline: '' }),
      ]),
    /response_status needs an expected HTTP status/,
  );
  assert.throws(
    () =>
      validateContract([
        requiredAction('reload'),
        requiredAssertion('j', { expectation: 'json_has', target: '', value: '', text: '', baseline: '' }),
      ]),
    /json_has needs a target JSON key/,
  );
});
