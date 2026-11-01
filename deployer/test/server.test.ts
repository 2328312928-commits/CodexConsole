import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tar } from '../scripts/tar.mjs';
import { findKeys, startServer, type RunningServer } from '../src/server.js';
import { Store } from '../src/store.js';
import { startFakeServer, testKeyPair } from './fake-ssh-server.mjs';

const PAGE = '<!doctype html><script nonce="__NONCE__"></script>';
const bundle = gzipSync(tar([{ name: 'deploy/install.sh', data: Buffer.from('#!/usr/bin/env bash\n') }]));
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

let dir: string;
let store: Store;
let running: RunningServer;
let quits = 0;
const closers: (() => Promise<unknown>)[] = [];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-deploy-test-'));
  fs.mkdirSync(path.join(dir, 'ssh'));
  quits = 0;
  store = new Store(path.join(dir, 'state'));
  running = await startServer({
    store,
    page: PAGE,
    installer: '#!/usr/bin/env bash\n',
    bundle,
    info: { version: '9.9.9', consoleVersion: '1.2.3', consoleCommit: 'abc1234' },
    sshDir: path.join(dir, 'ssh'),
    onQuit: () => quits++,
  });
});

afterEach(async () => {
  await running.close();
  await Promise.all(closers.splice(0).map((c) => c()));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(route: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${running.port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-deploy-token': running.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> };
}

/** A request with a Host header of our choosing (fetch will not send one). */
function rawGet(route: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: running.port, path: route, headers: { host, 'x-deploy-token': running.token } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });
}

async function finished(id: string) {
  for (let i = 0; i < 400; i++) {
    const r = await call(`/api/jobs/${id}`);
    if (r.body.done) return r.body;
    await sleep(25);
  }
  throw new Error('the task did not finish');
}

async function fakeServer(opts: Parameters<typeof startFakeServer>[0] = {}) {
  const server = await startFakeServer(opts);
  closers.push(() => server.close());
  return server;
}

const ipSite = { mode: 'ip', lang: 'en' };

describe('the local page', () => {
  it('serves the page with a fresh nonce, and only to 127.0.0.1 or localhost', async () => {
    const res = await fetch(`http://127.0.0.1:${running.port}/`);
    const csp = res.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`<!doctype html><script nonce="${nonce}"></script>`);
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');

    expect(await rawGet('/', `localhost:${running.port}`)).toBe(200);
    // DNS rebinding: a site that points its own name at 127.0.0.1 still sends that name.
    expect(await rawGet('/', `evil.example:${running.port}`)).toBe(403);
    expect(await rawGet('/api/state', `evil.example:${running.port}`)).toBe(403);
  });

  it('answers the API only with the token, from its own origin, in JSON', async () => {
    expect((await call('/api/state', undefined, { 'x-deploy-token': '' })).status).toBe(401);
    expect((await call('/api/state', undefined, { 'x-deploy-token': 'x'.repeat(43) })).status).toBe(401);
    expect((await call('/api/state', undefined, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('/api/state', undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    const form = await fetch(`http://127.0.0.1:${running.port}/api/lang`, { method: 'POST', headers: { 'x-deploy-token': running.token, 'content-type': 'text/plain' }, body: '{}' });
    expect(form.status).toBe(415);

    const state = await call('/api/state', undefined, { origin: `http://127.0.0.1:${running.port}` });
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ version: '9.9.9', consoleVersion: '1.2.3', consoleCommit: 'abc1234', server: null, keys: [], job: null });
  });

  it('checks what it is given before connecting anywhere', async () => {
    const conn = { host: '127.0.0.1', port: 22, username: 'root', auth: 'password', password: 'pw' };
    const field = async (connection: object, site: object = ipSite) => (await call('/api/deploy', { connection, site })).body.field;
    expect(await field({ ...conn, host: 'bad host!' })).toBe('host');
    expect(await field({ ...conn, port: 70_000 })).toBe('port');
    expect(await field({ ...conn, username: 'root; reboot' })).toBe('username');
    expect(await field({ ...conn, password: '' })).toBe('password');
    expect(await field({ ...conn, auth: 'key', keyName: '../../etc/passwd' })).toBe('key');
    expect(await field({ ...conn, auth: 'key', privateKey: 'not a key' })).toBe('key');
    expect(await field(conn, { mode: 'domain', domain: 'not a domain', lang: 'en' })).toBe('domain');
    expect(await field(conn, { mode: 'ip', email: 'nope', lang: 'en' })).toBe('email');
  });
});

describe('deploying from the page', () => {
  it('asks to trust the server, deploys, and remembers only what is not secret', async () => {
    const server = await fakeServer();
    const connection = { host: '127.0.0.1', port: server.port, username: 'root', auth: 'password', password: 'server-pw' };

    const first = await call('/api/deploy', { connection, site: ipSite });
    expect(first.status).toBe(202);
    const untrusted = await finished(first.body.job);
    expect(untrusted).toMatchObject({ ok: false, error: { code: 'unknown_host', hostPort: `127.0.0.1:${server.port}`, fingerprint: server.fingerprint } });

    // Only the fingerprint the connection actually saw can be trusted.
    expect((await call('/api/trust', { hostPort: `127.0.0.1:${server.port}`, fingerprint: 'SHA256:forged' })).status).toBe(409);
    expect((await call('/api/trust', { hostPort: `127.0.0.1:${server.port}`, fingerprint: server.fingerprint })).status).toBe(200);
    expect((await call('/api/trust', { hostPort: `127.0.0.1:${server.port}`, fingerprint: server.fingerprint })).status).toBe(409);

    const second = await call('/api/deploy', { connection, site: ipSite });
    const job = await finished(second.body.job);
    expect(job).toMatchObject({ ok: true, error: null, step: 'confirm', result: { ok: true, consoleUrl: 'https://203.0.113.7', setupUrl: 'https://203.0.113.7/setup#token=first-link', sshConfirmed: true } });
    expect(job.lines.join('\n')).toContain('Codex Console is ready');
    expect(job.lines.join('\n')).not.toContain('CODEX_CONSOLE_');

    const saved = fs.readFileSync(path.join(dir, 'state', 'state.json'), 'utf8');
    expect(saved).not.toContain('server-pw');
    expect(JSON.parse(saved)).toMatchObject({
      server: { host: '127.0.0.1', port: server.port, username: 'root', auth: 'password', keyName: '', mode: 'ip' },
      knownHosts: { [`127.0.0.1:${server.port}`]: server.fingerprint },
    });
    expect((await call('/api/state')).body.server.host).toBe('127.0.0.1');
  });

  it('runs one task at a time and reports a failed install', async () => {
    const server = await fakeServer({ installExit: 1, installDelayMs: 300 });
    store.trust(`127.0.0.1:${server.port}`, server.fingerprint);
    const connection = { host: '127.0.0.1', port: server.port, username: 'root', auth: 'password', password: 'server-pw' };
    const first = await call('/api/deploy', { connection, site: ipSite });
    expect(first.status).toBe(202);
    expect(await call('/api/check', { connection, site: ipSite })).toMatchObject({ status: 409, body: { error: 'busy' } });
    expect((await call('/api/state')).body.job).toEqual({ id: first.body.job, kind: 'deploy', done: false });
    const job = await finished(first.body.job);
    expect(job).toMatchObject({ ok: false, error: { code: 'install_failed' }, step: 'confirm', result: { ok: false, sshConfirmed: true } });
    expect(job.lines.join('\n')).toContain('Stopped on an error');
  });

  it('uses a key from the SSH folder, by name only', async () => {
    const keys = testKeyPair();
    fs.writeFileSync(path.join(dir, 'ssh', 'id_ed25519'), keys.private);
    fs.writeFileSync(path.join(dir, 'ssh', 'id_ed25519.pub'), keys.public);
    fs.writeFileSync(path.join(dir, 'ssh', 'id_notakey'), 'hello');
    expect(findKeys(path.join(dir, 'ssh'))).toEqual(['id_ed25519']);
    expect((await call('/api/state')).body.keys).toEqual(['id_ed25519']);

    const server = await fakeServer({ password: undefined, publicKey: keys.public });
    const connection = { host: '127.0.0.1', port: server.port, username: 'root', auth: 'key', keyName: 'id_ed25519' };
    await finished((await call('/api/check', { connection, site: ipSite })).body.job);
    await call('/api/trust', { hostPort: `127.0.0.1:${server.port}`, fingerprint: server.fingerprint });
    const job = await finished((await call('/api/check', { connection, site: ipSite })).body.job);
    expect(job).toMatchObject({ ok: true, error: null });
    expect(job.lines.join('\n')).toContain('Checking the server');
  });

  it('runs the setup-link and recovery-key tasks, and quits when asked', async () => {
    const server = await fakeServer({ installed: true });
    const connection = { host: '127.0.0.1', port: server.port, username: 'root', auth: 'password', password: 'server-pw' };
    await finished((await call('/api/setup-link', { connection })).body.job);
    await call('/api/trust', { hostPort: `127.0.0.1:${server.port}`, fingerprint: server.fingerprint });
    expect(await finished((await call('/api/setup-link', { connection })).body.job)).toMatchObject({ ok: true, result: { setupUrl: 'https://203.0.113.7/setup#token=new-link' } });
    expect(await finished((await call('/api/recovery-key', { connection, name: 'Laptop' })).body.job)).toMatchObject({ ok: false, error: { code: 'not_set_up' } });

    expect((await call('/api/quit', {})).status).toBe(200);
    await sleep(20);
    expect(quits).toBe(1);
  });
});
