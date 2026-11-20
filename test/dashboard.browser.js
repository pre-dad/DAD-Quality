import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { Run, RunError } from '../src/core.js';
import { createDashboardServer } from '../src/dashboard.js';
import { loadPolicy, hashPolicy } from '../src/policy.js';
import { metrics, assessPerformance } from '../src/performance.js';

test('dashboard supports run inspection, triage, launch, cancellation and mobile layout', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-ui-'));
  const failed = await Run.create(root, { adapter: 'impactgraph' }, ['staff-journey']);
  failed.data.candidate = { revision: 'a'.repeat(40), source: '/synthetic/DAD-Main' };
  await failed.step('staff-journey', async result => {
    result.evidence.push(await failed.evidence('failure.log', 'Expected unauthorized request to be rejected.'));
    throw new RunError('Expected 401, received 200.', 'failed');
  });
  await failed.finish();
  const passed = await Run.create(root, { adapter: 'impactgraph' }, ['staff-journey']);
  passed.data.candidate = { revision: 'b'.repeat(40), source: '/synthetic/DAD-Main' };
  await passed.step('staff-journey', async result => {
    result.evidence.push(await passed.evidence('passed.log', 'Authorization checks passed.'));
    return { summary: 'Authorization checks passed.' };
  });
  await passed.finish();
  const app = await createDashboardServer({
    repo: '/synthetic/DAD-Main',
    root,
    port: 0,
    resolve: async () => 'c'.repeat(40),
    executor: async options => {
      const run = await Run.create(root, { adapter: 'impactgraph', trigger: options.trigger }, ['cleanup']);
      options.onCreated(run);
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      await run.step('cleanup', async () => ({ summary: 'Cleaned up.' }));
      run.data.canceledAt = new Date().toISOString();
      await run.finish();
    },
  });
  let browser;
  t.after(async () => {
    await browser?.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.origin);
  await page.getByRole('heading', { name: 'Latest candidate passed.' }).waitFor();
  const accessible = async () => {
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    assert.deepEqual(
      result.violations.map(v => ({
        id: v.id,
        nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })),
      })),
      [],
    );
  };
  await accessible();
  await page.getByRole('button', { name: 'View evidence' }).click();
  await page.getByRole('heading', { name: 'Evidence integrity' }).waitFor();
  await page.getByRole('heading', { name: 'Local acceptance', exact: true }).waitFor();
  assert.match(await page.locator('#run-detail').innerText(), /Legacy run: no versioned policy/);
  assert.match(await page.locator('#run-detail').innerText(), /Blocked/);
  await accessible();
  assert.match(await page.locator('#run-detail').innerText(), /failed.*→.*passed/s);
  await page.getByRole('button', { name: 'Close run details' }).click();
  await page.getByRole('link', { name: /Findings/ }).click();
  await page.getByRole('button', { name: 'Review' }).click();
  await accessible();
  await page.getByLabel('Triage status').selectOption('confirmed');
  await page.getByLabel('Severity').selectOption('high');
  await page.getByLabel('Assessment').fill('Reproduced in synthetic staging; regression check added.');
  await page.getByRole('button', { name: 'Save assessment' }).click();
  await page.locator('#finding-dialog').waitFor({ state: 'hidden' });
  assert.match(await page.locator('#content').innerText(), /Confirmed/);
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Set up commit watch' }).click();
  await page.getByLabel('Local branch or ref').fill('main');
  await page.getByRole('button', { name: 'Enable commit watch' }).click();
  await page.getByText('Watching main', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Turn off commit watch' }).click();
  await page.getByRole('button', { name: 'Run validation' }).click();
  await page.getByLabel('Commit, branch, or tag').fill('main');
  const detailResponse = page.waitForResponse(response => /\/api\/runs\/atm-/.test(response.url()));
  await page.getByRole('button', { name: 'Start validation' }).click();
  const cancelButton = await page.getByRole('button', { name: 'Cancel validation' }).elementHandle();
  await cancelButton.focus();
  await detailResponse;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(
    await cancelButton.evaluate(button => button.isConnected && document.activeElement === button),
    true,
    'Polling must preserve the focused run control',
  );
  await page.getByRole('button', { name: 'Close run details' }).click();
  // The active run's duration changes on every poll, so each poll re-renders the page.
  await page.locator(`#content button.row-arrow[data-run="${passed.data.id}"]`).focus();
  for (let poll = 0; poll < 2; poll++) await page.waitForResponse(response => response.url().endsWith('/api/state'));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(
    await page.evaluate(id => document.activeElement?.matches(`button.row-arrow[data-run="${id}"]`), passed.data.id),
    true,
    'Polling must preserve focus within the page content',
  );
  await page.locator('#content button.run-link').first().click();
  await page.getByRole('button', { name: 'Cancel validation' }).click();
  await page.getByRole('button', { name: 'Run this revision again' }).waitFor();
  assert.match(await page.locator('#run-detail').innerText(), /Canceled/);
  await page.getByRole('button', { name: 'Close run details' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('link', { name: /Findings/ }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await accessible();
  await page.getByRole('link', { name: 'About', exact: true }).click();
  await page.getByRole('heading', { name: 'About ATM' }).waitFor();
  assert.match(await page.locator('#content').innerText(), /never authorizes a production release/i);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await accessible();
  assert.deepEqual(errors, []);
});

test('dashboard shows useful empty and malformed-run states', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-ui-empty-'));
  const app = await createDashboardServer({ repo: '/synthetic/DAD-Main', root, port: 0 });
  let browser;
  t.after(async () => {
    await browser?.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(app.origin);
  await page.getByRole('heading', { name: 'Your next release starts here.' }).waitFor();
  await mkdir(path.join(root, 'atm-20261009000000-aaaaaaaa'));
  await page.reload();
  await page.getByText(/Could not read atm-/).waitFor();
  await page.getByRole('button', { name: 'Run validation' }).click();
  await page.getByLabel('Commit, branch, or tag').fill('--bad');
  await page.getByRole('button', { name: 'Start validation' }).click();
  await page.getByRole('alert').filter({ hasText: 'Enter a valid commit' }).waitFor();
});

test('policy evidence view distinguishes passing checks from blocked acceptance', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-ui-policy-'));
  const policy = await loadPolicy();
  const run = await Run.create(
    root,
    { adapter: 'impactgraph' },
    policy.definition.checks.filter(c => c.required).map(c => c.id),
    policy,
  );
  run.data.candidate = {
    revision: 'a'.repeat(40),
    source: '/synthetic/DAD-Main',
    sourceArchiveSha256: 'b'.repeat(64),
    images: { api: `sha256:${'c'.repeat(64)}`, web: `sha256:${'d'.repeat(64)}` },
  };
  for (const check of policy.definition.checks) {
    const evidence = [];
    for (const name of check.evidence) evidence.push(await run.evidence(name, `Synthetic ${name}`));
    run.data.results.push({
      id: check.id,
      status: 'passed',
      required: check.required,
      summary: 'Synthetic verification',
      finishedAt: run.data.startedAt,
      evidence,
    });
  }
  await run.finish();
  const app = await createDashboardServer({ repo: run.data.candidate.source, root, port: 0 });
  let browser;
  t.after(async () => {
    await browser?.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(app.origin);
  await page.getByText('Local acceptance: Eligible', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'View evidence' }).click();
  await page.getByText(`impactgraph-local · ${policy.definition.version}`, { exact: true }).waitFor();
  await page.getByText('donor-claim-journey · v1', { exact: true }).click();
  await page.getByText('Sign-out revokes session', { exact: true }).waitFor();
  assert.deepEqual(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations.map(
      v => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) }),
    ),
    [],
  );
  await writeFile(path.join(run.dir, 'evidence/donor-verification.json'), 'tampered');
  await page.getByText('Blocked', { exact: true }).waitFor();
  assert.match(await page.locator('#run-detail').innerText(), /changed evidence evidence\/donor-verification.json/);
  await page.getByRole('button', { name: 'Close run details' }).click();
  await page.getByText('Local acceptance: Blocked', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Latest candidate passed.' }).waitFor();
});

test('performance view compares candidates, remains accessible on mobile and rejects changed evidence', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-ui-performance-'));
  const policy = await loadPolicy(),
    profile = policy.definition.checks.find(c => c.id === 'performance').profile;
  const environment = { kind: 'local', platform: 'fixture', arch: 'fixture', cpus: 2 };
  let latest;
  for (let i = 0; i < 2; i++) {
    const run = await Run.create(root, { adapter: 'impactgraph' }, [], policy);
    run.data.startedAt = `2026-10-0${i + 1}T00:00:00.000Z`;
    run.data.candidate = { source: '/synthetic/DAD-Main', revision: (i ? 'b' : 'a').repeat(40) };
    const sample = { ms: i ? 100 : 20, status: 200, error: null };
    const report = {
      schemaVersion: 1,
      profile,
      workloadDigest: hashPolicy(profile),
      environment,
      environmentDigest: hashPolicy(environment),
      completed: true,
      phases: profile.phases.map(p => ({
        ...p,
        elapsedMs: p.durationMs,
        capped: false,
        ...metrics(Array(120).fill(sample), p.durationMs),
        endpoints: Object.fromEntries(
          ['spend', 'dashboard', 'gifts'].map(name => [name, metrics(Array(40).fill(sample), p.durationMs)]),
        ),
      })),
    };
    report.assessment = assessPerformance(report);
    run.data.results = [
      {
        id: 'performance',
        status: 'passed',
        required: false,
        finishedAt: run.data.startedAt,
        summary: 'Synthetic performance fixture',
        evidence: [await run.evidence('performance.json', JSON.stringify(report))],
      },
    ];
    await run.finish();
    latest = run;
  }
  const app = await createDashboardServer({ repo: '/synthetic/DAD-Main', root, port: 0 });
  let browser;
  t.after(async () => {
    await browser?.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const page = await context.newPage();
  await page.goto(app.origin);
  await page.getByRole('button', { name: 'View evidence' }).click();
  await page.getByRole('heading', { name: 'Performance · Advisory' }).waitFor();
  await page.getByText(/Regression signal detected against/).waitFor();
  assert.match(
    await page.getByRole('region', { name: 'Performance report' }).innerText(),
    /baseline\/overall: p95 \+80\.0 ms/,
  );
  assert.equal(await page.getByRole('columnheader', { name: 'p99 ms' }).count(), 1);
  await mkdir(path.join(root, 'ui'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'ui', 'performance-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze()).violations.map(
      v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }),
    ),
    [],
  );
  await page.screenshot({ path: path.join(root, 'ui', 'performance-mobile.png'), fullPage: true });
  await writeFile(path.join(latest.dir, 'evidence/performance.json'), '{}');
  await page.getByText('Performance evidence integrity failed.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Performance report' }).count(), 0);
});
