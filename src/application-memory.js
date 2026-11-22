import { digest } from './core.js';
import { readDiscovery } from './discovery-report.js';

export const memoryLimits = Object.freeze({
  runs: 100,
  records: 250,
  bytes: 2_000_000,
  dependencies: 500,
  results: 8,
  resultBytes: 16_000,
});
const normalized = value =>
  String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
const bounded = (value, length = 500) => String(value ?? '').slice(0, length);
const unique = values => [...new Set(values.filter(Boolean))];
const hash = /^[a-f0-9]{64}$/;
const sameKey = record =>
  JSON.stringify([
    normalized(record.feature),
    normalized(record.behavior),
    (record.assertedActors.length ? record.assertedActors : record.actors).slice().sort(),
    normalized(record.state),
  ]);

function dependencies(report, investigation) {
  const references = new Set(investigation.plan?.references ?? []),
    hashes = new Map();
  const events = new Map(report.events.map(event => [event.step, event.investigationId]));
  for (const evidence of report.sourceEvidence ?? []) {
    const result = evidence.result;
    const items = result?.path ? [result] : (result?.matches ?? []);
    for (const item of items) {
      if (typeof item.path !== 'string' || !hash.test(item.sha256 ?? '')) continue;
      if (references.has(item.path) || events.get(evidence.step) === investigation.id) {
        references.add(item.path);
        const prior = hashes.get(item.path);
        hashes.set(item.path, hashes.has(item.path) && prior !== item.sha256 ? null : item.sha256);
      }
    }
  }
  return {
    items: [...references].slice(0, 16).map(file => ({ path: bounded(file, 240), sha256: hashes.get(file) ?? null })),
    omitted: Math.max(0, references.size - 16),
  };
}

function extract(report, run, investigation) {
  if (!investigation || typeof investigation.id !== 'string' || typeof investigation.title !== 'string') return null;
  const observationIds = new Set([
    investigation.observationId,
    ...report.events.filter(e => e.investigationId === investigation.id).map(e => e.observationId),
  ]);
  const observations = report.observations.filter(o => observationIds.has(o.id));
  const checks = Array.isArray(investigation.plan?.checks) ? investigation.plan.checks : [];
  const progress = Array.isArray(investigation.progress) ? investigation.progress : [];
  const source = dependencies(report, investigation);
  const findings = report.findings
    .filter(f => f.investigationId === investigation.id)
    .slice(0, 8)
    .map(f => ({ id: f.id, title: bounded(f.title), status: f.status, needsReview: true }));
  const failed = progress.filter(p => p.verification?.passed === false).map(p => p.checkId);
  const feature = bounded(investigation.plan?.capability ?? investigation.title, 200);
  return {
    id: `m${digest(`${run.id}:${investigation.id}`).slice(0, 24)}`,
    featureId: `f${digest(normalized(feature)).slice(0, 16)}`,
    feature,
    behavior: bounded(investigation.plan?.behavior ?? investigation.title, 200),
    state: bounded(investigation.plan?.state ?? 'unspecified'),
    title: bounded(investigation.title, 200),
    hypothesis: bounded(investigation.hypothesis),
    assertedActors: unique(
      (report.assertions ?? [])
        .filter(a => a.investigationId === investigation.id)
        .map(a => observations.find(o => o.id === a.observationId)?.actor),
    ).slice(0, 12),
    actors: unique([...observations.map(o => o.actor), ...checks.map(c => c.actor)].map(v => bounded(v, 100))).slice(
      0,
      12,
    ),
    pages: unique(observations.map(o => bounded(o.path, 512))).slice(0, 8),
    sourceDependencies: source.items,
    omittedDependencies: source.omitted,
    dataFields: unique(
      checks.filter(c => c.expectation?.startsWith('state_')).map(c => `${c.target}.${c.value}`),
    ).slice(0, 24),
    expectation: { text: bounded(investigation.plan?.expected), basis: investigation.plan?.basis ?? 'unknown' },
    checks: checks.slice(0, 12),
    outcome: investigation.conclusion?.status ?? 'unfinished',
    conclusion: bounded(investigation.conclusion?.reason),
    preconditions: bounded(investigation.plan?.preconditions),
    nextCheck: checks[progress.length]?.id ?? null,
    executedChecks: progress.map(p => p.checkId),
    failedChecks: failed,
    findings,
    evidence: {
      runId: run.id,
      investigationId: investigation.id,
      revision: run.candidate.revision,
      startedAt: run.startedAt,
      reportSha256: run.results.find(r => r.id === 'discovery').evidence.find(e => e.path === 'evidence/discovery.json')
        .sha256,
      observationIds: [...observationIds].filter(Boolean).slice(0, 40),
    },
    currentTruth: false,
  };
}

