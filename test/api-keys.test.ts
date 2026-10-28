import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerEvent } from '../shared/api.js';
import { API_HOST, Client, createKey, KeyClient, makeHarness, pairAndLogin, waitForEvent, type Harness } from './helpers.js';

let h: Harness;
let admin: Client;

beforeAll(async () => {
  h = await makeHarness();
  admin = await pairAndLogin(h);
});
afterAll(async () => {
  await h?.close();
});

async function keySession(k: KeyClient, title = 'from a tool') {
  const res = await k.post('/v1/sessions', { title });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().session as { id: string; cwd: string; workspacePath: string };
}

describe('API keys', () => {
  it('shows the secret once and stores only a hash', async () => {
    const { secret, key } = await createKey(h, admin, { label: 'Laptop script' });
    expect(secret).toMatch(/^cck_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}$/);
    const listed = (await admin.get('/api/admin/api-keys')).json();
    expect(JSON.stringify(listed)).not.toContain(secret.split('.')[1]);
    expect(listed.keys.find((k: { id: string }) => k.id === key.id)).toMatchObject({ label: 'Laptop script', status: 'active', display: expect.stringMatching(/^cck_[0-9a-f]{16}\.…/) });
    // No table anywhere holds the secret.
    const tables = h.runtime.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    for (const { name } of tables) {
      const rows = h.runtime.db.all<Record<string, unknown>>(`SELECT * FROM "${name}"`);
      expect(JSON.stringify(rows)).not.toContain(secret.split('.')[1]);
    }
    expect(fs.existsSync(path.join(h.workspace, key.folder))).toBe(true);
  });

  it('rejects missing, malformed, wrong and foreign credentials', async () => {
    const { secret } = await createKey(h, admin);
    const inject = (headers: Record<string, string>) => h.publicApi.app.inject({ method: 'GET', url: '/v1/me', headers: { host: API_HOST, ...headers } });
    expect((await inject({})).json().error.code).toBe('invalid_api_key');
    expect((await inject({ authorization: 'Bearer nonsense' })).json().error.code).toBe('invalid_api_key');
    const wrong = secret.slice(0, -4) + (secret.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect((await inject({ authorization: `Bearer ${wrong}` })).json().error.code).toBe('invalid_api_key');
    const { code } = h.runtime.devices.create('dev', null);
    const dev = new Client(h.app);
    await dev.post('/api/auth/pair', { code });
    const cookie = [...dev.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    expect((await inject({ cookie })).statusCode).toBe(401);
    expect((await inject({ authorization: `Bearer ${secret}` })).statusCode).toBe(200);
  });

  it('serves nothing but /v1 on the public listener, and keys open nothing on the console', async () => {
    const { client, secret } = await createKey(h, admin);
    for (const url of ['/', '/admin', '/api/sessions', '/api/admin/overview', '/v2/me', '/v1x', '/pair']) {
      const r = await client.get(url);
      expect(r.statusCode, url).toBe(404);
    }
    expect((await client.get('/%76%31/me')).json().error.code).toBe('path_invalid');
    const bad = await h.publicApi.app.inject({ method: 'GET', url: '/v1/me', headers: { host: 'evil.example', authorization: `Bearer ${secret}` } });
    expect(bad.statusCode).toBe(421);
    const consoleCall = await h.app.inject({ method: 'GET', url: '/api/sessions', headers: { host: '127.0.0.1:8787', authorization: `Bearer ${secret}` } });
    expect(consoleCall.json().error.code).toBe('device_required');
  });

  it('runs a prompt, waits for the result and counts whole-turn tokens', async () => {
    const { client, key } = await createKey(h, admin, { quotaTokens: 1_000_000, quotaPeriod: 'day' });
    const s = await keySession(client);
    expect(s.workspacePath.startsWith(`${key.folder}/`)).toBe(true);
    const res = await client.post(`/v1/sessions/${s.id}/turns`, { text: 'hello from my script', wait: true, timeoutSec: 30 });
    expect(res.statusCode).toBe(200);
    const result = res.json();
    expect(result).toMatchObject({ status: 'completed', usage: { inputTokens: 1200, outputTokens: 600, cachedInputTokens: 400 } });
    expect(result.text).toContain('hello from my script');
    const me = (await client.get('/v1/me')).json();
    expect(me.quota).toMatchObject({ tokens: 1_000_000, period: 'day', used: 1800, remaining: 998_200 });
    const later = (await client.get(`/v1/sessions/${s.id}/turns/${result.requestId}`)).json();
    expect(later.text).toBe(result.text);
    const reqs = (await admin.get(`/api/admin/requests?key=${key.id}`)).json();
    expect(reqs.rows[0]).toMatchObject({ apiKeyLabel: 'Test key', apiKeyId: key.id, deviceName: null, status: 'completed' });
    const usage = (await admin.get(`/api/admin/api-keys/${key.id}/usage`)).json();
    expect(usage.key.usage30d).toMatchObject({ requests: 1, inputTokens: 1200, outputTokens: 600 });
    expect(usage.daily).toHaveLength(30);
  });

  it('keeps keys to their own sessions and folder', async () => {
    const a = await createKey(h, admin, { label: 'A' });
    const b = await createKey(h, admin, { label: 'B' });
    const sa = await keySession(a.client);
    expect((await b.client.get(`/v1/sessions/${sa.id}`)).json().error.code).toBe('session_not_found');
    const consoleSession = (await admin.post('/api/sessions', { title: 'mine' })).json().session;
    expect((await a.client.get(`/v1/sessions/${consoleSession.id}`)).json().error.code).toBe('session_not_found');
    expect((await b.client.get('/v1/sessions')).json().sessions).toHaveLength(0);
    // The console still sees the key's session, labelled with the key.
    const all = (await admin.get('/api/sessions')).json().sessions;
    expect(all.find((x: { id: string }) => x.id === sa.id).apiKey).toMatchObject({ label: 'A' });
    // Files: confined to the key folder, symlinks out are refused.
    expect((await a.client.req('PUT', '/v1/files/content?path=../escape.txt', { raw: 'x' })).json().error.code).toBe('path_invalid');
    const up = await a.client.req('PUT', '/v1/files/content?path=data/in.txt', { raw: 'hello file', contentType: 'text/plain' });
    expect(up.json().file).toMatchObject({ path: 'data/in.txt', size: 10 });
    expect((await a.client.get('/v1/files/content?path=data/in.txt')).body).toBe('hello file');
    expect((await a.client.get('/v1/files?path=data')).json().entries.map((e: { name: string }) => e.name)).toEqual(['in.txt']);
    fs.symlinkSync(path.join(h.workspace, b.key.folder), path.join(h.workspace, a.key.folder, 'peek'));
    expect((await a.client.get('/v1/files?path=peek')).json().error.code).toBe('path_outside_workspace');
    const json = await a.client.req('PUT', '/v1/files/content?path=data/x.json', { raw: '{"a":1}', contentType: 'application/json' });
    expect(json.json().file.size).toBe(7);
    const transfers = (await admin.get(`/api/admin/transfers?key=${a.key.id}`)).json();
    expect(transfers.rows.map((r: { direction: string }) => r.direction).sort()).toEqual(['download', 'upload', 'upload']);
  });

  it('enforces scopes', async () => {
    const { client } = await createKey(h, admin, { scopes: ['prompt'] });
    const s = await keySession(client);
    for (const [method, url, body] of [
      ['PUT', '/v1/files/content?path=a.txt', undefined],
      ['GET', '/v1/files', undefined],
      ['PATCH', `/v1/sessions/${s.id}/settings`, { sandbox: 'read-only' }],
      ['POST', `/v1/sessions/${s.id}/shell`, { command: 'id' }],
      ['POST', `/v1/sessions/${s.id}/fork`, {}],
      ['GET', '/v1/mcp', undefined],
      ['GET', '/v1/approvals', undefined],
    ] as const) {
      const r = await client.req(method, url, body === undefined ? { raw: method === 'PUT' ? 'x' : undefined } : { body });
      expect(r.json().error?.code, `${method} ${url}`).toBe('scope_missing');
    }
    const cmd = await client.post(`/v1/sessions/${s.id}/command`, { command: '!id' });
    expect(cmd.json().error.code).toBe('scope_missing');
    const fork = await client.post(`/v1/sessions/${s.id}/command`, { command: '/fork' });
    expect(fork.json().error.code).toBe('scope_missing');
  });

  it('caps sandbox and network, and denies approvals for "deny" keys', async () => {
    const { client } = await createKey(h, admin, { approvals: 'deny', maxSandbox: 'workspace-write', allowNetwork: false });
    const s = await keySession(client);
    expect((await client.patch(`/v1/sessions/${s.id}/settings`, { sandbox: 'danger-full-access' })).json().error.code).toBe('setting_not_allowed');
    expect((await client.patch(`/v1/sessions/${s.id}/settings`, { networkAccess: true })).json().error.code).toBe('setting_not_allowed');
    const st = (await client.get(`/v1/sessions/${s.id}`)).json();
    expect(st.effective).toMatchObject({ sandbox: 'workspace-write', networkAccess: false, approvalPolicy: 'never' });
    const asked: ServerEvent[] = [];
    const listener = (sid: string, ev: ServerEvent) => sid === s.id && ev.type === 'approval_requested' && asked.push(ev);
    h.runtime.turns.on('event', listener);
    const res = await client.post(`/v1/sessions/${s.id}/turns`, { text: 'please approve this', wait: true });
    h.runtime.turns.off('event', listener);
    expect(res.json().status).toBe('completed');
    expect(asked).toHaveLength(0);
    expect(res.json().commands[0]).toMatchObject({ command: 'ls -la', status: 'completed' });
  });

  it('lets "ask" keys with the approvals scope answer approvals and questions', async () => {
    // Allowing approvals through the API needs a key whose caps already allow everything.
    const { client } = await createKey(h, admin, { approvals: 'ask', maxSandbox: 'danger-full-access', allowNetwork: true });
    const s = await keySession(client);
    const q = waitForEvent(h, s.id, 'question_requested');
    expect((await client.post(`/v1/sessions/${s.id}/turns`, { text: 'approve and ask a question' })).statusCode).toBe(202);
    await q;
    const questions = (await client.get('/v1/approvals')).json().questions;
    expect(questions).toHaveLength(1);
    const asked = waitForEvent(h, s.id, 'approval_requested');
    await client.post(`/v1/questions/${questions[0].id}`, { kind: 'input', answers: { color: ['Blue'] } });
    await asked;
    const pending = (await client.get('/v1/approvals')).json();
    expect(pending.approvals).toHaveLength(1);
    const completed = waitForEvent(h, s.id, 'turn_completed');
    await client.post(`/v1/approvals/${pending.approvals[0].id}`, { decision: 'accept' });
    const done = await completed;
    expect(done.event.type === 'turn_completed' && done.event.end.status).toBe('completed');
    const history = (await client.get(`/v1/sessions/${s.id}/history`)).json();
    expect(history.entries.find((e: { kind: string }) => e.kind === 'agentMessage').data.item.text).toContain('answer: Blue');
    // Another key can't answer this key's approvals.
    const other = await createKey(h, admin);
    expect((await other.client.post('/v1/approvals/apr_nope', { decision: 'accept' })).json().error.code).toBe('approval_not_found');
  });

  it('stops a turn that crosses the quota and refuses further prompts', async () => {
    const { client, key } = await createKey(h, admin, { quotaTokens: 900, quotaPeriod: 'day' });
    const s = await keySession(client);
    const res = await client.post(`/v1/sessions/${s.id}/turns`, { text: 'steady please', wait: true });
    expect(res.json()).toMatchObject({ status: 'quota_exceeded' });
    const again = await client.post(`/v1/sessions/${s.id}/turns`, { text: 'more' });
    expect(again.statusCode).toBe(429);
    expect(again.json().error.code).toBe('quota_exceeded');
    const reqs = (await admin.get(`/api/admin/requests?key=${key.id}`)).json();
    expect(reqs.rows.map((r: { status: string }) => r.status)).toEqual(['quota_exceeded', 'quota_exceeded']);
  });

  it('expires, rotates with grace, and revokes', async () => {
    const { client, key, secret } = await createKey(h, admin, { expiresInDays: 30 });
    expect((await client.get('/v1/me')).statusCode).toBe(200);
    const rotated = (await admin.post(`/api/admin/api-keys/${key.id}/rotate`, { graceSec: 3600 })).json();
    expect(rotated.secret).not.toBe(secret);
    expect((await client.get('/v1/me')).statusCode).toBe(200); // old secret still in its grace period
    const fresh = new KeyClient(h, rotated.secret);
    expect((await fresh.get('/v1/me')).statusCode).toBe(200);
    const hard = (await admin.post(`/api/admin/api-keys/${key.id}/rotate`, { graceSec: 0 })).json();
    expect((await fresh.get('/v1/me')).json().error.code).toBe('invalid_api_key');
    const current = new KeyClient(h, hard.secret);
    expect((await current.get('/v1/me')).statusCode).toBe(200);
    await admin.req('PATCH', `/api/admin/api-keys/${key.id}`, { body: { expiresAt: Date.now() - 1000 } });
    expect((await current.get('/v1/me')).json().error.code).toBe('api_key_expired');
    await admin.req('PATCH', `/api/admin/api-keys/${key.id}`, { body: { expiresAt: null } });
    await admin.post(`/api/admin/api-keys/${key.id}/revoke`);
    expect((await current.get('/v1/me')).json().error.code).toBe('api_key_revoked');
    const sec = (await admin.get(`/api/admin/security?key=${key.id}`)).json();
    expect(sec.rows.map((r: { kind: string }) => r.kind)).toEqual(expect.arrayContaining(['api_key_created', 'api_key_rotated', 'api_key_revoked', 'api_key_rejected']));
  });

  it('applies per-key request, prompt and concurrency limits', async () => {
    const strict = await createKey(h, admin, { limits: { perMinute: 3, promptsPerMinute: 1000, concurrent: 5, uploadMbPerHour: 500 } });
    for (let i = 0; i < 3; i++) expect((await strict.client.get('/v1/me')).statusCode).toBe(200);
    const limited = await strict.client.get('/v1/me');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();

    const one = await createKey(h, admin, { limits: { perMinute: 1000, promptsPerMinute: 1000, concurrent: 1, uploadMbPerHour: 500 } });
    const s1 = await keySession(one.client);
    const s2 = await keySession(one.client);
    const started = waitForEvent(h, s1.id, 'item_delta');
    await one.client.post(`/v1/sessions/${s1.id}/turns`, { text: 'slow' });
    await started;
    expect((await one.client.post(`/v1/sessions/${s2.id}/turns`, { text: 'second' })).json().error.code).toBe('too_many_turns');
    // Revoking the key stops its running turn.
    const done = waitForEvent(h, s1.id, 'turn_completed');
    await admin.post(`/api/admin/api-keys/${one.key.id}/revoke`);
    const { event } = await done;
    expect(event.type === 'turn_completed' && event.end.status).toBe('interrupted');
  });

  it('honours IP allowlists using the forwarded client address', async () => {
    const proxied = await makeHarness({ env: { CC_API_TRUST_PROXY: 'loopback' } });
    try {
      const owner = await pairAndLogin(proxied);
      const { secret } = await createKey(proxied, owner, { ipAllowlist: ['10.0.0.0/8', '2001:db8::/32'] });
      const from = (ip: string) => new KeyClient(proxied, secret, { 'x-forwarded-for': ip });
      expect((await new KeyClient(proxied, secret).get('/v1/me')).json().error.code).toBe('ip_not_allowed');
      expect((await from('10.1.2.3').get('/v1/me')).statusCode).toBe(200);
      expect((await from('2001:db8::7').get('/v1/me')).statusCode).toBe(200);
      expect((await from('192.168.1.9').get('/v1/me')).json().error.code).toBe('ip_not_allowed');
    } finally {
      await proxied.close();
    }
  });

  it('throttles repeated bad keys without blocking valid ones', async () => {
    const t = await makeHarness({ env: { CC_API_BAD_KEY_LIMIT: '3' } });
    try {
      const owner = await pairAndLogin(t);
      const { client } = await createKey(t, owner);
      const bad = new KeyClient(t, 'cck_0000000000000000.' + 'A'.repeat(43));
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await bad.get('/v1/me')).statusCode);
      expect(codes).toEqual([401, 401, 401, 429, 429]);
      expect((await client.get('/v1/me')).statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });

  it('streams events for its own sessions', async () => {
    const { client } = await createKey(h, admin);
    const s = await keySession(client);
    await h.publicApi.app.ready();
    const done = waitForEvent(h, s.id, 'turn_completed');
    await client.post(`/v1/sessions/${s.id}/turns`, { text: 'hi' });
    await done;
    const result = (await client.get(`/v1/sessions/${s.id}`)).json();
    expect(result.turn).toBeNull();
  });
});
