# AWS runner — post-run sync

> **Held: not deployed.** DAD-Main's ATM gate (`atm.yml`) and its Worker ledger are the
> single source of truth for findings, and that ledger accepts only receipts bound to a
> GitHub Actions run, which a CodeBuild run cannot produce. The runner and this sync stay
> built and tested for a future need GitHub-hosted runs cannot meet; until then nothing
> starts it. See DAD-Docs ADR 0006.

ATM runs on AWS CodeBuild (DAD-infra `apps/atm`) as an ephemeral, batch-style
acceptance runner. The CodeBuild host runs ATM unchanged against a pinned
DAD-Main revision, then a post-run step mirrors the finished run to durable
storage. This document covers that post-run sync: the environment it reads, what
it uploads, and how it reconciles findings.

ATM's core local storage (`.atm/runs/`) is **not** changed. The sync reads a
finished run read-only (`src/history.js`) and copies the result to S3 and
DynamoDB. This is the v1 "thin post-run wrapper" from the infra design; a native
cloud backend inside ATM is a later increment.

## Pieces

- `buildspec.atm.yml` — the CodeBuild buildspec. Clones DAD-Main at the
  revision passed to `StartBuild` (a revision is required), runs `npm run atm -- run`,
  captures ATM's exit code, runs the sync, then exits with ATM's code so CodeBuild and
  any caller gate on ATM's
  contract (`0`/`1`/`2`/`3`/`130`). A failing sync is logged and never changes that exit code.
- `scripts/aws-sync-run.js` — the sync (`npm run aws:sync`). Uploads evidence to
  S3 and reconciles findings into DynamoDB with conditional writes.

## Environment variables (injected by the RunnerStack)

| Variable | Set by | Purpose |
| --- | --- | --- |
| `ATM_EVIDENCE_BUCKET` | RunnerStack | S3 bucket, `atm-evidence-<env>-<account>`. |
| `ATM_FINDINGS_TABLE` | RunnerStack | DynamoDB table, `atm-findings-<env>`. |
| `ATM_ENV` | RunnerStack | `staging` or `production` (informational). |
| `GITHUB_APP_TOKEN` | optional, per `StartBuild` call | Token for the clone; empty clones anonymously (DAD-Main is public). |
| `SOURCE_VERSION` / `CODEBUILD_RESOLVED_SOURCE_VERSION` | StartBuild | Revision to validate. |
| `ATM_RUN_ROOT` / `ATM_RUN_ID` | buildspec | Run directory to sync (or pass `--run-root` / `--run-id`). |
| `ATM_SYNC_DRY_RUN` | operator | `1` prints the plan and makes no AWS calls. |

Resource names are never hardcoded — the script reads them from the environment
so the same code works against staging and production. The source repo and
revision for the S3 key layout come from ATM's own run manifest
(`run.candidate.source` = `github:<repo>`, `run.candidate.revision` = the SHA),
so the thing uploaded is keyed by the exact revision ATM validated.

## What gets uploaded to S3

Each run's manifest, report, and declared evidence files are uploaded under:

```
s3://<ATM_EVIDENCE_BUCKET>/<repo>/<revision>/<run-id>/run.json
s3://<ATM_EVIDENCE_BUCKET>/<repo>/<revision>/<run-id>/report.html
s3://<ATM_EVIDENCE_BUCKET>/<repo>/<revision>/<run-id>/evidence/<file>
```

- `<repo>` is `run.candidate.source` with the `github:` prefix stripped
  (e.g. `pre-dad/DAD-Main`).
- `<revision>` is the full 40-hex SHA.
- `<run-id>` matches ATM's run id, `atm-<14 digits>-<8 hex>`.

Only the allow-listed files are uploaded (`run.json`, `report.html`, and each
`evidence/<name>` referenced in the manifest) — never the source tree, compose
config, database volumes, or keys. This matches the evidence-bundle allow-list in
`src/ci.js`.

## How findings reconcile into DynamoDB

Findings come from `collectFindings` (the same grouping ATM uses locally):
grouped by `(source repo, check, normalized error signature)` into a 24-char id.
Each finding becomes one ledger item:

- **PK** = `source#<repo>`, **SK** = `finding#<id>`.
- **Create-if-absent.** A `PutItem` with
  `ConditionExpression: attribute_not_exists(PK) AND attribute_not_exists(SK)`.
  Only the first run to observe a signature creates the item.
- **Reconcile an existing finding.** If the create's condition fails, an
  `UpdateItem` runs, guarded by `attribute_exists(PK) ... AND lastSeen < :lastSeen`
  so a concurrent run cannot move `lastSeen` backward or clobber a newer
  observation. A lost-update race is benign (the other run recorded the same
  recurrence), so a failed guard is swallowed.
- **Reopen on recurrence.** When a finding that was `resolved` or `dismissed`
  recurs, `collectFindings` reports it as `reopened`; the update then sets
  `disposition`/`status` to `reopened` and stamps `reopenedAt`. This mirrors the
  reopen rule in `src/history.js` and `src/ci.js`.
- **Triage stays with operators.** The worker sync never confirms, resolves, or
  dismisses a finding — those transitions are made out of band, exactly as
  `src/ci.js publishProposal` enforces for the GitHub gate.

Every item carries a `status` attribute (the finding's disposition) so the
`by-status` GSI serves the "unresolved blocking findings for this source" query.

## Concurrency

Commit-triggered runs can finish near-simultaneously. DynamoDB conditional writes
give safe optimistic concurrency: create-if-absent prevents duplicate creation,
and the `lastSeen` guard serializes updates without a lock. ATM's local
single-writer filesystem lock does not translate to ephemeral runners, which is
why the ledger lives in DynamoDB.

## Dry run

`ATM_SYNC_DRY_RUN=1 npm run aws:sync -- --run-root <dir> --run-id <id>` prints the
planned S3 objects and DynamoDB writes as JSON and makes no AWS call. The planner
functions (`planEvidenceUploads`, `planLedgerWrites`, `planRun`) are pure and are
what the test suite asserts against, so the key layout and conditional-write
expressions are verified offline.
