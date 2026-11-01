import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  checkServer,
  confirmSsh,
  deploy,
  HostKeyChangedError,
  newSetupLink,
  recoveryKey,
  RemoteError,
  UnknownHostError,
  type Connection,
  type DeployStep,
  type Site,
} from './remote.js';
import type { SavedServer, Store } from './store.js';

export interface BuildInfo {
  version: string;
  consoleVersion: string;
  consoleCommit: string;
}

export interface ServerOptions {
  store: Store;
  /** page.html, with __NONCE__ where each response's CSP nonce goes. */
  page: string;
  /** deploy/install.sh, for "Check server". */
  installer: string;
  /** The console's files as .tar.gz, for "Deploy". */
  bundle: Buffer;
  info: BuildInfo;
  port?: number;
  /** Where to look for SSH keys (default ~/.ssh). */
  sshDir?: string;
  onQuit?: () => void;
}

export interface RunningServer {
  /** Open this in the browser: it carries the token. */
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
}

type JobKind = 'check' | 'deploy' | 'confirm' | 'setup-link' | 'recovery-key';

interface JobError {
  code: string;
  detail?: string;
  hostPort?: string;
  fingerprint?: string;
  previous?: string;
}

interface Job {
  id: string;
  kind: JobKind;
  lines: string[];
  step: DeployStep | null;
  done: boolean;
  ok: boolean;
  result: unknown;
  error: JobError | null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly field?: string,
  ) {
    super(code);
  }
}

const MAX_BODY = 256 * 1024;
const MAX_LINES = 20_000;
const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY',
};
const HOST_RE = /^[A-Za-z0-9.:-]{1,253}$/;
const USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,31}$/;
const DOMAIN_RE = /^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KEY_NAME_RE = /^id_[A-Za-z0-9_-]+$/;

/** Private keys in ~/.ssh, by file name (OpenSSH's default names, and any other id_* file). */
export function findKeys(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => KEY_NAME_RE.test(n));
  } catch {
    return [];
  }
  const order = ['id_ed25519', 'id_ecdsa', 'id_rsa'];
  names.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
  return names.filter((n) => {
    try {
      const fd = fs.openSync(path.join(dir, n), 'r');
      try {
        const head = Buffer.alloc(40);
        fs.readSync(fd, head, 0, head.length, 0);
        return head.toString('latin1').startsWith('-----BEGIN ');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
  });
}

function str(v: unknown, max: number, field: string): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, 'invalid', field);
  return v;
}

function readSite(raw: unknown): Site {
  const b = (raw ?? {}) as Record<string, unknown>;
  const lang = b.lang === 'zh-CN' ? 'zh-CN' : 'en';
  const email = str(b.email, 254, 'email').trim();
  if (email && !EMAIL_RE.test(email)) throw new HttpError(400, 'invalid', 'email');
  if (b.mode === 'domain') {
    const domain = str(b.domain, 253, 'domain').trim().toLowerCase();
    if (!DOMAIN_RE.test(domain)) throw new HttpError(400, 'invalid', 'domain');
    return { mode: 'domain', domain, email, lang };
  }
  if (b.mode !== 'ip') throw new HttpError(400, 'invalid', 'mode');
  return { mode: 'ip', email, lang };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...HEADERS });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(new HttpError(413, 'too_large'));
      try {
        resolve(size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'bad_request'));
      }
    });
    req.on('error', reject);
  });
}

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** What went wrong, as a code the page has words for. */
function describe(err: unknown, previous: (hostPort: string) => string | undefined): JobError {
  if (err instanceof UnknownHostError) return { code: 'unknown_host', hostPort: err.hostPort, fingerprint: err.fingerprint };
  if (err instanceof HostKeyChangedError) return { code: 'host_key_changed', hostPort: err.hostPort, fingerprint: err.fingerprint, previous: previous(err.hostPort) };
  if (err instanceof RemoteError) return { code: err.code, ...(err.detail ? { detail: err.detail } : {}) };
  const e = (err ?? {}) as { level?: string; code?: string; message?: string };
  const message = String(e.message ?? err);
  if (e.level === 'client-authentication') return { code: 'auth_failed' };
  if (e.level === 'client-timeout' || e.level === 'client-socket' || /^E[A-Z]+$/.test(e.code ?? '')) return { code: 'connect_failed', detail: e.code ?? message };
  if (/privateKey|passphrase|private key/i.test(message)) return { code: 'bad_key', detail: message.slice(0, 300) };
  return { code: 'failed', detail: message.slice(0, 300) };
}

