// `npm run test:contract`: the contract test against an `openapi.json` from, in this order:
//   OPENAPI_FILE  a local file;
//   OPENAPI_URL   a published document (staging: https://synergy-crm.gabriel-221.workers.dev/openapi.json);
//   neither       the one this monorepo's server code produces (scripts/local-openapi.ts, needs `tsx` in the repo).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const env = {};
if (!process.env.OPENAPI_FILE && !process.env.OPENAPI_URL) {
  run('npx', ['tsx', '--tsconfig', '../../tsconfig.api.json', 'scripts/local-openapi.ts', '.openapi-local.json']);
  env.OPENAPI_FILE = '.openapi-local.json';
}
run('npx', ['vitest', 'run', '--config', 'vitest.contract.config.ts'], env);
