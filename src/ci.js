import path from 'node:path';
import { readFile, mkdir, writeFile, lstat } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, publicEncrypt, privateDecrypt, randomBytes, constants } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { BUNDLE_PATH, digest, verifyEvidence } from './core.js';
import { collectFindings, RUN_ID } from './history.js';
import { evaluateRelease } from './release.js';
import { hashPolicy } from './policy.js';

const sha = /^[a-f0-9]{40}$/;
const hash = /^[a-f0-9]{64}$/;
const sourcePattern = /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const earlier = (a, b) => Date.parse(a) < Date.parse(b);
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const fail = message => {
  throw new Error(message);
};
const fields = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !names.includes(k)))
    fail('Unexpected CI state fields.');
};

export function emptyLedger(source) {
  if (!sourcePattern.test(source)) fail('Invalid repository identity.');
  return { schemaVersion: 1, source, sequence: 0, findings: [], receipts: [] };
}

export function validateLedger(ledger, source) {
  fields(ledger, ['schemaVersion', 'source', 'sequence', 'findings', 'receipts']);
  if (
    ledger.schemaVersion !== 1 ||
    ledger.source !== source ||
    !sourcePattern.test(source) ||
    !Number.isSafeInteger(ledger.sequence) ||
    ledger.sequence < 0 ||
    !Array.isArray(ledger.findings) ||
    !Array.isArray(ledger.receipts) ||
    ledger.sequence !== ledger.receipts.length
  )
    fail('Invalid or missing CI ledger.');
  const ids = new Set();
  for (const f of ledger.findings) {
    fields(f, [
      'id',
      'source',
      'check',
      'severity',
      'disposition',
      'firstSeen',
      'lastSeen',
      'lastRunId',
      'occurrences',
      'updatedAt',
      'audit',
    ]);
    if (
      !/^[a-f0-9]{24}$/.test(f.id) ||
      ids.has(f.id) ||
      f.source !== source ||
      !/^[a-z-]+$/.test(f.check) ||
      !['unassessed', 'low', 'medium', 'high', 'critical'].includes(f.severity) ||
      !['untriaged', 'confirmed', 'resolved', 'dismissed', 'reopened'].includes(f.disposition) ||
      !date(f.firstSeen) ||
      !date(f.lastSeen) ||
      !RUN_ID.test(f.lastRunId) ||
      !Number.isSafeInteger(f.occurrences) ||
      f.occurrences < 1 ||
      !Array.isArray(f.audit)
    )
      fail('Invalid CI finding.');
    if (f.updatedAt !== undefined && !date(f.updatedAt)) fail('Invalid triage timestamp.');
    if (['resolved', 'dismissed'].includes(f.disposition) && (!f.updatedAt || !f.audit.length))
      fail('Finding closure requires an audit record.');
    for (const a of f.audit) {
      fields(a, ['at', 'actor', 'disposition', 'severity', 'noteDigest']);
      if (
        !date(a.at) ||
        !/^[A-Za-z0-9_.@-]{1,100}$/.test(a.actor) ||
        !['untriaged', 'confirmed', 'resolved', 'dismissed'].includes(a.disposition) ||
        !['unassessed', 'low', 'medium', 'high', 'critical'].includes(a.severity) ||
        !hash.test(a.noteDigest)
      )
        fail('Invalid triage audit.');
    }
    ids.add(f.id);
  }
  const executions = new Set();
  for (const r of ledger.receipts) {
    fields(r, ['execution', 'runId', 'revision', 'bundleSha256', 'artifactId', 'artifactDigest', 'eligible']);
    if (
      !/^\d+:\d+$/.test(r.execution) ||
      executions.has(r.execution) ||
      !RUN_ID.test(r.runId) ||
      !sha.test(r.revision) ||
      !hash.test(r.bundleSha256) ||
      !/^\d+$/.test(r.artifactId) ||
      !hash.test(r.artifactDigest) ||
      typeof r.eligible !== 'boolean'
    )
      fail('Invalid publication receipt.');
    executions.add(r.execution);
  }
  return ledger;
}

