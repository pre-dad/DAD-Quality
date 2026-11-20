import test from 'node:test';
import assert from 'node:assert/strict';
import { benchmarkApplication } from '../src/discovery-benchmark.js';
import { openDiscoveryBrowser } from '../src/discovery-browser.js';
import { discover } from '../src/discovery.js';

const action = (kind, fields = {}) => ({
  action: kind,
  target: '',
  value: '',
  title: '',
  reason: 'Compare the declared profile expectations with independent evidence.',
  expectation: '',
  text: '',
  ...fields,
});
const actor = 'donor-a';
const requiredAction = (id, kind, target = '', value = '') => ({
  id,
  kind: 'action',
  action: kind,
  actor,
  target,
  value,
});
const assertion = (id, expectation, target, value, text, baseline = '') => ({
  id,
  kind: 'assertion',
  actor,
  expectation,
  target,
  value,
  text,
  baseline,
});
const plan = checks => ({
  capability: 'Profile',
  behavior: 'Persistence and isolation',
  state: 'Synthetic signed-in donor',
  preconditions: 'Donor A can manage its profile',
  expected: 'The requested save persists once and leaves the other donor unchanged',
  basis: 'observed',
  references: [],
  checks,
});

async function investigate(t, fault, checks) {
  const app = await benchmarkApplication(fault);
  let browser;
  t.after(async () => {
    await browser?.close();
    await app.close();
  });
  browser = await openDiscoveryBrowser({ ...app, signal: new AbortController().signal });
  const report = { requests: 0, tokens: 0, pages: [], observations: [], investigations: [], events: [], findings: [] };
  let planned = false,
    reported = false;
  const provider = async ({ observation, activeExperiment }) => {
    let choice;
    if (!planned && observation.actor !== actor) choice = action('switch_actor', { target: actor });
    else if (!planned) {
      planned = true;
      choice = action('investigate', { title: 'Profile contract', value: JSON.stringify(plan(checks)) });
    } else if (!activeExperiment) choice = action('finish');
    else {
      const failed = activeExperiment.completedChecks.find(c => c.verification?.passed === false);
      if (failed && !reported) {
        reported = true;
        choice = action('report_check', { target: failed.checkId, title: 'Profile violates its declared requirement' });
      } else if (failed) choice = action('conclude', { value: 'refuted' });
      else if (!activeExperiment.pendingCheck) choice = action('conclude', { value: 'supported' });
      else {
        const check = activeExperiment.pendingCheck;
        if (check.kind === 'checkpoint') choice = action('checkpoint', { target: check.id });
        else if (check.kind === 'assertion') choice = action('verify', { target: check.id });
        else
          choice = action(check.action, {
            target: check.target ? observation.controls.find(c => c.label === check.target).id : '',
            value: check.value,
          });
      }
    }
    return { action: choice, tokens: 1 };
  };
  await discover({ provider, browser, report, signal: new AbortController().signal });
  assert.equal(report.status, 'completed', report.summary);
  return { app, browser, report };
}

for (const fault of ['healthy', 'lost-save', 'cross-actor', 'duplicate-write', 'accept-invalid']) {
  test(`declared checks identify ${fault} using pristine replay and independently scored relationships`, async t => {
    const invalid = fault === 'accept-invalid';
    const checks = [
      { id: 'before', kind: 'checkpoint' },
      requiredAction('fill', 'fill', 'Public name', invalid ? '   ' : 'Changed'),
      requiredAction('save', 'click', 'Save profile'),
      requiredAction('reload', 'reload'),
      invalid
        ? assertion('validity', 'state_unchanged', actor, 'public_name', '', 'before')
        : assertion('persist', 'state_equals', actor, 'public_name', 'Changed'),
      assertion('isolation', 'state_unchanged', 'donor-b', 'public_name', '', 'before'),
      assertion('count', 'state_delta', actor, 'save_count', invalid ? '0' : '1', 'before'),
    ];
    const { app, browser, report } = await investigate(t, fault, checks);
    const experiment = report.investigations[0];
    if (fault === 'healthy') {
      assert.equal(report.findings.length, 0);
      assert.equal(experiment.conclusion.status, 'supported');
      assert.equal(experiment.progress.length, checks.length);
    } else {
      assert.equal(experiment.conclusion.status, 'refuted');
      assert.equal(report.findings.length, 1);
      const finding = report.findings[0];
      assert.equal(finding.status, 'reproduced');
      assert.equal(app.judge(finding), true);
      assert.ok(finding.reproduction.baselines['i1:before']);
      const expectation = {
        'lost-save': 'state_equals',
        'cross-actor': 'state_unchanged',
        'duplicate-write': 'state_delta',
        'accept-invalid': 'state_unchanged',
      }[fault];
      assert.equal(finding.expectation, expectation);
      if (expectation === 'state_equals') assert.equal(finding.initial.baselineId, undefined);
      else {
        assert.ok(finding.initial.baselineId, 'Relationship findings record the baseline they compared against');
        assert.notEqual(
          finding.initial.baselineId,
          finding.reproduction.verification.baselineId,
          'Replay must capture its own baseline observation',
        );
      }
      if (expectation === 'state_delta') assert.equal(app.judge({ ...finding, text: '500' }), false);
    }
    const after = await browser.observe();
    assert.equal(
      after.state[actor].save_count,
      fault === 'lost-save' ? 0 : fault === 'duplicate-write' ? 2 : 1,
      'Replay restores the working fixture rather than doubling writes',
    );
  });
}

test('reload equality replays the saved field checkpoint instead of comparing against original-run values', async t => {
  const checks = [
    requiredAction('fill', 'fill', 'Public name', 'Changed'),
    requiredAction('save', 'click', 'Save profile'),
    { id: 'saved', kind: 'checkpoint' },
    requiredAction('reload', 'reload'),
    assertion('survives', 'field_unchanged', 'Public name', '', '', 'saved'),
  ];
  const { report } = await investigate(t, 'lost-save', checks);
  const finding = report.findings[0];
  assert.equal(finding.expectation, 'field_unchanged');
  assert.equal(finding.status, 'reproduced');
  assert.equal(finding.initial.before, 'Changed');
  assert.equal(finding.reproduction.verification.before, 'Changed');
  assert.equal(finding.reproduction.verification.actual, 'Alex');
  assert.notEqual(finding.initial.baselineId, finding.reproduction.verification.baselineId);
});

test('a healthy app rejects an invalid name without creating a false positive', async t => {
  const checks = [
    { id: 'before', kind: 'checkpoint' },
    requiredAction('fill', 'fill', 'Public name', '   '),
    requiredAction('save', 'click', 'Save profile'),
    requiredAction('reload', 'reload'),
    assertion('unchanged', 'state_unchanged', actor, 'public_name', '', 'before'),
    assertion('no-write', 'state_delta', actor, 'save_count', '0', 'before'),
  ];
  const { report, browser } = await investigate(t, 'healthy', checks);
  assert.equal(report.findings.length, 0);
  assert.equal(report.investigations[0].conclusion.status, 'supported');
  assert.equal((await browser.observe()).state[actor].save_count, 0);
});
