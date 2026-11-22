# Autonomous application discovery

ATM's `explore` mode starts with a running application and synthetic identities,
not a prescribed journey, goal library, or sequence of assertions. The model
discovers visible capabilities, chooses hypotheses to investigate, performs UI
experiments, and reports supported mismatches. Existing validation remains a
separate mode. Exploration does not run unit, E2E, or load suites.

## Start an exploration

Set `OPENAI_API_KEY` and `ATM_MODEL` in your shell, or create the private, ignored
file `.atm/agent.env`:

```dotenv
OPENAI_API_KEY=your-key
ATM_MODEL=your-tool-capable-model
```

```sh
npm run explore -- --repo /path/to/DAD-Main --revision origin/dev
```

`npm run explore` explicitly loads that file with Node's environment-file parser;
it does not execute shell content. Shell variables take precedence. Alternatively,
`npm run atm -- explore --repo PATH --model MODEL` loads the same optional file.
An explicit tool-capable model is required; OpenAI Responses is the default provider.
Missing configuration fails before provisioning. Never commit the key.
For a shorter paid trial, add `--max-requests 12` (allowed range 1–40). This
lowers the request cap; a partial run remains inconclusive. Three consecutive
rejected experiment plans stop the run early with retained evidence. Source and
memory tools run directly, outside the browser-action checks in a contract.

To try discovery without Docker or a DAD checkout, `npm run explore -- --target benchmark`
runs the healthy synthetic profile application from the quality benchmark in-process.
It needs the same model configuration and records its own `benchmark-discovery` policy.

To explore **any** web application, point ATM at its repository with
`npm run explore -- --repo /path/to/repo --target generic-web`. The target repository
supplies an `atm.config.json` describing how to build, start, and reach it (and which
actors to explore as); see [the generic target guide](./generic-target.md). The
discovery engine, contracts, and evidence model are identical to the DAD path — only
provisioning is config-driven. Release validation (`run`) remains DAD-only, since only
DAD ships an acceptance policy.

To use **Explore application** in the dashboard:

```sh
npm start -- --repo /path/to/DAD-Main                    # DAD target (default)
npm start -- --repo /path/to/repo --target generic-web   # any web app via atm.config.json
```

The dashboard requires `--repo`. A non-DAD
target offers exploration only; the dashboard labels its profile with the target name.

Fixture initialization and replay restart the ingress together with the application
services and wait for its healthcheck, so nginx resolves the current container
addresses before observations resume.

Working-tree edits are excluded. ATM archives the exact committed candidate,
builds production images, creates a disposable database, and removes runtime
containers after exploration or cancellation. Credentials stay outside application
processes and the browser. The default history is `.atm/runs` for both modes.

## Use Thinking Machines Tinker

Tinker is Thinking Machines' platform. To use its Inkling model, put these settings
in `.atm/agent.env` (create `.atm` if needed), and replace the key placeholder locally:

```dotenv
ATM_PROVIDER=tinker
TINKER_API_KEY=your-key
ATM_MODEL=thinkingmachines/Inkling
```

Keep this file private (`chmod 600 .atm/agent.env`). It is ignored by Git. Never
paste a real key into chat, commands saved in shell history, or tracked files.
A different Tinker base-model name or `tinker://` sampler checkpoint can be used
as `ATM_MODEL` if it supports tool use.

Verify configuration with one model request before provisioning the application:

```sh
npm run model:check
npm run explore -- --repo /path/to/DAD-Main --revision origin/dev
```

The connection check can use up to 2,000 output tokens and 60 seconds. It validates
a structured tool action and token accounting; it does not start an application.
Exploration has the normal request, time, and token limits below. Restart an open
dashboard after changing configuration; `npm start` loads the same private file.
Use `--provider tinker --model MODEL` to override provider/model on the explore,
validation, or benchmark command. The key always comes from the environment.

