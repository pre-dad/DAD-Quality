import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rename, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';

export class RunError extends Error {
  constructor(message, status = 'inconclusive') {
    super(message);
    this.status = status;
  }
}

export const digest = value => createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();

export function redact(value) {
  return String(value)
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi, '$1[REDACTED]@')
    .replace(
      /([?#&](?:token|secret|key|code|password|passwd|api_key|apikey|access_token)=)[^\s&#"']+/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(?:sk|rk)-(?:proj-)?[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9]+\b|\bwhsec_[A-Za-z0-9]+\b/g, '[REDACTED]')
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g,
      '[REDACTED]',
    )
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/((?:authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]');
}

// Redacting values rather than serialized text keeps hostile page content such as
// "Cookie: ..." from breaking the JSON structure.
export const redactJSON = value =>
  JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === 'string' ? redact(item) : item)));

export function evaluate(required, results) {
  if (!required.length || new Set(required).size !== required.length) {
    return { status: 'inconclusive', eligible: false, reasons: ['Required checks must be nonempty and unique.'] };
  }
  const checks = required.map(id => {
    const matches = results.filter(r => r.id === id);
    if (matches.length !== 1 || !['passed', 'failed', 'inconclusive', 'canceled'].includes(matches[0].status)) {
      return { id, status: 'inconclusive', summary: 'Missing, duplicate, or invalid result.' };
    }
    return matches[0];
  });
  const status = ['failed', 'canceled', 'inconclusive'].find(s => checks.some(c => c.status === s)) ?? 'passed';
  return {
    status,
    eligible: status === 'passed',
    reasons: checks.filter(c => c.status !== 'passed').map(c => `${c.id}: ${c.summary}`),
  };
}

export async function atomicJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export async function verifyEvidence(directory, run) {
  const issues = [];
  for (const result of run.results) {
    for (const item of result.evidence ?? []) {
      const relative = item.path;
      if (typeof relative !== 'string' || !/^evidence\/[A-Za-z0-9_.-]+$/.test(relative)) {
        issues.push(`${result.id}: invalid evidence path`);
        continue;
      }
      try {
        if (
          !(await lstat(path.join(directory, 'evidence'))).isDirectory() ||
          !(await lstat(path.join(directory, relative))).isFile()
        )
          throw new Error('Evidence must be a regular file');
        const bytes = await readFile(path.join(directory, relative));
        if (digest(bytes) !== item.sha256 || bytes.length !== item.bytes)
          issues.push(`${result.id}: changed evidence ${relative}`);
      } catch {
        issues.push(`${result.id}: missing evidence ${relative}`);
      }
    }
  }
  return issues;
}

