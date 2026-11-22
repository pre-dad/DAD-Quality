#!/usr/bin/env node
import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { generateKeyPairSync } from 'node:crypto';
import { emptyLedger, validateLedger, prepareProposal, publishProposal, extractBundle } from '../src/ci.js';
import { atomicJSON, digest } from '../src/core.js';

process.umask(0o077);
let v, action;
try {
  ({
    values: v,
    positionals: [action],
  } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(
      [
        'repo',
        'revision',
        'source',
        'state',
        'output',
        'public-key',
        'private-key',
        'execution',
        'proposal',
        'bundle',
        'artifact-id',
        'artifact-digest',
        'finding',
        'severity',
        'disposition',
        'actor',
        'note-file',
      ].map(k => [k, { type: 'string' }]),
    ),
  }));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
const required = {
  init: ['state', 'source'],
  keygen: ['private-key', 'public-key'],
  run: ['repo', 'revision', 'source', 'state', 'public-key', 'output', 'execution'],
  publish: [
    'state',
    'proposal',
    'source',
    'execution',
    'revision',
    'artifact-id',
    'artifact-digest',
    'bundle',
    'output',
  ],
  triage: ['state', 'source', 'finding', 'note-file', 'severity', 'disposition', 'actor'],
  decrypt: ['bundle', 'private-key', 'output'],
};
const json = async file => JSON.parse(await readFile(file, 'utf8'));
try {
  const missing = (required[action] ?? []).filter(name => v[name] === undefined);
  if (missing.length) throw new Error(`Missing required option(s): ${missing.map(name => `--${name}`).join(', ')}.`);
  if (action === 'init') {
    // Explicit bootstrap only: normal execution never creates missing history.
    await writeFile(v.state, `${JSON.stringify(emptyLedger(v.source), null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } else if (action === 'keygen') {
    const keys = generateKeyPairSync('rsa', {
      modulusLength: 3072,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    await writeFile(v['private-key'], keys.privateKey, { mode: 0o600, flag: 'wx' });
    await writeFile(v['public-key'], keys.publicKey, { mode: 0o600, flag: 'wx' });
  } else if (action === 'run') {
    const { executeRun } = await import('../src/runner.js');
    if (!/^[a-f0-9]{40}$/.test(v.revision ?? '')) throw new Error('A full candidate SHA is required.');
    const ledger = validateLedger(await json(v.state), v.source);
    const publicKey = await readFile(v['public-key']);
    await mkdir(v.output, { recursive: true, mode: 0o700 });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
    let run;
    try {
      run = await executeRun({
        repo: v.repo,
        revision: v.revision,
        sourceIdentity: v.source,
        output: path.join(v.output, 'runs'),
        trigger: `github:${v.execution}`,
        signal: controller.signal,
      });
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    }
    const result = await prepareProposal({ run, ledger, publicKey, execution: v.execution });
    await writeFile(path.join(v.output, 'evidence.atm'), result.bundle, { mode: 0o600 });
    await atomicJSON(path.join(v.output, 'proposal.json'), result.proposal);
    // A blocked validation must still publish its evidence and new findings.
    // Only the final gate converts the persisted verdict to a GitHub exit code.
  } else if (action === 'publish') {
    const ledger = publishProposal({
      ledger: await json(v.state),
      proposal: await json(v.proposal),
      source: v.source,
      execution: v.execution,
      revision: v.revision,
      artifactId: v['artifact-id'],
      artifactDigest: v['artifact-digest'],
      bundle: await readFile(v.bundle),
    });
    await atomicJSON(v.state, ledger);
    await writeFile(v.output, ledger.receipts.at(-1).eligible ? 'eligible\n' : 'blocked\n', { mode: 0o600 });
  } else if (action === 'triage') {
    const ledger = validateLedger(await json(v.state), v.source);
    const finding = ledger.findings.find(f => f.id === v.finding);
    const note = (await readFile(v['note-file'], 'utf8')).trim();
    if (!finding || note.length < 10) throw new Error('Finding and a meaningful private audit note are required.');
    const at = new Date().toISOString();
    Object.assign(finding, { severity: v.severity, disposition: v.disposition, updatedAt: at });
    finding.audit.push({
      at,
      actor: v.actor,
      disposition: v.disposition,
      severity: v.severity,
      noteDigest: digest(note),
    });
    validateLedger(ledger, v.source);
    await atomicJSON(v.state, ledger);
  } else if (action === 'decrypt') {
    const issues = await extractBundle(await readFile(v.bundle), await readFile(v['private-key']), v.output);
    console.log(`Evidence extracted. Integrity issues captured: ${issues.length}`);
  } else throw new Error('Use init, keygen, run, publish, triage or decrypt. See docs/github-gate.md.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
