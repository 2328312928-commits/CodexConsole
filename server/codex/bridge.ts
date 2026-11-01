import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import type { CodexAccount, RateLimitSnapshot } from '../../shared/codex.js';
import { connectRelay, runViaRelay } from './relay.js';
import { RpcError, RpcPeer, type RpcId } from './rpc.js';

const runFile = promisify(execFile);

const WARNING_METHODS = new Set(['warning', 'configWarning', 'deprecationNotice', 'guardianWarning', 'model/rerouted']);

export type BridgeState = 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped';

export interface BridgeStatus {
  state: BridgeState;
  version: string | null;
  userAgent: string | null;
  pid: number | null;
  startedAt: number | null;
  restarts: number;
  lastError: string | null;
  account: CodexAccount | null;
  requiresOpenaiAuth: boolean;
  rateLimits: RateLimitSnapshot | null;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot>;
  rateLimitsAt: number | null;
}

export interface BridgeLogger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

/** What the bridge needs from Codex: the app-server child process, or a connection to it through the relay. */
export interface CodexProcess {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  pid?: number;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: 'error', listener: (err: Error) => void): this;
}

export interface BridgeOptions {
  bin: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  /** Reach Codex through the relay on this socket (Codex runs as its own user) instead of starting it. */
  agentSocket?: string | null;
  clientVersion: string;
  logger: BridgeLogger;
  /** Override restart backoff (tests). */
  minBackoffMs?: number;
}

interface BridgeEvents {
  notification: [method: string, params: any];
  serverRequest: [id: RpcId, method: string, params: any];
  exit: [info: { code: number | null; signal: string | null }];
  ready: [];
  rateLimits: [snapshot: RateLimitSnapshot];
  status: [status: BridgeStatus];
}

const STDERR_LINES = 300;

/** Environment for the Codex child: ours minus the console's own CC_* settings. */
export function codexChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith('CC_')) env[k] = v;
  return env;
}

/** Owns the `codex app-server` child process: spawn, handshake, restart with backoff. */
export class CodexBridge extends EventEmitter<BridgeEvents> {
  private child: CodexProcess | null = null;
  private peer: RpcPeer | null = null;
  private readonly loadedThreads = new Set<string>();
  private readonly stderrTail: string[] = [];
  private readonly warningLog: Array<{ at: number; kind: string; message: string }> = [];
  private readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  private backoffMs: number;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private generation = 0;
  private exitHandled = 0;

  readonly status: BridgeStatus = {
    state: 'stopped',
    version: null,
    userAgent: null,
    pid: null,
    startedAt: null,
    restarts: 0,
    lastError: null,
    account: null,
    requiresOpenaiAuth: true,
    rateLimits: null,
    rateLimitsByLimitId: {},
    rateLimitsAt: null,
  };

  constructor(private readonly opts: BridgeOptions) {
    super();
    this.backoffMs = opts.minBackoffMs ?? 1000;
  }

