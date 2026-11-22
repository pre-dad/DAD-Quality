import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { benchmarkApplication } from '../src/discovery-benchmark.js';
import { executeDiscovery } from '../src/discovery-runner.js';
import { readDiscovery } from '../src/discovery-report.js';
import { createDashboardServer } from '../src/dashboard.js';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';

const action = (name, fields = {}) => ({
  action: name,
  target: '',
  value: '',
  title: '',
  reason: 'Use prior feature evidence to select an uncovered or affected behavior.',
  expectation: '',
  text: '',
  ...fields,
});
const a = (id, action, target = '', value = '') => ({ id, kind: 'action', action, actor: 'donor-a', target, value });
const check = (id, expectation, target, value, text, baseline = '') => ({
  id,
  kind: 'assertion',
  actor: 'donor-a',
  expectation,
  target,
  value,
  text,
  baseline,
});
const contracts = {
  Persistence: [
    a('edit', 'fill', 'Public name', 'Changed'),
    a('save', 'click', 'Save profile'),
    a('reload', 'reload'),
    check('persist', 'state_equals', 'donor-a', 'public_name', 'Changed'),
  ],
  Isolation: [
    { id: 'before', kind: 'checkpoint' },
    a('edit', 'fill', 'Public name', 'Changed'),
    a('save', 'click', 'Save profile'),
    check('isolation', 'state_unchanged', 'donor-b', 'public_name', '', 'before'),
  ],
};

