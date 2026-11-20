import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { RunError } from './core.js';
import { cleanEnvironment } from './process.js';

export function allowedRequest(raw, method, origins, readOnly = false) {
  try {
    const url = new URL(raw);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      origins.includes(url.origin) &&
      (!readOnly || ['GET', 'HEAD'].includes(method))
    );
  } catch {
    return false;
  }
}

/**
 * @param {string[]} origins
 * @param {{readOnly?: boolean, signal?: AbortSignal}} [options]
 */
export async function openBrowser(origins, { readOnly = false, signal } = {}) {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      env: cleanEnvironment(),
      args: ['--host-resolver-rules=MAP *.localhost 127.0.0.1', '--disable-background-networking'],
    });
  } catch (error) {
    throw new RunError(`Chromium unavailable: ${error.message}`);
  }
  try {
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    context.setDefaultTimeout(15_000);
    const blocked = [];
    await context.route('**/*', route => {
      const request = route.request();
      if (allowedRequest(request.url(), request.method(), origins, readOnly)) return route.continue();
      blocked.push({ url: new URL(request.url()).origin, method: request.method() });
      return route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    const newPage = async () => {
      const page = await context.newPage();
      // Playwright routing sees only the first request of a redirect chain. CDP
      // Fetch pauses every hop, before it leaves Chromium, including subresources.
      const cdp = await context.newCDPSession(page);
      cdp.on('Fetch.requestPaused', async event => {
        try {
          if (allowedRequest(event.request.url, event.request.method, origins, readOnly)) {
            await cdp.send('Fetch.continueRequest', { requestId: event.requestId });
          } else {
            blocked.push({ url: new URL(event.request.url).origin, method: event.request.method });
            await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
          }
        } catch {
          /* A closed page cancels its paused requests. */
        }
      });
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      page.on('popup', popup => {
        void popup.close().catch(() => {});
      });
      return page;
    };
    const abort = () => {
      void browser.close().catch(() => {});
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      await browser.close();
      throw new RunError('Run canceled.', 'canceled');
    }
    const close = async () => {
      signal?.removeEventListener('abort', abort);
      await browser.close();
    };
    return { browser, context, blocked, close, newPage };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

async function expectStatus(page, url, status) {
  const response = await page.goto(url);
  assert.equal(response?.status(), status, `Expected ${status} for ${new URL(url).pathname}`);
}

// Browser and transport failures are inconclusive; anything else the journey
// observed is a product failure.
function journeyError(error, adapter, signal, label) {
  if (adapter.signal.aborted) return new RunError('Run canceled.', 'canceled');
  if (signal.aborted) return new RunError(`${label} exceeded its time budget.`);
  if (error instanceof RunError) return error;
  if (/net::ERR_|browser has been closed|Target closed/i.test(error.message)) return new RunError(error.message);
  return new RunError(error.message, 'failed');
}

/**
 * Retain trace/screenshot evidence in a `finally`. When the journey already
 * failed, a capture error is recorded as evidence instead of replacing that failure.
 * @param {any} adapter
 * @param {any} result
 * @param {string} label
 * @param {boolean} failed
 * @param {() => Promise<unknown>} capture
 */
export async function retainEvidence(adapter, result, label, failed, capture) {
  try {
    await capture();
  } catch (error) {
    if (!failed) throw error;
    result.evidence.push(await adapter.run.evidence(`${label}-capture-error.txt`, String(error.message)));
  }
}

export async function staffJourney(adapter, result) {
  const signal = AbortSignal.any([adapter.signal, AbortSignal.timeout(180_000)]);
  const session = await openBrowser([adapter.publicOrigin, adapter.staffOrigin], { signal });
  let failed = false;
  try {
    const page = await session.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await session.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const device = await session.context.newCDPSession(page);
    await device.send('WebAuthn.enable');
    await device.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    const invitation = await adapter.invitation();
    await page.goto(invitation);
    await page.getByRole('button', { name: 'Create a passkey', exact: true }).click();
    await page.getByText('Signed in as ATM Administrator · ADMIN', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('link', { name: 'Staff sign-in', exact: true }).click();
    await page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click();
    await page.getByText('Signed in as ATM Administrator · ADMIN', { exact: true }).waitFor();
    await page.screenshot({ path: path.join(adapter.run.dir, 'evidence/staff-signed-in.png'), fullPage: true });
    result.evidence.push(await adapter.run.reference('evidence/staff-signed-in.png'));
    const persisted = await adapter.verifyStaff();
    result.evidence.push(await adapter.run.evidence('staff-verification.json', JSON.stringify(persisted, null, 2)));

    // Cross-host routing checks use the deployed frontend, not mocked responses.
    await expectStatus(page, `${adapter.publicOrigin}/staff`, 404);
    await expectStatus(page, `${adapter.publicOrigin}/api/donor/staff/me`, 404);
    await expectStatus(page, `${adapter.staffOrigin}/donate`, 404);
    await expectStatus(page, `${adapter.staffOrigin}/api/donor/me/dashboard`, 404);
    await page.goto(invitation);
    await page.getByRole('alert').filter({ hasText: 'already been used or has expired' }).waitFor();

    // A fresh browser session must not inherit authenticated API access.
    await session.context.clearCookies();
    await expectStatus(page, `${adapter.staffOrigin}/api/donor/staff/me`, 401);
    assert.deepEqual(errors, [], 'Unexpected browser JavaScript errors');
    assert.deepEqual(session.blocked, [], 'Unexpected outbound request attempts');
    return {
      summary:
        'Passkey activation, logout/login, persisted credentials and session revocation, invitation replay rejection, and public/staff host boundaries verified.',
    };
  } catch (error) {
    failed = true;
    throw journeyError(error, adapter, signal, 'Staff journey');
  } finally {
    try {
      await retainEvidence(adapter, result, 'staff-trace', failed, async () => {
        await session.context.tracing.stop({ path: path.join(adapter.run.dir, 'evidence/staff-trace.zip') });
        result.evidence.push(await adapter.run.reference('evidence/staff-trace.zip'));
      });
    } finally {
      await session.close();
    }
  }
}

export async function donorClaimJourney(adapter, result) {
  const signal = AbortSignal.any([adapter.signal, AbortSignal.timeout(180_000)]);
  const session = await openBrowser([adapter.publicOrigin], { signal });
  const verification = {};
  let failed = false;
  try {
    const page = await session.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await session.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const fixture = await adapter.donorFixture();
    await expectStatus(page, `${adapter.publicOrigin}/api/donor/me/dashboard`, 401);
    await page.goto(fixture.links[0]);
    await page.getByRole('button', { name: 'Confirm and sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'You’re signed in', exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, '', 'Claim token must be removed from the URL');
    await page.getByRole('link', { name: 'View my dashboard', exact: true }).click();
    await page.getByRole('heading', { name: 'Link Referrals', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'Link Referrals', exact: true }).waitFor();
    await page.goto(`${adapter.publicOrigin}/account/profile`);
    await page.getByText('claim@atm.invalid', { exact: true }).waitFor();
    verification.afterClaim = await adapter.verifyDonor();
    await page.screenshot({ path: path.join(adapter.run.dir, 'evidence/donor-profile.png'), fullPage: true });
    result.evidence.push(await adapter.run.reference('evidence/donor-profile.png'));
    await page.goto(`${adapter.publicOrigin}/account/giving`);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('link', { name: 'Sign in to view your giving', exact: true }).waitFor();
    await expectStatus(page, `${adapter.publicOrigin}/api/donor/me/dashboard`, 401);
    verification.afterLogout = await adapter.verifyDonor({ signedOut: true });
    await session.context.clearCookies();
    for (const link of fixture.links) {
      await page.goto(link);
      await page.getByRole('button', { name: 'Confirm and sign in', exact: true }).click();
      await page
        .getByRole('alert')
        .filter({ hasText: 'This link is invalid or expired. Request a new link.' })
        .waitFor();
      await expectStatus(page, `${adapter.publicOrigin}/api/donor/me/dashboard`, 401);
    }
    verification.afterReplay = await adapter.verifyDonor({ signedOut: true });
    assert.deepEqual(errors, [], 'Unexpected browser JavaScript errors');
    assert.deepEqual(session.blocked, [], 'Unexpected outbound request attempts');
    verification.assertions = {
      authenticatedReload: true,
      correctDonorProfile: true,
      tokenRemoved: true,
      logoutDeniedAccess: true,
      replayRejected: true,
      siblingRejected: true,
      anonymousDenied: true,
    };
    return {
      summary:
        'Donor claim, authenticated reload, persisted link consumption, logout revocation, replay and sibling-link rejection verified; unrelated donor unchanged.',
    };
  } catch (error) {
    failed = true;
    throw journeyError(error, adapter, signal, 'Donor claim journey');
  } finally {
    try {
      await retainEvidence(adapter, result, 'donor-trace', failed, async () => {
        result.evidence.push(
          await adapter.run.evidence('donor-verification.json', JSON.stringify(verification, null, 2)),
        );
        await session.context.tracing.stop({ path: path.join(adapter.run.dir, 'evidence/donor-trace.zip') });
        result.evidence.push(await adapter.run.reference('evidence/donor-trace.zip'));
      });
    } finally {
      await session.close();
    }
  }
}
