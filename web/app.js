const $ = selector => document.querySelector(selector);
const escapeHTML = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const titleCase = value => (value ? value[0].toUpperCase() + value.slice(1) : '');
const date = value =>
  new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const duration = ms => {
  if (!Number.isFinite(ms)) return '—';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};
const badge = (status, mode) =>
  `<span class="badge ${escapeHTML(status)}">${escapeHTML(mode === 'exploration' && status === 'passed' ? 'Completed' : titleCase(status))}</span>`;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const runLabel = run =>
  run.mode === 'exploration'
    ? 'Autonomous discovery'
    : ({ 'commit-watch': 'Commit watch', dashboard: 'Manual validation', cli: 'Command line' }[run.trigger] ??
      (run.trigger?.startsWith('github:') ? 'GitHub acceptance' : 'Command line'));
let state,
  view = 'overview',
  search = '',
  filter = 'all',
  selectedRun,
  selectedFinding,
  refreshing = false,
  previousState = '',
  detailFingerprint = '',
  toastTimer,
  launchMode = 'validation',
  wasActive = false;

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(state?.csrf ? { 'X-ATM-Token': state.csrf } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `The request failed (HTTP ${response.status}).`);
  return body;
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('#toast').hidden = true;
  }, 4000);
}
function evidenceLinks(runId, entries = []) {
  return entries
    .map(
      e =>
        `<a href="/evidence/${encodeURIComponent(runId)}/${encodeURIComponent(e.path.split('/').pop())}" target="_blank" rel="noopener noreferrer">${escapeHTML(e.path.replace('evidence/', ''))} ↗</a>`,
    )
    .join('');
}
function activeFindings() {
  return state.findings.filter(f => !['resolved', 'dismissed'].includes(f.disposition));
}
function runTable(runs) {
  if (!runs.length)
    return '<div class="empty"><h2>No matching runs</h2><p>Start a validation or adjust your filters to see its checks and evidence here.</p></div>';
  return `<div class="table-shell"><table><thead><tr><th>Validation</th><th>Commit</th><th>Status</th><th>Checks</th><th>Duration</th><th><span class="muted">View</span></th></tr></thead><tbody>${runs.map(r => `<tr><td><button class="run-link" data-run="${escapeHTML(r.id)}">${escapeHTML(date(r.startedAt))}<small>${escapeHTML(runLabel(r))}</small></button></td><td><code class="commit">${escapeHTML(r.revision.slice(0, 8))}</code></td><td>${badge(r.status, r.mode)}</td><td><span class="checks">${r.passed}/${r.total}<progress max="${r.total || 1}" value="${r.passed}" aria-label="${r.passed} of ${r.total} checks passed"></progress></span></td><td class="muted">${escapeHTML(duration(r.durationMs))}</td><td><button class="row-arrow" data-run="${escapeHTML(r.id)}" aria-label="View run ${escapeHTML(r.id)}">↗</button></td></tr>`).join('')}</tbody></table></div>`;
}
function overview() {
  const latest = state.runs[0],
    active = state.active;
  const heroStatus = latest?.status ?? 'empty';
  const titles = {
    passed: 'Latest candidate passed.',
    failed: 'A candidate needs attention.',
    inconclusive: 'More evidence is needed.',
    incomplete: 'A run did not finish.',
    canceled: 'Validation was canceled.',
    running: 'Validation is in progress.',
    empty: 'Your next release starts here.',
  };
  const descriptions = {
    passed: 'All required local checks completed successfully. Explore the evidence behind this result.',
    failed: 'A required check failed. Review the results and supporting evidence before trying again.',
    inconclusive: 'Some checks could not complete. Review the execution details to find the next step.',
    incomplete: 'This run has no final result. Inspect its evidence and verify cleanup before rerunning.',
    canceled: 'Review the cleanup result before starting the next validation.',
    running: `Currently checking ${latest?.currentCheck?.replaceAll('-', ' ') ?? 'the candidate'}. Evidence is saved as each check completes.`,
    empty: 'Run your application through an isolated environment and see exactly what passed, what failed, and why.',
  };
  const explorationTitles = {
    passed: 'Latest exploration completed.',
    running: 'Agent exploration is running.',
    canceled: 'Exploration was canceled.',
  };
  explorationTitles.failed = explorationTitles.inconclusive = explorationTitles.incomplete = 'Exploration ended early.';
  const validations = state.runs.filter(r => r.mode !== 'exploration');
  const passed = validations.filter(r => r.status === 'passed').length;
  const explorations = state.runs.length - validations.length;
  return `<div class="overview-grid"><div><article class="hero ${escapeHTML(heroStatus)}"><div class="eyebrow"><span class="connection-dot"></span>LATEST VALIDATION</div><span class="status-symbol ${heroStatus === 'failed' ? 'bad' : ''}" aria-hidden="true">${heroStatus === 'passed' ? '✓' : heroStatus === 'running' ? '↻' : '◇'}</span><h2>${latest?.mode === 'exploration' ? explorationTitles[heroStatus] : titles[heroStatus]}</h2><p>${latest?.mode === 'exploration' ? (heroStatus === 'passed' || heroStatus === 'running' ? 'Review the application map, self-selected investigations, and evidence. An exploration is not a release verdict.' : 'The exploration stopped before the agent finished. Open the evidence for the reason and any partial investigations.') : escapeHTML(descriptions[heroStatus])}</p>${state.latestRelease && latest?.finishedAt && latest.mode !== 'exploration' ? `<p><strong>Local acceptance: ${state.latestRelease.eligible ? 'Eligible' : 'Blocked'}</strong>${state.latestRelease.eligible ? ' under the recorded policy.' : ' — open the evidence for blocking reasons.'}</p>` : ''}<div class="hero-bottom"><span class="mono">${latest ? `${escapeHTML(latest.revision.slice(0, 8))} · ${escapeHTML(date(latest.startedAt))}` : 'DAD · Local acceptance'}</span>${latest ? `<button class="text-button" data-run="${escapeHTML(latest.id)}">View evidence <span aria-hidden="true">↗</span></button>` : '<button class="text-button" data-action="launch">Start your first run ↗</button>'}</div></article><div class="metrics"><div class="metric"><div class="metric-label">Runs</div><div class="metric-number">${state.runs.length}</div><div class="metric-note">${validations.length} ${validations.length === 1 ? 'validation' : 'validations'} · ${explorations} ${explorations === 1 ? 'exploration' : 'explorations'}</div></div><div class="metric"><div class="metric-label">Passed validations</div><div class="metric-number">${passed}<span class="subtle"> / ${validations.length}</span></div><div class="metric-note">Required checks passed</div></div><div class="metric"><div class="metric-label">Open findings</div><div class="metric-number">${activeFindings().length}</div><div class="metric-note">Awaiting triage or resolution</div></div></div></div><div class="side-stack"><article class="panel"><div class="panel-title">Keep checking.<span class="tag">AUTOMATION</span></div><p>Validate new commits automatically, while you keep building.</p><div class="automation-state"><span class="connection-dot"></span>${state.watch.enabled ? `Watching ${escapeHTML(state.watch.revision)}` : 'Commit watch is off'}</div>${state.watch.error ? `<p class="notice error">${escapeHTML(state.watch.error)}</p>` : ''}<button class="text-button" data-action="watch">${state.watch.enabled ? 'Turn off commit watch' : 'Set up commit watch'} <span aria-hidden="true">→</span></button></article><article class="panel"><div class="panel-title">What this profile checks</div><div class="guide-row"><span class="guide-icon">✓</span><div><strong>Build & test</strong><small>API and frontend checks</small></div></div><div class="guide-row"><span class="guide-icon">⌁</span><div><strong>Real user journey</strong><small>Staff passkeys, donor claim and access boundaries</small></div></div><div class="guide-row"><span class="guide-icon">◇</span><div><strong>Independent verification</strong><small>Persisted state and evidence</small></div></div></article></div></div><div class="section-top"><div><h2>Recent runs</h2><small>Committed candidates, with a record of every check.</small></div><a class="text-button" href="#runs">View all runs →</a></div>${runTable(state.runs.slice(0, 5))}${active ? `<p class="section-note">One validation is active. Cleanup completes before another can start.</p>` : ''}`;
}
function findingsView() {
  const findings = state.findings.filter(
    f =>
      `${f.title} ${f.check} ${f.note}`.toLowerCase().includes(search.toLowerCase()) &&
      (filter === 'all' ||
        (filter === 'open' ? !['resolved', 'dismissed'].includes(f.disposition) : f.disposition === filter)),
  );
  return `<div class="toolbar"><input id="search" aria-label="Search findings" placeholder="Search findings…" value="${escapeHTML(search)}"><select id="filter" aria-label="Filter findings">${['all', 'open', 'untriaged', 'confirmed', 'resolved', 'dismissed'].map(value => `<option value="${value}" ${filter === value ? 'selected' : ''}>${value === 'all' ? 'All findings' : titleCase(value)}</option>`).join('')}</select></div><p class="section-note">Agent hypotheses and recurring check failures are grouped here. Triage records your assessment; it never changes a run’s result.</p><div class="finding-list">${findings.length ? findings.map(f => `<article class="finding-card"><span class="finding-icon" aria-hidden="true">◇</span><div class="finding-body"><h3>${escapeHTML(f.title)}</h3><div class="finding-meta"><span class="tag">${escapeHTML(f.check)}</span><span>${f.occurrences.length} ${f.occurrences.length === 1 ? 'occurrence' : 'occurrences'}</span><span>·</span><span>${escapeHTML(titleCase(f.disposition))}</span>${f.severity !== 'unassessed' ? `<span class="tag">${escapeHTML(f.severity)}</span>` : ''}</div><p>${f.latestCheckPassed ? 'This check passed in a later run. Review before resolving.' : `Last seen ${escapeHTML(date(f.lastSeen))}`}</p></div><button class="button secondary" data-finding="${escapeHTML(f.id)}">Review ↗</button></article>`).join('') : '<div class="empty"><h2>No findings to show</h2><p>Completed check failures will appear here with evidence and reproduction details.</p></div>'}</div>`;
}
function runsView() {
  const runs = state.runs.filter(
    r =>
      `${r.id} ${r.revision}`.toLowerCase().includes(search.toLowerCase()) && (filter === 'all' || r.status === filter),
  );
  return `<div class="toolbar"><input id="search" aria-label="Search runs" placeholder="Search by commit or run ID…" value="${escapeHTML(search)}"><select id="filter" aria-label="Filter runs">${['all', 'passed', 'failed', 'running', 'inconclusive', 'canceled', 'incomplete'].map(value => `<option value="${value}" ${filter === value ? 'selected' : ''}>${value === 'all' ? 'All statuses' : titleCase(value)}</option>`).join('')}</select></div>${runTable(runs)}`;
}