test('three real-browser runs remember persistence, investigate isolation, then revisit a changed profile handler', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-memory-browser-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'candidate');
  await mkdir(sourceRoot);
  await mkdir(path.join(sourceRoot, 'docs'));
  await mkdir(path.join(sourceRoot, 'handlers'));
  await writeFile(
    path.join(sourceRoot, 'docs/profile.md'),
    'Saving a name persists after reload and must leave other donors unchanged.\n',
  );
  await writeFile(path.join(sourceRoot, 'handlers/profile.js'), 'export const profileVersion = 1;\n');
  const completed = [];
  for (let round = 0; round < 3; round++) {
    if (round === 2)
      await writeFile(path.join(sourceRoot, 'handlers/profile.js'), 'export const profileVersion = 2;\n');
    const app = await benchmarkApplication();
    let step = 0,
      planned = false,
      selectedBehavior,
      retrieved;
    const provider = async ({ observation, applicationMemory, memoryEvidence, activeExperiment }) => {
      let choice;
      if (step === 0) {
        assert.equal(
          observation.state['donor-a'].public_name,
          'Alex',
          'Each run starts with a fresh fixture, not prior mutation state',
        );
        if (round === 0) assert.equal(applicationMemory.investigations, 0);
        else {
          assert.ok(applicationMemory.featureMap.some(f => f.name === 'Profile'));
          assert.equal(applicationMemory.needsRevalidation > 0, round === 2);
        }
        choice = action('switch_actor', { target: 'donor-a' });
      } else if (step === 1 && round > 0) choice = action('search_memory', { target: 'Profile Persistence' });
      else if (step === 2 && round > 0) {
        const results = memoryEvidence.at(-1).result.results;
        assert.ok(results.length);
        assert.equal(results[0].freshness, round === 2 ? 'needs-revalidation' : 'unchanged-references');
        retrieved = results[0].id;
        choice = action('read_memory', { target: retrieved });
      } else if (step === (round > 0 ? 3 : 1)) choice = action('read_source', { target: 'docs/profile.md' });
      else if (step === (round > 0 ? 4 : 2)) choice = action('read_source', { target: 'handlers/profile.js' });
      else if (!planned) {
        // Controlled provider verifies retrieval/selection plumbing, not live-model intelligence.
        selectedBehavior = round === 1 ? 'Isolation' : 'Persistence';
        if (round > 0) assert.equal(memoryEvidence.at(-1).result.record.behavior, 'Persistence');
        planned = true;
        choice = action('investigate', {
          title: `Profile ${selectedBehavior}`,
          value: JSON.stringify({
            capability: 'Profile',
            behavior: selectedBehavior,
            state: 'Valid name',
            preconditions: 'Fresh donor A and independent donor B',
            expected:
              selectedBehavior === 'Persistence'
                ? 'Changed name survives reload'
                : 'Changing donor A leaves donor B unchanged',
            basis: 'documented',
            references: ['docs/profile.md', 'handlers/profile.js'],
            checks: contracts[selectedBehavior],
          }),
        });
      } else if (!activeExperiment) choice = action('finish');
      else if (!activeExperiment.pendingCheck) choice = action('conclude', { value: 'supported' });
      else {
        const next = activeExperiment.pendingCheck;
        if (next.kind === 'checkpoint') choice = action('checkpoint', { target: next.id });
        else if (next.kind === 'assertion') choice = action('verify', { target: next.id });
        else
          choice = action(next.action, {
            target: next.target ? observation.controls.find(c => c.label === next.target).id : '',
            value: next.value,
          });
      }
      step++;
      return { action: choice, tokens: 1 };
    };
    let cleaned = false;
    const revision = (round === 2 ? 'c' : 'b').repeat(40);
    const run = await executeDiscovery({
      repo: sourceRoot,
      revision,
      output: root,
      provider,
      adapterFactory: run => ({
        source: sourceRoot,
        publicOrigin: app.origin,
        snapshot: async () => {
          run.data.candidate = { source: '/synthetic-memory-app', revision };
        },
        docker: async () => {},
        build: async () => {},
        database: async () => {},
        deploy: async () => {},
        discoveryFixture: async () => app.actors,
        discoveryReplayFixture: async () => app.fixture,
        cleanup: async () => {
          cleaned = true;
          await app.close();
        },
      }),
    });
    const report = await readDiscovery(root, run.data);
    assert.equal(cleaned, true);
    assert.equal(report.status, 'completed', report.summary);
    assert.equal(report.findings.length, 0);
    assert.equal(report.investigations[0].plan.behavior, round === 1 ? 'Isolation' : 'Persistence');
    if (round > 0) assert.ok(report.investigations[0].memoryReferences.includes(retrieved));
    const savedIndex = JSON.parse(await readFile(path.join(run.dir, 'evidence/application-memory.json'), 'utf8'));
    assert.equal(savedIndex.schemaVersion, 1);
    assert.equal(savedIndex.source, '/synthetic-memory-app');
    if (round === 1) {
      assert.equal(savedIndex.records[0].behavior, 'Persistence');
      assert.ok(savedIndex.features[0].unexploredActors.includes('donor-b'));
    }
    if (round === 2) assert.ok(savedIndex.records.every(r => r.freshness === 'needs-revalidation'));
    completed.push(report);
  }
  assert.equal(completed[2].applicationMemory.needsRevalidation, 2);
  const dashboard = await createDashboardServer({ repo: sourceRoot, root, port: 0 });
  let browser;
  t.after(async () => {
    await browser?.close();
    await dashboard.close();
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  await page.goto(dashboard.origin);
  await page.getByRole('button', { name: 'View evidence', exact: true }).click();
  const section = page.locator('section[aria-label="Application memory"]');
  await section.getByRole('heading', { name: 'Application memory' }).waitFor();
  assert.match(
    await section.innerText(),
    /1 remembered features.*2 prior investigations.*2 latest behaviors need revalidation/,
  );
  await section.getByText('Suggested follow-up evidence', { exact: true }).click();
  assert.match(await section.innerText(), /handlers\/profile.js/);
  assert.match(await section.innerText(), /donor-b/);
  const download = await page.request.get(
    new URL(await section.getByRole('link').getAttribute('href'), dashboard.origin).href,
  );
  assert.equal(download.status(), 200);
  assert.equal((await download.json()).records.length, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
  assert.deepEqual(
    audit.violations.map(v => v.id),
    [],
  );
});
