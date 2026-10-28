import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerEvent } from '../shared/api.js';
import { generateTotpSecret, totpCode } from '../server/auth/totp.js';
import { loadConfig } from '../server/config.js';
import { buildApp } from '../server/http/app.js';
import { buildPublicApi } from '../server/http/publicApi.js';
import { createRuntime } from '../server/runtime.js';

export const FAKE_CODEX = fileURLToPath(new URL('./fake-codex/app-server.mjs', import.meta.url));
export const HOST = '127.0.0.1:8787';
export const ORIGIN = `http://${HOST}`;

const silent = { info() {}, warn() {}, error() {} };

export const API_HOST = '127.0.0.1:8788';

export interface Harness {
  root: string;
  workspace: string;
  app: FastifyInstance;
  publicApi: Awaited<ReturnType<typeof buildPublicApi>>;
  runtime: Awaited<ReturnType<typeof createRuntime>>;
  password: string;
  totpSecret: string;
  close(): Promise<void>;
}

export async function makeHarness(opts: { signedIn?: boolean; env?: Record<string, string>; fakeEnv?: Record<string, string> } = {}): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-'));
  const workspace = path.join(root, 'workspace');
  const config = loadConfig({
    CC_DATA_DIR: path.join(root, 'data'),
    CC_WORKSPACE_ROOT: workspace,
    CC_PORT: '8787',
    CODEX_BIN: process.execPath,
    CC_RATE_API_PER_MIN: '100000',
    CC_RATE_PROMPTS_PER_MIN: '1000',
    ...opts.env,
  });
  const runtime = await createRuntime(config, {
    codexArgs: [FAKE_CODEX, 'app-server'],
    codexEnv: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CODEX_HOME: path.join(root, 'codex-home'),
      FAKE_CODEX_SIGNED_IN: opts.signedIn === false ? '0' : '1',
      FAKE_CODEX_DELAY_MS: '1',
      ...opts.fakeEnv,
    },
    logger: silent,
    minBackoffMs: 50,
  });
  const app = await buildApp(runtime, { logger: false });
  const publicApi = await buildPublicApi(runtime, { logger: false });
  runtime.bridge.start();
  await runtime.bridge.waitReady(15_000);
  // waitReady resolves before account/read finishes; wait for it so signedIn is settled.
  for (let i = 0; i < 100 && runtime.bridge.status.account === null && opts.signedIn !== false; i++) await new Promise((r) => setTimeout(r, 20));
  const password = 'correct horse battery staple';
  const totpSecret = generateTotpSecret();
  await runtime.owner.create(password, totpSecret);
  return {
    root,
    workspace: runtime.workspace.realRoot,
    app,
    publicApi,
    runtime,
    password,
    totpSecret,
    async close() {
      await publicApi.close();
      await app.close();
      await runtime.stop();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Minimal browser-like client: cookie jar, Host/Origin and the CSRF header. */
export class Client {
  cookies = new Map<string, string>();

  constructor(private readonly app: FastifyInstance) {}

  async req(method: string, url: string, opts: { body?: unknown; headers?: Record<string, string>; raw?: Buffer; contentType?: string } = {}) {
    const headers: Record<string, string> = { host: HOST, origin: ORIGIN, 'x-codex-console': '1', ...opts.headers };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload: string | Buffer | undefined;
    if (opts.raw) {
      payload = opts.raw;
      headers['content-type'] = opts.contentType!;
    } else if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    const res = await this.app.inject({ method: method as 'GET', url, headers, payload });
    const setCookie = res.headers['set-cookie'];
    for (const c of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
      const [pair] = c.split(';');
      const [name, ...rest] = pair!.split('=');
      const value = rest.join('=');
      if (!value || /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(name!);
      else this.cookies.set(name!, value);
    }
    return res;
  }

  get = (url: string, headers?: Record<string, string>) => this.req('GET', url, { headers });
  post = (url: string, body?: unknown) => this.req('POST', url, { body: body ?? {} });
}

export async function pairAndLogin(h: Harness, client = new Client(h.app)): Promise<Client> {
  const { code } = h.runtime.devices.create('Test device', null);
  const pair = await client.post('/api/auth/pair', { code });
  if (pair.statusCode !== 200) throw new Error(`pair failed: ${pair.body}`);
  const login = await client.post('/api/auth/login', { password: h.password, code: totpCode(h.totpSecret, Date.now()) });
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.body}`);
  return client;
}

export function multipart(files: Array<{ name: string; content: Buffer | string; type?: string }>): { raw: Buffer; contentType: string } {
  const boundary = `----cctest${crypto.randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const f of files) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: ${f.type ?? 'application/octet-stream'}\r\n\r\n`),
      Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { raw: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Resolve with the first event of `type` for a session (and collect everything before it). */
export function waitForEvent(h: Harness, sessionId: string, type: ServerEvent['type'], timeoutMs = 15_000): Promise<{ event: ServerEvent; seen: ServerEvent[] }> {
  return new Promise((resolve, reject) => {
    const seen: ServerEvent[] = [];
    const timer = setTimeout(() => {
      h.runtime.turns.off('event', listener);
      reject(new Error(`timed out waiting for ${type}; saw ${seen.map((e) => e.type).join(',')}`));
    }, timeoutMs);
    const listener = (sid: string, ev: ServerEvent) => {
      if (sid !== sessionId) return;
      seen.push(ev);
      if (ev.type === type) {
        clearTimeout(timer);
        h.runtime.turns.off('event', listener);
        resolve({ event: ev, seen });
      }
    };
    h.runtime.turns.on('event', listener);
  });
}

/** A tool calling the public API with an API key. */
export class KeyClient {
  constructor(
    private readonly h: Harness,
    public key: string,
    private readonly extraHeaders: Record<string, string> = {},
  ) {}

  req(method: string, url: string, opts: { body?: unknown; headers?: Record<string, string>; raw?: Buffer | string; contentType?: string } = {}) {
    const headers: Record<string, string> = { host: API_HOST, authorization: `Bearer ${this.key}`, ...this.extraHeaders, ...opts.headers };
    let payload: string | Buffer | undefined;
    if (opts.raw !== undefined) {
      payload = opts.raw;
      if (opts.contentType) headers['content-type'] = opts.contentType;
    } else if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    return this.h.publicApi.app.inject({ method: method as 'GET', url, headers, payload });
  }

  get = (url: string) => this.req('GET', url);
  post = (url: string, body?: unknown) => this.req('POST', url, { body: body ?? {} });
  patch = (url: string, body: unknown) => this.req('PATCH', url, { body });
  del = (url: string) => this.req('DELETE', url);
}

export const DEFAULT_KEY = {
  label: 'Test key',
  scopes: ['prompt', 'sessions', 'files:read', 'files:write', 'approvals', 'settings', 'mcp:read'],
  quotaTokens: null as number | null,
  quotaPeriod: 'month',
  maxSandbox: 'workspace-write',
  allowNetwork: false,
  approvals: 'ask',
  limits: { perMinute: 1000, promptsPerMinute: 1000, concurrent: 5, uploadMbPerHour: 500 },
  ipAllowlist: [] as string[],
  expiresInDays: null as number | null,
};

/** Create an API key through the admin API (the client must be signed in with admin unlocked). */
export async function createKey(h: Harness, admin: Client, overrides: Partial<typeof DEFAULT_KEY> & Record<string, unknown> = {}) {
  const res = await admin.post('/api/admin/api-keys', { ...DEFAULT_KEY, ...overrides });
  if (res.statusCode !== 200) throw new Error(`createKey failed: ${res.body}`);
  const body = res.json() as { key: { id: string; folder: string }; secret: string };
  return { ...body, client: new KeyClient(h, body.secret) };
}