ATM uses Tinker's official [Anthropic-compatible Messages API](https://tinker-docs.thinkingmachines.ai/tinker/compatible-apis/anthropic/),
with a named tool and local schema validation. Only a single supported tool call
with a complete response and valid usage advances the agent; text and thinking
blocks are not actions. Input and output tokens (plus cache usage when reported)
count toward the existing token budget. Reports record the provider and model,
never the key or raw thinking blocks. The endpoint is currently a beta intended
for testing and internal use; organization access and tool support for your
chosen model must be available. HTTP errors remain inconclusive.

## Discovery and investigation

The adapter provides a guest and two independently identified, already claimed
synthetic donors. Each donor has one distinguishable synthetic gift. These are
fixtures, not goals. The agent receives identity descriptions, entry pages,
visible text, observed controls, discovered links, and server/JavaScript errors.
It does not receive cookies, API keys, arbitrary filesystem access, SQL, or an
application-specific success script. It can inspect a bounded read-only inventory of
the committed source archive, search literal text, and read numbered source excerpts.
Environment files, key files, dependency/build directories, binaries and symlinks
are excluded. The model receives changed-file hints from the selected commit.

The agent can:

- Read source and documentation and cite files already inspected.
- Record its own hypothesis, capability, behavior, state, preconditions, expected result,
  expectation basis (documented, implementation, observed, or assumption), and ordered
  executable checks chosen before the experiment.
- Navigate discovered pages, click observed controls, fill fields, select options,
  toggle controls, reload, and switch identity.
- Assert text, field values, checkbox state, navigation paths, errors, or approved
  persisted fixture state. Both passing and failing assertions are retained.
- Report a current mismatch and request independent replay.
- Conclude an experiment as supported, refuted, or blocked with a reason. A supported
  conclusion requires every declared check to execute in order and every assertion
  to pass. A refuted conclusion requires a failed declared assertion. Blocked work remains visible.
- End the run with a summary of coverage and uncertainty.

Only the model decides which capabilities to investigate and which experiments
to perform. The browser broker maps observation IDs to captured controls; the
model cannot supply selectors, JavaScript, arbitrary URLs, or HTTP requests.
Out-of-origin requests, redirect hops, WebSockets, service workers, downloads,
and popup interaction are restricted by the existing browser layer. Password and
file inputs are not exposed as agent controls. Same-origin UI mutations are
permitted against disposable data. Payment, mail, push, and workers are disabled.
Failures caused by these missing services must be treated as environment limits.

App text and previous discoveries are treated as untrusted data in the prompt.
Tool and network restrictions are enforced outside the model. This is for trusted
application source: build scripts still execute code from the selected repository.

## Evidence and reproduction

`discovery.json` retains the application map, hypotheses, observations, every
decision and outcome, prior memory references, usage, and potential findings.
Screenshots accompany observations. Switching actors creates a fresh browser
context, including IndexedDB and Cache Storage; each context retains a separate
trace (`discovery-trace.zip`, then numbered segments). Saved page maps remain
snapshots of what was known at that point. Reports and referenced files have
content hashes and remain private locally.
The dashboard exposes the report, decision trail, map, findings, source evidence,
and behavior/actor/state coverage. Visited pages are tracked separately from tested
behavior. Every planned experiment must be concluded before the agent can finish;
blocked and unfinished work remains visible and is carried into bounded memory.

The harness evaluates each reported expectation against captured visible text or
browser errors. An assertion contradicted by the evidence is rejected. Truncated
text makes text checks inconclusive. Supported expectations are `text_present`,
`text_absent`, `no_server_error`, `no_page_error`, `field_value`, `field_checked`,
`path_equals`, `state_equals`, `state_unchanged`, `state_delta`, `field_unchanged`,
`checkbox_unchanged`, `a11y_clean`, `response_status` and `json_has`. `a11y_clean`
passes when the axe-core WCAG 2a/2aa audit of the observed page reports no
violations; it is inconclusive when the audit was not captured. The `probe` action
issues a loopback-relative GET through the authenticated page context and attaches
the response status and parsed JSON to the observation; `response_status` and
`json_has` (dotted key path, optional value) evaluate it and are inconclusive when
no probe preceded them. Missing fields are inconclusive, never assumed
matches. The DAD adapter independently reads only the two synthetic donors'
public names, email notification preferences/version, gift count, and active session
count. It exposes no arbitrary query tool or session credentials. Code is evidence
about implementation; it does not establish that the implementation is correct.