  start(): void {
    this.stopping = false;
    this.spawnProcess();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    this.setState('stopped');
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      child.stdin?.end();
      child.kill('SIGTERM');
    });
  }

  get ready(): boolean {
    return this.status.state === 'ready';
  }

  get signedIn(): boolean {
    return this.status.account !== null || !this.status.requiresOpenaiAuth;
  }

  stderr(): string[] {
    return [...this.stderrTail];
  }

  /** Recent warnings and notices Codex reported (config problems, deprecations, model reroutes). */
  warnings(): Array<{ at: number; kind: string; message: string }> {
    return [...this.warningLog];
  }

  /** Run a Codex CLI subcommand (e.g. `doctor`) the same way the app-server is started. */
  async runCli(args: string[], timeoutMs = 60_000): Promise<{ ok: boolean; output: string }> {
    if (this.opts.agentSocket) return runViaRelay(this.opts.agentSocket, args, timeoutMs);
    const prefix = (this.opts.args ?? ['app-server']).filter((a) => a !== 'app-server');
    try {
      const { stdout, stderr } = await runFile(this.opts.bin, [...prefix, ...args], { env: this.opts.env ?? codexChildEnv(), timeout: timeoutMs, maxBuffer: 1024 * 1024 });
      return { ok: true, output: `${stdout}${stderr}` };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message: string };
      return { ok: false, output: `${e.stdout ?? ''}${e.stderr ?? ''}` || e.message };
    }
  }

  /** Codex's home folder (config.toml, prompts/, sessions). */
  get codexHome(): string {
    return this.opts.env?.CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  }

  /** The thread has to be loaded again (e.g. to apply thread-level config). */
  markThreadUnloaded(threadId: string): void {
    this.loadedThreads.delete(threadId);
  }

  isThreadLoaded(threadId: string): boolean {
    return this.loadedThreads.has(threadId);
  }

  markThreadLoaded(threadId: string): void {
    this.loadedThreads.add(threadId);
  }

  /** Resolves once the app-server has completed its handshake. */
  waitReady(timeoutMs = 20_000): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.status.state === 'stopped') return Promise.reject(new Error('Codex bridge stopped'));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== waiter);
        reject(new Error('Codex app-server is not ready'));
      }, timeoutMs);
      this.readyWaiters.push(waiter);
    });
  }

  async request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    await this.waitReady();
    if (!this.peer) throw new RpcError(-32099, 'Codex connection closed');
    return this.peer.request<T>(method, params, timeoutMs);
  }

  respond(id: RpcId, result: unknown): void {
    this.peer?.respond(id, result);
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.peer?.respondError(id, code, message);
  }

  async refreshAccount(): Promise<void> {
    const res = await this.request<{ account: CodexAccount | null; requiresOpenaiAuth: boolean }>('account/read', {});
    this.status.account = res.account;
    this.status.requiresOpenaiAuth = res.requiresOpenaiAuth;
    this.emitStatus();
  }

  async refreshRateLimits(): Promise<RateLimitSnapshot | null> {
    if (!this.signedIn) return null;
    try {
      const res = await this.request<{
        rateLimits: RateLimitSnapshot;
        rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null;
      }>('account/rateLimits/read', undefined, 30_000);
      this.status.rateLimits = res.rateLimits;
      this.status.rateLimitsByLimitId = res.rateLimitsByLimitId ?? {};
      this.status.rateLimitsAt = Date.now();
      this.emit('rateLimits', res.rateLimits);
      this.emitStatus();
      return res.rateLimits;
    } catch (err) {
      this.opts.logger.warn({ err: (err as Error).message }, 'Could not read Codex rate limits');
      return null;
    }
  }

  private setState(state: BridgeState, error?: string): void {
    this.status.state = state;
    if (error !== undefined) this.status.lastError = error;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.emit('status', this.status);
  }

  private spawnProcess(): void {
    const gen = ++this.generation;
    this.setState(this.status.restarts > 0 ? 'restarting' : 'starting');
    this.loadedThreads.clear();
    let child: CodexProcess;
    try {
      child = this.opts.agentSocket
        ? connectRelay(this.opts.agentSocket)
        : spawn(this.opts.bin, this.opts.args ?? ['app-server'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: this.opts.env ?? codexChildEnv(),
            windowsHide: true,
          });
    } catch (err) {
      this.onSpawnFailure(gen, (err as Error).message);
      return;
    }
    this.child = child;
    const peer = new RpcPeer((line) => {
      if (child.stdin && !child.stdin.destroyed) child.stdin.write(line);
    });
    this.peer = peer;

    child.stdin?.on('error', () => undefined);
    readline.createInterface({ input: child.stdout! }).on('line', (line) => peer.handleLine(line));
    readline.createInterface({ input: child.stderr! }).on('line', (line) => {
      this.stderrTail.push(line.slice(0, 2000));
      if (this.stderrTail.length > STDERR_LINES) this.stderrTail.shift();
    });
    peer.on('notification', (method, params) => this.onNotification(method, params));
    peer.on('request', (id, method, params) => this.emit('serverRequest', id, method, params));
    peer.on('protocolError', (line) => this.opts.logger.warn({ line }, 'Non-JSON output from codex app-server'));

    child.once('error', (err) => this.onSpawnFailure(gen, err.message));
    child.once('exit', (code, signal) => this.onExit(gen, code, signal));

    void this.handshake(gen, peer, child);
  }

  private async handshake(gen: number, peer: RpcPeer, child: CodexProcess): Promise<void> {
    try {
      const init = await peer.request<{ userAgent: string }>(
        'initialize',
        {
          clientInfo: { name: 'codex_console', title: 'Codex Console', version: this.opts.clientVersion },
          // Plan mode, background terminals and memories are only on the experimental API.
          // The Codex version is pinned and `npm run codex:check` verifies every method used.
          capabilities: { experimentalApi: true, requestAttestation: false },
        },
        30_000,
      );
      if (gen !== this.generation) return;
      peer.notify('initialized');
      this.status.userAgent = init.userAgent;
      this.status.version = /^[^/]+\/(\S+)/.exec(init.userAgent)?.[1] ?? null;
      this.status.pid = child.pid ?? null;
      this.status.startedAt = Date.now();
      this.status.lastError = null;
      this.setState('ready');
      for (const w of this.readyWaiters.splice(0)) w.resolve();
      this.emit('ready');
      this.opts.logger.info({ version: this.status.version, pid: child.pid }, 'Codex app-server ready');
      await this.refreshAccount().catch((err) => this.opts.logger.warn({ err: err.message }, 'account/read failed'));
      await this.refreshRateLimits();
      // A process that stays up for a minute resets the restart backoff.
      setTimeout(() => {
        if (gen === this.generation && this.ready) this.backoffMs = this.opts.minBackoffMs ?? 1000;
      }, 60_000).unref();
    } catch (err) {
      if (gen !== this.generation) return;
      this.opts.logger.error({ err: (err as Error).message }, 'Codex app-server handshake failed');
      this.status.lastError = (err as Error).message;
      child.kill('SIGTERM');
    }
  }

  private onNotification(method: string, params: any): void {
    if (method === 'account/rateLimits/updated' && params?.rateLimits) {
      const snap = params.rateLimits as RateLimitSnapshot;
      if (snap.limitId && this.status.rateLimits?.limitId && snap.limitId !== this.status.rateLimits.limitId) {
        this.status.rateLimitsByLimitId[snap.limitId] = snap;
      } else {
        this.status.rateLimits = snap;
      }
      this.status.rateLimitsAt = Date.now();
      this.emit('rateLimits', snap);
      this.emitStatus();
    } else if (method === 'account/updated' || method === 'account/login/completed') {
      void this.refreshAccount().catch(() => undefined);
    } else if (WARNING_METHODS.has(method)) {
      const p = params as { message?: unknown; summary?: unknown; details?: unknown; fromModel?: unknown; toModel?: unknown } | undefined;
      const message =
        method === 'model/rerouted'
          ? `${String(p?.fromModel ?? '?')} → ${String(p?.toModel ?? '?')}`
          : String(p?.message ?? p?.summary ?? p?.details ?? JSON.stringify(params ?? {})).slice(0, 1000);
      this.warningLog.push({ at: Date.now(), kind: method, message });
      if (this.warningLog.length > 100) this.warningLog.shift();
    }
    this.emit('notification', method, params);
  }

  private onSpawnFailure(gen: number, message: string): void {
    if (gen !== this.generation) return;
    this.opts.logger.error({ bin: this.opts.agentSocket ? `relay ${this.opts.agentSocket}` : this.opts.bin, err: message }, 'Could not start codex app-server');
    this.status.lastError = message;
    this.onExit(gen, null, null);
  }

  private onExit(gen: number, code: number | null, signal: NodeJS.Signals | null): void {
    // 'error' and 'exit' can both fire for one process; handle each generation once.
    if (gen !== this.generation || this.exitHandled === gen) return;
    this.exitHandled = gen;
    this.peer?.close('Codex app-server exited');
    this.peer = null;
    this.child = null;
    this.status.pid = null;
    this.loadedThreads.clear();
    for (const w of this.readyWaiters.splice(0)) w.reject(new Error('Codex app-server exited'));
    this.emit('exit', { code, signal });
    if (this.stopping) return;
    this.status.restarts++;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    this.setState('failed', this.status.lastError ?? `exited (code ${code}, signal ${signal})`);
    this.opts.logger.warn({ code, signal, retryInMs: delay }, 'Codex app-server exited; restarting');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.spawnProcess();
    }, delay);
    this.restartTimer.unref();
  }
}