export function mergeFindings(ledger, incoming) {
  const next = structuredClone(ledger);
  for (const f of incoming) {
    const existing = next.findings.find(item => item.id === f.id);
    if (!existing) {
      next.findings.push({
        id: f.id,
        source: f.source,
        check: f.check,
        severity: 'unassessed',
        disposition: 'untriaged',
        firstSeen: f.firstSeen,
        lastSeen: f.lastSeen,
        lastRunId: f.lastRunId,
        occurrences: 1,
        audit: [],
      });
    } else if (existing.lastRunId !== f.lastRunId) {
      if (earlier(f.lastSeen, existing.lastSeen)) fail('Out-of-order finding observation.');
      Object.assign(existing, { lastSeen: f.lastSeen, lastRunId: f.lastRunId, occurrences: existing.occurrences + 1 });
      // Both dismissal and resolution must be reviewed if the failure recurs.
      if (['resolved', 'dismissed'].includes(existing.disposition)) existing.disposition = 'reopened';
    }
  }
  return validateLedger(next, ledger.source);
}

// Upload only the manifest, report and declared evidence, never the source tree,
// compose configuration, database volumes, encryption key or other run files.
async function evidenceBundle(run, publicKey) {
  const issues = await verifyEvidence(run.dir, run.data);
  if (!(await lstat(path.join(run.dir, 'evidence'))).isDirectory())
    fail('Evidence directory must not be a symbolic link.');
  const files = {};
  const names = [
    'run.json',
    'report.html',
    ...new Set(run.data.results.flatMap(r => (r.evidence ?? []).map(e => e.path))),
  ];
  let total = 0;
  for (const name of names) {
    if (!BUNDLE_PATH.test(name)) fail('Unsafe bundle path.');
    try {
      const stat = await lstat(path.join(run.dir, name));
      if (!stat.isFile()) fail('Bundle file is not regular.');
      total += stat.size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (total > MAX_BUNDLE_BYTES) fail('Evidence bundle is too large.');
  for (const name of names) {
    const file = path.join(run.dir, name);
    try {
      files[name] = (await readFile(file)).toString('base64');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      issues.push(`Missing bundle file: ${name}`);
    }
  }
  const plaintext = gzipSync(JSON.stringify({ schemaVersion: 1, files, issues }));
  const key = randomBytes(32),
    iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const wrapped = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return {
    bytes: Buffer.from(
      JSON.stringify({
        version: 1,
        key: wrapped.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: encrypted.toString('base64'),
      }),
    ),
    issues,
  };
}

export function decryptBundle(bytes, privateKey) {
  const envelope = JSON.parse(bytes);
  if (envelope.version !== 1) fail('Unsupported evidence envelope.');
  const key = privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(envelope.key, 'base64'),
  );
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]);
  const bundle = JSON.parse(gunzipSync(plaintext, { maxOutputLength: 512 * 1024 * 1024 }).toString('utf8'));
  if (bundle.schemaVersion !== 1 || !bundle.files || Object.keys(bundle.files).some(name => !BUNDLE_PATH.test(name)))
    fail('Unsafe evidence bundle.');
  return bundle;
}

export async function prepareProposal({ run, ledger, publicKey, execution }) {
  validateLedger(ledger, run.data.candidate?.source ?? ledger.source);
  if (!/^\d+:\d+$/.test(execution)) fail('Invalid GitHub execution.');
  const findings = await collectFindings(path.dirname(run.dir), [run.data]);
  const next = mergeFindings(ledger, findings);
  const bundle = await evidenceBundle(run, publicKey);
  const assessment = evaluateRelease(run.data, { findings: next.findings, evidenceIssues: bundle.issues });
  // This public proposal deliberately contains no error text or browser data.
  const proposal = {
    schemaVersion: 1,
    source: ledger.source,
    baseDigest: hashPolicy(ledger),
    execution,
    runId: run.data.id,
    revision: run.data.candidate?.revision ?? run.data.options.revision,
    bundleSha256: digest(bundle.bytes),
    findings: next.findings,
    eligible: assessment.eligible,
    checks: run.data.results.map(r => ({ id: r.id, status: r.status })),
    policyDigest: run.data.policy.digest,
  };
  return { proposal, bundle: bundle.bytes, assessment };
}

