import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { digest, verifyEvidence } from './core.js';

export async function readDiscovery(root, run) {
  const check = run.results.find(r => r.id === 'discovery');
  if (!check) return null;
  const items = check.evidence.filter(e => e.path === 'evidence/discovery.json');
  if (!items.length && !check.finishedAt) return null;
  if (items.length !== 1) throw new Error('Discovery report is missing or duplicated.');
  const directory = path.join(root, run.id, 'evidence'),
    file = path.join(directory, 'discovery.json');
  if (!(await lstat(directory)).isDirectory()) throw new Error('Invalid discovery evidence directory.');
  const info = await lstat(file);
  if (!info.isFile() || info.size > 8_000_000) throw new Error('Invalid discovery evidence file.');
  const bytes = await readFile(file);
  if (digest(bytes) !== items[0].sha256 || bytes.length !== items[0].bytes)
    throw new Error('Discovery evidence changed.');
  const issues = await verifyEvidence(path.join(root, run.id), { results: [check] });
  if (issues.length) throw new Error(`Discovery supporting evidence is invalid: ${issues.join('; ')}`);
  const report = JSON.parse(bytes.toString('utf8'));
  if (
    report.version !== 1 ||
    report.runId !== run.id ||
    report.revision !== run.candidate?.revision ||
    report.source !== run.candidate?.source ||
    !['running', 'completed', 'budget-exhausted', 'inconclusive', 'canceled'].includes(report.status)
  )
    throw new Error('Invalid discovery report identity.');
  for (const field of ['findings', 'investigations', 'observations', 'events', 'pages', 'memory'])
    if (!Array.isArray(report[field])) throw new Error('Invalid discovery report structure.');
  return report;
}

export async function discoveryDetail(root, run) {
  try {
    return { report: await readDiscovery(root, run), error: null };
  } catch (error) {
    return { report: null, error: error.message };
  }
}

export async function discoveryMemory(root, runs, candidate) {
  const memory = [],
    warnings = [];
  for (const prior of runs
    .filter(r => r.finishedAt && r.candidate?.source === candidate.source && r.results.some(c => c.id === 'discovery'))
    .slice(0, 5)) {
    try {
      const report = await readDiscovery(root, prior);
      if (!report) continue;
      memory.push({
        runId: prior.id,
        revision: prior.candidate.revision,
        status: report.status,
        pages: report.pages.slice(0, 25).map(p => ({ path: p.path, title: p.title, visitedBy: p.visitedBy })),
        investigations: report.investigations.slice(-5).map(i => ({
          title: i.title,
          hypothesis: i.hypothesis.slice(0, 400),
          plan: i.plan,
          conclusion: i.conclusion,
        })),
        findings: report.findings
          .slice(0, 5)
          .map(f => ({ title: f.title, path: f.path, status: f.status, expectation: f.expectation, text: f.text })),
        summary: report.summary?.slice(0, 600),
        unfinished: report.coverage?.experiments.filter(e => ['unfinished', 'blocked'].includes(e.status)).slice(0, 8),
      });
      // Bound carried memory without silently truncating a JSON record.
      if (JSON.stringify(memory).length > 12_000) {
        memory.pop();
        break;
      }
    } catch {
      warnings.push(`Prior discovery ${prior.id} has invalid evidence and was excluded from memory.`);
    }
  }
  return { memory, warnings };
}
