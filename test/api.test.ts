import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '../server/auth/totp.js';
import { Client, HOST, makeHarness, multipart, pairAndLogin, waitForEvent, type Harness } from './helpers.js';

let h: Harness;
let client: Client;

beforeAll(async () => {
  h = await makeHarness();
  client = await pairAndLogin(h);
});
afterAll(async () => {
  await h?.close();
});

async function newSession(c = client, title = 'Test') {
  const res = await c.post('/api/sessions', { title });
  expect(res.statusCode).toBe(200);
  return res.json().session as { id: string; workspacePath: string; cwd: string };
}

describe('access control', () => {
  it('rejects unknown Host headers (DNS rebinding)', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/health', headers: { host: 'evil.example:8787' } });
    expect(res.statusCode).toBe(421);
  });

  it('requires a paired device, then a login', async () => {
    const anon = new Client(h.app);
    expect((await anon.get('/api/sessions')).json().error.code).toBe('device_required');
    const { code } = h.runtime.devices.create('Second', null);
    expect((await anon.post('/api/auth/pair', { code: 'AAAAA-BBBBB-CCCCC-DDDDD' })).json().error.code).toBe('invalid_pairing_code');
    expect((await anon.post('/api/auth/pair', { code: code.toLowerCase() })).statusCode).toBe(200);
    expect((await anon.post('/api/auth/pair', { code })).json().error.code).toBe('invalid_pairing_code'); // single use
    expect((await anon.get('/api/sessions')).json().error.code).toBe('login_required');
    const state = (await anon.get('/api/auth/state')).json();
    expect(state).toMatchObject({ setupComplete: true, loggedIn: false, device: { name: 'Second' } });
  });

  it('cannot be bypassed with percent-encoded or odd /api paths', async () => {
    const anon = new Client(h.app);
    const s = await newSession();
    fs.writeFileSync(path.join(s.cwd, 'secret.txt'), 'top secret');
    const probes: Array<[string, string, unknown?]> = [
      ['GET', '/%61pi/sessions'],
      ['GET', '/a%70i/sessions'],
      ['GET', '/ap%69/admin/overview'],
      ['GET', `/%61pi/files/view?path=${encodeURIComponent(`${s.workspacePath}/secret.txt`)}`],
      ['POST', '/%61pi/admin/devices', { name: 'evil' }],
      ['POST', '/%61pi/files/delete', { path: s.workspacePath }],
      ['GET', '/%2561pi/sessions'],
      ['GET', '/API/sessions'],
      ['GET', '//api/sessions'],
      ['GET', '/api/sessions/'],
      ['GET', '/api/./sessions'],
      ['GET', '/x/../api/sessions'],
    ];
    for (const [method, url, body] of probes) {
      const res = await anon.req(method, url, body === undefined ? {} : { body, headers: { 'x-codex-console': '' } });
      expect(res.statusCode, `${method} ${url}`).toBeGreaterThanOrEqual(400);
      expect(res.body, `${method} ${url}`).not.toContain('top secret');
      expect(res.body, `${method} ${url}`).not.toContain('"sessions"');
      expect(res.body, `${method} ${url}`).not.toContain('pairUrl');
    }
    expect(fs.existsSync(s.cwd)).toBe(true);
    expect(h.runtime.devices.list().some((d) => d.name === 'evil')).toBe(false);
  });

  it('rejects state-changing requests without the CSRF header or from another origin', async () => {
    const noHeader = await client.req('POST', '/api/sessions', { body: {}, headers: { 'x-codex-console': '' } });
    expect(noHeader.json().error.code).toBe('csrf_header_missing');
    const badOrigin = await client.req('POST', '/api/sessions', { body: {}, headers: { origin: 'https://evil.example' } });
    expect(badOrigin.json().error.code).toBe('forbidden_origin');
  });

  it('locks login after repeated failures and never says which factor was wrong', async () => {
    const c = new Client(h.app);
    const { code } = h.runtime.devices.create('Brute', null);
    await c.post('/api/auth/pair', { code });
    for (let i = 0; i < 5; i++) {
      const r = await c.req('POST', '/api/auth/login', { body: { password: 'wrong password!!', code: '000000' }, headers: { 'x-forwarded-for': '1.2.3.4' } });
      expect(r.json().error.code).toBe('invalid_credentials');
    }
    const locked = await c.post('/api/auth/login', { password: h.password, code: totpCode(h.totpSecret, Date.now()) });
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('login_locked');
    expect(locked.headers['retry-after']).toBeDefined();
    h.runtime.limiter.reset('login:ip:127.0.0.1');
    h.runtime.limiter.reset('login:all');
  });

  it('sets hardened headers', async () => {
    const res = await client.get('/api/auth/state');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
    const cookie = [...client.cookies.keys()];
    expect(cookie).toContain('ccdev');
    expect(cookie).toContain('ccsess');
  });
});

