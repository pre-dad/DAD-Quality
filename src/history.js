import { readdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { digest, evaluate, redact } from './core.js';
import { readDiscovery } from './discovery-report.js';

export const RUN_ID = /^atm-\d{14}-[a-f0-9]{8}$/;
const statuses = new Set(['passed', 'failed', 'inconclusive', 'canceled']);
const notFound = message => Object.assign(new Error(message), { status: 404 });

export async function readRun(root, id) {
  if (!RUN_ID.test(id)) throw notFound('Invalid run ID.');
  const directory = path.join(root, id);
  if (!(await lstat(directory)).isDirectory()) throw notFound('Invalid run directory.');
  const file = path.join(directory, 'run.json');
  if (!(await lstat(file)).isFile()) throw new Error('Invalid manifest.');
  const run = JSON.parse(await readFile(file, 'utf8'));
  if (run.id !== id || !Array.isArray(run.required) || !Array.isArray(run.results) || !run.startedAt)
    throw notFound('Invalid run manifest.');
  run.decision = run.canceledAt
    ? { status: 'canceled', eligible: false, reasons: ['Run canceled.'] }
    : evaluate(run.required, run.results);
  return run;
}

export async function listRuns(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { runs: [], warnings: [] };
    throw error;
  }
  const runs = [],
    warnings = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_ID.test(entry.name)) continue;
    try {
      runs.push(await readRun(root, entry.name));
    } catch {
      warnings.push(`Could not read ${entry.name}; its evidence has not been discarded.`);
    }
  }
  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return { runs, warnings };
}

export function summarize(run, activeId) {
  return {
    id: run.id,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    revision: run.candidate?.revision ?? run.options?.revision ?? 'unresolved',
    status: run.finishedAt ? run.decision.status : run.id === activeId ? 'running' : 'incomplete',
    passed: run.results.filter(r => run.required.includes(r.id) && r.status === 'passed' && r.finishedAt).length,
    total: run.required.length,
    trigger: run.options?.trigger ?? 'cli',
    currentCheck: run.results.find(r => !r.finishedAt && r.startedAt)?.id,
    mode: run.options?.mode ?? 'validation',
    durationMs: Math.max(0, Date.parse(run.finishedAt ?? new Date().toISOString()) - Date.parse(run.startedAt)),
  };
}

