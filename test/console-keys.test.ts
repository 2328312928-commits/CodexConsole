import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, issueConsoleKey, KeyClient, makeHarness, signIn, waitForEvent, type Harness } from './helpers.js';

let h: Harness;
let admin: Client;

beforeAll(async () => {
  h = await makeHarness();
  admin = await signIn(h);
});
afterAll(async () => {
  await h?.close();
});

const newSession = async (c: Client, title = 'Test') => {
  const res = await c.post('/api/sessions', { title });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().session as { id: string; workspacePath: string | null; cwd: string };
};

/** Open the live event stream over a real socket; resolves when the server ends it. */
async function openStream(c: Client, sessionId: string): Promise<{ ended: Promise<string> }> {
  if (!h.app.server.listening) await h.app.listen({ port: 0, host: '127.0.0.1' });
  const port = (h.app.server.address() as AddressInfo).port;
  const cookie = [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/api/sessions/${sessionId}/events`, headers: { host: '127.0.0.1:8787', cookie } }, resolve).on('error', reject);
  });
  expect(res.statusCode).toBe(200);
  let body = '';
  res.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
  return { ended: new Promise((resolve) => res.on('end', () => resolve(body))) };
}

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`not within ${ms} ms`)), ms))]);

describe('revoking and changing keys', () => {
  it('revoking a key signs it out everywhere at once: requests, live stream and running turn', async () => {
    const { key, secret } = issueConsoleKey(h, 'Laptop');
    const laptop = await signIn(h, new Client(h.app), { key: secret, admin: false });
    const s = await newSession(laptop);
    const stream = await openStream(laptop, s.id);
    const streaming = waitForEvent(h, s.id, 'item_delta');
    await laptop.post(`/api/sessions/${s.id}/turns`, { text: 'slow' });
    await streaming;
    const stopped = waitForEvent(h, s.id, 'turn_completed');

    expect((await admin.post(`/api/admin/api-keys/${key.id}/revoke`)).statusCode).toBe(200);
    expect(await within(stream.ended, 2000)).toContain('event: snapshot');
    const { event } = await stopped;
    expect(event.type === 'turn_completed' && event.end.status).toBe('interrupted');
    expect((await laptop.get('/api/sessions')).json().error.code).toBe('login_required');
    expect((await new Client(h.app).post('/api/auth/key', { key: secret })).json().error.code).toBe('api_key_revoked');
  });

  it('rotating signs the key out; the old secret never signs in to the console again', async () => {
    const { key, secret } = issueConsoleKey(h, 'Desk', { scopes: ['prompt'] });
    const desk = await signIn(h, new Client(h.app), { key: secret, admin: false });
    const rotated = (await admin.post(`/api/admin/api-keys/${key.id}/rotate`, { graceSec: 3600 })).json();
    expect(rotated.consoleUrl).toBe('http://127.0.0.1:8787');
    expect((await desk.get('/api/sessions')).json().error.code).toBe('login_required');
    // The grace period keeps the old secret working for API scripts only.
    expect((await new KeyClient(h, secret).get('/v1/me')).statusCode).toBe(200);
    expect((await new Client(h.app).post('/api/auth/key', { key: secret })).json().error.code).toBe('invalid_api_key');
    expect((await new Client(h.app).post('/api/auth/key', { key: rotated.secret })).statusCode).toBe(200);
  });

  it('changing console access signs the key out; an IP allowlist and an expiry apply to the next request', async () => {
    const { key, secret } = issueConsoleKey(h, 'Phone');
    const phone = await signIn(h, new Client(h.app), { key: secret, admin: false });
    await admin.req('PATCH', `/api/admin/api-keys/${key.id}`, { body: { ipAllowlist: ['10.0.0.0/8'] } });
    expect((await phone.get('/api/sessions')).json().error.code).toBe('login_required');
    expect((await new Client(h.app).post('/api/auth/key', { key: secret })).json().error.code).toBe('ip_not_allowed');
    expect((await new Client(h.app, '10.1.2.3').post('/api/auth/key', { key: secret })).statusCode).toBe(200);

    await admin.req('PATCH', `/api/admin/api-keys/${key.id}`, { body: { ipAllowlist: [] } });
    const again = await signIn(h, new Client(h.app), { key: secret, admin: false });
    await admin.req('PATCH', `/api/admin/api-keys/${key.id}`, { body: { expiresAt: Date.now() - 1000 } });
    expect((await again.get('/api/sessions')).json().error.code).toBe('login_required');
    expect((await new Client(h.app).post('/api/auth/key', { key: secret })).json().error.code).toBe('api_key_expired');

    const other = issueConsoleKey(h, 'Watch');
    const watch = await signIn(h, new Client(h.app), { key: other.secret, admin: false });
    await admin.req('PATCH', `/api/admin/api-keys/${other.key.id}`, { body: { consoleAccess: 'folder' } });
    expect((await watch.get('/api/sessions')).json().error.code).toBe('login_required');
    await admin.req('PATCH', `/api/admin/api-keys/${other.key.id}`, { body: { consoleAccess: 'none', scopes: ['prompt'] } });
    expect((await new Client(h.app).post('/api/auth/key', { key: other.secret })).json().error.code).toBe('console_not_allowed');
    // A key has to be good for something.
    const useless = await admin.req('PATCH', `/api/admin/api-keys/${other.key.id}`, { body: { scopes: [] } });
    expect(useless.json().error.code).toBe('bad_request');
  });
});

describe('what a key reaches', () => {
  it('a folder key sees only its own sessions and folder, with paths relative to it', async () => {
    const shared = await newSession(admin, 'Owner work');
    fs.writeFileSync(path.join(shared.cwd, 'private.txt'), 'owner only');
    const created = (
      await admin.post('/api/admin/api-keys', {
        label: 'Kiosk',
        consoleAccess: 'folder',
        scopes: [],
        quotaTokens: null,
        quotaPeriod: 'month',
        maxSandbox: 'workspace-write',
        allowNetwork: false,
        approvals: 'ask',
        limits: { perMinute: 600, promptsPerMinute: 20, concurrent: 2, uploadMbPerHour: 100 },
        ipAllowlist: [],
        expiresInDays: null,
      })
    ).json();
    const kiosk = await signIn(h, new Client(h.app), { key: created.secret, admin: false });
    const state = (await kiosk.get('/api/auth/state')).json();
    expect(state.key).toMatchObject({ access: 'folder', maxSandbox: 'workspace-write', allowNetwork: false, canAllow: false });

    const list = (await kiosk.get('/api/sessions')).json();
    expect(list.sessions).toEqual([]);
    expect(list.workspaceRoot).toBe(path.join(h.workspace, created.key.folder));
    expect((await kiosk.get(`/api/sessions/${shared.id}`)).json().error.code).toBe('session_not_found');
    expect((await kiosk.get(`/api/files/view?path=${encodeURIComponent(`${shared.workspacePath}/private.txt`)}`)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await kiosk.get(`/api/files/view?path=${encodeURIComponent('../' + shared.workspacePath + '/private.txt')}`)).statusCode).toBeGreaterThanOrEqual(400);

    const own = await newSession(kiosk, 'Kiosk work');
    expect(own.cwd.startsWith(path.join(h.workspace, created.key.folder) + path.sep)).toBe(true);
    expect(own.workspacePath).not.toContain('/api/');
    fs.writeFileSync(path.join(own.cwd, 'note.txt'), 'kiosk note');
    const view = await kiosk.get(`/api/files/view?path=${encodeURIComponent(`${own.workspacePath}/note.txt`)}`);
    expect(view.body).toBe('kiosk note');
    expect((await kiosk.get('/api/files')).json().entries.map((e: { name: string }) => e.name)).toEqual([path.basename(own.cwd)]);
    expect((await kiosk.get('/api/codex/threads')).json().error.code).toBe('setting_not_allowed');
    // The owner still sees everything, attributed to the key that made it.
    const mine = (await admin.get('/api/sessions')).json().sessions.find((x: { id: string }) => x.id === own.id);
    expect(mine.apiKey).toMatchObject({ id: created.key.id, label: 'Kiosk' });
  });

  it('applies the key caps: no bigger sandbox, no network, no automatic reviewer, decline only', async () => {
    const { secret } = issueConsoleKey(h, 'Capped', { maxSandbox: 'workspace-write', allowNetwork: false });
    const capped = await signIn(h, new Client(h.app), { key: secret, admin: false });
    const s = await newSession(capped);
    const tryPatch = (body: unknown) => capped.req('PATCH', `/api/sessions/${s.id}/settings`, { body });
    expect((await tryPatch({ sandbox: 'danger-full-access' })).json().error.code).toBe('setting_not_allowed');
    expect((await tryPatch({ networkAccess: true })).json().error.code).toBe('setting_not_allowed');
    expect((await tryPatch({ approvalsReviewer: 'auto_review' })).json().error.code).toBe('setting_not_allowed');
    expect((await tryPatch({ sandbox: 'read-only' })).statusCode).toBe(200);
    const imageLink = await capped.post(`/api/sessions/${s.id}/turns`, { text: 'look', imageUrls: ['https://example.com/a.png'] });
    expect(imageLink.json().error.code).toBe('setting_not_allowed');
    // Shell commands would run outside the sandbox: refused on both paths.
    expect((await capped.post(`/api/sessions/${s.id}/shell`, { command: 'id' })).json().error.code).toBe('setting_not_allowed');
    expect((await capped.post(`/api/sessions/${s.id}/command`, { command: '!id' })).json().error.code).toBe('setting_not_allowed');

    const asked = waitForEvent(h, s.id, 'approval_requested');
    await capped.post(`/api/sessions/${s.id}/turns`, { text: 'please approve a command' });
    const { event } = await asked;
    const approvalId = event.type === 'approval_requested' ? event.approval.id : '';
    expect((await capped.post(`/api/approvals/${approvalId}`, { decision: 'accept' })).json().error.code).toBe('setting_not_allowed');
    const done = waitForEvent(h, s.id, 'turn_completed');
    expect((await capped.post(`/api/approvals/${approvalId}`, { decision: 'decline' })).statusCode).toBe(200);
    await done;
  });

  it('a full key with nothing capped works like the old owner console', async () => {
    const full = await signIn(h, new Client(h.app), { admin: false });
    const s = await newSession(full);
    expect((await full.req('PATCH', `/api/sessions/${s.id}/settings`, { body: { sandbox: 'danger-full-access', approvalsReviewer: 'auto_review', networkAccess: true } })).statusCode).toBe(200);
    const asked = waitForEvent(h, s.id, 'approval_requested');
    await full.req('PATCH', `/api/sessions/${s.id}/settings`, { body: { approvalsReviewer: 'user' } });
    await full.post(`/api/sessions/${s.id}/turns`, { text: 'please approve a command' });
    const { event } = await asked;
    const done = waitForEvent(h, s.id, 'turn_completed');
    expect((await full.post(`/api/approvals/${event.type === 'approval_requested' ? event.approval.id : ''}`, { decision: 'accept' })).statusCode).toBe(200);
    await done;
  });

  it('charges console turns to the key: quota, prompts per minute and usage per key', async () => {
    const { key, secret } = issueConsoleKey(h, 'Metered', { quotaTokens: 100, quotaPeriod: 'day', limits: { perMinute: 600, promptsPerMinute: 1, concurrent: 1, uploadMbPerHour: 10 } });
    const metered = await signIn(h, new Client(h.app), { key: secret, admin: false });
    const s = await newSession(metered);
    const done = waitForEvent(h, s.id, 'turn_completed');
    expect((await metered.post(`/api/sessions/${s.id}/turns`, { text: 'hello' })).statusCode).toBe(200);
    await done;
    expect((await metered.post(`/api/sessions/${s.id}/turns`, { text: 'again' })).json().error.code).toBe('rate_limited');
    h.runtime.limiter.reset(`apikey:prompt:${key.id}`);
    expect((await metered.post(`/api/sessions/${s.id}/turns`, { text: 'again' })).json().error.code).toBe('quota_exceeded');
    const usage = (await admin.get(`/api/admin/api-keys/${key.id}/usage`)).json();
    expect(usage.key.usage30d.requests).toBeGreaterThanOrEqual(1);
    expect(usage.key.signIns).toBe(1);
  });

  it('lets a capped key look at other sessions but only work in its own', async () => {
    const ownerSession = await newSession(admin, 'Owner session');
    const { secret } = issueConsoleKey(h, 'Viewer', { maxSandbox: 'read-only', allowNetwork: false, approvals: 'deny' });
    const viewer = await signIn(h, new Client(h.app), { key: secret, admin: false });
    expect((await viewer.get(`/api/sessions/${ownerSession.id}`)).statusCode).toBe(200);
    expect((await viewer.get(`/api/sessions/${ownerSession.id}/history`)).statusCode).toBe(200);
    const denied = (method: string, url: string, body?: unknown) =>
      viewer.req(method, url, body === undefined ? {} : { body }).then((r) => r.json().error?.code);
    expect(await denied('POST', `/api/sessions/${ownerSession.id}/turns`, { text: 'hi' })).toBe('setting_not_allowed');
    expect(await denied('POST', `/api/sessions/${ownerSession.id}/queue`, { text: 'hi' })).toBe('setting_not_allowed');
    expect(await denied('POST', `/api/sessions/${ownerSession.id}/goal`, { objective: 'keep going' })).toBe('setting_not_allowed');
    expect(await denied('PATCH', `/api/sessions/${ownerSession.id}/settings`, { approvalPolicy: 'never' })).toBe('setting_not_allowed');
    expect(await denied('POST', `/api/sessions/${ownerSession.id}/steer`, { text: 'also do this' })).toBe('setting_not_allowed');
    expect(await denied('DELETE', `/api/sessions/${ownerSession.id}`)).toBe('setting_not_allowed');
    // A fork is its own: it runs under the key's caps.
    const fork = await viewer.post(`/api/sessions/${ownerSession.id}/fork`, {});
    expect(fork.json().error?.code).not.toBe('setting_not_allowed');

    // In its own session it may not join a turn someone else started either.
    const mine = await newSession(viewer, 'Viewer work');
    const streaming = waitForEvent(h, mine.id, 'item_delta');
    await admin.post(`/api/sessions/${mine.id}/turns`, { text: 'slow' });
    await streaming;
    expect(await denied('POST', `/api/sessions/${mine.id}/steer`, { text: 'and delete everything' })).toBe('setting_not_allowed');
    const stopped = waitForEvent(h, mine.id, 'turn_completed');
    await admin.post(`/api/sessions/${mine.id}/interrupt`);
    await stopped;
  });

  it('holds queued prompts to the key: prompts per minute, and prompts at once', async () => {
    const { key, secret } = issueConsoleKey(h, 'Queued', { limits: { perMinute: 600, promptsPerMinute: 20, concurrent: 1, uploadMbPerHour: 10 } });
    const queued = await signIn(h, new Client(h.app), { key: secret, admin: false });
    const a = await newSession(queued, 'Queue A');
    const b = await newSession(queued, 'Queue B');
    const aDone = waitForEvent(h, a.id, 'turn_completed');
    const bDone = waitForEvent(h, b.id, 'turn_completed');
    expect((await queued.post(`/api/sessions/${a.id}/queue`, { text: 'steady' })).statusCode).toBe(200);
    expect((await queued.post(`/api/sessions/${b.id}/queue`, { text: 'steady' })).statusCode).toBe(200);
    let most = 0;
    const timer = setInterval(() => (most = Math.max(most, h.runtime.turns.runningForKey(key.id))), 5);
    await Promise.all([aDone, bDone]);
    clearInterval(timer);
    expect(most).toBe(1);

    const slow = issueConsoleKey(h, 'One a minute', { limits: { perMinute: 600, promptsPerMinute: 1, concurrent: 4, uploadMbPerHour: 10 } });
    const one = await signIn(h, new Client(h.app), { key: slow.secret, admin: false });
    const c = await newSession(one, 'Queue C');
    const cDone = waitForEvent(h, c.id, 'turn_completed');
    expect((await one.post(`/api/sessions/${c.id}/queue`, { text: 'hello' })).statusCode).toBe(200);
    expect((await one.post(`/api/sessions/${c.id}/queue`, { text: 'again' })).json().error.code).toBe('rate_limited');
    await cDone;
  });

  it('keeps the admin area out of reach of every key', async () => {
    const plain = await signIn(h, new Client(h.app), { admin: false });
    for (const url of ['/api/admin/overview', '/api/admin/api-keys', '/api/admin/logins', '/api/admin/codex']) {
      expect((await plain.get(url)).json().error.code, url).toBe('admin_required');
    }
    expect((await plain.post('/api/admin/api-keys', { label: 'sneaky' })).json().error.code).toBe('admin_required');
  });
});
