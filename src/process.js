import { spawn } from 'node:child_process';
import { RunError } from './core.js';

// Deliberately omit application credentials, NODE_OPTIONS and cloud-provider settings.
export function cleanEnvironment(extra = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: 'en_US.UTF-8',
    CI: '1',
    NO_COLOR: '1',
    NEXT_TELEMETRY_DISABLED: '1',
  };
  for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return { ...env, ...extra };
}

/**
 * @param {string} binary
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string, string>, timeout?: number, signal?: AbortSignal, input?: string,
 *   failureStatus?: string, maxBytes?: number}} [options]
 */
export async function command(
  binary,
  args,
  { cwd, env, timeout = 120_000, signal, input, failureStatus = 'inconclusive', maxBytes = 8_000_000 } = {},
) {
  if (signal?.aborted) throw new RunError('Run canceled.', 'canceled');
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env: cleanEnvironment(env),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const chunks = { stdout: [], stderr: [] };
    let bytes = 0,
      reason,
      killTimer;
    const kill = force => {
      try {
        if (process.platform === 'win32') child.kill(force ? 'SIGKILL' : 'SIGTERM');
        else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch {}
    };
    const stop = why => {
      if (reason) return;
      reason = why;
      kill(false);
      killTimer = setTimeout(() => kill(true), 2_000);
    };
    const abort = () => stop('canceled');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('timeout'), timeout);
    for (const stream of ['stdout', 'stderr'])
      child[stream].on('data', chunk => {
        bytes += chunk.length;
        if (bytes <= maxBytes) chunks[stream].push(chunk);
        else stop('output limit');
      });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
    };
    child.once('error', error => {
      cleanup();
      reject(new RunError(`${binary} could not start: ${error.message}`));
    });
    child.once('close', (code, termSignal) => {
      // The leader can exit on SIGTERM while a descendant in its group ignores it.
      if (reason && process.platform !== 'win32') kill(true);
      cleanup();
      const output = Object.fromEntries(
        Object.entries(chunks).map(([key, values]) => [key, Buffer.concat(values).toString('utf8')]),
      );
      if (reason || code !== 0) {
        const error = new RunError(
          reason ? `${binary}: ${reason}` : `${binary} exited ${code ?? termSignal}`,
          reason === 'canceled' ? 'canceled' : reason ? 'inconclusive' : failureStatus,
        );
        Object.assign(error, output, { exitCode: code });
        reject(error);
      } else resolve({ ...output, exitCode: code });
    });
  });
}