const escapeHTML = value =>
  String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function reportHTML(run) {
  const decision = run.decision;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'">
<title>ATM · ${escapeHTML(run.id)}</title><style>
body{font:16px/1.6 system-ui,sans-serif;margin:40px auto;padding:0 24px;max-width:1000px;color:#172433;background:#f5f7fa}
h1{font-size:32px;line-height:1.2}small{color:#43556b}table{border-collapse:collapse;width:100%;background:white}td,th{text-align:left;padding:12px;border-bottom:1px solid #d6dee7;vertical-align:top}code{overflow-wrap:anywhere}a{color:#1250a3}.status{font-weight:700}li{margin:8px 0}pre{white-space:pre-wrap}header{border-bottom:4px solid #314d79;margin-bottom:28px}footer{margin-top:30px}
</style><header><small>ATM / ${run.options?.mode === 'exploration' ? 'AUTONOMOUS DISCOVERY' : 'LOCAL VALIDATION'}</small><h1>${escapeHTML(run.options?.mode === 'exploration' && decision.status === 'passed' ? 'EXPLORATION COMPLETED' : decision.status.toUpperCase())}</h1>
<p>${run.options?.mode === 'exploration' ? 'Review discovered capabilities, hypotheses and reproduction evidence in discovery.json. Completion does not mean the application is bug-free.' : decision.eligible ? 'Selected local checks passed.' : 'Selected local checks do not authorize acceptance.'} This report does not authorize a production release.</p></header>
${run.release ? `<section><h2>Local acceptance: ${escapeHTML(run.release.status)}</h2>${run.policy?.definition ? `<p>Policy ${escapeHTML(run.policy.definition.id)} ${escapeHTML(run.policy.definition.version)} · <code>${escapeHTML(run.policy.digest)}</code></p>` : '<p>No versioned acceptance policy recorded.</p>'}<p>Assessment captured at completion. Use inspect or the dashboard to reassess current findings and evidence.</p><ul>${run.release.reasons.map(reason => `<li>${escapeHTML(reason)}</li>`).join('')}</ul></section>` : ''}
<p>Run <code>${escapeHTML(run.id)}</code><br>Revision <code>${escapeHTML(run.candidate?.revision ?? 'unresolved')}</code><br>Started ${escapeHTML(run.startedAt)}<br>Finished ${escapeHTML(run.finishedAt ?? 'running')}</p>
<table><thead><tr><th>Check</th><th>Result</th><th>Evidence</th></tr></thead><tbody>${run.results.map(r => `<tr><td>${escapeHTML(r.id)}${r.required ? '' : ' (advisory)'}</td><td><span class="status">${escapeHTML(r.status)}</span><br>${escapeHTML(r.summary)}</td><td>${(r.evidence ?? []).map(e => `<a href="${escapeHTML(e.path)}">${escapeHTML(e.path)}</a>`).join('<br>')}</td></tr>`).join('')}</tbody></table>
<ul>${decision.reasons.map(reason => `<li>${escapeHTML(reason)}</li>`).join('')}</ul>
<footer><a href="run.json">Machine-readable manifest</a> · Evidence is private and may include synthetic credentials in browser traces.</footer></html>`;
}

export class Run {
  static async create(root, options, required, policy) {
    const id = `atm-${new Date()
      .toISOString()
      .replace(/[^0-9]/g, '')
      .slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const dir = path.resolve(root, id);
    await mkdir(path.join(dir, 'evidence'), { recursive: true, mode: 0o700 });
    const run = new Run(dir, {
      schemaVersion: policy ? 2 : 1,
      id,
      startedAt: now(),
      options,
      required,
      policy: policy ?? { version: 1, scope: 'local-validation', digest: digest(JSON.stringify(required)) },
      results: [],
      decision: evaluate(required, []),
    });
    await run.save();
    return run;
  }
  constructor(dir, data) {
    this.dir = dir;
    this.data = data;
  }
  async save() {
    this.data.decision = evaluate(this.data.required, this.data.results);
    if (this.data.canceledAt)
      this.data.decision = {
        status: 'canceled',
        eligible: false,
        reasons: ['Run canceled; inspect cleanup before retrying.'],
      };
    await atomicJSON(path.join(this.dir, 'run.json'), this.data);
    await writeFile(path.join(this.dir, 'report.html'), reportHTML(this.data), { mode: 0o600 });
  }
  async evidence(relative, content) {
    const file = path.join(this.dir, 'evidence', relative);
    let safe = redact(content);
    if (relative.endsWith('.json')) {
      try {
        safe = JSON.stringify(redactJSON(JSON.parse(content)), null, 2);
      } catch {
        /* Retain malformed diagnostic payloads as redacted text. */
      }
    }
    await writeFile(file, safe, { mode: 0o600 });
    return this.reference(`evidence/${relative}`);
  }
  async reference(relative) {
    const content = await readFile(path.join(this.dir, relative));
    return { path: relative, sha256: digest(content), bytes: content.length };
  }
  async step(id, action) {
    const result = {
      id,
      required: this.data.required.includes(id),
      status: 'inconclusive',
      startedAt: now(),
      evidence: [],
      summary: 'Interrupted before completion.',
    };
    this.data.results.push(result);
    await this.save();
    process.stdout.write(`→ ${id}\n`);
    try {
      const outcome = await action(result);
      Object.assign(result, { status: 'passed', summary: 'Completed.' }, outcome);
    } catch (error) {
      result.status = error.status ?? 'inconclusive';
      result.summary = redact(error.message);
    }
    result.finishedAt = now();
    await this.save();
    process.stdout.write(`  ${result.status}: ${result.summary}\n`);
    return result.status === 'passed';
  }
  async finish() {
    this.data.finishedAt = now();
    await this.save();
  }
}
