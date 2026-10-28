import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { TESTED_CODEX_VERSION, USED_CLIENT_REQUESTS, USED_SERVER_NOTIFICATIONS, USED_SERVER_REQUESTS } from '../../shared/codex.js';
import { codexChildEnv } from '../codex/bridge.js';
import { RpcPeer } from '../codex/rpc.js';
import { ConfigError, loadConfig, loadDotEnv } from '../config.js';

const run = promisify(execFile);

/** Collect every `properties.method.enum` value from a generated JSON schema. */
function methodsIn(file: string): Set<string> {
  const out = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') {
      const n = node as Record<string, any>;
      const e = n.properties?.method?.enum;
      if (Array.isArray(e)) for (const m of e) if (typeof m === 'string') out.add(m);
      for (const v of Object.values(n)) visit(v);
    }
  };
  visit(JSON.parse(fs.readFileSync(file, 'utf8')));
  return out;
}

/**
 * Checks that the configured Codex binary speaks every protocol method this console
 * uses, then performs a read-only handshake. It never logs in or sends a prompt.
 * `--schema` also writes TypeScript bindings to .codex-schema/ for reference.
 */
async function main(): Promise<void> {
  loadDotEnv();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const bin = config.codex.bin;
  const env = codexChildEnv();
  console.log(`Codex binary: ${bin}`);
  const { stdout: versionOut } = await run(bin, ['--version'], { env });
  const version = versionOut.trim().split(/\s+/).pop() ?? '';
  console.log(`Version: ${version} (console tested with ${TESTED_CODEX_VERSION})`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-console-schema-'));
  let problems = 0;
  try {
    // The console uses the experimental API (Plan mode, background terminals, memories).
    await run(bin, ['app-server', 'generate-json-schema', '--experimental', '--out', tmp], { env });
    const checks: Array<[string, readonly string[]]> = [
      ['ClientRequest.json', USED_CLIENT_REQUESTS],
      ['ServerNotification.json', USED_SERVER_NOTIFICATIONS],
      ['ServerRequest.json', USED_SERVER_REQUESTS],
    ];
    for (const [file, used] of checks) {
      const available = methodsIn(path.join(tmp, file));
      const missing = used.filter((m) => !available.has(m));
      problems += missing.length;
      console.log(`${file}: ${used.length - missing.length}/${used.length} methods available${missing.length ? ` — MISSING: ${missing.join(', ')}` : ''}`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (process.argv.includes('--schema')) {
    const dir = path.resolve('.codex-schema');
    fs.rmSync(dir, { recursive: true, force: true });
    await run(bin, ['app-server', 'generate-ts', '--out', dir], { env });
    console.log(`TypeScript bindings written to ${dir}`);
  }

  // Read-only handshake: initialize, account status, model list.
  const child = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], env });
  const peer = new RpcPeer((line) => child.stdin.write(line));
  readline.createInterface({ input: child.stdout }).on('line', (l) => peer.handleLine(l));
  peer.on('request', (id) => peer.respondError(id, -32601, 'not supported by codex:check'));
  try {
    await peer.request('initialize', {
      clientInfo: { name: 'codex_console_check', title: 'Codex Console check', version: '1' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    peer.notify('initialized');
    const acct = await peer.request<{ account: { type: string; planType?: string } | null; requiresOpenaiAuth: boolean }>('account/read', {});
    const signedIn = acct.account !== null || !acct.requiresOpenaiAuth;
    console.log(`Handshake: ok. Signed in: ${signedIn ? `yes (${acct.account?.type}${acct.account?.planType ? `, ${acct.account.planType}` : ''})` : 'NO — run `codex login` on this machine'}`);
    const models = await peer.request<{ data: unknown[] }>('model/list', { limit: 100 });
    console.log(`Models available: ${models.data.length}`);
  } catch (err) {
    problems++;
    console.error(`Handshake failed: ${(err as Error).message}`);
  } finally {
    peer.close();
    child.kill('SIGTERM');
  }
  if (version !== TESTED_CODEX_VERSION) console.log(`Note: version differs from the tested ${TESTED_CODEX_VERSION}.`);
  console.log(problems === 0 ? 'Result: compatible.' : `Result: ${problems} problem(s) found.`);
  process.exit(problems === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