With DAD's replay fixture, the harness pauses API and web services and captures
the agent's current database. It restores a pristine post-seeding snapshot, restarts
the services, and replays the full action sequence, including actor changes, against
that fixture. Actor changes create fresh browser contexts. After replay, it pauses
the services again, restores the agent's working database, and resumes the live actor
at the original page. Client-side in-progress form state is not preserved across this
resumption; the next observation reflects a fresh page. Replay never doubles writes
in the working database. Snapshots stay in runner memory, not model context or reports.
The adapter refuses replay outside its run-owned exploration database. A failed swap
or restoration ends exploration as inconclusive and cleanup removes the environment.

Recorded controls must match captured identities. Replay stops after 30 actions,
on forbidden requests, divergent state/controls, or a different destination/actor.
Without a replay fixture, mutations remain observed and automatic replay is refused;
read-only replay still uses a fresh context. A matching independent mismatch becomes
**reproduced**. The report retains both observations, screenshots, action steps, and
replay traces. `discovery-regressions.json` exports reproduced hypotheses as revision-
bound regression **candidates** with expectations and fixture replay steps; a human
must review the requirement before promoting them to an acceptance test. This export
does not install or execute tests in the application's repository.

Neither label means the expected behavior is correct. A model can misunderstand
the product. All findings are hypotheses until a human reviews the stated basis.
The Findings view supports confirmation, dismissal, severity, and resolution.
Unreviewed discovery hypotheses do not block unrelated validation runs. Confirmed
findings use the existing severity policy. A later exploration ending successfully
does not resolve a prior finding.

## Memory and limits

Each exploration builds a searchable application memory from retained, verified
reports for the same source repository. A short startup summary accompanies the
index; detailed feature evidence is retrieved on demand with `search_memory` and
`read_memory`. The index connects capabilities, browser pages, assertion actors,
source references, fixture data fields, expectations, executed checks, historical
findings, and unfinished work. Evidence remains tied to its original run, candidate,
investigation, observations, and report digest.

The index is retained as private, hash-referenced `application-memory.json` evidence
for the current run. It is reconstructed from the retained discovery reports each
run, so concurrent runs do not overwrite a shared memory database. Removing old run
evidence removes that evidence from later indexes. Local and GitHub histories are
not synchronized automatically. Historical index snapshots are not used as a shortcut
around verifying the original reports and supporting screenshots/traces.

Current source hashes are compared with hashes recorded when cited source was read
or searched. Source inspected during an investigation is also linked to it. Changed
or removed referenced files mark the investigation `needs-revalidation`, even when
the change predates the current commit. Matching files are `unchanged-references`;
missing hashes or unavailable comparisons are `unknown`, or `same-revision` when the
candidate revision is identical. None of these labels means the UI was retested.
Only captured dependencies are tracked; this is not transitive static analysis.

Search uses literal feature, behavior, page, actor, data-field, source-path, outcome,
or freshness terms. It prioritizes changed references, historical failures, and
unfinished/blocked work. Newer equivalent behavior records supersede older successful
records for planning; old failures remain historical review items. Current triage is
not synchronized into memory, and memory never closes findings or changes acceptance.
The model is encouraged to investigate supplied actors without prior recorded
assertions and to explore outside remembered coverage.

Memory is untrusted historical evidence. Source citations still require reading
current source. Unfinished work includes its original prerequisites, full declared
checks, and next unfinished check; a follow-up must recreate prerequisites and
checkpoints in the fresh fixture. Retrieval cannot restore a previous browser,
advance a new experiment's checks, or turn an old pass into a current assertion.

