import path from 'node:path';
import { requireModelConfig } from '../src/model-provider.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  benchmarkApplication,
  benchmarkFaults,
  benchmarkContract,
  benchmarkSource,
  benchmarkMetrics,
} from '../src/discovery-benchmark.js';
import { Run, atomicJSON, digest, redact, redactJSON } from '../src/core.js';
import { buildApplicationMemory } from '../src/application-memory.js';
import { sourceReader } from '../src/source-reader.js';
import { discoveryProvider, discover, discoveryLimits, discoveryInstructions } from '../src/discovery.js';
import { openDiscoveryBrowser } from '../src/discovery-browser.js';

function usageError(message) {
  console.error(message);
  process.exit(2);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      live: { type: 'boolean' },
      help: { type: 'boolean' },
      model: { type: 'string' },
      provider: { type: 'string' },
      'max-requests': { type: 'string', default: '40' },
      repeats: { type: 'string', default: '1' },
      output: { type: 'string', default: '.atm/benchmarks' },
      'token-price': { type: 'string' },
    },
  }));
} catch (error) {
  usageError(error.message);
}
if (values.help) {
  console.log(
    `Usage: npm run benchmark:discovery -- --live --model MODEL [--repeats 1..5] [--max-requests 1..${discoveryLimits.requests}] [--output DIR] [--token-price USD_PER_MILLION_TOTAL_TOKENS]\nRuns five blinded application variants through the real model. Requires the selected provider API key (ATM_PROVIDER or --provider openai|tinker). Token price is an optional blended estimate supplied by you.`,
  );
} else {
  const model = values.model ?? process.env.ATM_MODEL,
    repeats = Number(values.repeats),
    price = values['token-price'] === undefined ? null : Number(values['token-price']);
  if (!values.live) usageError('Benchmark requires --live.');
  let config;
  try {
    config = requireModelConfig({ providerName: values.provider, model });
  } catch (error) {
    usageError(error.message);
  }
  const decide = discoveryProvider(config);
  if (
    !Number.isInteger(repeats) ||
    repeats < 1 ||
    repeats > 5 ||
    (price !== null && (!Number.isFinite(price) || price < 0))
  )
    usageError('Invalid repetitions or token price.');
  const maxRequests = Number(values['max-requests']);
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > discoveryLimits.requests)
    usageError(`Benchmark request limit must be 1–${discoveryLimits.requests}.`);
  const directory = path.resolve(values.output, `benchmark-${Date.now()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const cases = [],
    controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    for (let repeat = 0; repeat < repeats && !controller.signal.aborted; repeat++)
      for (const fault of benchmarkFaults) {
        if (controller.signal.aborted) break;
        const run = await Run.create(
          directory,
          { mode: 'exploration', model, provider: config.providerName, adapter: 'synthetic-profile' },
          ['discovery'],
        );
        run.data.candidate = {
          revision: digest(benchmarkSource + benchmarkContract).slice(0, 40),
          source: 'benchmark:synthetic-profile',
        };
        const sourceRoot = path.join(run.dir, 'source');
        await mkdir(sourceRoot);
        await writeFile(path.join(sourceRoot, 'README.md'), benchmarkContract, { mode: 0o600 });
        await writeFile(path.join(sourceRoot, 'profile.js'), benchmarkSource, { mode: 0o600 });
        const source = await sourceReader(sourceRoot);
        const report = {
          version: 1,
          contractVersion: 1,
          runId: run.data.id,
          ...run.data.candidate,
          model,
          provider: config.providerName,
          promptSha256: digest(discoveryInstructions),
          limits: { ...discoveryLimits, requests: maxRequests },
          startedAt: new Date().toISOString(),
          status: 'running',
          requests: 0,
          tokens: 0,
          pages: [],
          observations: [],
          events: [],
          investigations: [],
          findings: [],
          memory: [],
          warnings: [],
          sourceContext: { initialFiles: source.inventory },
        };
        let app, browser;
        const start = Date.now();
        await run.step('discovery', async result => {
          const update = async () => {
            await atomicJSON(path.join(run.dir, 'evidence/discovery.json'), redactJSON(report));
            result.evidence = result.evidence.filter(e => e.path !== 'evidence/discovery.json');
            result.evidence.push(await run.reference('evidence/discovery.json'));
            await run.save();
          };
          try {
            app = await benchmarkApplication(fault);
            const knowledge = await buildApplicationMemory({
              root: directory,
              runs: [],
              candidate: run.data.candidate,
              source,
              actors: app.actors,
              signal: controller.signal,
            });
            report.applicationMemory = knowledge.overview;
            await atomicJSON(path.join(run.dir, 'evidence/application-memory.json'), redactJSON(knowledge.index));
            result.evidence.push(await run.reference('evidence/application-memory.json'));
            const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(discoveryLimits.durationMs)]);
            browser = await openDiscoveryBrowser({ ...app, signal, run, result });
            await discover({
              provider: decide,
              browser,
              source,
              knowledge,
              report,
              signal,
              maxRequests,
              onUpdate: update,
            });
          } catch (error) {
            report.status = controller.signal.aborted ? 'canceled' : 'inconclusive';
            report.summary = redact(error.message);
            throw error;
          } finally {
            report.finishedAt ??= new Date().toISOString();
            try {
              await browser?.close();
            } finally {
              await update();
            }
          }
          return { status: report.status === 'completed' ? 'passed' : 'inconclusive', summary: report.summary };
        });
        try {
          cases.push({
            runId: run.data.id,
            fault,
            repeat,
            status: report.status,
            findings: report.findings.length,
            verifiedFindings: report.findings.filter(f => app?.judge(f)).length,
            requests: report.requests,
            tokens: report.tokens,
            usageIncomplete: Boolean(report.usageIncomplete),
            durationMs: Date.now() - start,
          });
          run.data.release = {
            scope: 'exploration',
            status: 'not-applicable',
            eligible: false,
            productionAuthorized: false,
            reasons: ['Synthetic discovery benchmark; not release acceptance.'],
          };
          await run.finish();
        } finally {
          await app?.close();
        }
        const metrics = benchmarkMetrics(cases);
        await atomicJSON(path.join(directory, 'benchmark.json'), {
          schemaVersion: 1,
          model,
          provider: config.providerName,
          repeats,
          promptSha256: digest(discoveryInstructions),
          applicationContractSha256: digest(benchmarkContract + benchmarkSource),
          limits: { ...discoveryLimits, requests: maxRequests },
          cases,
          metrics,
          costEstimateUSD: price === null ? null : (metrics.tokens * price) / 1_000_000,
          suppliedBlendedPricePerMillionTokens: price,
        });
        console.log(
          `${fault}: ${cases.at(-1).verifiedFindings} independently scored findings; ${report.tokens} tokens`,
        );
      }
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
  console.log(`Benchmark report: ${path.join(directory, 'benchmark.json')}`);
  if (controller.signal.aborted) process.exitCode = 130;
}
