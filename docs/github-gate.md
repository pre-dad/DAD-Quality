# GitHub acceptance gate

ATM can validate trusted DAD candidates in GitHub Actions. The integration
implements a **local acceptance gate** on an ephemeral runner. It does not deploy
staging or production, exercise live integrations, run the optional AI provider,
or replace existing CI, security, performance or deployment requirements.

The DAD-Main installation uses the durable Worker ledger described in
[its operations guide](https://github.com/pre-dad/DAD-Main/blob/dev/docs/atm-ledger.md).
That guide and DAD-Main's checked-in workflow are authoritative for that installation.
The Git-backed workflow template below remains supported for other installations;
do not use its initialization or publication steps to replace DAD-Main's ledger.
Its existing archive and evidence-key filenames retain `impactgraph` for compatibility.

## Branch protection

**ATM acceptance** is not a required status check on DAD-Main's `dev` branch: the
workflow runs and reports results, but does not block merging. Making it required
is a deliberate owner decision; when it is made, add the check while preserving
existing protections, then verify that a failing ATM result blocks merging.

## Installation

1. Publish the ATM revision containing this integration. Copy
   `integrations/github/impactgraph.yml` into the target repository's
   `.github/workflows/atm.yml`. Replace **both** `ATM_COMMIT_SHA` placeholders with
   the same full, reviewed ATM commit SHA. The runner, policy and encryption
   recipient are loaded from that pin, not from the candidate.
2. Explicitly initialize `ledger.json` on the target's `atm-state` branch:
   `npm run github-ci -- init --state /path/to/state/ledger.json --source github:OWNER/REPO`.
   Commit and push this branch before running the workflow. Missing or corrupt
   state is an error; normal runs never initialize or reset it. Initializing CI
   establishes a separate GitHub history; it does not delete or resolve the
   existing local dashboard's findings. Review those before any release.
3. Keep the evidence private key outside Git. For this installation it is
   `.atm/keys/impactgraph-evidence.pem` in the ATM checkout. Back it up securely:
   losing it makes that recipient's retained evidence unrecoverable. Only its
   public key is committed. To install for another owner, use `keygen` with
   `--private-key` and `--public-key` paths, and pin the resulting ATM commit.
4. If ATM is private, the target needs an `ATM_READ_TOKEN` secret with **read-only
   contents access to ATM**. A target repository's default token cannot read a
   different private repository. Public ATM checkouts need no extra credential.
5. Open a same-repository PR targeting `dev`. Verify the exact candidate SHA in
   `proposal.json`, the encrypted artifact, the state commit and the final
   **ATM acceptance** check. A green validation job alone is insufficient.
6. Optional, once the owner decides to enforce it (see Branch protection): in GitHub branch protection or a ruleset, add **ATM acceptance** as a required
   status check for `dev` and the production promotion branch. Preserve existing
   checks and review rules; require up-to-date branches if that is the release
   policy. Protect workflow/policy changes through review. A workflow file alone
   does not enforce merges, and this installation does not grant production
   authorization. The workflow must exist on each protected promotion branch.

Fork PRs intentionally fail the final gate without executing their code. A
maintainer must review and move an approved candidate to a trusted repository
branch. Never switch this workflow to `pull_request_target` while executing PR
code. Same-repository write access is the trust boundary; this is not a sandbox
for hostile maintainers. Do not run it on a persistent self-hosted runner.

## Evidence and durable findings

The validation job has read-only repository permissions and no persisted checkout
credentials. Candidate code runs in isolated application/test containers. A fresh
publication job executes only pinned ATM code and has the write permission needed
to update `atm-state`. It verifies the proposal's repository, candidate SHA,
execution ID, evidence hash and previous ledger digest, then pushes without force.
Concurrent triage changes cause failure rather than overwriting history.

The artifact contains `evidence.atm` and a public `proposal.json`. The evidence is
gzip-compressed and encrypted with a random AES-256-GCM key, wrapped with RSA-OAEP
SHA-256 for the committed recipient. It includes only `run.json`, `report.html`
and declared evidence. Source archives, compose credentials and database state
are excluded. Detailed runner output is redirected away from public Actions logs.
The public proposal and ledger contain finding IDs, checks, severity, disposition,
dates, counts and artifact receipts; error messages, screenshots and traces stay
inside the encrypted bundle. The ledger is durable Git history. Artifacts expire
after 30 days; download needed evidence before expiry. Expiry does not clear
findings, although it limits later forensic review. Git administrators can still
rewrite or delete history; these hashes are integrity checks, not signatures.

The final check requires all three conditions: successful validation execution,
successful artifact retention/state publication, and an eligible assessment.
Failed application checks still publish their findings and encrypted evidence.
Setup errors, cancellation, missing state, missing artifacts, stale state and
failed pushes cannot produce a passing gate. After fixing publication errors,
rerun **all jobs** so validation and publication share a new execution attempt.

Decrypt a downloaded artifact into a new private directory:

```sh
npm run github-ci -- decrypt --bundle /path/to/evidence.atm \
  --private-key .atm/keys/impactgraph-evidence.pem --output .atm/review-NEW
```

## Triage

Review the decrypted evidence before classifying or closing a finding. In a clean
worktree of the latest `atm-state` branch:

```sh
npm run github-ci -- triage --source github:OWNER/REPO \
  --state /path/to/state/ledger.json --finding FINDING_ID \
  --severity medium --disposition resolved --actor YOUR_GITHUB_LOGIN \
  --note-file /private/path/to/review-note.txt
```

Commit and push `ledger.json` with normal authenticated Git review. Retain the
private note; only its digest and audit metadata are public. Unassessed, high and
critical open findings block acceptance. Passing later checks does not resolve
them. Recurrence reopens both resolved and dismissed findings. Triage does not
waive a failing required check. The local dashboard triage store and GitHub ledger
are separate in this version; the dashboard does not edit GitHub findings.

## Validation and operational limits

`npm test` covers evidence encryption/decryption, tampering, symlinks, stale
proposals, candidate mismatch, recurrence, corrupt state and history preservation.
Run `actionlint integrations/github/impactgraph.yml` after editing the workflow.
The public proposal is trusted output from the pinned validation process; it is
not a cryptographically signed attestation. Protect the workflow and ATM pin as
part of code review. The publisher never evaluates downloaded code.

GitHub concurrency serializes runs but can replace an older pending run. That
candidate will have no passing check. Long-lived unresolved findings intentionally
block other candidates in the same repository until triaged. There is no automatic
exception, expiry or history pruning. Large evidence bundles are assembled in
memory; a runner resource failure blocks acceptance. Image promotion, staging
acceptance, production monitoring, load tests and AI exploration remain later
milestones.
