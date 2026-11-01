import fs from 'node:fs';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { allowedCommand, runViaRelay } from '../server/codex/relay.js';
import { makeHarness, signIn, waitForEvent, type Harness } from './helpers.js';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

/** Send one raw request to the relay and collect what it answers before closing. */
function rawRequest(socketPath: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let data = '';
    sock.setEncoding('utf8');
    sock.on('data', (c: string) => (data += c));
    sock.on('close', () => resolve(data));
    sock.on('error', reject);
    sock.write(payload);
  });
}

describe('the Codex relay', () => {
  it('runs only the app-server, doctor and MCP sign-out, with no other arguments', () => {
    expect(allowedCommand(['app-server'])).toEqual(['app-server']);
    expect(allowedCommand(['doctor'])).toEqual(['doctor']);
    expect(allowedCommand(['mcp', 'logout', 'github'])).toEqual(['mcp', 'logout', 'github']);
    for (const bad of [
      ['app-server', '--listen', 'ws://0.0.0.0:9000'],
      ['exec', 'rm -rf /'],
      ['mcp', 'logout', '../x'],
      ['mcp', 'add', 'x'],
      ['login'],
      'app-server',
      [1],
      [],
    ]) {
      expect(allowedCommand(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('listens on a socket only its group may use, and refuses anything else', async () => {
    h = await makeHarness({ relay: {} });
    const socketPath = h.relay!.socketPath;
    expect(fs.statSync(socketPath).mode & 0o777).toBe(0o660);
    expect(JSON.parse(await rawRequest(socketPath, '{"cmd":["exec","id"]}\n'))).toEqual({ error: 'not_allowed' });
    expect(JSON.parse(await rawRequest(socketPath, 'not json\n'))).toEqual({ error: 'not_allowed' });
    // A first line that never ends is cut off.
    expect(await rawRequest(socketPath, 'x'.repeat(10_000))).toBe('');
    expect(await runViaRelay(socketPath, ['doctor'], 10_000)).toMatchObject({ ok: true, output: expect.stringContaining('installation') });
    expect(await runViaRelay(socketPath, ['mcp', 'logout', 'github'], 10_000)).toMatchObject({ ok: true, output: expect.stringContaining('github') });
  });

  it('runs a whole console through it: turns, doctor, MCP sign-out', async () => {
    h = await makeHarness({ relay: {} });
    expect(h.runtime.bridge.ready).toBe(true);
    const admin = await signIn(h);
    const s = (await admin.post('/api/sessions', { title: 'Through the relay' })).json().session;
    const done = waitForEvent(h, s.id, 'turn_completed');
    expect((await admin.post(`/api/sessions/${s.id}/turns`, { text: 'Hello through the relay' })).statusCode).toBe(200);
    const { event, seen } = await done;
    expect(event.type === 'turn_completed' && event.end.status).toBe('completed');
    expect(seen.some((e) => e.type === 'item_delta')).toBe(true);
    const doctor = (await admin.post('/api/admin/codex/doctor')).json();
    expect(doctor).toMatchObject({ ok: true, output: expect.stringContaining('installation') });
    expect((await admin.post('/api/admin/mcp/github/logout')).statusCode).toBe(200);
    expect((await admin.get('/api/admin/codex')).json().bin).toBe(`relay: ${h.relay!.socketPath}`);
  });

  it('reconnects when the relay restarts', async () => {
    h = await makeHarness({ relay: {} });
    const bridge = h.runtime.bridge;
    await h.relay!.stop();
    for (let i = 0; i < 100 && bridge.ready; i++) await new Promise((r) => setTimeout(r, 20));
    expect(bridge.ready).toBe(false);
    await h.relay!.start();
    await bridge.waitReady(10_000);
    const admin = await signIn(h);
    const s = (await admin.post('/api/sessions', {})).json().session;
    const done = waitForEvent(h, s.id, 'turn_completed');
    await admin.post(`/api/sessions/${s.id}/turns`, { text: 'still there?' });
    expect((await done).event.type).toBe('turn_completed');
  });

  it('starts at most the configured number of app-servers at once', async () => {
    h = await makeHarness({ relay: { maxAppServers: 1 } });
    // The console holds the only slot, so another app-server connection is turned away.
    expect(JSON.parse(await rawRequest(h.relay!.socketPath, '{"cmd":["app-server"]}\n'))).toEqual({ error: 'busy' });
  });
});
