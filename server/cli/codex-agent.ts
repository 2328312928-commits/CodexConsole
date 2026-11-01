// Runs Codex for the console as its own system user (deploy/install.sh starts it as
// codex-console-codex.service). Settings come from the environment:
//   CC_CODEX_AGENT_SOCKET  the Unix socket to listen on (required)
//   CODEX_BIN              the Codex binary (default: the version pinned in package.json)
//   CODEX_HOME, HOME       Codex's own folders
import path from 'node:path';
import { codexChildEnv } from '../codex/bridge.js';
import { startRelay } from '../codex/relay.js';
import { resolvePinnedCodexBin } from '../config.js';

const log = (level: 'info' | 'warn' | 'error') => (obj: object | string, msg?: string) => {
  const line = typeof obj === 'string' ? { msg: obj } : { ...obj, msg };
  process.stderr.write(`${JSON.stringify({ level, time: new Date().toISOString(), ...line })}\n`);
};
const logger = { info: log('info'), warn: log('warn'), error: log('error') };

const socketPath = process.env.CC_CODEX_AGENT_SOCKET?.trim();
if (!socketPath || !path.isAbsolute(socketPath)) {
  logger.error('Set CC_CODEX_AGENT_SOCKET to the absolute path of the socket to listen on');
  process.exit(1);
}

const relay = await startRelay({
  socketPath,
  bin: process.env.CODEX_BIN?.trim() || resolvePinnedCodexBin() || 'codex',
  env: codexChildEnv(),
  logger,
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void relay.close().then(() => process.exit(0));
  });
}
