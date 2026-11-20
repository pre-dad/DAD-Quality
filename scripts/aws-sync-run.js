#!/usr/bin/env node
// Post-run sync wrapper for the AWS CodeBuild runner (DAD-infra apps/atm).
//
// After `npm run atm -- run` finishes on an ephemeral CodeBuild host, this
// uploads the run directory (run.json, report.html, evidence/*) to the S3
// evidence bucket and reconciles that run's findings into the DynamoDB finding
// ledger with conditional writes so concurrent runs are safe.
//
// It does NOT change ATM's core local .atm/runs/ storage: it reads a finished
// run read-only via src/history.js (collectFindings/readRun) and mirrors the
// result to AWS. The design calls this the "thin post-run wrapper" (v1), kept
// decoupled from a future native cloud backend inside ATM.
//
// Resource names and the env are read from the environment the RunnerStack
// injects — never hardcoded:
//   ATM_EVIDENCE_BUCKET  S3 bucket (atm-evidence-<env>-<account>)
//   ATM_FINDINGS_TABLE   DynamoDB table (atm-findings-<env>)
// The source repo + revision for the S3 key layout come from ATM's own run
// manifest (run.candidate.source = 'github:<repo>', run.candidate.revision =
// <40-hex sha>), matching how ATM already records the validated revision.
//
// ATM_SYNC_DRY_RUN=1 routes through the pure planner functions and prints the
// planned requests without constructing or calling any AWS client, so it can be
// exercised offline (and in the test suite) with no credentials or network.

import path from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { BUNDLE_PATH } from '../src/core.js';
import { collectFindings, readRun } from '../src/history.js';

// Mirrors the reopen rule in src/history.js and src/ci.js mergeFindings. The
// stored disposition lives only in DynamoDB, so the reopen is a conditional write.
const REOPENED = 'reopened';

// The evidence objects every bundle carries, plus each result's declared
// evidence files. Matches src/ci.js evidenceBundle's allow-list exactly.
const truthy = value => value === '1' || value === 'true' || value === 'yes';

export function isDryRun(env = process.env) {
  return truthy(env.ATM_SYNC_DRY_RUN);
}

// github:<owner>/<repo> -> <owner>/<repo>. The ledger PK stores source#<repo>
// (the design's source#<repo>), so the github: transport prefix is stripped.
export function repoFromSource(source) {
  if (typeof source !== 'string') throw new Error('Run candidate.source is required.');
  const match = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(source);
  if (!match) throw new Error(`Unsupported candidate.source '${source}'.`);
  return match[1];
}

export function readConfig(env = process.env) {
  const bucket = env.ATM_EVIDENCE_BUCKET;
  const table = env.ATM_FINDINGS_TABLE;
  if (!bucket) throw new Error('ATM_EVIDENCE_BUCKET is not set.');
  if (!table) throw new Error('ATM_FINDINGS_TABLE is not set.');
  return { bucket, table };
}

// Resolve the files that belong to a run, in the same allow-list order as the
// evidence bundle: the manifest, the report, then each declared evidence file.
function runFiles(run) {
  const names = ['run.json', 'report.html'];
  for (const result of run.results ?? []) {
    for (const item of result.evidence ?? []) {
      if (BUNDLE_PATH.test(item.path) && !names.includes(item.path)) names.push(item.path);
    }
  }
  return names;
}

// Build the S3 PutObject request plan for a run: <repo>/<sha>/<run-id>/<name>.
// Returns descriptors { bucket, key, sourcePath, contentType } without reading
// file bodies, so the planner stays pure and side-effect free for the dry run.
export function planEvidenceUploads(run, { bucket, runRoot }) {
  if (!bucket) throw new Error('A bucket name is required to plan uploads.');
  const repo = repoFromSource(run.candidate?.source);
  const revision = run.candidate?.revision;
  if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw new Error('Run candidate.revision must be a full SHA.');
  const prefix = `${repo}/${revision}/${run.id}`;
  return runFiles(run).map(name => ({
    bucket,
    key: `${prefix}/${name}`,
    // The on-disk location is only used by the live uploader, not the planner's
    // assertions; runRoot defaults to undefined for pure key-layout checks.
    sourcePath: runRoot ? path.join(runRoot, run.id, name) : undefined,
    contentType: contentTypeFor(name),
  }));
}

const CONTENT_TYPES = {
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.png': 'image/png',
};

