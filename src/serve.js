import { parseArgs } from 'node:util';
import { createDashboardServer } from './dashboard.js';
import { redact } from './core.js';

process.umask(0o077);
const { values } = parseArgs({
  options: {
    repo: { type: 'string' },
    output: { type: 'string', default: '.atm/runs' },
    policy: { type: 'string' },
    target: { type: 'string', default: 'dad' },
    config: { type: 'string' },
    port: { type: 'string', default: '4310' },
    help: { type: 'boolean' },
  },
});
if (values.help) {
  console.log(
    'npm start -- --repo /path/to/repo [--target dad|generic-web] [--config atm.config.json] [--port 4310] [--output .atm/runs] [--policy FILE]',
  );
} else {
  const fail = message => {
    console.error(message);
    process.exitCode = 1;
  };
  const port = Number(values.port);
  const problem = !values.repo
    ? 'Use: npm start -- --repo /path/to/repo [--target dad|generic-web]'
    : !Number.isInteger(port) || port < 1 || port > 65535
      ? 'Port must be between 1 and 65535.'
      : values.config !== undefined && values.target !== 'generic-web'
        ? '--config applies only to --target generic-web.'
        : undefined;
  if (problem) fail(problem);
  else
    createDashboardServer({
      repo: values.repo,
      root: values.output,
      port,
      policy: values.policy,
      target: values.target,
      configFile: values.config,
    })
      .then(app => {
        console.log(
          `ATM dashboard: ${app.origin}\nRepository: ${app.dashboard.repo}\nStop with Ctrl-C. Active validation will be canceled and cleaned up.`,
        );
        let stopping = false;
        const stop = async () => {
          if (stopping) return;
          stopping = true;
          console.log('Stopping dashboard; waiting for run cleanup…');
          await app.close();
        };
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
      })
      .catch(error => fail(redact(error.message)));
}