function assess(record, candidate, fingerprints) {
  const changed = [],
    unknown = [];
  for (const dependency of record.sourceDependencies) {
    const current = fingerprints[dependency.path];
    dependency.currentSha256 = current?.sha256 ?? null;
    dependency.currentStatus = current?.status ?? 'not-compared';
    if (current?.status === 'missing') changed.push(dependency.path);
    else if (!dependency.sha256 || current?.status !== 'available') unknown.push(dependency.path);
    else if (dependency.sha256 !== current.sha256) changed.push(dependency.path);
  }
  const freshness = changed.length
    ? 'needs-revalidation'
    : unknown.length || record.omittedDependencies || !record.sourceDependencies.length
      ? record.evidence.revision === candidate.revision
        ? 'same-revision'
        : 'unknown'
      : 'unchanged-references';
  const reasons = [];
  if (changed.length) reasons.push('Referenced source changed or was removed.');
  if (unknown.length || record.omittedDependencies || !record.sourceDependencies.length)
    reasons.push('Some source dependencies are unknown; matching files do not prove all dependencies were captured.');
  if (record.findings.length || record.failedChecks.length || record.outcome === 'refuted')
    reasons.push('Earlier failures or hypotheses need review and retesting; memory does not carry current triage.');
  if (['unfinished', 'blocked'].includes(record.outcome))
    reasons.push('Earlier investigation is unfinished or blocked. Recreate its preconditions in the fresh fixture.');
  return { freshness, changedFiles: changed, unknownFiles: unknown, reasons };
}

const priority = record =>
  record.freshness === 'needs-revalidation'
    ? 0
    : record.findings.length || record.failedChecks.length || record.outcome === 'refuted'
      ? 1
      : ['unfinished', 'blocked'].includes(record.outcome)
        ? 2
        : record.freshness === 'unknown'
          ? 3
          : 4;
function ranked(records) {
  return records
    .slice()
    .sort(
      (a, b) =>
        priority(a) +
          (a.latestForBehavior || a.findings.length || a.failedChecks.length ? 0 : 10) -
          (priority(b) + (b.latestForBehavior || b.findings.length || b.failedChecks.length ? 0 : 10)) ||
        b.evidence.startedAt.localeCompare(a.evidence.startedAt) ||
        a.id.localeCompare(b.id),
    );
}
function summary(record) {
  return {
    id: record.id,
    feature: record.feature,
    behavior: record.behavior,
    actors: record.actors,
    pages: record.pages,
    dataFields: record.dataFields,
    outcome: record.outcome,
    freshness: record.freshness,
    changedFiles: record.changedFiles,
    reasons: record.reasons,
    nextCheck: record.nextCheck,
    priorFailureCount: record.failedChecks.length + record.findings.length,
    runId: record.evidence.runId,
    revision: record.evidence.revision,
  };
}