Limits: scan at most 100 finished runs, retain at most 250 investigation records and
2 MB of serialized index evidence, compare at most 500 unique referenced paths,
and return at most eight search results or 16 KB of record evidence per retrieval.
Per-record dependencies are bounded at 16 paths. Omitted history, records and source
comparisons are reported in the index and dashboard. The newest source/memory tool
result is sent in full with bounded planning context. Oversized observations still
stop the run rather than silently dropping correctness evidence.

Report and supporting-evidence hashes are checked while building memory and again
when returning search/read results. Tampered or missing supporting evidence is
excluded with a visible warning or tool error. The dashboard shows the memory used
by that run, changed references, supplied actors lacking recorded assertions, and
the retrieval trail. A remembered feature is not a claim of complete role coverage.

Each run permits at most 40 model requests, 10 minutes of exploration, 2,000 output
tokens per request, and 100,000 accounted tokens. The last response can exceed the
token threshold; its action is not executed. Reaching the threshold exactly stops
further requests. Request counts include failed attempts. Tinker usage from rejected or truncated
responses is counted when the provider supplies valid usage. `usageIncomplete`
marks a provider failure without valid usage, so recorded tokens are a lower
bound rather than a billing total; benchmark summaries count these cases. These are resource bounds, not a
currency budget. Each request has at most 60,000 input characters. Provider errors,
missing usage accounting, cancellation, and exhausted budgets retain partial
evidence and cannot appear as complete exploration. A completed run means the
agent ended its bounded investigation, never that the application is bug-free.

CLI exit 0 means exploration and cleanup completed; 2 means partial/inconclusive,
1 an infrastructure check failure, and 130 user cancellation. There is no release
authorization from exploration. Existing required-check branch protection remains
deferred. Discovery is manually launched; commit watch and GitHub continue using
their existing validation mode and do not incur model usage automatically.

The first adapter covers public and donor UI discovery. Staff provisioning,
arbitrary API investigation, broader database projections, semantic deduplication,
and scheduled unattended exploration remain future extensions. No product-spec oracle is claimed.

## Verification

Harness tests use a controlled model provider and real Chromium against small
fault-injection applications. They check observed-control navigation, actor
isolation, server-error reproduction, write-replay refusal, unsupported claims,
budgets, cleanup, memory integrity, and dashboard presentation. They test the
agent infrastructure; they do not demonstrate a live model's discovery ability.
A live-model run against DAD requires configured credentials and should
be reviewed separately for useful investigations and false-positive rate.

