import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import type { BridgeLogger, CodexProcess } from './bridge.js';
import { MCP_NAME_RE } from './mcp.js';

const runFile = promisify(execFile);

/** The first line a client sends, at most this long: `{"cmd":["app-server"]}`. */
const MAX_HEADER = 4096;
const HEADER_TIMEOUT_MS = 5000;

export interface RelayOptions {
  /** Unix socket the console connects to. */
  socketPath: string;
  bin: string;
  /** Arguments before the Codex command (tests run the fake Codex as `node fake.mjs …`). */
  binArgs?: string[];
  env: NodeJS.ProcessEnv;
  logger: BridgeLogger;
  /** App-server connections at once (the console needs one; a reconnect can briefly overlap). */
  maxAppServers?: number;
}

/**
 * The commands the console may run through the relay: the app-server itself, `doctor`, and
 * signing out of one MCP server. Nothing else, and never with other arguments.
 */
export function allowedCommand(cmd: unknown): string[] | null {
  if (!Array.isArray(cmd) || !cmd.every((a): a is string => typeof a === 'string')) return null;
  const [name, sub, arg] = cmd as string[];
  if (cmd.length === 1 && (name === 'app-server' || name === 'doctor')) return [name];
  if (cmd.length === 3 && name === 'mcp' && sub === 'logout' && MCP_NAME_RE.test(arg!)) return ['mcp', 'logout', arg!];
  return null;
}

/**
 * Runs Codex for the console as Codex's own system user (`codex-console-codex.service`), so Codex
 * cannot read or change the console's data. Codex's own app-server socket only lets its owner in,
 * so this relay listens on a socket the console's group may use and starts Codex per connection.
 *
 * Protocol: the client sends one JSON line `{"cmd":[…]}`. For `app-server` the rest of the
 * connection is the app-server's stdin/stdout (JSON-RPC lines); other commands answer with one
 * line `{"code":…,"output":"…"}` and close.
 */
export async function startRelay(opts: RelayOptions): Promise<{ server: net.Server; close: () => Promise<void> }> {
  const { socketPath, bin, logger } = opts;
  const binArgs = opts.binArgs ?? [];
  const maxAppServers = opts.maxAppServers ?? 4;
  const children = new Set<ChildProcess>();

  const reply = (sock: net.Socket, body: object) => {
    sock.end(`${JSON.stringify(body)}\n`);
  };

  const runAppServer = (sock: net.Socket, rest: Buffer) => {
    if (children.size >= maxAppServers) return reply(sock, { error: 'busy' });
    const child = spawn(bin, [...binArgs, 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'], env: opts.env });
    children.add(child);
    let killTimer: NodeJS.Timeout | null = null;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null || killTimer) return;
      child.stdin?.end();
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
      killTimer.unref();
    };
    child.stdin!.on('error', () => undefined);
    // Codex's log goes to this service's journal; its stdout is the JSON-RPC stream.
    child.stderr!.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    if (rest.length) child.stdin!.write(rest);
    sock.pipe(child.stdin!);
    child.stdout!.pipe(sock);
    child.once('error', (err) => {
      logger.error({ err: err.message }, 'Could not start codex app-server');
      sock.destroy();
    });
    child.once('exit', (code, signal) => {
      children.delete(child);
      if (killTimer) clearTimeout(killTimer);
      logger.info({ code, signal }, 'codex app-server exited');
      sock.end();
    });
    sock.once('close', stop);
    sock.on('error', stop);
  };

  const runCommand = async (sock: net.Socket, cmd: string[]) => {
    const timeout = cmd[0] === 'doctor' ? 90_000 : 30_000;
    try {
      const { stdout, stderr } = await runFile(bin, [...binArgs, ...cmd], { env: opts.env, timeout, maxBuffer: 1024 * 1024 });
      reply(sock, { code: 0, output: `${stdout}${stderr}` });
    } catch (err) {
      const e = err as { code?: unknown; stdout?: string; stderr?: string; message: string };
      reply(sock, { code: typeof e.code === 'number' ? e.code : 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` || e.message });
    }
  };

  const server = net.createServer((sock) => {
    let header = Buffer.alloc(0);
    const timer = setTimeout(() => sock.destroy(), HEADER_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      header = Buffer.concat([header, chunk]);
      const nl = header.indexOf(0x0a);
      if (nl === -1) {
        if (header.length > MAX_HEADER) sock.destroy();
        return;
      }
      clearTimeout(timer);
      sock.off('data', onData);
      sock.pause();
      let cmd: string[] | null = null;
      try {
        cmd = allowedCommand((JSON.parse(header.subarray(0, nl).toString('utf8')) as { cmd?: unknown }).cmd);
      } catch {
        cmd = null;
      }
      if (!cmd) {
        logger.warn('Refused a relay request outside the allowed commands');
        return reply(sock, { error: 'not_allowed' });
      }
      const rest = header.subarray(nl + 1);
      if (cmd[0] === 'app-server') runAppServer(sock, rest);
      else void runCommand(sock, cmd);
      sock.resume();
    };
    sock.on('data', onData);
    sock.on('error', () => clearTimeout(timer));
  });

  // A socket left over from a previous run would make listen() fail.
  fs.rmSync(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  // The console (in the shared group) may connect; nobody else.
  fs.chmodSync(socketPath, 0o660);
  logger.info({ socket: socketPath }, 'Codex relay listening');

  return {
    server,
    async close() {
      for (const child of children) child.kill('SIGTERM');
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---- the console's side ----

/**
 * Connect to the relay's app-server. The result behaves like the app-server child process
 * (stdin, stdout, `exit`, `kill`), so the bridge drives both the same way.
 */
export function connectRelay(socketPath: string): CodexProcess {
  const sock = net.createConnection(socketPath);
  const proc = Object.assign(new EventEmitter(), {
    stdin: sock,
    stdout: sock,
    // Codex's own log stays in the relay's journal.
    stderr: new PassThrough(),
    pid: undefined,
    exitCode: null as number | null,
    kill: () => {
      sock.destroy();
      return true;
    },
  });
  sock.write(`${JSON.stringify({ cmd: ['app-server'] })}\n`);
  sock.on('error', (err) => proc.emit('error', err));
  sock.once('close', (hadError) => {
    proc.exitCode = hadError ? 1 : 0;
    proc.stderr.end();
    proc.emit('exit', proc.exitCode, null);
  });
  return proc as unknown as CodexProcess;
}

/** Run `doctor` or `mcp logout <name>` through the relay. */
export function runViaRelay(socketPath: string, cmd: string[], timeoutMs: number): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath);
    let data = '';
    let done = false;
    const finish = (r: { ok: boolean; output: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, output: 'Codex did not answer in time' }), timeoutMs + 5000);
    sock.setEncoding('utf8');
    sock.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) finish({ ok: false, output: 'answer too long' });
    });
    sock.on('error', (err) => finish({ ok: false, output: err.message }));
    sock.on('end', () => {
      try {
        const r = JSON.parse(data.trim()) as { code?: number; output?: string; error?: string };
        finish(r.error ? { ok: false, output: r.error } : { ok: r.code === 0, output: r.output ?? '' });
      } catch {
        finish({ ok: false, output: 'unreadable answer from the Codex relay' });
      }
    });
    sock.write(`${JSON.stringify({ cmd })}\n`);
  });
}
