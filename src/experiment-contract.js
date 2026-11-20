const actionKinds = ['click', 'fill', 'select', 'check', 'navigate', 'reload', 'switch_actor', 'probe'];
export const relationshipExpectations = ['state_unchanged', 'state_delta', 'field_unchanged', 'checkbox_unchanged'];
export const literalExpectations = [
  'text_present',
  'text_absent',
  'no_server_error',
  'no_page_error',
  'a11y_clean',
  'response_status',
  'json_has',
  'field_value',
  'field_checked',
  'path_equals',
  'state_equals',
];
const idPattern = /^[a-z][a-z0-9-]{0,39}$/;
const fieldsAre = (value, fields) =>
  value && !Array.isArray(value) && Object.keys(value).sort().join() === [...fields].sort().join();
const short = (value, limit = 300) => typeof value === 'string' && value.length <= limit;

export function validateContract(checks) {
  if (!Array.isArray(checks) || checks.length < 2 || checks.length > 12)
    throw new Error('Declare 2–12 ordered contract checks.');
  const ids = new Set(),
    checkpoints = new Set();
  let actions = 0,
    assertions = 0;
  for (const check of checks) {
    if (!check || typeof check.id !== 'string' || !idPattern.test(check.id) || ids.has(check.id))
      throw new Error('Contract checks require unique short IDs.');
    ids.add(check.id);
    if (check.kind === 'action') {
      if (!actionKinds.includes(check.action))
        throw new Error(
          `Contract actions must be one of: ${actionKinds.join(', ')}. Use source/memory tools directly before investigate, outside contract checks.`,
        );
      if (
        !fieldsAre(check, ['id', 'kind', 'action', 'actor', 'target', 'value']) ||
        !short(check.actor, 100) ||
        !check.actor ||
        !short(check.target, 240) ||
        !short(check.value, 500)
      )
        throw new Error('Invalid action contract.');
      if (
        ['click', 'fill', 'select', 'check', 'navigate', 'switch_actor', 'probe'].includes(check.action) &&
        !check.target
      )
        throw new Error('Action contract needs an observed label, path or actor.');
      if (check.action === 'reload' && check.target) throw new Error('Reload action takes no target.');
      if (check.action === 'check' && !['true', 'false'].includes(check.value))
        throw new Error('Checkbox action requires true or false.');
      actions++;
    } else if (check.kind === 'checkpoint') {
      if (!fieldsAre(check, ['id', 'kind'])) throw new Error('Invalid checkpoint contract.');
      checkpoints.add(check.id);
    } else if (check.kind === 'assertion') {
      if (
        !fieldsAre(check, ['id', 'kind', 'expectation', 'target', 'value', 'text', 'baseline', 'actor']) ||
        !short(check.actor, 100) ||
        !check.actor ||
        ![...literalExpectations, ...relationshipExpectations].includes(check.expectation) ||
        !short(check.target, 240) ||
        !short(check.value, 500) ||
        !short(check.text) ||
        !short(check.baseline, 40)
      )
        throw new Error('Invalid assertion contract.');
      if (
        relationshipExpectations.includes(check.expectation)
          ? !checkpoints.has(check.baseline)
          : Boolean(check.baseline)
      )
        throw new Error('Relationship checks must reference an earlier checkpoint; literal checks have no baseline.');
      if (check.expectation.startsWith('state_') && (!check.target || !check.value))
        throw new Error('State checks need a fixture actor and field.');
      if (
        ['field_value', 'field_checked', 'field_unchanged', 'checkbox_unchanged'].includes(check.expectation) &&
        !check.target
      )
        throw new Error('Field checks need an observed label.');
      if (['text_present', 'text_absent', 'path_equals'].includes(check.expectation) && !check.text.trim())
        throw new Error('Text/path checks need an expected value.');
      if (check.expectation === 'response_status' && !/^[1-5][0-9]{2}$/.test(check.text))
        throw new Error('response_status needs an expected HTTP status code (e.g. "200").');
      if (check.expectation === 'json_has' && !check.target.trim())
        throw new Error('json_has needs a target JSON key path (e.g. "data.id").');
      if (check.expectation === 'field_checked' && !['true', 'false'].includes(check.text))
        throw new Error('Checkbox expectation requires true or false.');
      if (check.expectation === 'state_delta' && !/^-?(?:0|[1-9][0-9]*)$/.test(check.text))
        throw new Error('Counter deltas must be integer strings.');
      if (check.expectation === 'state_delta' && !Number.isSafeInteger(Number(check.text)))
        throw new Error('Counter delta exceeds the safe integer range.');
      if (!actions) throw new Error('A declared assertion must follow a browser action.');
      assertions++;
    } else throw new Error('Unknown contract check kind.');
  }
  if (!actions || !assertions) throw new Error('A contract requires a browser action and an assertion.');
  return checks;
}

