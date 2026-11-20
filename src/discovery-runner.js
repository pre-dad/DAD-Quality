import path from 'node:path';
import { modelConfig } from './model-provider.js';
import { Run, RunError, digest, atomicJSON, redactJSON, redact } from './core.js';
import { discover, discoveryProvider, discoveryLimits, discoveryInstructions } from './discovery.js';
import { openDiscoveryBrowser } from './discovery-browser.js';
import { discoveryMemory } from './discovery-report.js';
import { buildApplicationMemory } from './application-memory.js';
import { sourceReader } from './source-reader.js';
import { listRuns } from './history.js';
import { hashPolicy, evidenceRequirements } from './policy.js';
import { resolveTarget } from './targets/index.js';

export function discoveryPolicy(target = 'dad') {
  const { policyId, adapterId } = resolveTarget(target);
  const times = {
    snapshot: 60_000,
    docker: 30_000,
    build: 1_800_000,
    database: 180_000,
    deploy: 180_000,
    discovery: 660_000,
    cleanup: 120_000,
  };
  const definition = {
    schemaVersion: 1,
    id: policyId,
    version: '1.3.0',
    adapter: adapterId,
    scope: 'exploration',
    checks: Object.entries(times).map(([id, timeoutMs]) => ({
      id,
      required: true,
      timeoutMs,
      evidence: evidenceRequirements[id],
    })),
    findings: { blockingSeverities: ['unassessed', 'high', 'critical'] },
    exceptions: { mode: 'disabled' },
  };
  const snapshot = { definition, scenarios: [] };
  return { ...snapshot, digest: hashPolicy(snapshot) };
}

/**
 * @param {{repo?: string, revision?: string, output?: string, model?: string, signal?: AbortSignal, trigger?: string,
 *   onCreated?: (run: Run) => void, provider?: Function, providerName?: string, maxRequests?: number, target?: string,
 *   configFile?: string, adapterFactory?: (run: Run, options: object) => any, browserFactory?: Function}} options
 */
