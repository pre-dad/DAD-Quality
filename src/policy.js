import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scenarios } from './scenarios.js';
import { validatePerformanceProfile } from './performance-config.js';
import { isRegisteredAdapter } from './targets/index.js';

const defaultPolicyPath = fileURLToPath(new URL('../policies/impactgraph-local.json', import.meta.url));
export const evidenceRequirements = {
  snapshot: ['candidate.json'],
  docker: ['docker.log', 'compose-version.log'],
  build: ['build-api.log', 'build-web.log'],
  database: ['migrations.log', 'test-migrations.log'],
  'api-tests': ['api-tests.log'],
  'web-tests': ['web-tests.log'],
  deploy: ['readiness.log'],
  'staff-journey': ['staff-verification.json', 'staff-trace.zip'],
  'donor-claim-journey': ['donor-verification.json', 'donor-trace.zip'],
  'ai-public-journey': ['agent-events.json', 'agent-final.png'],
  cleanup: ['cleanup.log'],
  performance: ['performance.json'],
  discovery: ['discovery.json', 'discovery-trace.zip'],
};
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const hashPolicy = value => createHash('sha256').update(canonical(value)).digest('hex');
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)))
    throw new Error('Invalid or unsupported policy fields.');
}
const explorationChecks = ['snapshot', 'docker', 'build', 'database', 'deploy', 'discovery', 'cleanup'];

export function validatePolicy(policy) {
  fields(policy, ['schemaVersion', 'id', 'version', 'adapter', 'scope', 'checks', 'findings', 'exceptions']);
  if (
    policy.schemaVersion !== 1 ||
    !/^[a-z0-9-]{1,80}$/.test(policy.id ?? '') ||
    !/^\d+\.\d+\.\d+$/.test(policy.version ?? '') ||
    !isRegisteredAdapter(policy.adapter) ||
    !['local-acceptance', 'exploration'].includes(policy.scope)
  )
    throw new Error('Unsupported policy identity, version, adapter or scope.');
  const exploration = policy.scope === 'exploration';
  if (
    !Array.isArray(policy.checks) ||
    !policy.checks.length ||
    new Set(policy.checks.map(c => c?.id)).size !== policy.checks.length
  )
    throw new Error('Policy checks must be nonempty and unique.');
  for (const check of policy.checks) {
    fields(check, ['id', 'required', 'timeoutMs', 'evidence', 'scenario', 'profile']);
    if (check.id === 'performance') {
      validatePerformanceProfile(check.profile);
      const minimum =
        check.profile.phases.reduce((sum, phase) => sum + phase.durationMs + check.profile.requestTimeoutMs, 0) + 10000;
      if (check.timeoutMs < minimum) throw new Error('Performance time budget cannot cover its workload.');
      if (check.required && (check.profile.criteria.maxP95Ms === null || check.profile.criteria.maxErrorRate === null))
        throw new Error('Required performance needs explicit latency and error budgets.');
    } else if (check.profile !== undefined) throw new Error('Only performance checks accept a workload profile.');
    if (
      !Object.hasOwn(evidenceRequirements, check.id) ||
      typeof check.required !== 'boolean' ||
      !Number.isInteger(check.timeoutMs) ||
      check.timeoutMs < 1000 ||
      check.timeoutMs > 3_600_000
    )
      throw new Error('Unsupported check or timeout.');
    if (
      !Array.isArray(check.evidence) ||
      new Set(check.evidence).size !== check.evidence.length ||
      check.evidence.some(e => typeof e !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(e)) ||
      evidenceRequirements[check.id].some(e => !check.evidence.includes(e))
    )
      throw new Error(`Missing or invalid evidence contract: ${check.id}`);
    if (scenarios[check.id]) {
      if (check.timeoutMs > 180_000) throw new Error('Journey time budgets cannot exceed 180 seconds.');
      fields(check.scenario, ['id', 'version']);
      if (check.scenario.id !== check.id || check.scenario.version !== scenarios[check.id].version)
        throw new Error(`Unsupported scenario version: ${check.id}`);
    } else if (check.scenario) throw new Error('Only implemented journeys may reference scenarios.');
    if (check.id === 'cleanup' && check.timeoutMs < 110_000)
      throw new Error('Cleanup requires at least 110 seconds for bounded log collection and removal.');
  }
  for (const id of exploration
    ? explorationChecks
    : ['snapshot', 'docker', 'build', 'database', 'api-tests', 'web-tests', 'deploy', 'cleanup']) {
    if (!policy.checks.some(c => c.id === id && c.required))
      throw new Error(`Required foundation check missing: ${id}`);
  }
  if (!exploration && !policy.checks.some(c => c.scenario && c.required && c.id !== 'ai-public-journey'))
    throw new Error('At least one deterministic journey must be required.');
  if (exploration && policy.checks.some(c => !explorationChecks.includes(c.id)))
    throw new Error('Exploration does not execute predefined suites.');
  if (!exploration && policy.checks.some(c => c.id === 'discovery'))
    throw new Error('Discovery requires an exploration policy.');
  fields(policy.findings, ['blockingSeverities']);
  const levels = policy.findings.blockingSeverities;
  if (
    !Array.isArray(levels) ||
    !levels.includes('critical') ||
    !levels.includes('unassessed') ||
    new Set(levels).size !== levels.length ||
    levels.some(s => !['unassessed', 'low', 'medium', 'high', 'critical'].includes(s))
  )
    throw new Error('Invalid blocking severities; critical and unassessed findings must block.');
  fields(policy.exceptions, ['mode']);
  if (policy.exceptions.mode !== 'disabled')
    throw new Error('Release exceptions are not supported; checks and blocking findings cannot be waived.');
  return policy;
}
export async function loadPolicy(file = defaultPolicyPath, { ai = false, requireAI = false } = {}) {
  const definition = validatePolicy(JSON.parse(await readFile(file, 'utf8')));
  let check = definition.checks.find(c => c.id === 'ai-public-journey');
  if ((ai || requireAI) && !check) {
    check = {
      id: 'ai-public-journey',
      required: false,
      timeoutMs: 180_000,
      evidence: evidenceRequirements['ai-public-journey'],
      scenario: { id: 'ai-public-journey', version: 1 },
    };
    definition.checks.push(check);
  }
  if (requireAI) check.required = true;
  const snapshot = {
    definition,
    scenarios: definition.checks.filter(c => c.scenario).map(c => structuredClone(scenarios[c.id])),
  };
  return { ...snapshot, digest: hashPolicy(snapshot) };
}
export function policyIssues(run) {
  try {
    const { definition, scenarios: saved, digest } = run.policy;
    validatePolicy(definition);
    if (hashPolicy({ definition, scenarios: saved }) !== digest) throw new Error('Policy snapshot hash mismatch.');
    const expected = definition.checks.filter(c => c.scenario).map(c => scenarios[c.id]);
    if (canonical(expected) !== canonical(saved))
      throw new Error('Scenario definitions do not match supported handler versions.');
    if (canonical(definition.checks.filter(c => c.required).map(c => c.id)) !== canonical(run.required))
      throw new Error('Required checks differ from the recorded policy.');
    return [];
  } catch (error) {
    return [`Policy unavailable or invalid: ${error.message}`];
  }
}