export const pendingCheck = investigation => investigation?.plan.checks[investigation.progress.length] ?? null;
export const baselineKey = (investigation, id) => `${investigation.id}:${id}`;
export function actionMatches(check, action, observation) {
  if (
    check?.kind !== 'action' ||
    check.action !== action.action ||
    check.actor !== observation.actor ||
    check.value !== action.value
  )
    return false;
  let target = '';
  if (['click', 'fill', 'select', 'check'].includes(action.action)) {
    const control = observation.controls?.find(c => c.id === action.target);
    if (!control || observation.controls.filter(c => c.label === control.label).length !== 1) return false;
    target = control.label;
  } else if (action.action === 'navigate') target = observation.pages?.find(p => p.id === action.target)?.path;
  else if (['switch_actor', 'probe'].includes(action.action)) target = action.target;
  return check.target === target;
}

export function contractAssertion(check, observation, investigation) {
  if (check.actor !== observation.actor) throw new Error(`Check ${check.id} requires actor ${check.actor}.`);
  let target = check.target;
  if (['field_value', 'field_checked', 'field_unchanged', 'checkbox_unchanged'].includes(check.expectation)) {
    const matches = observation.controls?.filter(c => c.label === target) ?? [];
    if (matches.length !== 1)
      throw new Error(`Check ${check.id} requires one uniquely observed field labeled ${target}.`);
    target = matches[0].id;
  }
  return {
    action: 'assert',
    title: check.id,
    reason: investigation.plan.expected,
    expectation: check.expectation,
    target,
    value: check.value,
    text: check.text,
    baseline: check.baseline ? baselineKey(investigation, check.baseline) : '',
  };
}

function field(observation, action, referenceControl) {
  const matches = referenceControl
    ? observation.controls?.filter(c => c.identity === referenceControl.identity)
    : observation.controls?.filter(c => c.id === action.target);
  if (matches?.length !== 1) return undefined;
  const control = matches[0],
    key = action.expectation === 'checkbox_unchanged' ? 'checked' : 'value';
  if (
    !Object.hasOwn(control, key) ||
    control[key] === undefined ||
    (key === 'checked' && typeof control[key] !== 'boolean')
  )
    return undefined;
  return { control, value: control[key] };
}
const scalar = value =>
  value === null ||
  ['string', 'boolean'].includes(typeof value) ||
  (typeof value === 'number' && Number.isFinite(value));
export function evaluateRelationship(action, observation, baselines = {}) {
  const baseline = baselines[action.baseline];
  const inconclusive = reason => ({
    evaluable: false,
    reason,
    observationId: observation.id,
    baselineId: baseline?.id,
  });
  if (!baseline) return inconclusive('The declared checkpoint is unavailable.');
  let before, actual;
  if (action.expectation.startsWith('state_')) {
    const old = baseline.state?.[action.target],
      current = observation.state?.[action.target];
    if (!old || !current || !Object.hasOwn(old, action.value) || !Object.hasOwn(current, action.value))
      return inconclusive('The persisted state field is missing at one side of the comparison.');
    before = old[action.value];
    actual = current[action.value];
    if (!scalar(before) || !scalar(actual))
      return inconclusive('Relationship assertions require captured scalar state.');
  } else {
    if (baseline.actor !== observation.actor) return inconclusive('Field comparisons require the same browser actor.');
    const current = field(observation, action);
    if (!current?.control.identity) return inconclusive('The current field identity is unavailable.');
    const old = field(baseline, action, current.control);
    if (!old) return inconclusive('The checkpoint field is missing or ambiguous.');
    before = old.value;
    actual = current.value;
  }
  if (action.expectation === 'state_delta') {
    const delta = Number(action.text);
    if (![before, actual, delta, actual - before].every(Number.isSafeInteger))
      return inconclusive('Counter changes require safe integer values.');
    return {
      evaluable: true,
      passed: actual - before === delta,
      before,
      actual,
      expectedDelta: delta,
      actualDelta: actual - before,
      observationId: observation.id,
      baselineId: baseline.id,
    };
  }
  return {
    evaluable: true,
    passed: Object.is(before, actual),
    before,
    actual,
    observationId: observation.id,
    baselineId: baseline.id,
  };
}
