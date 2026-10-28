import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RpcError } from '../server/codex/rpc.js';
import { Client, makeHarness, pairAndLogin, waitForEvent, type Harness } from './helpers.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('Codex process supervision', () => {
  it('restarts the app-server after it crashes', async () => {
    h = await makeHarness({ fakeEnv: { FAKE_CODEX_CRASH_ON: 'model/list' } });
    const bridge = h.runtime.bridge;
    await expect(bridge.request('model/list', {})).rejects.toBeInstanceOf(RpcError);
    await new Promise((r) => setTimeout(r, 300));
    await bridge.waitReady(10_000);
    expect(bridge.status.restarts).toBeGreaterThanOrEqual(1);
    const acct = await bridge.request<{ account: { type: string } }>('account/read', {});
    expect(acct.account.type).toBe('chatgpt');
  });

  it('fails a running turn cleanly when Codex dies mid-turn', async () => {
    h = await makeHarness();
    const client = await pairAndLogin(h);
    const s = (await client.post('/api/sessions', {})).json().session;
    const streaming = waitForEvent(h, s.id, 'item_delta');
    await client.post(`/api/sessions/${s.id}/turns`, { text: 'slow' });
    await streaming;
    const done = waitForEvent(h, s.id, 'turn_completed');
    (h.runtime.bridge as unknown as { child: { kill(sig: string): void } }).child.kill('SIGKILL');
    const { event } = await done;
    expect(event.type === 'turn_completed' && event.end).toMatchObject({ status: 'error', error: 'Codex app-server exited' });
    const reqs = (await client.get('/api/admin/requests')).json();
    expect(reqs.rows[0].status).toBe('error');
    await h.runtime.bridge.waitReady(10_000);
    expect(h.runtime.turns.isRunning(s.id)).toBe(false);
  });
});

describe('server-sent events', () => {
  it('streams a snapshot and live events to an authenticated browser only', async () => {
    h = await makeHarness();
    const client = await pairAndLogin(h);
    const s = (await client.post('/api/sessions', {})).json().session;
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (h.app.server.address() as AddressInfo).port;
    const cookie = [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; ');

    const open = (withCookie: boolean) =>
      new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: `/api/sessions/${s.id}/events`, headers: { host: '127.0.0.1:8787', ...(withCookie ? { cookie } : {}) } }, resolve);
        req.on('error', reject);
      });

    const denied = await open(false);
    expect(denied.statusCode).toBe(401);
    denied.resume();

    const res = await open(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    let buffer = '';
    const events: string[] = [];
    const gotCompletion = new Promise<void>((resolve) => {
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        for (const m of buffer.matchAll(/^event: (\w+)$/gm)) events.push(m[1]!);
        buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
        if (events.includes('turn_completed')) resolve();
      });
    });
    await new Client(h.app).req('GET', '/api/health');
    await client.post(`/api/sessions/${s.id}/turns`, { text: 'hello over SSE' });
    await gotCompletion;
    res.destroy();
    expect(events[0]).toBe('snapshot');
    expect(events).toEqual(expect.arrayContaining(['turn_started', 'item_started', 'item_delta', 'item_completed', 'usage', 'turn_completed']));
  });
});