function contentTypeFor(name) {
  return CONTENT_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

// Build the DynamoDB write plan for a run's findings. One write per finding:
//   - PK = source#<repo>, SK = finding#<id>
//   - create-if-absent: Put with ConditionExpression attribute_not_exists(PK)
//   - existing finding: Update guarded by lastSeen so a concurrent run cannot
//     move it backward; occurrences are added, never overwritten, and triage
//     fields are untouched. A conditional reopen reverts only a stored
//     resolved/dismissed disposition to 'reopened' when the failure recurs.
// The by-status GSI 'status' attribute is written on every item so the
// "unresolved blocking findings for this source" query is serviceable.
export function planLedgerWrites(findings, { table, repo }) {
  if (!table) throw new Error('A table name is required to plan ledger writes.');
  if (!repo) throw new Error('A repo is required to plan ledger writes.');
  const pk = `source#${repo}`;
  return findings.map(finding => {
    const sk = `finding#${finding.id}`;
    const occurrences = Array.isArray(finding.occurrences) ? finding.occurrences.length : 0;
    return {
      findingId: finding.id,
      create: {
        TableName: table,
        Item: {
          PK: pk,
          SK: sk,
          source: finding.source,
          repo,
          check: finding.check,
          title: finding.title,
          kind: finding.kind,
          severity: finding.severity,
          disposition: finding.disposition,
          status: finding.disposition,
          firstSeen: finding.firstSeen,
          lastSeen: finding.lastSeen,
          lastRunId: finding.lastRunId,
          occurrences,
          updatedAt: finding.lastSeen,
        },
        // Only the first run to observe this signature creates the ledger item.
        ConditionExpression: 'attribute_not_exists(PK) AND attribute_not_exists(SK)',
      },
      // Reconcile an already-present finding. The guard keeps a run from moving
      // lastSeen backward, and the update never writes disposition or status:
      // triage transitions (confirm/resolve/dismiss) are owned by operators,
      // never by a worker sync, mirroring src/ci.js publishProposal.
      update: {
        TableName: table,
        Key: { PK: pk, SK: sk },
        UpdateExpression:
          'SET lastSeen = :lastSeen, lastRunId = :lastRunId, updatedAt = :lastSeen ADD occurrences :occurrences',
        ConditionExpression: 'attribute_exists(PK) AND attribute_exists(SK) AND lastSeen < :lastSeen',
        ExpressionAttributeValues: {
          ':lastSeen': finding.lastSeen,
          ':lastRunId': finding.lastRunId,
          ':occurrences': occurrences,
        },
      },
      // Only a recurrence of a closed finding moves its disposition, and only
      // to 'reopened'. The stored disposition decides, so this is conditional
      // and must be applied before the update advances lastSeen.
      reopen: {
        TableName: table,
        Key: { PK: pk, SK: sk },
        UpdateExpression: 'SET disposition = :reopened, #status = :reopened, reopenedAt = :lastSeen',
        ConditionExpression: 'disposition IN (:resolved, :dismissed) AND lastSeen < :lastSeen',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':lastSeen': finding.lastSeen,
          ':reopened': REOPENED,
          ':resolved': 'resolved',
          ':dismissed': 'dismissed',
        },
      },
    };
  });
}

// Compose the full plan for a finished run: read the manifest + findings via the
// read-only history helpers (never mutating .atm/runs/), then build the S3 and
// DynamoDB request plans.
export async function planRun({ runRoot, runId, config }) {
  const run = await readRun(runRoot, runId);
  const repo = repoFromSource(run.candidate?.source);
  const findings = await collectFindings(runRoot, [run]);
  return {
    run,
    repo,
    uploads: planEvidenceUploads(run, { bucket: config.bucket, runRoot }),
    ledgerWrites: planLedgerWrites(findings, { table: config.table, repo }),
  };
}

// Live execution: upload each object, then apply each ledger write (create,
// falling back to the guarded update when the item already exists). SDK clients
// are injected so tests never construct a real client; defaults are created
// lazily only when actually sending.
export async function syncRun({ runRoot, runId, config, clients }) {
  const plan = await planRun({ runRoot, runId, config });
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const { PutCommand, UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  const s3 = clients.s3;
  const ddb = clients.ddb;
  for (const upload of plan.uploads) {
    const body = await readFile(upload.sourcePath);
    await s3.send(
      new PutObjectCommand({ Bucket: upload.bucket, Key: upload.key, Body: body, ContentType: upload.contentType }),
    );
  }
  for (const write of plan.ledgerWrites) {
    try {
      await ddb.send(new PutCommand(write.create));
    } catch (error) {
      if (error?.name !== 'ConditionalCheckFailedException') throw error;
      // The finding already exists; reconcile it. A failed guard is benign:
      // either another run advanced lastSeen first and recorded the same
      // recurrence, or the finding was not closed.
      for (const request of [write.reopen, write.update]) {
        try {
          await ddb.send(new UpdateCommand(request));
        } catch (updateError) {
          if (updateError?.name !== 'ConditionalCheckFailedException') throw updateError;
        }
      }
    }
  }
  return plan;
}

async function buildClients() {
  const { S3Client } = await import('@aws-sdk/client-s3');
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient } = await import('@aws-sdk/lib-dynamodb');
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-2';
  return {
    s3: new S3Client({ region }),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({ region })),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'run-root': { type: 'string' },
      'run-id': { type: 'string' },
    },
  });
  const runRoot = values['run-root'] ?? process.env.ATM_RUN_ROOT;
  const runId = values['run-id'] ?? process.env.ATM_RUN_ID;
  if (!runRoot || !runId) throw new Error('Provide --run-root and --run-id (or ATM_RUN_ROOT / ATM_RUN_ID).');
  if (!(await lstat(runRoot)).isDirectory()) throw new Error('Run root must be a directory.');
  const config = readConfig();
  if (isDryRun()) {
    const plan = await planRun({ runRoot, runId, config });
    process.stdout.write(
      `${JSON.stringify(
        {
          dryRun: true,
          bucket: config.bucket,
          table: config.table,
          uploads: plan.uploads,
          ledgerWrites: plan.ledgerWrites,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const plan = await syncRun({ runRoot, runId, config, clients: await buildClients() });
  process.stdout.write(`Synced ${plan.uploads.length} object(s) and ${plan.ledgerWrites.length} finding(s).\n`);
}

// Only run as a CLI; importing the module (tests) must have no side effects.
// Resolve argv[1] through pathToFileURL so the comparison holds for paths with
// spaces or other characters that a bare `file://` prefix would not encode,
// matching the entrypoint guard in src/cli.js.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