function aboutView() {
  return `<div class="about-grid"><article class="panel"><div class="eyebrow">ATM · VERSION ${escapeHTML(state.project.version)}</div><h2>Evidence before confidence.</h2><p>ATM is a private, local quality workspace for DAD. It builds committed candidates in isolated containers, exercises critical staff and donor journeys in a real browser, verifies persisted state independently, and retains the evidence behind every result.</p><p>Commit watch can validate each new local commit while the dashboard runs. A passing run means the candidate satisfies the recorded local acceptance policy. It never authorizes a production release.</p></article><article class="panel"><h2>What validation covers</h2><ul><li>Production API and frontend image builds</li><li>Go race-enabled API tests and frontend lint, unit, and type checks</li><li>Staff passkey activation, sign-out, and sign-in</li><li>Donor account claim, session, and replay protection</li><li>Host, authentication, and persisted-state boundaries</li><li>Advisory baseline, burst, and recovery measurements</li></ul></article><article class="panel"><h2>Autonomous discovery</h2><ul><li>Explore application starts the candidate with a guest and two synthetic donors, and no prescribed journey.</li><li>The agent reads the pinned source, chooses its own experiments, and declares executable checks before acting.</li><li>Mismatches are replayed against a clean fixture; reproduced findings still need a person to confirm the expected behavior.</li><li>Each exploration is limited to ${state.project.limits.discovery.requests} model requests, ${state.project.limits.discovery.minutes} minutes, and ${state.project.limits.discovery.tokens.toLocaleString('en-US')} tokens, and needs a configured provider and model.</li><li>Explorations never assess release readiness.</li></ul></article><article class="panel"><h2>Safety and privacy</h2><ul><li>Runs use synthetic identities and disposable PostgreSQL storage.</li><li>The dashboard binds to loopback and is intended for one trusted local operator.</li><li>Mutations require same-origin requests and a session token.</li><li>Evidence stays local unless the optional encrypted GitHub gate is configured.</li><li>Browser traces can contain synthetic session data and should remain private.</li></ul></article><article class="panel"><h2>Known limits</h2><ul><li>No production deployment, promotion, rollback, or monitoring.</li><li>No live Stripe, email, push, or external integration coverage.</li><li>The default performance profile is advisory and does not establish capacity.</li><li>AI discovery findings remain hypotheses until a person reviews them.</li><li>Trusted source is required: dependency and container build scripts execute candidate code.</li></ul></article></div>`;
}
function focusSelector(element) {
  if (!element || !$('#content').contains(element)) return null;
  if (element.id) return `#${CSS.escape(element.id)}`;
  const name = ['data-run', 'data-finding', 'data-action'].find(attribute => element.hasAttribute(attribute));
  if (!name) return null;
  const type = element.classList[0] ? `.${CSS.escape(element.classList[0])}` : '';
  return `${element.tagName}${type}[${name}="${CSS.escape(element.getAttribute(name))}"]`;
}
function announceRunStatus() {
  const latest = state.runs[0];
  const message = state.active
    ? 'A run is in progress.'
    : wasActive && latest
      ? `Run finished: ${latest.status}.`
      : $('#run-status').textContent;
  wasActive = Boolean(state.active);
  $('#run-status').textContent = message;
}
function render() {
  if (!state) return;
  const focused = focusSelector(document.activeElement),
    selection = document.activeElement?.id === 'search' ? $('#search').selectionStart : null;
  $('#project-name').textContent = state.project.name;
  $('#app-version').textContent = `v${state.project.version}`;
  $('#nav-runs').textContent = state.runs.length;
  $('#nav-findings').textContent = activeFindings().length;
  const titles = {
    overview: ['Release overview', `Validation history and evidence for ${state.project.name}.`],
    runs: ['Runs', 'Every validation and exploration, and the evidence behind each result.'],
    findings: ['Findings', 'Turn failed checks into clear next steps.'],
    about: ['About ATM', 'Scope, safety boundaries, and operational limits.'],
  };
  $('#page-title').textContent = titles[view][0];
  $('#page-description').textContent = titles[view][1];
  document.querySelectorAll('[data-nav]').forEach(link => {
    link.classList.toggle('active', link.getAttribute('data-nav') === view);
    if (link.getAttribute('data-nav') === view) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  $('#new-exploration').disabled = Boolean(state.active || state.starting);
  $('#new-run').disabled = Boolean(state.active || state.starting);
  $('#new-run').textContent = state.active || state.starting ? 'Validation running…' : '＋ Run validation';
  announceRunStatus();
  $('#warnings').textContent = [...state.warnings, ...(state.lastLaunchError ? [state.lastLaunchError] : [])].join(' ');
  $('#warnings').hidden = !$('#warnings').textContent;
  $('#content').innerHTML =
    view === 'overview'
      ? overview()
      : view === 'runs'
        ? runsView()
        : view === 'findings'
          ? findingsView()
          : aboutView();
  $('#content').setAttribute('aria-busy', 'false');
  const restored = focused && $(focused);
  if (restored) {
    restored.focus({ preventScroll: true });
    if (selection !== null) restored.setSelectionRange(selection, selection);
  }
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const next = await api('/api/state');
    const encoded = JSON.stringify(next);
    state = next;
    $('#connection-error').hidden = true;
    if (encoded !== previousState) {
      previousState = encoded;
      render();
    }
    if (selectedRun && $('#run-dialog').open) await showRun(selectedRun, false);
  } catch (error) {
    $('#connection-error').textContent = `Runner unavailable. ${error.message} Reconnecting…`;
    $('#connection-error').hidden = false;
  } finally {
    refreshing = false;
  }
}
function openLaunch(mode = 'validation') {
  if (!state || state.active || state.starting) return;
  launchMode = mode;
  const discovery = mode === 'exploration';
  $('#launch-title').textContent = discovery ? 'Explore application' : 'Test a candidate';
  $('#launch-description').textContent = discovery
    ? 'The agent discovers capabilities and chooses its own investigations in a disposable environment. No test goal is required.'
    : 'Build an isolated environment from a committed revision, run the checks, and collect the evidence.';
  $('#launch-submit').textContent = discovery ? 'Start exploration' : 'Start validation';
  $('#launch-dialog .option-box').hidden = discovery;
  $('#discovery-help').hidden = !discovery;
  $('#discovery-help').textContent = state.project.aiConfigured
    ? `Uses ${state.project.model}. Up to ${state.project.limits.discovery.requests} requests, ${state.project.limits.discovery.minutes} minutes, and ${state.project.limits.discovery.tokens.toLocaleString('en-US')} accounted tokens; the final response can exceed the token budget. Model usage is billed by your provider. Prior discoveries inform this run.`
    : 'Configure ATM_PROVIDER, its API key, and ATM_MODEL on the runner to enable autonomous discovery.';
  $('#launch-error').hidden = true;
  $('#ai').checked = false;
  $('#require-ai').checked = false;
  $('#require-ai').disabled = true;
  $('#ai').disabled = !state.project.aiConfigured;
  $('#ai-help').textContent = state.project.aiConfigured
    ? `Uses ${state.project.model}. Limited to ${state.project.limits.ai.actions} actions and ${state.project.limits.ai.minutes} minutes; model usage is billed by your provider.`
    : 'To enable, set ATM_PROVIDER, its API key, and ATM_MODEL on the runner and restart the dashboard.';
  $('#launch-dialog').showModal();
  $('#revision').focus();
}
function contractView(investigation) {
  if (!investigation.plan?.checks) return '';
  return `<details><summary>Declared checks (${investigation.progress?.length ?? 0}/${investigation.plan.checks.length} executed)</summary><ol>${investigation.plan.checks
    .map(check => {
      const recorded = investigation.progress?.find(item => item.checkId === check.id);
      const status = !recorded
        ? 'pending'
        : check.kind === 'assertion'
          ? recorded.verification?.passed
            ? 'passed'
            : 'failed'
          : check.kind === 'checkpoint'
            ? 'captured'
            : 'executed';
      const description =
        check.kind === 'action'
          ? `${check.action} ${check.target} ${check.value}`
          : check.kind === 'checkpoint'
            ? 'Capture comparison baseline'
            : `${check.expectation} ${check.target} ${check.value} ${check.text}${check.baseline ? ` · compared with ${check.baseline}` : ''}`;
      return `<li><strong>${escapeHTML(check.id)} · ${escapeHTML(status)}</strong><p><code>${escapeHTML(description)}${check.actor ? ` · ${escapeHTML(check.actor)}` : ''}</code></p>${recorded?.verification ? `<pre class="repro">${escapeHTML(JSON.stringify(recorded.verification, null, 2))}</pre>` : ''}</li>`;
    })
    .join('')}</ol></details>`;
}
function experimentCoverage(report) {
  if (!report.coverage) return '';
  return `<h4>Behavior coverage</h4><p>${report.coverage.experiments.length} selected experiments · ${report.assertions?.length ?? 0} recorded assertions. Visiting a page does not establish tested behavior.</p><ul>${report.coverage.experiments.map(e => `<li><strong>${escapeHTML(e.capability)}</strong> · ${escapeHTML(e.behavior)} · ${escapeHTML(e.actor)} · ${escapeHTML(e.state)} · ${escapeHTML(e.status)}<p>${escapeHTML(e.reason || 'Investigation remains unfinished.')}</p>${e.requiredChecks ? `<p>${e.completedChecks}/${e.requiredChecks} declared checks executed${e.pendingCheck ? ` · pending: ${escapeHTML(e.pendingCheck)}` : ''}</p>` : ''}</li>`).join('')}</ul><details><summary>Source evidence (${report.sourceEvidence?.length ?? 0})</summary><pre class="repro">${escapeHTML(JSON.stringify(report.sourceEvidence ?? [], null, 2))}</pre></details>`;
}
function applicationMemoryView(report, runId) {
  const memory = report.applicationMemory;
  if (!memory) return '';
  return `<section aria-label="Application memory"><h4>Application memory</h4><p>${memory.features} remembered features · ${memory.investigations} prior investigations · ${memory.needsRevalidation} latest behaviors need revalidation.</p><p>Historical evidence does not establish a current pass. Unknown dependencies and untested roles remain open.</p><ul>${(memory.featureMap ?? []).map(feature => `<li><strong>${escapeHTML(feature.name)}</strong><p>Previously checked as: <code>${escapeHTML(feature.testedActors.join(', ') || 'no recorded assertion actor')}</code></p><p>Actors without recorded checks: <code>${escapeHTML(feature.unexploredActors.join(', ') || 'none among supplied actors')}</code></p></li>`).join('')}</ul><details><summary>Suggested follow-up evidence</summary><ul>${(memory.followUps ?? []).map(item => `<li><strong>${escapeHTML(item.feature)} · ${escapeHTML(item.behavior)}</strong><p>${escapeHTML(item.freshness)} · ${escapeHTML(item.outcome)}${item.nextCheck ? ` · unfinished check: ${escapeHTML(item.nextCheck)}` : ''}</p>${item.changedFiles.length ? `<p>Changed references: <code>${escapeHTML(item.changedFiles.join(', '))}</code></p>` : ''}</li>`).join('')}</ul><p>History limits omitted ${memory.omissions.runs} runs, ${memory.omissions.records} investigations, and ${memory.omissions.dependencies} source comparisons.</p></details><details><summary>Retrieved memory evidence (${report.memoryEvidence?.length ?? 0})</summary><pre class="repro">${escapeHTML(JSON.stringify(report.memoryEvidence ?? [], null, 2))}</pre></details><p><a href="/evidence/${encodeURIComponent(runId)}/application-memory.json" target="_blank" rel="noopener noreferrer">Download application memory index ↗</a></p></section>`;
}
function discoveryView(value, runId) {
  if (value?.error)
    return `<section class="performance-panel"><h3>Autonomous discovery</h3><p class="notice error">${escapeHTML(value.error)}</p></section>`;
  const report = value?.report;
  if (!report) return '';
  return `<section class="performance-panel" aria-label="Autonomous discovery"><h3>Autonomous discovery · ${escapeHTML(report.status)}</h3><p>${escapeHTML(report.summary || 'The agent is exploring and choosing investigations.')}</p><p>${report.requests} model requests · ${report.tokens} tokens · ${report.pages.length} discovered pages · ${report.memory.length} prior runs remembered.</p><p>Observations and reproduced mismatches require human review of expected behavior. This run does not approve a release.</p>${report.warnings.map(w => `<p class="notice">${escapeHTML(w)}</p>`).join('')}${applicationMemoryView(report, runId)}${experimentCoverage(report)}<h4>Agent-chosen investigations</h4>${report.investigations.length ? `<ul>${report.investigations.map(i => `<li><strong>${escapeHTML(i.title)}</strong> · ${escapeHTML(i.actor)}<p>${escapeHTML(i.hypothesis)}</p>${contractView(i)}</li>`).join('')}</ul>` : report.status === 'running' ? '<p>Discovering the application…</p>' : '<p>No investigations were recorded.</p>'}<details><summary>Application map (${report.pages.length})</summary><ul>${report.pages.map(p => `<li><code>${escapeHTML(p.path)}</code> ${escapeHTML(p.title)} · ${p.visitedBy.length ? `visited as ${escapeHTML(p.visitedBy.join(', '))}` : 'unexplored'}</li>`).join('')}</ul></details><h4>Potential findings (${report.findings.length})</h4>${report.findings.map(f => `<article class="discovery-finding"><h4>${escapeHTML(f.title)} · ${escapeHTML(f.status)}</h4><p>${escapeHTML(f.basis)}</p><p>Expectation: ${escapeHTML(f.expectation)} ${escapeHTML(f.text)} · ${escapeHTML(f.path)} · ${escapeHTML(f.actor)}</p><p>Replay: ${escapeHTML(f.reproduction.status)}${f.reproduction.reason ? ` — ${escapeHTML(f.reproduction.reason)}` : ''}</p><details><summary>Reproduction evidence</summary><pre class="repro">${escapeHTML(JSON.stringify(f.reproduction, null, 2))}</pre></details></article>`).join('') || '<p>No supported mismatch recorded. Unexplored behavior may still contain defects.</p>'}<details><summary>Decision trail (${report.events.length})</summary><ol>${report.events.map(e => `<li><strong>${escapeHTML(e.action.action)}</strong> ${escapeHTML(e.action.target)}<p>${escapeHTML(e.action.reason)}</p><small>${escapeHTML(e.outcome ?? 'Pending')}</small></li>`).join('')}</ol></details><p><a href="/evidence/${encodeURIComponent(runId)}/discovery.json" target="_blank" rel="noopener noreferrer">Download discovery report ↗</a></p></section>`;
}
function performanceView(value) {
  if (!value) return '';
  if (value.error)
    return `<section class="performance-panel"><h3>Performance</h3><p class="notice error">${escapeHTML(value.error)}</p></section>`;
  const { report, advisory, comparison } = value;
  const number = n => (n === null ? '—' : Number(n).toFixed(1));
  const delta = n => `${n > 0 ? '+' : ''}${number(n)}`;
  return `<section class="performance-panel" aria-label="Performance report"><h3>Performance · ${advisory ? 'Advisory' : 'Required'}</h3><p>${escapeHTML(titleCase(report.assessment.status))}. Donor reads use synthetic accounts with seeded gift history. Closed-loop load; warm-up excluded from assessment.</p><div class="performance-scroll" role="region" aria-label="Performance phase metrics" tabindex="0"><table><caption>Latency includes the complete response and failed requests. Throughput is successful requests per second.</caption><thead><tr><th scope="col">Phase</th><th scope="col">Users</th><th scope="col">Seconds</th><th scope="col">Requests</th><th scope="col">p50 ms</th><th scope="col">p95 ms</th><th scope="col">p99 ms</th><th scope="col">Success/s</th><th scope="col">Errors</th><th scope="col">Timeouts</th></tr></thead><tbody>${report.phases.map(p => `<tr><th scope="row">${escapeHTML(titleCase(p.name))}</th><td>${p.concurrency}</td><td>${number(p.elapsedMs / 1000)}</td><td>${p.requests}</td><td>${number(p.p50Ms)}</td><td>${number(p.p95Ms)}</td><td>${number(p.p99Ms)}</td><td>${number(p.successfulThroughput)}</td><td>${number(p.errorRate === null ? null : p.errorRate * 100)}%</td><td>${p.timeouts}</td></tr>`).join('')}</tbody></table></div><p>Budgets: p95 ${report.profile.criteria.maxP95Ms === null ? 'not set' : `${number(report.profile.criteria.maxP95Ms)} ms`}; errors ${report.profile.criteria.maxErrorRate === null ? 'not set' : `${number(report.profile.criteria.maxErrorRate * 100)}%`}. ${advisory ? 'Results do not block acceptance.' : ''}</p>${report.assessment.reasons.map(r => `<p>${escapeHTML(r)}</p>`).join('')}<h4>Candidate comparison</h4>${
    comparison.comparable
      ? `<p>${comparison.regression ? 'Regression signal detected' : 'No regression signal detected'} against <button class="text-button" data-run="${escapeHTML(comparison.baselineId)}">${escapeHTML(comparison.revision.slice(0, 8))}</button>. Same workload and environment metadata; measurements may still vary.</p><ul>${comparison.changes
          .filter(c => c.endpoint === 'overall' || c.regression)
          .map(
            c =>
              `<li>${escapeHTML(c.phase)}/${escapeHTML(c.endpoint)}: p95 ${delta(c.p95DeltaMs)} ms; success/s ${delta(c.throughputDelta)}; errors ${delta(c.errorRateDelta * 100)} percentage points${c.regression ? ' · regression signal' : ''}</li>`,
          )
          .join('')}</ul>`
      : `<p>${escapeHTML(comparison.reason)}</p>`
  }<p>Environment: ${escapeHTML(report.environment.kind)} · ${escapeHTML(report.environment.platform)} / ${escapeHTML(report.environment.arch)} · ${escapeHTML(report.environment.cpus)} host CPUs. These measurements do not establish production capacity.</p></section>`;
}
async function showRun(id, open = true) {
  try {
    const data = await api(`/api/runs/${id}`);
    const { durationMs, ...stableSummary } = data.summary;
    const fingerprint = JSON.stringify({ ...data, summary: stableSummary }) + JSON.stringify(state.active);
    if (!open && selectedRun === id && detailFingerprint === fingerprint) {
      $('#run-detail .detail-meta small').textContent = `${duration(durationMs)} · ${runLabel(data.summary)}`;
      return;
    }
    selectedRun = id;
    detailFingerprint = fingerprint;
    const { run, summary, comparison, integrity, release } = data;
    const active = state.active?.id === id;
    const openChecks = [...document.querySelectorAll('#run-detail details[open]')].map(element =>
      element.getAttribute('data-check'),
    );
    $('#run-detail').innerHTML =
      `<div class="dialog-top"><div><div class="eyebrow">${summary.mode === 'exploration' ? 'EXPLORATION EVIDENCE' : 'VALIDATION EVIDENCE'}</div><h2 id="run-title">${escapeHTML(date(run.startedAt))}</h2></div><button class="icon-button close-dialog" aria-label="Close run details">×</button></div><div class="detail-meta">${badge(summary.status, summary.mode)}<code class="commit">${escapeHTML(summary.revision.slice(0, 12))}</code><small>${escapeHTML(duration(summary.durationMs))} · ${escapeHTML(runLabel(summary))}</small></div>${discoveryView(data.discovery, id)}${performanceView(data.performance)}<div class="detail-grid"><section aria-label="Checks">${run.results.map(r => `<details class="check-row" data-check="${escapeHTML(r.id)}" ${openChecks.includes(r.id) || r.status !== 'passed' ? 'open' : ''}><summary><span>${escapeHTML(r.id)}${r.required ? '' : ' · advisory'}</span>${badge(!r.finishedAt && active ? 'running' : r.status)}</summary><p>${escapeHTML(!r.finishedAt && active ? 'Check in progress. Evidence appears when the check completes.' : r.summary)}</p><div class="evidence-links">${evidenceLinks(id, r.evidence)}</div></details>`).join('') || '<p>Preparing the candidate…</p>'}</section><aside class="detail-aside"><h3>Local acceptance</h3><p><strong>${release?.scope === 'exploration' ? 'Not applicable — exploration' : release?.eligible ? 'Eligible' : 'Blocked'}</strong> · current assessment</p>${(release?.reasons ?? ['Assessment unavailable.']).map(reason => `<p>${escapeHTML(reason)}</p>`).join('')}<h3>Recorded policy</h3><p>${escapeHTML(run.policy?.definition ? `${run.policy.definition.id} · ${run.policy.definition.version}` : 'Legacy run: no versioned policy')}</p><code class="policy-digest">${escapeHTML(run.policy?.digest ?? '')}</code>${run.policy?.scenarios?.map(s => `<details><summary>${escapeHTML(s.id)} · v${escapeHTML(s.version)}</summary><p>${escapeHTML(s.goal)}</p><strong>Success criteria</strong><ul>${s.successCriteria.map(c => `<li>${escapeHTML(c)}</li>`).join('')}</ul></details>`).join('') ?? ''}${run.release ? `<p>At completion: ${escapeHTML(run.release.status)}. Current evidence and finding assessments may change eligibility.</p>` : ''}<hr><h3>Evidence integrity</h3><div class="integrity ${escapeHTML(integrity.status)}">${integrity.status === 'verified' ? '✓ Recorded evidence hashes match' : 'Evidence needs attention'}</div>${integrity.issues.map(issue => `<p>${escapeHTML(issue)}</p>`).join('')}<hr><h3>Compared with previous run</h3>${comparison ? `<p>${escapeHTML(comparison.revision?.slice(0, 8) ?? 'Unresolved revision')}</p>${comparison.changes.length ? comparison.changes.map(c => `<div class="change"><strong>${escapeHTML(c.check)}</strong>${escapeHTML(c.before)} <span class="arrow">→</span> ${escapeHTML(c.after)}</div>`).join('') : '<p>No check status changes.</p>'}${comparison.removed.length ? `<p>Not present: ${escapeHTML(comparison.removed.join(', '))}</p>` : ''}<button class="text-button" data-run="${escapeHTML(comparison.baselineId)}">View previous run →</button>` : '<p>This is the first comparable run.</p>'}<hr><h3>Acceptance scope</h3><p>Eligibility applies to the recorded local policy. Production promotion is not authorized. Finding triage cannot override a failed required check.</p></aside></div><div class="dialog-actions">${active ? `<button class="button secondary" data-cancel="${escapeHTML(id)}" ${state.active.cancelRequested ? 'disabled' : ''}>${state.active.cancelRequested ? 'Canceling & cleaning up…' : 'Cancel validation'}</button>` : `<button class="button secondary" data-rerun="${escapeHTML(summary.revision)}" data-mode="${escapeHTML(summary.mode)}" ${state.active ? 'disabled' : ''}>Run this revision again</button>`}<button class="button primary close-dialog">Done</button></div>`;
    if (open && !$('#run-dialog').open) $('#run-dialog').showModal();
  } catch (error) {
    if (open) toast(error.message);
  }
}
function reproduction(finding) {
  const occurrence = finding.occurrences.at(-1);
  if (finding.check === 'discovery')
    return `Candidate: ${occurrence.revision}\nActor: ${finding.discovery.actor}\n${JSON.stringify(finding.discovery.reproduction, null, 2)}\n\nStart a new investigation (agent choices may differ):\nnpm run explore -- --repo ${quote(state.project.repo)} --revision ${quote(occurrence.revision ?? 'HEAD')}`;
  return `npm run atm -- run --repo ${quote(state.project.repo)} --revision ${quote(occurrence.revision ?? 'HEAD')}`;
}
function showFinding(id) {
  const finding = state.findings.find(f => f.id === id);
  if (!finding) return;
  selectedFinding = id;
  const occurrence = finding.occurrences.at(-1);
  $('#finding-detail').innerHTML =
    `<form id="triage-form"><div class="dialog-top"><div><div class="eyebrow">FINDING · ${escapeHTML(finding.check)}</div><h2 id="finding-title">${finding.check === 'discovery' ? 'Review an agent hypothesis' : 'Review a check failure'}</h2></div><button type="button" class="icon-button close-dialog" aria-label="Close finding">×</button></div><p>${escapeHTML(finding.title)}</p>${finding.discovery ? `<p><strong>${escapeHTML(finding.discovery.status)}</strong> · Expected behavior needs human review.</p><p>${escapeHTML(finding.discovery.basis)}</p><pre class="repro">${escapeHTML(JSON.stringify(finding.discovery.reproduction, null, 2))}</pre>` : ''}<div class="finding-meta"><span>${finding.occurrences.length} ${finding.occurrences.length === 1 ? 'occurrence' : 'occurrences'}</span><span>·</span><span>First seen ${escapeHTML(date(finding.firstSeen))}</span></div>${finding.latestCheckPassed ? '<div class="notice">This check passed in a later run. Confirm the underlying issue is resolved before closing it.</div>' : ''}<div class="triage-grid"><div><label for="disposition">Triage status</label><select id="disposition">${['untriaged', 'confirmed', 'resolved', 'dismissed'].map(v => `<option ${finding.disposition === v ? 'selected' : ''} value="${v}">${titleCase(v)}</option>`).join('')}</select></div><div><label for="severity">Severity</label><select id="severity">${['unassessed', 'low', 'medium', 'high', 'critical'].map(v => `<option ${finding.severity === v ? 'selected' : ''} value="${v}">${titleCase(v)}</option>`).join('')}</select></div></div><label for="triage-note">Assessment</label><textarea id="triage-note" maxlength="2000" placeholder="What happened, and what should happen next?">${escapeHTML(finding.note)}</textarea><small>A reason is required to resolve or dismiss. Triage does not override a failed check.</small><hr><h3>Reproduce this candidate</h3><pre class="repro">${escapeHTML(reproduction(finding))}</pre><button type="button" class="text-button" data-action="copy-repro">Copy command</button><h3>Latest evidence</h3><div class="evidence-links">${evidenceLinks(occurrence.runId, occurrence.evidence)}</div><p><button type="button" class="text-button" data-run="${escapeHTML(occurrence.runId)}">Open originating run ↗</button></p>${
      finding.audit.length
        ? `<details><summary>Assessment history (${finding.audit.length})</summary>${[...finding.audit]
            .reverse()
            .map(
              entry =>
                `<div class="audit-entry"><strong>${escapeHTML(titleCase(entry.disposition))}</strong> · ${escapeHTML(entry.severity)} · ${escapeHTML(date(entry.updatedAt))}<p>${escapeHTML(entry.note)}</p></div>`,
            )
            .join('')}</details>`
        : ''
    }<div id="triage-error" class="notice error" role="alert" hidden></div><div class="dialog-actions"><button type="button" class="button secondary" data-action="export-finding">Download finding</button><button type="submit" class="button primary">Save assessment</button></div></form>`;
  if (!$('#finding-dialog').open) $('#finding-dialog').showModal();
}
document.addEventListener('click', async event => {
  const button = /** @type {Element} */ (event.target).closest('button');
  if (!button) return;
  if (button.classList.contains('close-dialog')) {
    button.closest('dialog').close();
    return;
  }
  if (button.id === 'new-exploration') openLaunch('exploration');
  if (button.id === 'new-run' || button.dataset.action === 'launch') openLaunch();
  if (button.dataset.run) await showRun(button.dataset.run);
  if (button.dataset.finding) showFinding(button.dataset.finding);
  if (button.dataset.rerun) {
    $('#run-dialog').close();
    openLaunch(button.dataset.mode ?? 'validation');
    $('#revision').value = button.dataset.rerun;
  }
  if (button.dataset.cancel) {
    try {
      button.disabled = true;
      await api(`/api/runs/${button.dataset.cancel}/cancel`, { method: 'POST', body: '{}' });
      toast('Cancellation requested. Cleanup will finish before another run starts.');
      await refresh();
    } catch (error) {
      toast(error.message);
      button.disabled = false;
    }
  }
  if (button.dataset.action === 'watch') {
    if (state.watch.enabled) {
      try {
        await api('/api/watch', { method: 'PATCH', body: JSON.stringify({ enabled: false }) });
        await refresh();
      } catch (error) {
        toast(error.message);
      }
    } else {
      $('#watch-error').hidden = true;
      $('#watch-revision').value = state.watch.revision;
      $('#watch-dialog').showModal();
    }
  }
  if (button.dataset.action === 'copy-repro') {
    try {
      await navigator.clipboard.writeText(reproduction(state.findings.find(f => f.id === selectedFinding)));
      toast('Reproduction command copied.');
    } catch {
      toast('Copy the command from the text above.');
    }
  }
  if (button.dataset.action === 'export-finding') {
    const finding = state.findings.find(f => f.id === selectedFinding);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ ...finding, reproduction: reproduction(finding) }, null, 2)], {
        type: 'application/json',
      }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `atm-finding-${finding.id}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
});
document.addEventListener('input', event => {
  const target = /** @type {HTMLInputElement} */ (event.target);
  if (target.id === 'search') {
    search = target.value;
    render();
  }
});
document.addEventListener('change', event => {
  const target = /** @type {HTMLSelectElement | HTMLInputElement} */ (event.target);
  if (target.id === 'filter') {
    filter = target.value;
    render();
  }
  if (target.id === 'ai') {
    $('#require-ai').disabled = !$('#ai').checked;
    if (!$('#ai').checked) $('#require-ai').checked = false;
  }
});
$('#launch-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#launch-submit').disabled = true;
  $('#launch-error').hidden = true;
  try {
    const run = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({
        mode: launchMode,
        revision: $('#revision').value.trim(),
        ai: $('#ai').checked,
        requireAI: $('#require-ai').checked,
      }),
    });
    $('#launch-dialog').close();
    await refresh();
    await showRun(run.id);
    toast(launchMode === 'exploration' ? 'Exploration started.' : 'Validation started.');
  } catch (error) {
    $('#launch-error').textContent = error.message;
    $('#launch-error').hidden = false;
  } finally {
    $('#launch-submit').disabled = false;
  }
});
$('#watch-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = /** @type {HTMLButtonElement} */ (event.submitter);
  button.disabled = true;
  try {
    await api('/api/watch', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: true, revision: $('#watch-revision').value.trim() }),
    });
    $('#watch-dialog').close();
    await refresh();
    toast('Watching for the next committed revision.');
  } catch (error) {
    $('#watch-error').textContent = error.message;
    $('#watch-error').hidden = false;
  } finally {
    button.disabled = false;
  }
});
document.addEventListener('submit', async event => {
  if (/** @type {HTMLFormElement} */ (event.target).id !== 'triage-form') return;
  event.preventDefault();
  const submit = /** @type {HTMLButtonElement} */ (event.submitter);
  submit.disabled = true;
  try {
    await api(`/api/findings/${selectedFinding}`, {
      method: 'PATCH',
      body: JSON.stringify({
        disposition: $('#disposition').value,
        severity: $('#severity').value,
        note: $('#triage-note').value,
      }),
    });
    $('#finding-dialog').close();
    await refresh();
    toast('Assessment saved. Original run evidence is unchanged.');
  } catch (error) {
    $('#triage-error').textContent = error.message;
    $('#triage-error').hidden = false;
    submit.disabled = false;
  }
});
function navigate() {
  const target = location.hash.slice(1);
  view = ['overview', 'runs', 'findings', 'about'].includes(target) ? target : 'overview';
  search = '';
  filter = 'all';
  render();
}
window.addEventListener('hashchange', navigate);
navigate();
await refresh();
setInterval(refresh, 2500);