export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { store, bundle, installer, info } = opts;
  const sshDir = opts.sshDir ?? path.join(os.homedir(), '.ssh');
  const token = randomBytes(32).toString('base64url');
  const jobs = new Map<string, Job>();
  let current: Job | null = null;
  // The one fingerprint the owner may trust next: the one the last connection actually saw.
  let pendingTrust: { hostPort: string; fingerprint: string } | null = null;
  let port = 0;

  const origins = () => [`127.0.0.1:${port}`, `localhost:${port}`];

  function readConnection(raw: unknown): { conn: Connection; saved: Omit<SavedServer, 'mode' | 'domain' | 'email'> } {
    const b = (raw ?? {}) as Record<string, unknown>;
    const host = str(b.host, 253, 'host').trim().replace(/^\[(.*)\]$/, '$1');
    if (!HOST_RE.test(host)) throw new HttpError(400, 'invalid', 'host');
    const portNum = typeof b.port === 'number' ? b.port : Number(b.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65_535) throw new HttpError(400, 'invalid', 'port');
    const username = str(b.username, 32, 'username').trim();
    if (!USER_RE.test(username)) throw new HttpError(400, 'invalid', 'username');
    const auth = b.auth === 'key' ? 'key' : 'password';
    const conn: Connection = { host, port: portNum, username };
    const sudoPassword = str(b.sudoPassword, 1024, 'sudoPassword');
    if (sudoPassword) conn.sudoPassword = sudoPassword;
    let keyName = '';
    if (auth === 'password') {
      conn.password = str(b.password, 1024, 'password');
      if (!conn.password) throw new HttpError(400, 'invalid', 'password');
    } else {
      keyName = str(b.keyName, 100, 'key');
      const pasted = str(b.privateKey, 64 * 1024, 'key');
      if (keyName) {
        // Only a key this program listed itself, never an arbitrary path.
        if (!findKeys(sshDir).includes(keyName)) throw new HttpError(400, 'invalid', 'key');
        conn.privateKey = fs.readFileSync(path.join(sshDir, keyName), 'utf8');
      } else if (pasted.includes('PRIVATE KEY')) conn.privateKey = pasted;
      else throw new HttpError(400, 'invalid', 'key');
      const passphrase = str(b.passphrase, 1024, 'passphrase');
      if (passphrase) conn.passphrase = passphrase;
    }
    return { conn, saved: { host, port: portNum, username, auth, keyName } };
  }

  function run(kind: JobKind, work: (job: Job) => Promise<unknown>): Job {
    if (current && !current.done) throw new HttpError(409, 'busy');
    const job: Job = { id: randomBytes(9).toString('base64url'), kind, lines: [], step: null, done: false, ok: false, result: null, error: null };
    jobs.set(job.id, job);
    for (const id of [...jobs.keys()].slice(0, -10)) jobs.delete(id);
    current = job;
    work(job)
      .then((result) => {
        job.result = result;
      })
      .catch((err: unknown) => {
        job.error = describe(err, (hp) => store.get(hp));
      })
      .finally(() => {
        if (job.error?.fingerprint && job.error.hostPort) pendingTrust = { hostPort: job.error.hostPort, fingerprint: job.error.fingerprint };
        job.ok = !job.error;
        job.done = true;
      });
    return job;
  }

  const push = (job: Job) => (line: string) => {
    if (job.lines.length < MAX_LINES) job.lines.push(line);
  };

  async function api(req: http.IncomingMessage, url: URL, res: http.ServerResponse): Promise<void> {
    if (!sameToken(String(req.headers['x-deploy-token'] ?? ''), token)) throw new HttpError(401, 'unauthorized');
    const origin = req.headers.origin;
    if (origin !== undefined && !origins().some((o) => origin === `http://${o}`)) throw new HttpError(403, 'forbidden');
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'forbidden');

    const route = url.pathname;
    if (req.method === 'GET') {
      if (route === '/api/state') {
        return json(res, 200, {
          ...info,
          lang: store.lang,
          server: store.server,
          keys: findKeys(sshDir),
          sshDir: sshDir.replace(os.homedir(), '~').replace(/\\/g, '/'),
          job: current ? { id: current.id, kind: current.kind, done: current.done } : null,
        });
      }
      const m = /^\/api\/jobs\/([A-Za-z0-9_-]+)$/.exec(route);
      const job = m ? jobs.get(m[1]!) : undefined;
      if (!job) throw new HttpError(404, 'not_found');
      const since = Math.max(0, Number(url.searchParams.get('since')) || 0);
      return json(res, 200, { kind: job.kind, lines: job.lines.slice(since), next: job.lines.length, step: job.step, done: job.done, ok: job.ok, result: job.result, error: job.error });
    }
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    // JSON only, so no plain form on another site can ever post here.
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type');
    const body = (await readBody(req)) as Record<string, unknown>;

    switch (route) {
      case '/api/lang': {
        store.lang = body.lang === 'zh-CN' ? 'zh-CN' : 'en';
        return json(res, 200, { ok: true });
      }
      case '/api/trust': {
        const { hostPort, fingerprint } = body;
        if (!pendingTrust || hostPort !== pendingTrust.hostPort || fingerprint !== pendingTrust.fingerprint) throw new HttpError(409, 'stale');
        store.trust(pendingTrust.hostPort, pendingTrust.fingerprint);
        pendingTrust = null;
        return json(res, 200, { ok: true });
      }
      case '/api/quit': {
        json(res, 200, { ok: true });
        if (opts.onQuit) setImmediate(opts.onQuit);
        return;
      }
      case '/api/check':
      case '/api/deploy': {
        const { conn, saved } = readConnection(body.connection);
        const where = readSite(body.site);
        store.server = { ...saved, mode: where.mode, domain: where.domain ?? '', email: where.email ?? '' };
        const job =
          route === '/api/check'
            ? run('check', async (j) => {
                j.step = 'connect';
                if (!(await checkServer(conn, store, installer, where, push(j)))) j.error = { code: 'check_failed' };
                return null;
              })
            : run('deploy', async (j) => {
                const r = await deploy(conn, store, bundle, where, push(j), (s) => (j.step = s));
                if (!r.ok) j.error = { code: 'install_failed' };
                return r;
              });
        return json(res, 202, { job: job.id });
      }
      case '/api/confirm': {
        const { conn } = readConnection(body.connection);
        const job = run('confirm', async (j) => {
          const sshConfirmed = await confirmSsh(conn, store);
          if (!sshConfirmed) j.error = { code: 'confirm_failed' };
          return { sshConfirmed };
        });
        return json(res, 202, { job: job.id });
      }
      case '/api/setup-link': {
        const { conn } = readConnection(body.connection);
        const job = run('setup-link', async () => ({ setupUrl: await newSetupLink(conn, store) }));
        return json(res, 202, { job: job.id });
      }
      case '/api/recovery-key': {
        const { conn } = readConnection(body.connection);
        const name = str(body.name, 60, 'name').trim() || 'Recovery';
        const lang = body.lang === 'zh-CN' ? 'zh-CN' : 'en';
        const job = run('recovery-key', () => recoveryKey(conn, store, name, lang));
        return json(res, 202, { job: job.id });
      }
      default:
        throw new HttpError(404, 'not_found');
    }
  }

  const server = http.createServer((req, res) => {
    // A page on another site that renames itself to 127.0.0.1 (DNS rebinding) still sends its own name here.
    if (!origins().includes(String(req.headers.host ?? ''))) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', ...HEADERS });
      res.end('Forbidden');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) {
      api(req, url, res).catch((err: unknown) => {
        if (res.headersSent) return;
        if (err instanceof HttpError) json(res, err.status, { error: err.code, ...(err.field ? { field: err.field } : {}) });
        else json(res, 500, { error: 'internal' });
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      const nonce = randomBytes(16).toString('base64');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        ...HEADERS,
      });
      res.end(opts.page.replaceAll('__NONCE__', nonce));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', ...HEADERS });
    res.end('Not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/?t=${token}`,
        token,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
