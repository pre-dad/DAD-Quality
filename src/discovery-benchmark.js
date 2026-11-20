import { createServer } from 'node:http';
import { escapeHTML } from './core.js';
import { replayFixture } from './discovery-fixture.js';

export const benchmarkFaults = ['healthy', 'lost-save', 'cross-actor', 'accept-invalid', 'duplicate-write'];
export const benchmarkContract = `# Synthetic profile application
Each donor can edit their own public name. Names must be nonblank and at most 40 characters.
Save persists the name across reloads and increments save_count exactly once for a valid submission.
An invalid name must not change persisted data or save_count. Saving one donor must not change another donor.
Guest visitors cannot save. The independent fixture inspector exposes each donor's public_name and save_count.
`;
export const benchmarkSource = `// Profile contract implementation (runtime behavior is tested independently).
export function saveProfile(actor, name, profiles) {
  if (!actor || !name.trim() || name.length > 40) return { status: 400 };
  profiles[actor].public_name = name;
  profiles[actor].save_count++;
  return { status: 200 };
}
`;
export async function benchmarkApplication(fault = 'healthy') {
  if (!benchmarkFaults.includes(fault)) throw new Error('Unknown benchmark fault.');
  const seed = () => ({
    'donor-a': { public_name: 'Alex', save_count: 0 },
    'donor-b': { public_name: 'Blair', save_count: 0 },
  });
  let actual = seed(),
    expected = seed(),
    observations = 0;
  const oracle = new Map();
  const server = createServer(async (request, response) => {
    const actor = request.headers.cookie?.includes('test-a')
      ? 'donor-a'
      : request.headers.cookie?.includes('test-b')
        ? 'donor-b'
        : null;
    if (request.method === 'POST' && request.url === '/profile') {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 4000) {
          response.writeHead(413).end();
          return;
        }
      }
      if (!actor) {
        response.writeHead(401).end();
        return;
      }
      let name;
      try {
        name = JSON.parse(body).name;
      } catch {
        response.writeHead(400).end();
        return;
      }
      if (typeof name !== 'string') {
        response.writeHead(400).end();
        return;
      }
      const valid = Boolean(name.trim()) && name.length <= 40;
      if (valid) {
        expected[actor].public_name = name;
        expected[actor].save_count++;
      }
      if (!valid && fault !== 'accept-invalid') {
        response.writeHead(400).end('Invalid name');
        return;
      }
      if (fault !== 'lost-save') {
        actual[actor].public_name = name;
        actual[actor].save_count += fault === 'duplicate-write' ? 2 : 1;
        if (fault === 'cross-actor') actual[actor === 'donor-a' ? 'donor-b' : 'donor-a'].public_name = name;
      }
      response.end('Saved');
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(
      `<!doctype html><html lang="en"><title>Profile</title><body><h1>${actor ? `${escapeHTML(actor)} profile` : 'Welcome'}</h1><a href="/profile">Profile</a><p>Names must be nonblank and at most 40 characters. Save persists only your own profile and records one save.</p>${actor ? `<form><label>Public name<input name="public_name" value="${escapeHTML(actual[actor].public_name)}"></label><button>Save profile</button></form><p role="status" id="status"></p><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const r=await fetch('/profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:document.querySelector('input').value})});document.querySelector('#status').textContent=r.ok?'Profile saved.':'Name is invalid.'}</script>` : '<p>Sign in with a supplied synthetic identity to manage a profile.</p>'}</body></html>`,
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const fixture = await replayFixture({
    snapshot: async () => structuredClone({ actual, expected }),
    restore: async state => {
      ({ actual, expected } = structuredClone(state));
    },
    stop: async () => {},
    start: async () => {},
    inspect: async () => {
      oracle.set(`o${++observations}`, { actual: structuredClone(actual), expected: structuredClone(expected) });
      return structuredClone(actual);
    },
  });
  return {
    origin: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`,
    actors: [
      { id: 'guest', description: 'Anonymous visitor', entry: '/' },
      { id: 'donor-a', description: 'Synthetic donor Alex', cookie: 'test-a', entry: '/profile' },
      { id: 'donor-b', description: 'Synthetic donor Blair', cookie: 'test-b', entry: '/profile' },
    ],
    fixture,
    judge(finding) {
      // Score only exact independently checked contract violations, not model prose.
      const action = finding.assertion,
        first = oracle.get(finding.initial.observationId),
        replay = oracle.get(finding.reproduction.observation?.id);
      if (
        finding.status !== 'reproduced' ||
        !['state_equals', 'state_unchanged', 'state_delta'].includes(finding.expectation) ||
        !first ||
        !replay
      )
        return false;
      const firstBaseline = oracle.get(finding.initial.baselineId),
        replayBaseline = oracle.get(finding.reproduction.verification?.baselineId);
      return [
        [first, firstBaseline],
        [replay, replayBaseline],
      ].every(([state, baseline]) => {
        if (!state.expected[action.target] || !Object.hasOwn(state.expected[action.target], action.value)) return false;
        const wanted = state.expected[action.target][action.value],
          actual = state.actual[action.target][action.value];
        if (finding.expectation === 'state_equals')
          return String(wanted) === finding.text && String(actual) !== finding.text;
        if (!baseline?.expected[action.target] || !Object.hasOwn(baseline.expected[action.target], action.value))
          return false;
        const priorWanted = baseline.expected[action.target][action.value],
          priorActual = baseline.actual[action.target][action.value];
        if (finding.expectation === 'state_unchanged')
          return Object.is(wanted, priorWanted) && !Object.is(actual, priorActual);
        const delta = Number(finding.text);
        return (
          [wanted, actual, priorWanted, priorActual, delta].every(Number.isSafeInteger) &&
          wanted - priorWanted === delta &&
          actual - priorActual !== delta
        );
      });
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

export function benchmarkMetrics(cases) {
  const defects = cases.filter(c => c.fault !== 'healthy'),
    healthy = cases.filter(c => c.fault === 'healthy');
  const totalTokens = cases.reduce((n, c) => n + c.tokens, 0),
    detected = defects.filter(c => c.verifiedFindings > 0).length;
  return {
    cases: cases.length,
    defectiveCases: defects.length,
    detectedCases: detected,
    detectionRate: defects.length ? detected / defects.length : null,
    healthyCases: healthy.length,
    healthyReportsWithFindings: healthy.filter(c => c.findings > 0).length,
    healthyFalsePositiveRunRate: healthy.length ? healthy.filter(c => c.findings > 0).length / healthy.length : null,
    verifiedFindings: cases.reduce((n, c) => n + c.verifiedFindings, 0),
    unmatchedFindingsNeedReview: cases.reduce((n, c) => n + c.findings - c.verifiedFindings, 0),
    tokens: totalTokens,
    usageIncompleteCases: cases.filter(c => c.usageIncomplete).length,
    requests: cases.reduce((n, c) => n + c.requests, 0),
    tokensPerDetectedCase: detected ? totalTokens / detected : null,
    completedCases: cases.filter(c => c.status === 'completed').length,
    scoring:
      'Only reproduced literal or relationship state assertions matching hidden contract state count as detections. Other findings require review. Partial runs remain in the denominator.',
  };
}