The default OpenAI provider uses the official [Responses function-calling interface](https://developers.openai.com/api/docs/guides/function-calling)
with a strict tool schema, one action per request, and `store: false`. Each request
is self-contained with bounded observations and decision summaries.

## Discovery quality benchmark

Run the opt-in live-model benchmark with the same model used for exploration.
Use `--max-requests N` (1–40 per case) for shorter trials. Incomplete attempts
remain in the detection denominator; lowering the cap can lower measured quality:

```sh
npm run benchmark:discovery -- --live --model YOUR_MODEL --repeats 3
```

It runs a healthy synthetic profile application and four hidden runtime variants:
lost persistence (with misleading success), cross-donor writes, accepted invalid
names, and duplicate writes. All variants expose the same documented contract and
reference source to the model; fault labels and the scoring oracle stay outside its
context. The agent chooses its experiments and actions. No scripted journey is
supplied to the live model. Each case has the normal discovery budgets and private
evidence. SIGINT stops work and closes run-owned browsers and servers.

`benchmark.json` records detection rate, healthy-run false positives, reproduction
counts, unmatched findings requiring review, requests, tokens, and duration. Only
reproduced literal or relationship persisted-state assertions whose expectations
agree with hidden contract state count as automatic detections. Other assertions require manual review;
partial attempts stay in the denominator. Repetitions reveal variability. This small
benchmark measures these defect classes, not general application competence.

The command requires `--live`, an explicit model, and configured credentials. It is
not run by routine tests. Optional `--token-price USD_PER_MILLION_TOTAL_TOKENS` adds a
user-supplied blended cost estimate; without it, no dollar cost is inferred.

See [AGENTS.md](../AGENTS.md) for the test commands.

Controlled-provider browser tests prove the investigation machinery and mutation
replay. Only live-model runs and reviewed findings establish discovery quality.

## Executable experiment contracts

Every new investigation declares `checks` in its plan. Plans are immutable after
registration. Each plan contains 2–12 ordered action, checkpoint, or assertion checks.
The agent chooses the checks; the runner never prescribes an application journey.
A contract establishes what was tested, not whether the chosen checks exhaustively
cover the prose hypothesis. Product expectations still require review.

Actions match successful browser operations by actor, action kind, exact unique
observed control label (or discovered path), and value. A failed action, wrong actor,
or an earlier out-of-order action cannot satisfy a later step. Checkpoint capture
and assertion verification use the next declared check ID. Supplemental `assert`
results cannot substitute for mandatory checks. `verify` ignores model-supplied
replacement expectations and evaluates the registered check. `report_check` replays
a previously failed declared assertion. Malformed plans return an actionable error
and can be corrected within the remaining run budget.

A supported conclusion requires all declared checks, in order, and passing evaluable
assertions. Missing/ambiguous fields remain inconclusive and do not advance a check.
A refuted conclusion requires a declared assertion failure. The agent can conclude
blocked with an explanation; incomplete checks remain visible. Reports and the
behavior coverage view include completed/required counts and the next pending check.
Old saved reports remain readable; their old conclusions do not acquire contracts.

For example, after navigating as donor A, an agent might declare:

```json
[
  {"id":"before","kind":"checkpoint"},
  {"id":"edit","kind":"action","action":"fill","actor":"donor-a","target":"Public name","value":"New Name"},
  {"id":"save","kind":"action","action":"click","actor":"donor-a","target":"Save profile","value":""},
  {"id":"reload","kind":"action","action":"reload","actor":"donor-a","target":"","value":""},
  {"id":"persist","kind":"assertion","expectation":"state_equals","actor":"donor-a","target":"donor-a","value":"public_name","text":"New Name","baseline":""},
  {"id":"isolation","kind":"assertion","expectation":"state_unchanged","actor":"donor-a","target":"donor-b","value":"public_name","text":"","baseline":"before"},
  {"id":"once","kind":"assertion","expectation":"state_delta","actor":"donor-a","target":"donor-a","value":"save_count","text":"1","baseline":"before"}
]
```

This example uses the synthetic benchmark's `save_count`. Real adapters expose only
their approved fields; the DAD donor projection does not expose `save_count`.
The plan's other fields (`capability`, `behavior`, `state`, `preconditions`, `expected`,
`basis`, `references`) remain required. A full worked contract is retained in each
investigation report. Use `checkpoint` with `target=before`, execute the actions,
then `verify` with the declared assertion IDs.

Relationships reference an earlier checkpoint in the same experiment:

- `state_unchanged`: a named fixture actor's scalar field is unchanged.
- `state_delta`: a safe integer counter changed by the declared integer difference.
- `field_unchanged`: the same browser actor's same identified field has the same value.
- `checkbox_unchanged`: that field's boolean checked state is unchanged.

Checkpoint values are immutable. Field identity, rather than a reused observation
ID, connects field values. Missing baselines, actor changes for field comparisons,
ambiguous controls, wrong types, and unsafe integers are inconclusive. A null value
and the string `"null"` differ. An equal-across-reload check should checkpoint the
saved state before reload and separately verify the intended edit was saved.

Replay recaptures checkpoints at their original positions in the clean action
sequence. It evaluates relationships against those fresh values, never original-run
baseline values. Checkpoints and both comparison observations are retained with
reproduction evidence and exported regression candidates.

## Memory and live-model quality

Memory retrieval, stale-provenance handling and memory budgets are tested with a
controlled provider, which proves the plumbing, not live-model planning quality.