// A single run adds at most one observation: counts and lastRunId move together.
function observedOnce(prior, current, runId) {
  if (current.occurrences === prior.occurrences) return current.lastRunId === prior.lastRunId;
  return current.occurrences === prior.occurrences + 1 && current.lastRunId === runId;
}

export function publishProposal({
  ledger,
  proposal,
  source,
  execution,
  revision,
  artifactId,
  artifactDigest,
  bundle,
  now = Date.now(),
}) {
  validateLedger(ledger, source);
  fields(proposal, [
    'schemaVersion',
    'source',
    'baseDigest',
    'execution',
    'runId',
    'revision',
    'bundleSha256',
    'findings',
    'eligible',
    'checks',
    'policyDigest',
  ]);
  if (
    proposal.schemaVersion !== 1 ||
    proposal.source !== source ||
    proposal.baseDigest !== hashPolicy(ledger) ||
    proposal.execution !== execution ||
    !/^\d+:\d+$/.test(execution) ||
    proposal.revision !== revision ||
    !sha.test(revision) ||
    !RUN_ID.test(proposal.runId) ||
    !hash.test(proposal.bundleSha256) ||
    digest(bundle) !== proposal.bundleSha256 ||
    !hash.test(proposal.policyDigest) ||
    typeof proposal.eligible !== 'boolean' ||
    !Array.isArray(proposal.checks) ||
    proposal.checks.some(
      c =>
        !c ||
        typeof c !== 'object' ||
        !/^[a-z-]+$/.test(c.id) ||
        !['passed', 'failed', 'inconclusive', 'canceled'].includes(c.status),
    )
  )
    fail('Candidate, evidence or ledger binding mismatch.');
  if (ledger.receipts.some(r => r.execution === execution)) fail('Execution already published.');
  const next = {
    ...structuredClone(ledger),
    findings: proposal.findings,
    sequence: ledger.sequence + 1,
    receipts: [
      ...ledger.receipts,
      {
        execution,
        runId: proposal.runId,
        revision,
        bundleSha256: proposal.bundleSha256,
        artifactId,
        artifactDigest,
        eligible: proposal.eligible,
      },
    ],
  };
  validateLedger(next, source);
  // A worker may observe failures but cannot remove findings or change triage.
  for (const prior of ledger.findings) {
    const current = next.findings.find(f => f.id === prior.id);
    if (
      !current ||
      current.severity !== prior.severity ||
      hashPolicy(current.audit) !== hashPolicy(prior.audit) ||
      current.updatedAt !== prior.updatedAt ||
      current.firstSeen !== prior.firstSeen ||
      current.check !== prior.check ||
      earlier(current.lastSeen, prior.lastSeen) ||
      !observedOnce(prior, current, proposal.runId) ||
      (current.disposition !== prior.disposition &&
        !(['resolved', 'dismissed'].includes(prior.disposition) && current.disposition === 'reopened'))
    )
      fail('Worker cannot discard or triage historical findings.');
  }
  for (const f of next.findings.filter(f => !ledger.findings.some(p => p.id === f.id))) {
    if (f.severity !== 'unassessed' || f.disposition !== 'untriaged' || f.audit.length)
      fail('New findings must be unassessed.');
    if (f.occurrences !== 1 || f.lastRunId !== proposal.runId) fail('Worker cannot misreport finding history.');
  }
  if (next.findings.some(f => Date.parse(f.lastSeen) > now)) fail('Finding observed in the future.');
  if (
    proposal.eligible &&
    next.findings.some(
      f =>
        !['resolved', 'dismissed'].includes(f.disposition) && ['unassessed', 'high', 'critical'].includes(f.severity),
    )
  )
    fail('Open findings contradict eligible proposal.');
  return next;
}

export async function extractBundle(bytes, privateKey, output) {
  const bundle = decryptBundle(bytes, privateKey);
  // A new directory prevents extraction through preexisting symbolic links.
  await mkdir(output, { mode: 0o700 });
  await mkdir(path.join(output, 'evidence'), { mode: 0o700 });
  for (const [name, data] of Object.entries(bundle.files))
    await writeFile(path.join(output, name), Buffer.from(data, 'base64'), { mode: 0o600, flag: 'wx' });
  return bundle.issues;
}