export async function buildApplicationMemory({ root, runs, candidate, source, actors = [], signal }) {
  const warnings = [],
    records = [],
    loadedRuns = [];
  const eligible = runs
    .filter(r => r.finishedAt && r.candidate?.source === candidate.source && r.results.some(c => c.id === 'discovery'))
    .slice()
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  let bytes = 0,
    droppedRecords = 0;
  for (const run of eligible.slice(0, memoryLimits.runs)) {
    signal?.throwIfAborted();
    let report;
    try {
      report = await readDiscovery(root, run);
    } catch {
      warnings.push(`Application memory excluded ${run.id}: its report or supporting evidence is invalid.`);
      continue;
    }
    if (!report) continue;
    loadedRuns.push(run.id);
    for (const investigation of report.investigations.slice().reverse()) {
      let record;
      try {
        record = extract(report, run, investigation);
      } catch {
        warnings.push(`Application memory skipped a malformed investigation in ${run.id}.`);
        continue;
      }
      if (!record) continue;
      const size = Buffer.byteLength(JSON.stringify(record));
      if (records.length >= memoryLimits.records || bytes + size > memoryLimits.bytes - 200_000) {
        droppedRecords++;
        continue;
      }
      records.push(record);
      bytes += size;
    }
  }
  const paths = unique(records.flatMap(r => r.sourceDependencies.map(d => d.path)));
  const fingerprints = source?.fingerprints
    ? await source.fingerprints(paths.slice(0, memoryLimits.dependencies), signal)
    : {};
  const latest = new Set();
  for (const record of records) {
    Object.assign(record, assess(record, candidate, fingerprints));
    const key = sameKey(record);
    record.latestForBehavior = !latest.has(key);
    latest.add(key);
  }
  const makeFeatures = () => {
    const features = [];
    for (const id of unique(records.map(r => r.featureId))) {
      const entries = records.filter(r => r.featureId === id),
        current = entries.filter(r => r.latestForBehavior);
      features.push({
        id,
        name: entries[0].feature,
        records: entries.map(r => r.id),
        pages: unique(entries.flatMap(r => r.pages)).slice(0, 30),
        actors: unique(entries.flatMap(r => r.actors)).slice(0, 20),
        sourceFiles: unique(entries.flatMap(r => r.sourceDependencies.map(d => d.path))).slice(0, 40),
        dataFields: unique(entries.flatMap(r => r.dataFields)).slice(0, 30),
        testedActors: unique(current.flatMap(r => r.assertedActors)),
        unexploredActors: actors.map(a => a.id).filter(id => !current.some(r => r.assertedActors.includes(id))),
        needsRevalidation: current.filter(r => r.freshness === 'needs-revalidation').length,
      });
    }
    return features;
  };
  const index = {
    schemaVersion: 1,
    source: candidate.source,
    revision: candidate.revision,
    limits: memoryLimits,
    verifiedRuns: loadedRuns,
    omittedRuns: Math.max(0, eligible.length - memoryLimits.runs),
    omittedRecords: droppedRecords,
    omittedDependencies:
      Math.max(0, paths.length - memoryLimits.dependencies) + records.reduce((n, r) => n + r.omittedDependencies, 0),
    features: makeFeatures(),
    records,
    warnings,
    limitations: [
      'Memory is historical evidence, never a current pass or approval.',
      'Only observed and cited source dependencies are tracked; transitive impact is not established.',
      'Findings are historical hypotheses; current triage is not synchronized.',
      'Unfinished work must restart its prerequisites and checkpoints in a fresh fixture.',
    ],
  };
  while (Buffer.byteLength(JSON.stringify(index)) > memoryLimits.bytes && records.length) {
    records.pop();
    index.omittedRecords++;
    index.features = makeFeatures();
  }
  const selected = ranked(records.filter(r => r.latestForBehavior));
  const overview = {
    features: index.features.length,
    investigations: records.length,
    verifiedRuns: loadedRuns.length,
    featureMap: index.features.slice(0, 10).map(f => ({
      id: f.id,
      name: f.name,
      testedActors: f.testedActors,
      unexploredActors: f.unexploredActors,
      needsRevalidation: f.needsRevalidation,
    })),
    needsRevalidation: selected.filter(r => r.freshness === 'needs-revalidation').length,
    followUps: selected.slice(0, 5).map(r => ({
      id: r.id,
      feature: r.feature,
      behavior: r.behavior,
      outcome: r.outcome,
      freshness: r.freshness,
      changedFiles: r.changedFiles.slice(0, 3),
      nextCheck: r.nextCheck,
    })),
    historicalIssues: ranked(records.filter(r => r.findings.length || r.failedChecks.length))
      .slice(0, 3)
      .map(r => ({ id: r.id, feature: r.feature, outcome: r.outcome, needsReview: true })),
    omissions: { runs: index.omittedRuns, records: index.omittedRecords, dependencies: index.omittedDependencies },
    guidance:
      'Use search_memory/read_memory for evidence. Revisit changed behavior and unfinished work; also explore capabilities outside remembered coverage. Never reuse a historical pass or checkpoint as a current result.',
  };
  const runById = new Map(runs.map(run => [run.id, run]));
  const verify = async record => {
    try {
      signal?.throwIfAborted();
      await readDiscovery(root, runById.get(record.evidence.runId));
    } catch {
      throw new Error(`Memory ${record.id} is unavailable: its retained evidence no longer verifies.`);
    }
  };
  return {
    index,
    overview,
    async act(action) {
      signal?.throwIfAborted();
      if (action.action === 'read_memory') {
        const record = records.find(r => r.id === action.target);
        if (!record) throw new Error('Read a memory ID returned by search_memory.');
        const response = { record: structuredClone(record), limitations: index.limitations };
        if (Buffer.byteLength(JSON.stringify(response)) > memoryLimits.resultBytes)
          throw new Error('Memory record exceeds its retrieval budget. Search summaries remain available.');
        await verify(record);
        return response;
      }
      if (action.action !== 'search_memory') throw new Error('Unsupported application memory action.');
      const offset = Number(action.value || '0');
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new Error('Memory search offset must be a nonnegative integer.');
      const terms = normalized(action.target).split(' ').filter(Boolean).slice(0, 12);
      const matches = ranked(
        records.filter(record => {
          const haystack = normalized(
            [
              record.feature,
              record.behavior,
              record.title,
              record.hypothesis,
              ...record.actors,
              ...record.pages,
              ...record.sourceDependencies.map(d => d.path),
              ...record.dataFields,
              record.outcome,
              record.freshness,
              record.evidence.revision,
            ].join(' '),
          );
          return terms.every(term => haystack.includes(term));
        }),
      );
      const results = [],
        verification = new Map();
      for (const record of matches.slice(offset, offset + memoryLimits.results)) {
        try {
          if (!verification.has(record.evidence.runId)) verification.set(record.evidence.runId, verify(record));
          await verification.get(record.evidence.runId);
        } catch {
          const warning = `Application memory excluded ${record.id} during retrieval: supporting evidence no longer verifies.`;
          if (!warnings.includes(warning)) warnings.push(warning);
          continue;
        }
        const item = summary(record);
        if (Buffer.byteLength(JSON.stringify([...results, item])) > memoryLimits.resultBytes - 1000) break;
        results.push(item);
      }
      return {
        results,
        total: matches.length,
        nextOffset: offset + memoryLimits.results < matches.length ? offset + memoryLimits.results : null,
        guidance: overview.guidance,
      };
    },
  };
}