export function compareRuns(current, baseline) {
  if (!baseline) return null;
  const previous = new Map(baseline.results.map(r => [r.id, r.status]));
  return {
    baselineId: baseline.id,
    revision: baseline.candidate?.revision,
    changes: current.results.flatMap(result => {
      const before = previous.get(result.id) ?? 'not-run';
      if (before === result.status) return [];
      return [{ check: result.id, before, after: result.status, improved: result.status === 'passed' }];
    }),
    removed: baseline.results.filter(r => !current.results.some(c => c.id === r.id)).map(r => r.id),
  };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI color codes begin with ESC.
const stripANSI = value => value.replace(/\x1b\[[0-9;]*m/g, '');
export function normalizeFailure(value) {
  return redact(stripANSI(value))
    .replace(/atm-\d{14}-[a-f0-9]{8}/g, '<run>')
    .replace(/https?:\/\/(?:localhost|127\.0\.0\.1|staff\.localhost):\d+/g, 'http://local')
    .replace(/\(\d+(?:\.\d+)?s\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

function failureSignatures(result, logs) {
  const text = stripANSI(logs);
  const named = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^--- FAIL: |^FAIL\s+\S+.*>|^×\s+/.test(line));
  return [...new Set((named.length ? named : [result.summary]).map(normalizeFailure))].slice(0, 30);
}

export async function collectFindings(root, runs, triage = {}) {
  const groups = new Map();
  // Only completed checks produce findings; in-progress results start inconclusive.
  for (const run of [...runs].reverse()) {
    for (const result of run.results) {
      if (result.id === 'discovery') {
        try {
          const report = await readDiscovery(root, run);
          for (const item of report?.findings ?? []) {
            const id = digest(`${run.candidate?.source}\ndiscovery\n${item.id}`).slice(0, 24);
            const finding = groups.get(id) ?? {
              id,
              source: run.candidate?.source,
              check: 'discovery',
              title: item.title,
              kind: 'Agent hypothesis',
              firstSeen: run.startedAt,
              occurrences: [],
              severity: 'unassessed',
              disposition: 'untriaged',
              note: '',
              audit: [],
            };
            Object.assign(finding, { lastSeen: run.startedAt, lastRunId: run.id, discovery: item });
            finding.occurrences.push({
              runId: run.id,
              revision: run.candidate?.revision,
              status: item.status,
              summary: item.basis,
              evidence: result.evidence,
              finishedAt: result.finishedAt,
            });
            groups.set(id, finding);
          }
        } catch {
          /* Invalid reports are surfaced by run detail/integrity, never trusted as findings. */
        }
        continue;
      }
      // Infrastructure failures in an exploration are execution diagnostics, not
      // automatically discovered product defects or acceptance blockers.
      if (run.options?.mode === 'exploration') continue;
      // Advisory performance is measurement only, including execution issues.
      // It must not indirectly become a blocker via unassessed findings.
      if (result.id === 'performance' && !run.required.includes('performance')) continue;
      if (!result.finishedAt || !['failed', 'inconclusive'].includes(result.status)) continue;
      let logs = '';
      const evidence = (result.evidence ?? []).filter(e => /^evidence\/[A-Za-z0-9_.-]+\.log$/.test(e.path));
      for (const item of evidence.slice(0, 3)) {
        try {
          if (!(await lstat(path.join(root, run.id, 'evidence'))).isDirectory()) continue;
          const file = path.join(root, run.id, item.path);
          const metadata = await lstat(file);
          if (metadata.isFile() && metadata.size < 8_000_000) logs += (await readFile(file, 'utf8')).slice(-24_000);
        } catch {
          /* Missing evidence is reported by integrity verification. */
        }
      }
      for (const signature of failureSignatures(result, logs)) {
        const id = digest(`${run.candidate?.source ?? 'impactgraph'}\n${result.id}\n${signature}`).slice(0, 24);
        let finding = groups.get(id);
        if (!finding) {
          finding = {
            id,
            source: run.candidate?.source,
            check: result.id,
            title: signature,
            kind: result.status === 'failed' ? 'Check failure' : 'Execution issue',
            firstSeen: run.startedAt,
            occurrences: [],
            severity: 'unassessed',
            disposition: 'untriaged',
            note: '',
            audit: [],
          };
          groups.set(id, finding);
        }
        finding.lastSeen = run.startedAt;
        finding.lastRunId = run.id;
        finding.occurrences.push({
          runId: run.id,
          revision: run.candidate?.revision,
          status: result.status,
          summary: result.summary,
          evidence: result.evidence ?? [],
          finishedAt: result.finishedAt,
        });
      }
    }
  }
  for (const finding of groups.values()) {
    const saved = triage[finding.id];
    if (saved) Object.assign(finding, saved);
    // A run can start before triage and finish with a new failure afterwards.
    if (
      ['resolved', 'dismissed'].includes(finding.disposition) &&
      finding.occurrences.some(o => (o.finishedAt ?? finding.lastSeen) > (finding.updatedAt ?? ''))
    )
      finding.disposition = 'reopened';
    const lastRun = runs.find(r => r.id === finding.lastRunId);
    const later = runs.filter(
      r =>
        r.startedAt > finding.lastSeen &&
        r.candidate?.source === lastRun?.candidate?.source &&
        r.finishedAt &&
        statuses.has(r.decision.status),
    );
    const latestComparable = later.find(r => r.results.some(c => c.id === finding.check && c.finishedAt));
    finding.latestCheckPassed =
      finding.check !== 'discovery' && latestComparable?.results.find(c => c.id === finding.check)?.status === 'passed';
  }
  return [...groups.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}