export async function executeDiscovery({
  repo,
  revision = 'HEAD',
  output = '.atm/runs',
  model,
  signal = new AbortController().signal,
  trigger = 'cli',
  onCreated = () => {},
  provider,
  providerName,
  maxRequests = discoveryLimits.requests,
  target = 'dad',
  configFile,
  adapterFactory,
  browserFactory = openDiscoveryBrowser,
}) {
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > discoveryLimits.requests)
    throw new RunError('Discovery request limit must be 1–40.');
  const resolved = resolveTarget(target);
  adapterFactory ??= resolved.adapterFactory;
  // Fail before building images when model configuration is absent.
  const decide = provider ?? discoveryProvider({ providerName, model });
  const config = provider ? { providerName: 'injected-provider', model } : modelConfig({ providerName, model });
  model = config.model;
  const policy = discoveryPolicy(target);
  const run = await Run.create(
    output,
    {
      adapter: resolved.adapterId,
      revision,
      mode: 'exploration',
      model,
      provider: config.providerName,
      maxRequests,
      trigger,
    },
    policy.definition.checks.map(c => c.id),
    policy,
  );
  onCreated(run);
  console.log(`Exploration evidence: ${run.dir}`);
  const adapter = adapterFactory(run, { repo, revision, signal, configFile });
  const step = async (id, action) => {
    const check = policy.definition.checks.find(c => c.id === id);
    const deadline = AbortSignal.timeout(check.timeoutMs);
    adapter.signal = id === 'cleanup' ? deadline : AbortSignal.any([signal, deadline]);
    return run.step(id, async result => {
      result.timeoutMs = check.timeoutMs;
      const outcome = await action(result);
      if (deadline.aborted) throw new RunError(`${id} exceeded its time budget.`);
      return outcome;
    });
  };
  try {
    let ready = true;
    for (const id of ['snapshot', 'docker', 'build', 'database', 'deploy']) {
      if (!ready || signal.aborted) break;
      ready = await step(id, result => adapter[id](result));
    }
    if (ready && !signal.aborted)
      await step('discovery', async result => {
        const { runs, warnings } = await listRuns(output);
        const carried = await discoveryMemory(output, runs, run.data.candidate);
        const report = {
          version: 1,
          contractVersion: 1,
          runId: run.data.id,
          revision: run.data.candidate.revision,
          source: run.data.candidate.source,
          model: model ?? 'injected-provider',
          provider: config.providerName,
          promptSha256: digest(discoveryInstructions),
          limits: { ...discoveryLimits, requests: maxRequests },
          startedAt: new Date().toISOString(),
          status: 'running',
          summary: '',
          requests: 0,
          tokens: 0,
          pages: [],
          investigations: [],
          observations: [],
          events: [],
          findings: [],
          memory: carried.memory,
          warnings: [...warnings, ...carried.warnings],
        };
        const update = async () => {
          await atomicJSON(path.join(run.dir, 'evidence/discovery.json'), redactJSON(report));
          const reference = await run.reference('evidence/discovery.json');
          result.evidence = result.evidence.filter(e => e.path !== reference.path);
          result.evidence.push(reference);
          const regressions = {
            schemaVersion: 1,
            revision: report.revision,
            source: report.source,
            candidates: report.findings
              .filter(f => f.status === 'reproduced')
              .map(f => ({
                findingId: f.id,
                title: f.title,
                needsReview: true,
                plan: f.plan,
                contractCheck: f.contractCheck,
                expectation: { expectation: f.expectation, text: f.text, ...f.assertion },
                reproduction: f.reproduction,
              })),
          };
          result.evidence = result.evidence.filter(e => e.path !== 'evidence/discovery-regressions.json');
          await atomicJSON(path.join(run.dir, 'evidence/discovery-regressions.json'), redactJSON(regressions));
          result.evidence.push(await run.reference('evidence/discovery-regressions.json'));
          await run.save();
        };
        let browser;
        try {
          await update();
          const actors = await adapter.discoveryFixture();
          const source = adapter.source ? await sourceReader(adapter.source) : undefined;
          const knowledge = await buildApplicationMemory({
            root: output,
            runs,
            candidate: run.data.candidate,
            source,
            actors,
            signal: adapter.signal,
          });
          report.applicationMemory = knowledge.overview;
          report.warnings.push(...knowledge.index.warnings);
          await atomicJSON(path.join(run.dir, 'evidence/application-memory.json'), redactJSON(knowledge.index));
          result.evidence.push(await run.reference('evidence/application-memory.json'));
          const fixture = adapter.discoveryReplayFixture ? await adapter.discoveryReplayFixture() : undefined;
          report.sourceContext = {
            changedFiles: (run.data.candidate.changedFiles ?? []).slice(0, 40),
            inventoryCount: source?.inventory.length ?? 0,
            initialFiles: source?.inventory.slice(0, 40) ?? [],
          };
          report.sourceInventory = source?.inventory ?? [];
          report.capabilities = {
            sourceInspection: Boolean(source),
            persistedState: Boolean(fixture?.inspect),
            cleanFixtureReplay: Boolean(fixture?.replay),
          };
          report.actors = actors.map(({ id, description, entry }) => ({ id, description, entry }));
          const explorationSignal = AbortSignal.any([adapter.signal, AbortSignal.timeout(discoveryLimits.durationMs)]);
          browser = await browserFactory({
            origin: adapter.publicOrigin,
            actors,
            signal: explorationSignal,
            run,
            result,
            fixture,
          });
          await discover({
            provider: decide,
            browser,
            report,
            source,
            knowledge,
            memory: carried.memory,
            maxRequests,
            signal: explorationSignal,
            onUpdate: update,
          });
        } catch (error) {
          report.status = signal.aborted ? 'canceled' : 'inconclusive';
          report.summary = redact(error.message);
        } finally {
          try {
            if (browser) {
              report.blockedRequests = browser.blocked;
              await browser.close();
            }
          } finally {
            report.finishedAt ??= new Date().toISOString();
            await update();
          }
        }
        return {
          status: report.status === 'completed' ? 'passed' : signal.aborted ? 'canceled' : 'inconclusive',
          summary: redact(
            `${report.investigations.length} self-selected investigations; ${report.findings.length} potential findings (${report.findings.filter(f => f.status === 'reproduced').length} reproduced). ${report.summary}`,
          ),
        };
      });
  } finally {
    await step('cleanup', result => adapter.cleanup(result));
    for (const check of policy.definition.checks)
      if (!run.data.results.some(r => r.id === check.id))
        run.data.results.push({
          id: check.id,
          required: true,
          status: signal.aborted ? 'canceled' : 'inconclusive',
          summary: 'Not executed; prerequisite unavailable.',
          evidence: [],
        });
    if (signal.aborted) run.data.canceledAt = new Date().toISOString();
    run.data.release = {
      status: 'not-applicable',
      eligible: false,
      scope: 'exploration',
      productionAuthorized: false,
      reasons: ['Discovery reports observations and hypotheses; it does not assess release readiness.'],
    };
    await run.finish();
  }
  console.log(`Exploration ${run.data.decision.status}: ${path.join(run.dir, 'report.html')}`);
  return run;
}
