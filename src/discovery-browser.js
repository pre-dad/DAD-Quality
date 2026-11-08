import path from 'node:path';
import { openBrowser } from './browser.js';
import { discoveryLimits, evaluateExpectation } from './discovery.js';
import { redact } from './core.js';
import { auditAccessibility } from './accessibility.js';

const clean = value => redact(String(value)).slice(0, 12_000);
// Evaluated in the page for both observation and execution. Inputs often have
// no textContent, so labels, names and destinations are part of their identity.
const controlIdentity = el =>
  JSON.stringify([
    el.tagName,
    el.getAttribute('type'),
    el.getAttribute('role'),
    el.getAttribute('aria-label'),
    el.getAttribute('name'),
    el.getAttribute('id'),
    el.getAttribute('placeholder'),
    el.getAttribute('href'),
    [...(el.labels ?? [])].map(label => label.textContent?.trim()),
    el.textContent?.trim().slice(0, 120),
  ]);
export async function openDiscoveryBrowser({
  origin,
  actors,
  signal,
  run,
  result,
  fixture,
  audit = auditAccessibility,
}) {
  const permitted = new URL(origin);
  if (
    permitted.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(permitted.hostname) ||
    !permitted.port ||
    permitted.pathname !== '/' ||
    permitted.username ||
    permitted.password
  )
    throw new Error('Discovery requires a run-owned loopback origin.');
  let session,
    page,
    segment = 0,
    reproductionNumber = 0;
  const blocked = [];
  const known = new Map();
  const replayTrail = [];
  let replayUnavailable = false;
  let controls = new Map(),
    actor = actors[0],
    trail = [],
    dirty = false,
    sequence = 0,
    lastObservation,
    lastProbe;
  let serverErrors = [],
    pageErrors = [];
  const relative = raw => {
    const u = new URL(raw, origin);
    return clean(`${u.pathname}${u.search}${u.hash}`);
  };
  const capture = (target, errors) => {
    target.on('response', response => {
      if (response.status() >= 500 && errors.server.length < 20)
        errors.server.push({ path: relative(response.url()), status: response.status() });
    });
    target.on('pageerror', error => {
      if (errors.page.length < 20) errors.page.push(clean(error.message).slice(0, 600));
    });
  };
  const errors = { server: serverErrors, page: pageErrors };
  const resetErrors = () => {
    errors.server = serverErrors = [];
    errors.page = pageErrors = [];
  };
  const closeSession = async () => {
    const previous = session;
    session = null;
    if (!previous) return;
    blocked.push(...previous.blocked);
    try {
      if (run) {
        const name = segment === 1 ? 'discovery-trace.zip' : `discovery-trace-${segment}.zip`;
        await previous.context.tracing.stop({ path: path.join(run.dir, 'evidence', name) });
        result.evidence.push(await run.reference(`evidence/${name}`));
      }
    } finally {
      await previous.close();
    }
  };
  const recordURL = (raw, title = '') => {
    let url;
    try {
      url = new URL(raw, origin);
    } catch {
      return;
    }
    if (url.origin !== origin || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) return;
    if (known.has(url.href)) return known.get(url.href);
    if (known.size >= 120) return;
    const record = {
      id: `p${known.size + 1}`,
      url: url.href,
      path: relative(url.href),
      title: clean(title).slice(0, 160),
      visitedBy: [],
    };
    known.set(url.href, record);
    return record;
  };
  const bootstrap = async (context, who) => {
    await context.clearCookies();
    if (who.cookie)
      await context.addCookies([
        {
          name: who.cookieName ?? 'dad_donor_session',
          value: who.cookie,
          url: origin,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);
  };
  const settle = async target => {
    await target.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    // Give client rendering and fetches a bounded opportunity to settle. Never
    // interpret network idleness as a correctness or completion assertion.
    await target.waitForTimeout(300);
  };
  const start = async who => {
    await closeSession();
    actor = who;
    trail = [];
    controls.clear();
    resetErrors();
    // A new context also isolates IndexedDB, Cache Storage and browser caches.
    // Clearing cookies/localStorage alone can manufacture cross-user findings.
    session = await openBrowser([origin], { signal });
    segment++;
    try {
      session.context.setDefaultTimeout(5000);
      await session.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      page = await session.newPage();
      capture(page, errors);
      page.on('request', request => {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) dirty = true;
      });
      await bootstrap(session.context, actor);
      await page.goto(new URL(actor.entry ?? '/', origin).href, { timeout: 10000 });
      await settle(page);
    } catch (error) {
      try {
        await closeSession();
      } catch {
        /* Preserve the startup error. */
      }
      throw error;
    }
  };
  await start(actor);

  async function evidence(target, who, currentErrors, save = false) {
    const rawText = await target.locator('body').innerText({ timeout: 5000 });
    const id = `o${++sequence}`;
    const observation = {
      id,
      actor: who.id,
      path: relative(target.url()),
      text: clean(rawText).slice(0, 8000),
      textTruncated: rawText.length > 8000,
      serverErrors: structuredClone(currentErrors.server),
      pageErrors: structuredClone(currentErrors.page),
    };
    if (fixture?.inspect) observation.state = await fixture.inspect();
    if (save && run) {
      const name = `discovery-${id}.png`;
      await target.screenshot({ path: path.join(run.dir, 'evidence', name), fullPage: false, timeout: 5000 });
      result.evidence.push(await run.reference(`evidence/${name}`));
      observation.screenshot = `evidence/${name}`;
    }
    return observation;
  }
  const matchingFields = async (target, templates) => {
    const handles = await target
      .locator('input:not([type=password]):not([type=file]),textarea,select')
      .elementHandles();
    const live = [];
    for (const handle of handles.slice(0, 200))
      if (await handle.isVisible()) live.push({ handle, identity: await handle.evaluate(controlIdentity) });
    const captured = [];
    for (const template of templates) {
      const matches = live.filter(item => item.identity === template.identity);
      if (matches.length !== 1) continue;
      const handle = matches[0].handle;
      captured.push({
        id: template.id,
        label: template.label,
        identity: template.identity,
        value: await handle.inputValue(),
        checked: await handle.evaluate(el => (['checkbox', 'radio'].includes(el.type) ? el.checked : undefined)),
      });
    }
    return captured;
  };
  const perform = async (target, spec) => {
    if (spec.action === 'navigate') {
      await target.goto(spec.url, { timeout: 10000 });
      return;
    }
    if (spec.action === 'reload') {
      await target.reload({ timeout: 10000 });
      return;
    }
    if (spec.action === 'probe') {
      let status = 0;
      let json;
      const response = await target.request.get(spec.url, {
        timeout: 10000,
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      status = response.status();
      const body = (await response.text()).slice(0, 20_000);
      try {
        json = JSON.parse(body);
      } catch {
        json = undefined;
      }
      lastProbe = { status, json: json === undefined ? undefined : JSON.parse(clean(JSON.stringify(json))) };
      return;
    }
    const locator = target.locator(spec.selector);
    if ((await locator.count()) !== 1 || !(await locator.isVisible()))
      throw new Error('Observed control is no longer uniquely visible. Observe again.');
    const identity = await locator.evaluate(controlIdentity);
    if (identity !== spec.identity) throw new Error('Observed control changed; replay/action stopped.');
    if (spec.action === 'click') await locator.click({ timeout: 5000 });
    else if (spec.action === 'fill') await locator.fill(spec.value, { timeout: 5000 });
    else if (spec.action === 'select') await locator.selectOption({ label: spec.value }, { timeout: 5000 });
    else if (spec.action === 'check') {
      if (!['true', 'false'].includes(spec.value)) throw new Error('check value must be true or false.');
      await locator.setChecked(spec.value === 'true', { timeout: 5000 });
    } else throw new Error('Unsupported browser action.');
  };
  return {
    pages: () => structuredClone([...known.values()].map(({ url: _url, ...item }) => item)),
    async observe() {
      signal.throwIfAborted();
      if (replayUnavailable) throw new Error('Fixture replay or restoration failed; exploration cannot continue.');
      const current = recordURL(page.url(), await page.title());
      if (current && !current.visitedBy.includes(actor.id)) current.visitedBy.push(actor.id);
      const observation = await evidence(page, actor, errors, true);
      controls = new Map();
      const elements = await page
        .locator('a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link]')
        .elementHandles();
      const visible = [];
      for (const handle of elements.slice(0, 200)) {
        if (visible.length >= 60) break;
        if (!(await handle.isVisible())) continue;
        const info = await handle.evaluate(el => {
          const parts = [];
          let current = el;
          while (current && current.nodeType === 1) {
            const siblings = [...(current.parentElement?.children ?? [current])].filter(
              s => s.tagName === current.tagName,
            );
            parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`);
            current = current.parentElement;
          }
          return {
            selector: parts.join(' > '),
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') ?? '',
            label: (
              el.getAttribute('aria-label') ||
              el.labels?.[0]?.innerText ||
              el.innerText ||
              el.getAttribute('placeholder') ||
              el.getAttribute('name') ||
              ''
            ).slice(0, 180),
            checked: ['checkbox', 'radio'].includes(el.type) ? el.checked : undefined,
            value: el.type === 'password' ? '[hidden]' : String(el.value ?? '').slice(0, 300),
            href: el.tagName === 'A' ? el.href : null,
            newWindow: el.tagName === 'A' && el.target && el.target !== '_self',
            options: el.tagName === 'SELECT' ? [...el.options].slice(0, 20).map(o => o.label) : undefined,
          };
        });
        if (info.newWindow || info.type === 'password' || info.type === 'file') continue;
        info.identity = await handle.evaluate(controlIdentity);
        const id = `c${visible.length + 1}`;
        controls.set(id, info);
        const link = info.href ? recordURL(info.href, info.label) : null;
        visible.push({
          id,
          tag: info.tag,
          type: info.type,
          label: clean(info.label),
          value: clean(info.value),
          checked: info.checked,
          identity: info.identity,
          options: info.options,
          page: link?.id ?? null,
        });
      }
      observation.controls = visible;
      observation.actors = actors.map(({ id, description }) => ({ id, description }));
      observation.pages = this.pages();
      // Capture an accessibility audit so the agent can assert a11y_clean. Best
      // effort: a null result (audit unavailable) leaves a11y undefined, which
      // the evaluator treats as inconclusive rather than a failure.
      const violations = await audit(page).catch(() => null);
      if (violations) observation.a11y = violations;
      // Attach the most recent probe response (if any) to this observation so a
      // response_status/json_has assertion can evaluate it, then consume it.
      if (lastProbe) {
        observation.response = lastProbe;
        lastProbe = undefined;
      }
      lastObservation = structuredClone(observation);
      return observation;
    },
    async checkpoint(name, observation) {
      if (replayUnavailable || observation?.id !== lastObservation?.id || observation.actor !== actor.id)
        throw new Error('Checkpoint requires the current captured observation.');
      const marker = {
        action: 'checkpoint',
        name,
        actor: actor.id,
        controls: (observation.controls ?? [])
          .filter(c => ['input', 'textarea', 'select'].includes(c.tag))
          .map(({ id, label, identity }) => ({ id, label, identity })),
      };
      replayTrail.push(marker);
      trail.push(marker);
    },
    async act(action) {
      signal.throwIfAborted();
      if (replayUnavailable) throw new Error('Fixture restoration failed; stop this exploration.');
      if (action.action === 'inspect_state') {
        if (!fixture?.inspect) throw new Error('Persisted state verifier is unavailable.');
        return;
      }
      if (action.action === 'switch_actor') {
        const who = actors.find(a => a.id === action.target);
        if (!who) throw new Error('Unknown actor.');
        replayTrail.push({ action: 'switch_actor', actor: who.id });
        await start(who);
        return;
      }
      if (action.action === 'probe') {
        // A read-only GET to a loopback-relative path as the current actor, using
        // the authenticated page's request context (shares cookies and the
        // loopback origin; never leaves the permitted application). GET only — a
        // probe never mutates. Body is parsed as JSON when possible, size-bounded
        // and redacted; a non-JSON or oversized body leaves json undefined.
        const target = String(action.target ?? '');
        if (!/^\/(?!\/)[\w./?=&%-]{0,399}$/.test(target))
          throw new Error('Probe target must be a loopback-relative path beginning with "/".');
        const url = new URL(target, origin);
        if (url.origin !== permitted.origin) throw new Error('Probe target is outside the permitted application.');
        resetErrors();
        const spec = { action: 'probe', url: url.href };
        trail.push(spec);
        replayTrail.push(spec);
        await perform(page, spec).catch(error => {
          throw new Error(`Probe request failed: ${clean(error.message).slice(0, 300)}`);
        });
        return;
      }
      let spec = { action: action.action, value: action.value };
      if (action.action === 'navigate') {
        const route = [...known.values()].find(p => p.id === action.target);
        if (!route) throw new Error('Navigate only to a discovered page ID.');
        spec.url = route.url;
      } else if (action.action !== 'reload') {
        const control = controls.get(action.target);
        if (!control) throw new Error('Use a control ID from the current observation.');
        if (control.href && ![...known.values()].some(p => p.url === control.href))
          throw new Error('Link is outside the permitted application.');
        spec = { ...spec, selector: control.selector, identity: control.identity };
      }
      resetErrors();
      // Include failed/partially executed actions in reproduction; never pretend
      // the subsequent state was reached through a shorter successful sequence.
      trail.push(spec);
      replayTrail.push(spec);
      await perform(page, spec);
      await settle(page);
    },
    async reproduce(action, original = lastObservation) {
      const steps = structuredClone(fixture?.replay ? replayTrail : trail);
      const expectedPath = original?.path;
      const originalErrors = { server: original?.serverErrors ?? [], page: original?.pageErrors ?? [] };
      const base = {
        actor: actor.id,
        entry: (fixture?.replay ? actors[0] : actor).entry ?? '/',
        steps,
        status: 'inconclusive',
        cleanFixture: Boolean(fixture?.replay),
      };
      if (!original || original.actor !== actor.id)
        return { ...base, reason: 'No matching original observation; mismatch is not verified.' };
      if (replayUnavailable) return { ...base, reason: 'Fixture restoration previously failed.' };
      if (dirty && !fixture?.replay)
        return {
          ...base,
          reason:
            'Application received a mutation. Automatic replay requires a pristine fixture; no mutation was repeated.',
        };
      if (steps.filter(s => s.action !== 'checkpoint').length > discoveryLimits.replayActions)
        return { ...base, reason: 'Replay action budget exceeded.' };
      const originalURL = page.url();
      // Quiesce the live page before the adapter stops services and swaps data.
      let restore;
      if (fixture?.replay) {
        await page.close();
        try {
          restore = await fixture.replay();
        } catch (error) {
          replayUnavailable = true;
          throw error;
        }
      }
      let replay;
      let replaySegment = 0;
      const replayBlocked = [];
      const reproductionId = ++reproductionNumber;
      const startReplay = async () => {
        replay = await openBrowser([origin], { readOnly: !fixture?.replay, signal });
        if (run) await replay.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
        replaySegment++;
      };
      const closeReplay = async () => {
        if (!replay) return;
        const current = replay;
        replay = null;
        replayBlocked.push(...current.blocked);
        blocked.push(...current.blocked);
        try {
          if (run) {
            const name = `discovery-replay-${reproductionId}-${replaySegment}.zip`;
            await current.context.tracing.stop({ path: path.join(run.dir, 'evidence', name) });
            result.evidence.push(await run.reference(`evidence/${name}`));
          }
        } finally {
          await current.close();
        }
      };
      const replayErrors = { server: [], page: [] };
      const replayBaselines = Object.create(null);
      let replayActor = fixture?.replay ? actors[0] : actor;
      try {
        await startReplay();
        let target = await replay.newPage();
        capture(target, replayErrors);
        await bootstrap(replay.context, replayActor);
        await target.goto(new URL(replayActor.entry ?? '/', origin).href, { timeout: 10000 });
        await settle(target);
        for (const spec of steps) {
          if (spec.action === 'checkpoint') {
            if (replayActor.id !== spec.actor)
              return { ...base, reason: 'Replay checkpoint reached a different actor.' };
            const captured = await evidence(target, replayActor, replayErrors, true);
            captured.controls = await matchingFields(target, spec.controls);
            replayBaselines[spec.name] = captured;
            continue;
          }
          replayErrors.server = [];
          replayErrors.page = [];
          if (spec.action === 'switch_actor') {
            replayActor = actors.find(a => a.id === spec.actor);
            await closeReplay();
            await startReplay();
            target = await replay.newPage();
            capture(target, replayErrors);
            await bootstrap(replay.context, replayActor);
            await target.goto(new URL(replayActor.entry ?? '/', origin).href, { timeout: 10000 });
          } else await perform(target, spec);
          await settle(target);
        }
        const observation = await evidence(target, replayActor, replayErrors, true);
        if (['field_value', 'field_checked', 'field_unchanged', 'checkbox_unchanged'].includes(action.expectation)) {
          const originalControl = original.controls?.find(c => c.id === action.target);
          if (!originalControl) return { ...base, reason: 'Original field is unavailable.' };
          observation.controls = await matchingFields(target, [originalControl]);
          if (observation.controls.length !== 1)
            return { ...base, reason: 'Replay field is no longer uniquely identifiable.' };
        }
        const verification = evaluateExpectation(action, observation, replayBaselines);
        base.baselines = replayBaselines;
        if (replayBlocked.length || replay.blocked.length)
          return {
            ...base,
            observation,
            verification,
            reason: 'Replay attempted a forbidden request; mismatch is not verified.',
          };
        if (observation.actor !== original.actor || observation.path !== expectedPath)
          return {
            ...base,
            observation,
            verification,
            reason: 'Replay reached a different page; mismatch is not verified.',
          };
        if (
          action.expectation === 'no_server_error' &&
          !observation.serverErrors.some(e =>
            originalErrors.server.some(o => o.path === e.path && o.status === e.status),
          )
        )
          return { ...base, observation, verification, reason: 'The same server failure did not recur.' };
        if (
          action.expectation === 'no_page_error' &&
          !observation.pageErrors.some(e => originalErrors.page.includes(e))
        )
          return { ...base, observation, verification, reason: 'The same JavaScript failure did not recur.' };
        return {
          ...base,
          observation,
          verification,
          status: !verification.evaluable ? 'inconclusive' : verification.passed ? 'not-reproduced' : 'reproduced',
        };
      } catch (error) {
        return { ...base, reason: clean(error.message).slice(0, 600) };
      } finally {
        try {
          await closeReplay();
        } finally {
          if (restore) {
            try {
              await restore();
              page = await session.newPage();
              capture(page, errors);
              resetErrors();
              page.on('request', request => {
                if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) dirty = true;
              });
              await page.goto(originalURL, { timeout: 10000 });
              await settle(page);
            } catch (error) {
              replayUnavailable = true;
              // biome-ignore lint/correctness/noUnsafeFinally: later experiments would run against unknown state, so a failed restoration replaces the replay result.
              throw new Error(`Fixture restoration failed: ${error.message}`);
            }
          }
        }
      }
    },
    close: closeSession,
    get fatal() {
      return replayUnavailable;
    },
    get blocked() {
      return [...blocked, ...(session?.blocked ?? [])];
    },
  };
}
