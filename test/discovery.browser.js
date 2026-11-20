import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { openDiscoveryBrowser } from '../src/discovery-browser.js';
import { discover } from '../src/discovery.js';
import { Run } from '../src/core.js';
import { discoveryPolicy } from '../src/discovery-runner.js';
import { createDashboardServer } from '../src/dashboard.js';

const action = (kind, fields = {}) => ({
  action: kind,
  target: '',
  value:
    kind === 'investigate'
      ? JSON.stringify({
          capability: 'Observed feature',
          behavior: 'Investigate behavior',
          state: 'Initial state',
          preconditions: 'Supplied fixture',
          expected: 'UI matches its promise',
          basis: 'observed',
          references: [],
          checks: [
            { id: 'catalog', kind: 'action', action: 'click', actor: 'guest', target: 'Browse catalog', value: '' },
            {
              id: 'healthy',
              kind: 'assertion',
              expectation: 'no_server_error',
              actor: 'guest',
              target: '',
              value: '',
              text: '',
              baseline: '',
            },
          ],
        })
      : '',
  title: '',
  reason: 'Investigate what the observed interface promises.',
  expectation: '',
  text: '',
  ...fields,
});
const signal = new AbortController().signal;
async function fixture(t) {
  let mutations = 0;
  const server = createServer((request, response) => {
    if (request.url === '/write') {
      mutations++;
      response.end('saved');
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    const who = request.headers.cookie?.includes('test-a')
      ? 'Donor A'
      : request.headers.cookie?.includes('test-b')
        ? 'Donor B'
        : 'Guest';
    if (request.url === '/changing') {
      response.end(
        '<html lang="en"><title>Changing controls</title><body><div id="fields"><label>Search<input name="search"></label><label>Email<input name="email"></label></div><button onclick="fields.prepend(fields.lastElementChild)">Swap fields</button></body></html>',
      );
      return;
    }
    if (request.url === '/storage') {
      response.end(`<html lang="en"><title>Storage</title><body><h1>${who}</h1><p id="status">Loading storage</p><script>
        (async () => {
          const request = indexedDB.open('actor-storage', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('state');
          const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = reject; });
          const tx = db.transaction('state', 'readwrite');
          const prior = tx.objectStore('state').get('owner');
          const owner = await new Promise(resolve => { prior.onsuccess = () => resolve(prior.result ?? 'empty'); });
          tx.objectStore('state').put('${who}', 'owner');
          const cache = await caches.open('actor-cache');
          const cached = await cache.match('/stored-owner');
          const cachedOwner = cached ? await cached.text() : 'empty';
          await cache.put('/stored-owner', new Response('${who}'));
          document.querySelector('#status').textContent = 'IndexedDB: ' + owner + '; Cache: ' + cachedOwner;
        })();
      </script></body></html>`);
      return;
    }
    if (request.url === '/broken') {
      response.statusCode = 500;
      response.end('<html lang="en"><title>Failed</title><body><h1>Unexpected service failure</h1></body></html>');
      return;
    }
    response.end(
      `<html lang="en"><title>Application</title><body><h1>${who}</h1><a href="/broken">Browse catalog</a><a href="http://example.invalid/">External</a><label>Search<input name="search"></label><button onclick="fetch('/write',{method:'POST'})">Save</button></body></html>`,
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, mutations: () => mutations };
}
const actors = [
  { id: 'guest', description: 'Guest', entry: '/' },
  { id: 'donor-a', description: 'Synthetic donor A', entry: '/', cookie: 'test-a' },
  { id: 'donor-b', description: 'Synthetic donor B', entry: '/', cookie: 'test-b' },
];

test('discovery browser maps observed controls, isolates actors, reproduces a server defect and prevents arbitrary navigation', async t => {
  const app = await fixture(t);
  const browser = await openDiscoveryBrowser({ origin: app.origin, actors, signal });
  t.after(() => browser.close());
  let observation = await browser.observe();
  assert.match(observation.text, /Guest/);
  assert.equal(JSON.stringify(observation).includes('test-a'), false);
  assert.ok(observation.pages.some(p => p.path === '/broken'));
  const originalPages = structuredClone(observation.pages);
  await assert.rejects(browser.act(action('navigate', { target: 'http://example.invalid' })), /discovered page/);
  await assert.rejects(
    browser.act(action('click', { target: observation.controls.find(c => c.label === 'External').id })),
    /outside/,
  );
  await browser.act(action('switch_actor', { target: 'donor-a' }));
  const guestObservation = observation;
  observation = await browser.observe();
  assert.match(observation.text, /Donor A/);
  assert.deepEqual(guestObservation.pages, originalPages, 'Later visits must not rewrite earlier observations');
  await browser.act(action('switch_actor', { target: 'donor-b' }));
  observation = await browser.observe();
  assert.match(observation.text, /Donor B/);
  assert.doesNotMatch(observation.text, /Donor A/);
  await browser.act(action('click', { target: observation.controls.find(c => c.label === 'Browse catalog').id }));
  observation = await browser.observe();
  assert.equal(observation.serverErrors[0].status, 500);
  const replay = await browser.reproduce(action('report', { expectation: 'no_server_error', title: 'Catalog fails' }));
  assert.equal(replay.status, 'reproduced');
  assert.equal(replay.observation.serverErrors[0].status, 500);
  assert.equal(replay.steps.length, 1);
  const differentObservation = { ...observation, serverErrors: [{ path: '/different', status: 500 }] };
  const mismatch = await browser.reproduce(
    action('report', { expectation: 'no_server_error', title: 'Original error' }),
    differentObservation,
  );
  assert.equal(mismatch.status, 'inconclusive');
  assert.match(mismatch.reason, /same server failure did not recur/);
});

test('switching actors isolates IndexedDB and Cache Storage and preserves every trace segment', async t => {
  const app = await fixture(t);
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-discovery-actors-'));
  const run = await Run.create(root, { mode: 'exploration' }, ['discovery'], discoveryPolicy());
  const result = { evidence: [] };
  let browser;
  t.after(async () => {
    await browser?.close();
    await rm(root, { recursive: true, force: true });
  });
  browser = await openDiscoveryBrowser({
    origin: app.origin,
    actors: actors.map(a => ({ ...a, entry: '/storage' })),
    signal,
    run,
    result,
  });
  for (const id of ['guest', 'donor-a', 'donor-b']) {
    if (id !== 'guest') await browser.act(action('switch_actor', { target: id }));
    const observation = await browser.observe();
    assert.match(observation.text, /IndexedDB: empty; Cache: empty/);
    assert.deepEqual(observation.pageErrors, []);
  }
  await browser.close();
  assert.deepEqual(
    result.evidence.filter(e => e.path.includes('trace')).map(e => e.path),
    ['evidence/discovery-trace.zip', 'evidence/discovery-trace-2.zip', 'evidence/discovery-trace-3.zip'],
  );
});

test('mutating experiments retain observations but are never automatically replayed', async t => {
  const app = await fixture(t);
  const browser = await openDiscoveryBrowser({ origin: app.origin, actors, signal });
  t.after(() => browser.close());
  let observation = await browser.observe();
  await browser.act(
    action('fill', { target: observation.controls.find(c => c.label === 'Search').id, value: 'synthetic input' }),
  );
  observation = await browser.observe();
  assert.equal(observation.controls.find(c => c.label === 'Search').value, 'synthetic input');
  await browser.act(action('click', { target: observation.controls.find(c => c.label === 'Save').id }));
  const replay = await browser.reproduce(
    action('report', { expectation: 'text_present', text: 'Saved', title: 'No confirmation' }),
  );
  assert.equal(replay.status, 'inconclusive');
  assert.match(replay.reason, /mutation/);
  assert.equal(app.mutations(), 1);
});

test('a changed input at the same DOM position cannot receive an action intended for another field', async t => {
  const app = await fixture(t);
  const browser = await openDiscoveryBrowser({
    origin: app.origin,
    actors: [{ ...actors[0], entry: '/changing' }],
    signal,
  });
  t.after(() => browser.close());
  const before = await browser.observe();
  const search = before.controls.find(c => c.label === 'Search');
  await browser.act(action('click', { target: before.controls.find(c => c.label === 'Swap fields').id }));
  await assert.rejects(
    browser.act(action('fill', { target: search.id, value: 'wrong recipient' })),
    /Observed control changed/,
  );
  const after = await browser.observe();
  assert.equal(after.controls.find(c => c.label === 'Email').value, '');
});

test('discovery loop records a defect in real browser evidence and dashboard exposes hypotheses, memory and integrity', async t => {
  const app = await fixture(t);
  const root = await mkdtemp(path.join(os.tmpdir(), 'atm-discovery-ui-'));
  const run = await Run.create(root, { adapter: 'impactgraph', mode: 'exploration' }, ['discovery'], discoveryPolicy());
  run.data.candidate = { source: '/synthetic', revision: 'a'.repeat(40) };
  const report = {
    version: 1,
    runId: run.data.id,
    ...run.data.candidate,
    status: 'running',
    requests: 0,
    tokens: 0,
    pages: [],
    events: [],
    observations: [],
    investigations: [],
    findings: [],
    memory: [],
    warnings: [],
  };
  await run.step('discovery', async result => {
    const browser = await openDiscoveryBrowser({ origin: app.origin, actors, signal, run, result });
    try {
      // This controlled provider tests the harness, not live-model intelligence.
      let step = 0;
      const provider = async ({ observation }) => ({
        tokens: 10,
        action: [
          () =>
            action('investigate', {
              title: 'Explore catalog',
              reason: 'The observed catalog link promises a browsable destination.',
            }),
          () => action('click', { target: observation.controls.find(c => c.label === 'Browse catalog').id }),
          () => action('verify', { target: 'healthy' }),
          () => action('report_check', { title: 'Catalog returns server failure', target: 'healthy' }),
          () => action('conclude', { value: 'refuted' }),
          () => action('finish', { reason: 'Catalog failure reproduced; other areas remain unexplored.' }),
        ][step++](),
      });
      await discover({ provider, browser, report, signal });
    } finally {
      await browser.close();
    }
    result.evidence.push(await run.evidence('discovery.json', JSON.stringify(report, null, 2)));
  });
  await run.finish();
  assert.equal(report.findings[0].status, 'reproduced');
  const dashboard = await createDashboardServer({ repo: '/synthetic', root, port: 0 });
  let chromiumBrowser;
  t.after(async () => {
    await chromiumBrowser?.close();
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  });
  chromiumBrowser = await chromium.launch({ headless: true });
  const context = await chromiumBrowser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  await page.goto(dashboard.origin);
  await page.getByRole('heading', { name: 'Latest exploration completed.' }).waitFor();
  const metricsText = await page.locator('.metrics').innerText();
  assert.match(metricsText, /0 validations · 1 exploration/);
  assert.match(metricsText, /Passed validations\s*0\s*\/ 0/);
  await page.getByRole('button', { name: 'View evidence' }).click();
  await page.getByRole('heading', { name: /Autonomous discovery · completed/ }).waitFor();
  assert.match(await page.locator('#run-detail').innerText(), /Catalog returns server failure · reproduced/);
  assert.match(await page.locator('#run-detail').innerText(), /Not applicable — exploration/);
  await page.getByText('Declared checks (2/2 executed)', { exact: true }).click();
  assert.match(await page.locator('#run-detail').innerText(), /healthy · failed/);
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
  assert.deepEqual(
    audit.violations.map(v => v.id),
    [],
  );
  await mkdir(path.join(root, 'ui'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'ui', 'discovery-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(root, 'ui', 'discovery-mobile.png'), fullPage: true });
  await page.getByRole('button', { name: 'Close run details' }).click();
  await page.getByRole('button', { name: 'Explore application', exact: true }).click();
  await page.getByRole('heading', { name: 'Explore application', exact: true }).waitFor();
  assert.match(await page.locator('#launch-description').innerText(), /No test goal/);
  assert.equal(await page.locator('#ai').isVisible(), false);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await writeFile(path.join(run.dir, 'evidence/discovery.json'), '{}');
  await page.getByRole('button', { name: 'View evidence' }).click();
  await page.getByText('Discovery evidence changed.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('heading', { name: /Catalog returns server failure/ }).count(), 0);
});
