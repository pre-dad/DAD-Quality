import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { auditAccessibility } from '../src/accessibility.js';

async function audit(t, html, options) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await (await browser.newContext()).newPage();
  await page.goto(`data:text/html,${encodeURIComponent(html)}`);
  return auditAccessibility(page, options);
}

test('auditAccessibility reports a compact violation for an image without alt text', async t => {
  const violations = await audit(
    t,
    '<!doctype html><html lang="en"><head><title>t</title></head><body><main><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></main></body></html>',
  );
  const missingAlt = violations.find(v => v.rule === 'image-alt');
  assert.ok(missingAlt, JSON.stringify(violations));
  assert.equal(missingAlt.impact, 'critical');
  assert.match(missingAlt.help, /^https:\/\/dequeuniversity\.com\//);
  assert.ok(missingAlt.targets.some(target => target.includes('img')));
  assert.deepEqual(Object.keys(missingAlt).sort(), ['help', 'impact', 'rule', 'targets']);
});

test('auditAccessibility returns an empty list for a clean page', async t => {
  const violations = await audit(
    t,
    '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Clean</h1><p>Text</p></main></body></html>',
  );
  assert.deepEqual(violations, []);
});
