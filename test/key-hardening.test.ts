import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerEvent } from '../shared/api.js';
import { Client, createKey, KeyClient, makeHarness, signIn, waitForEvent, type Harness } from './helpers.js';

const endOf = (ev: ServerEvent) => (ev.type === 'turn_completed' ? ev.end : null);

describe('API key caps, quota and lifetime', () => {
  let h: Harness;
  let admin: Client;
  beforeAll(async () => {
    h = await makeHarness();
    admin = await signIn(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  const keySession = async (c: KeyClient) => (await c.post('/v1/sessions', { title: 'hardening' })).json().session as { id: string };

  it('lets a capped key decline its approvals but not allow them; the owner still can', async () => {
    const { client } = await createKey(h, admin, { approvals: 'ask' });
    const s = await keySession(client);
    const asked = waitForEvent(h, s.id, 'approval_requested');
    expect((await client.post(`/v1/sessions/${s.id}/turns`, { text: 'please approve this' })).statusCode).toBe(202);
    await asked;
    const [approval] = (await client.get('/v1/approvals')).json().approvals;
    for (const decision of ['accept', 'acceptForSession']) {
      const res = await client.post(`/v1/approvals/${approval.id}`, { decision });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('setting_not_allowed');
    }
    // The owner, in the console, decides.
    const done = waitForEvent(h, s.id, 'turn_completed');
    expect((await admin.post(`/api/approvals/${approval.id}`, { decision: 'accept' })).statusCode).toBe(200);
    expect(endOf((await done).event)?.status).toBe('completed');

    // A permission request (network / files) can be declined by the key itself.
    const asked2 = waitForEvent(h, s.id, 'approval_requested');
    await client.post(`/v1/sessions/${s.id}/turns`, { text: 'need permission for the network' });
    const ev = (await asked2).event;
    expect(ev.type === 'approval_requested' && ev.approval.kind).toBe('permissions');
    const sent: unknown[] = [];
    const bridge = h.runtime.bridge as unknown as { respond: (id: unknown, result: unknown) => void };
    const original = bridge.respond.bind(bridge);
    bridge.respond = (id, result) => {
      sent.push(result);
      original(id, result);
    };
    try {
      const pending = (await client.get('/v1/approvals')).json().approvals[0];
      expect((await client.post(`/v1/approvals/${pending.id}`, { decision: 'accept' })).statusCode).toBe(403);
      const finished = waitForEvent(h, s.id, 'turn_completed');
      expect((await client.post(`/v1/approvals/${pending.id}`, { decision: 'decline' })).statusCode).toBe(200);
      await finished;
      expect(sent).toContainEqual({ permissions: {}, scope: 'turn' });
    } finally {
      bridge.respond = original;
    }
  });

  it('lets a key with full access and network allow its own approvals', async () => {
    const { client } = await createKey(h, admin, { approvals: 'ask', maxSandbox: 'danger-full-access', allowNetwork: true });
    const s = await keySession(client);
    const asked = waitForEvent(h, s.id, 'approval_requested');
    await client.post(`/v1/sessions/${s.id}/turns`, { text: 'please approve this' });
    await asked;
    const [approval] = (await client.get('/v1/approvals')).json().approvals;
    const done = waitForEvent(h, s.id, 'turn_completed');
    expect((await client.post(`/v1/approvals/${approval.id}`, { decision: 'accept' })).statusCode).toBe(200);
    expect(endOf((await done).event)?.status).toBe('completed');
  });

  it('refuses image links for keys without network access', async () => {
    const offline = await createKey(h, admin);
    const s = await keySession(offline.client);
    const res = await offline.client.post(`/v1/sessions/${s.id}/turns`, { text: 'look', imageUrls: ['https://example.com/a.png'] });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('setting_not_allowed');
    const online = await createKey(h, admin, { allowNetwork: true });
    const s2 = await keySession(online.client);
    const done = waitForEvent(h, s2.id, 'turn_completed');
    expect((await online.client.post(`/v1/sessions/${s2.id}/turns`, { text: 'look', imageUrls: ['https://example.com/a.png'] })).statusCode).toBe(202);
    await done;
  });

  it('holds the quota across turns running at the same time', async () => {
    const quota = 2500;
    const { client } = await createKey(h, admin, { quotaTokens: quota, quotaPeriod: 'day' });
    const ids = await Promise.all([keySession(client), keySession(client), keySession(client)]);
    // One "steady" turn alone uses ~2,850 tokens; three in parallel used ~3× the quota before the fix.
    const results = await Promise.all(ids.map((s) => client.post(`/v1/sessions/${s.id}/turns`, { text: 'steady please', wait: true, timeoutSec: 30 })));
    for (const r of results) expect(r.json().status).toBe('quota_exceeded');
    const used = (await client.get('/v1/me')).json().quota.used as number;
    expect(used).toBeGreaterThan(0);
    expect(used).toBeLessThan(quota * 1.6);
    expect((await client.post(`/v1/sessions/${ids[0]!.id}/turns`, { text: 'more' })).json().error.code).toBe('quota_exceeded');
  });

  it('stops a running turn when its key expires', async () => {
    const { client, key } = await createKey(h, admin);
    const s = await keySession(client);
    const started = waitForEvent(h, s.id, 'turn_started');
    await client.post(`/v1/sessions/${s.id}/turns`, { text: 'slow please' });
    await started;
    const done = waitForEvent(h, s.id, 'turn_completed', 10_000);
    expect((await admin.req('PATCH', `/api/admin/api-keys/${key.id}`, { body: { expiresAt: Date.now() + 300 } })).statusCode).toBe(200);
    const t0 = Date.now();
    expect(endOf((await done).event)?.status).toBe('interrupted');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect((await client.get('/v1/me')).json().error.code).toBe('api_key_expired');
  });

  it('tracks turns Codex starts by itself, and charges them to the key', async () => {
    // Console session: the automatic turn is logged and streamed like any other.
    const s = (await admin.post('/api/sessions', { title: 'auto' })).json().session as { id: string };
    const first = waitForEvent(h, s.id, 'turn_completed');
    await admin.post(`/api/sessions/${s.id}/turns`, { text: 'hello' });
    await first;
    const auto = waitForEvent(h, s.id, 'turn_completed');
    expect((await admin.post(`/api/sessions/${s.id}/goal`, { objective: 'autostart the next step' })).statusCode).toBe(200);
    const { event, seen } = await auto;
    expect(seen.find((e) => e.type === 'turn_started')).toMatchObject({ kind: 'auto' });
    expect(endOf(event)).toMatchObject({ status: 'completed', kind: 'auto' });
    const rows = (await admin.get('/api/admin/requests?limit=5')).json().rows as Array<{ sessionId: string; kind: string; inputTokens: number | null }>;
    const row = rows.find((r) => r.sessionId === s.id && r.kind === 'auto');
    expect(row?.inputTokens).toBeGreaterThan(0);

    // Key session with its quota used up: the automatic turn is stopped at once.
    const { client } = await createKey(h, admin, { quotaTokens: 900, quotaPeriod: 'day' });
    const ks = await keySession(client);
    expect((await client.post(`/v1/sessions/${ks.id}/turns`, { text: 'hello', wait: true })).json().status).toBe('quota_exceeded');
    const stopped = waitForEvent(h, ks.id, 'turn_completed');
    await client.post(`/v1/sessions/${ks.id}/goal`, { objective: 'autostart more work' });
    expect(endOf((await stopped).event)).toMatchObject({ status: 'quota_exceeded', kind: 'auto' });
  });
});

describe('public API rate budget', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness({ env: { CC_API_MAX_PER_MIN: '10' } });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('keeps unauthenticated and failed calls from using up the budget of valid keys', async () => {
    const admin = await signIn(h);
    const { client } = await createKey(h, admin);
    const bad = new KeyClient(h, `cck_${'0'.repeat(16)}.${'A'.repeat(43)}`);
    for (let i = 0; i < 12; i++) expect((await bad.get('/v1/me')).statusCode).toBe(401);
    const health = [];
    for (let i = 0; i < 11; i++) health.push((await bad.get('/v1/health')).statusCode);
    expect(health.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(health[10]).toBe(429);
    expect((await client.get('/v1/me')).statusCode).toBe(200);
  });
});