describe('sessions and turns', () => {
  it('streams a turn and records it', async () => {
    const s = await newSession();
    const done = waitForEvent(h, s.id, 'turn_completed');
    const start = await client.post(`/api/sessions/${s.id}/turns`, { text: 'Hello Codex' });
    expect(start.statusCode).toBe(200);
    const { event, seen } = await done;
    expect(event.type === 'turn_completed' && event.end.status).toBe('completed');
    expect(seen.some((e) => e.type === 'item_delta' && e.field === 'text')).toBe(true);
    expect(seen.some((e) => e.type === 'usage')).toBe(true);

    const history = (await client.get(`/api/sessions/${s.id}/history`)).json();
    const kinds = history.entries.map((e: { kind: string }) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['userMessage', 'reasoning', 'agentMessage', 'turnEnd']));
    const agent = history.entries.find((e: { kind: string }) => e.kind === 'agentMessage');
    expect(agent.data.item.text).toContain('Hello Codex');

    const reqs = (await client.get(`/api/admin/requests?session=${s.id}`)).json();
    expect(reqs.rows[0]).toMatchObject({ status: 'completed', promptChars: 11, inputTokens: 1200, outputTokens: 600, deviceName: 'Test device' });
    expect(reqs.rows[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('relays approvals and records the decision', async () => {
    const s = await newSession();
    const asked = waitForEvent(h, s.id, 'approval_requested');
    await client.post(`/api/sessions/${s.id}/turns`, { text: 'please approve a command' });
    const { event } = await asked;
    if (event.type !== 'approval_requested') throw new Error('unexpected');
    expect(event.approval).toMatchObject({ kind: 'command', command: 'ls -la' });
    const snapshot = (await client.get(`/api/sessions/${s.id}`)).json();
    expect(snapshot.turn.approvals).toHaveLength(1);
    const done = waitForEvent(h, s.id, 'turn_completed');
    expect((await client.post(`/api/approvals/${event.approval.id}`, { decision: 'accept' })).statusCode).toBe(200);
    await done;
    const history = (await client.get(`/api/sessions/${s.id}/history`)).json();
    const cmd = history.entries.find((e: { kind: string }) => e.kind === 'commandExecution');
    expect(cmd.data.item.status).toBe('completed');
    expect(history.entries.some((e: { kind: string; data: { outcome?: string } }) => e.kind === 'approval' && e.data.outcome === 'accept')).toBe(true);
  });

  it('declined approvals are passed to Codex', async () => {
    const s = await newSession();
    const asked = waitForEvent(h, s.id, 'approval_requested');
    await client.post(`/api/sessions/${s.id}/turns`, { text: 'approve this?' });
    const { event } = await asked;
    if (event.type !== 'approval_requested') throw new Error('unexpected');
    const done = waitForEvent(h, s.id, 'turn_completed');
    await client.post(`/api/approvals/${event.approval.id}`, { decision: 'decline' });
    await done;
    const history = (await client.get(`/api/sessions/${s.id}/history`)).json();
    expect(history.entries.find((e: { kind: string }) => e.kind === 'commandExecution').data.item.status).toBe('declined');
  });

  it('interrupts a running turn', async () => {
    const s = await newSession();
    const started = waitForEvent(h, s.id, 'item_delta');
    await client.post(`/api/sessions/${s.id}/turns`, { text: 'slow please' });
    await started;
    expect((await client.post(`/api/sessions/${s.id}/turns`, { text: 'again' })).json().error.code).toBe('turn_in_progress');
    const done = waitForEvent(h, s.id, 'turn_completed');
    expect((await client.post(`/api/sessions/${s.id}/interrupt`)).statusCode).toBe(200);
    const { event } = await done;
    expect(event.type === 'turn_completed' && event.end.status).toBe('interrupted');
  });

  it('marks usage-limit failures', async () => {
    const s = await newSession();
    const done = waitForEvent(h, s.id, 'turn_completed');
    await client.post(`/api/sessions/${s.id}/turns`, { text: 'fail limit' });
    const { event } = await done;
    expect(event.type === 'turn_completed' && event.end.status).toBe('usage_limited');
  });

  it('captures images Codex views and media it creates', async () => {
    const s = await newSession();
    const done = waitForEvent(h, s.id, 'turn_completed');
    await client.post(`/api/sessions/${s.id}/turns`, { text: 'make an image and a video' });
    const { event, seen } = await done;
    const viewed = seen.find((e) => e.type === 'item_completed' && e.item.type === 'imageView');
    expect(viewed && viewed.type === 'item_completed' && viewed.media[0]).toMatchObject({ kind: 'image', source: 'workspace', name: 'fake-plot.png' });
    expect(event.type === 'turn_completed' && event.media.map((m) => m.name)).toEqual(['clip.webm']);
    const img = await client.get(`/api/files/view?path=${encodeURIComponent(`${s.workspacePath}/fake-plot.png`)}`);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['content-security-policy']).toContain('sandbox');
  });

  it('attaches uploaded images to the prompt', async () => {
    const s = await newSession();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const up = await client.req('POST', `/api/files/upload?path=${encodeURIComponent(s.workspacePath + '/uploads')}&session=${s.id}`, multipart([{ name: 'pic.png', content: png }]));
    expect(up.statusCode).toBe(200);
    const file = up.json().files[0];
    const done = waitForEvent(h, s.id, 'turn_completed');
    await client.post(`/api/sessions/${s.id}/turns`, { text: 'describe it', attachments: [file.path] });
    await done;
    const history = (await client.get(`/api/sessions/${s.id}/history`)).json();
    const user = history.entries.find((e: { kind: string }) => e.kind === 'userMessage');
    expect(user.data.item.content).toEqual(expect.arrayContaining([{ type: 'localImage', path: path.join(h.workspace, file.path) }]));
    const reqs = (await client.get(`/api/admin/requests?session=${s.id}`)).json();
    expect(reqs.rows[0]).toMatchObject({ attachmentCount: 1, attachmentBytes: png.length });
  });

  it('refuses prompts when Codex is signed out', async () => {
    const signedOut = await makeHarness({ signedIn: false });
    try {
      const c = await pairAndLogin(signedOut);
      const s = (await c.post('/api/sessions', {})).json().session;
      const res = await c.post(`/api/sessions/${s.id}/turns`, { text: 'hi' });
      expect(res.json().error.code).toBe('codex_not_signed_in');
      const reqs = (await c.get('/api/admin/requests')).json();
      expect(reqs.rows[0]).toMatchObject({ status: 'rejected', error: 'codex_not_signed_in' });
      expect((await c.get('/api/codex/status')).json()).toMatchObject({ signedIn: false, state: 'ready' });
    } finally {
      await signedOut.close();
    }
  });

  it('imports a thread started elsewhere', async () => {
    const seeded = await makeHarness({ fakeEnv: { FAKE_CODEX_SEED: '1' } });
    try {
      const c = await pairAndLogin(seeded);
      const list = (await c.get('/api/codex/threads')).json();
      expect(list.threads).toHaveLength(1);
      const imported = (await c.post('/api/sessions/import', { threadId: list.threads[0].id })).json();
      expect(imported.session).toMatchObject({ title: 'Parser refactor', imported: true });
      const history = (await c.get(`/api/sessions/${imported.session.id}/history`)).json();
      expect(history.entries.map((e: { kind: string }) => e.kind)).toEqual(['userMessage', 'agentMessage', 'turnEnd']);
      expect((await c.post('/api/sessions/import', { threadId: list.threads[0].id })).json().error.code).toBe('thread_already_imported');
    } finally {
      await seeded.close();
    }
  });
});

describe('files', () => {
  it('uploads, lists, previews with ranges and downloads', async () => {
    const s = await newSession();
    const up = await client.req('POST', `/api/files/upload?path=${encodeURIComponent(s.workspacePath)}`, multipart([{ name: 'hello.txt', content: '0123456789' }, { name: 'hello.txt', content: 'dup' }]));
    expect(up.json().files.map((f: { name: string }) => f.name)).toEqual(['hello.txt', 'hello (1).txt']);
    const list = (await client.get(`/api/files?path=${encodeURIComponent(s.workspacePath)}`)).json();
    expect(list.entries.map((e: { name: string }) => e.name)).toEqual(['hello (1).txt', 'hello.txt']);
    const ranged = await client.get(`/api/files/view?path=${encodeURIComponent(`${s.workspacePath}/hello.txt`)}`, { range: 'bytes=2-5' });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.body).toBe('2345');
    expect(ranged.headers['content-range']).toBe('bytes 2-5/10');
    const dl = await client.get(`/api/files/download?path=${encodeURIComponent(`${s.workspacePath}/hello.txt`)}`);
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);
    const transfers = (await client.get('/api/admin/transfers')).json();
    expect(transfers.rows.some((r: { direction: string }) => r.direction === 'upload')).toBe(true);
    // Ranged reads are logged too (they can't be used to read a file unrecorded).
    expect(transfers.rows.some((r: { direction: string; bytes: number; path: string }) => r.direction === 'view' && r.bytes === 4 && r.path.endsWith('/hello.txt'))).toBe(true);
  });

  it('serves HTML as plain text, never as a page', async () => {
    const s = await newSession();
    fs.writeFileSync(path.join(s.cwd, 'x.html'), '<script>alert(1)</script>');
    const res = await client.get(`/api/files/view?path=${encodeURIComponent(`${s.workspacePath}/x.html`)}`);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('refuses paths outside the workspace, including via symlinks', async () => {
    expect((await client.get('/api/files?path=../')).json().error.code).toBe('path_invalid');
    expect((await client.get(`/api/files/download?path=${encodeURIComponent('/etc/passwd')}`)).statusCode).toBe(404);
    fs.symlinkSync('/etc', path.join(h.workspace, 'escape'));
    expect((await client.get('/api/files?path=escape')).json().error.code).toBe('path_outside_workspace');
    expect((await client.get('/api/files/download?path=escape/hostname')).json().error.code).toBe('path_outside_workspace');
    const up = await client.req('POST', '/api/files/upload?path=escape', multipart([{ name: 'x', content: 'x' }]));
    expect(up.json().error.code).toBe('path_outside_workspace');
  });

  it('rejects uploads over the size limit', async () => {
    const small = await makeHarness({ env: { CC_MAX_UPLOAD_MB: '1' } });
    try {
      const c = await pairAndLogin(small);
      const res = await c.req('POST', '/api/files/upload?path=big', multipart([{ name: 'big.bin', content: Buffer.alloc(1024 * 1024 + 10) }]));
      expect(res.statusCode).toBe(413);
      expect(fs.readdirSync(path.join(small.workspace, 'big'))).toEqual([]);
    } finally {
      await small.close();
    }
  });
});

describe('admin', () => {
  it('requires a fresh TOTP after locking', async () => {
    expect((await client.post('/api/auth/admin/lock')).statusCode).toBe(200);
    expect((await client.get('/api/admin/overview')).json().error.code).toBe('admin_required');
    expect((await client.post('/api/auth/admin/verify', { code: '123456' })).json().error.code).toBe('invalid_totp');
    const next = totpCode(h.totpSecret, Date.now() + 30_000);
    expect((await client.post('/api/auth/admin/verify', { code: next })).statusCode).toBe(200);
    expect((await client.post('/api/auth/admin/verify', { code: next })).json().error.code).toBe('invalid_totp'); // no replay
    const overview = (await client.get('/api/admin/overview?tz=-600')).json();
    expect(overview.codex).toMatchObject({ state: 'ready', signedIn: true, account: { type: 'chatgpt', planType: 'plus', email: 'owner@example.com' } });
    expect(overview.codex.rateLimits.primary.windowDurationMins).toBe(300);
    expect(overview.daily).toHaveLength(14);
    expect(overview.totals.requests24h).toBeGreaterThan(0);
  });

  it('manages devices: pairing QR, usage, revoke', async () => {
    const created = (await client.post('/api/admin/devices', { name: 'Phone', expiresInDays: 30 })).json();
    expect(created.qrSvg).toContain('<svg');
    expect(created.pairUrl).toBe(`http://${HOST}/pair#code=${encodeURIComponent(created.code)}`);
    const phone = new Client(h.app);
    await phone.post('/api/auth/pair', { code: created.code });
    await phone.post('/api/auth/login', { password: h.password, code: totpCode(h.totpSecret, Date.now() - 30_000) });
    const devices = (await client.get('/api/admin/devices')).json().devices;
    expect(devices.find((d: { id: string }) => d.id === created.device.id)).toMatchObject({ status: 'active', tokenHint: expect.stringMatching(/^ccd_/) });
    const me = devices.find((d: { name: string }) => d.name === 'Test device');
    expect(me.usage.requests).toBeGreaterThan(0);
    await client.post(`/api/admin/devices/${created.device.id}/revoke`);
    expect((await phone.get('/api/sessions')).json().error.code).toBe('device_required');
    const sec = (await client.get('/api/admin/security?kind=device_revoked')).json();
    expect(sec.total).toBe(1);
  });

  it('exports requests as CSV with formula injection neutralised', async () => {
    const s = await newSession(client, '=HYPERLINK("x")');
    const done = waitForEvent(h, s.id, 'turn_completed');
    await client.post(`/api/sessions/${s.id}/turns`, { text: 'hi' });
    await done;
    const csv = await client.get('/api/admin/requests.csv');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain(`"'=HYPERLINK(""x"")"`);
  });

  it('logs every API call per device', async () => {
    const log = (await client.get('/api/admin/api-log?limit=5')).json();
    expect(log.total).toBeGreaterThan(10);
    expect(log.rows[0]).toMatchObject({ deviceName: 'Test device', method: expect.any(String), route: expect.stringMatching(/^\/api\//) });
  });
});
