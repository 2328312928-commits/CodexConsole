// Development mode: rebuild the UI on change and restart the server on change.
//   npm run dev                 -> uses your real Codex (needs `codex login`)
//   npm run dev -- --fake-codex -> uses the bundled fake app-server (no login, no OpenAI calls)
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const env = { ...process.env };
if (process.argv.includes('--fake-codex')) {
  env.CODEX_BIN = fileURLToPath(new URL('../test/fake-codex/app-server.mjs', import.meta.url));
}
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const procs = [
  spawn(npx, ['vite', 'build', '--watch', '--config', 'web/vite.config.ts'], { stdio: 'inherit', env }),
  spawn(npx, ['tsx', 'watch', '--clear-screen=false', 'server/index.ts'], { stdio: 'inherit', env }),
];
const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
