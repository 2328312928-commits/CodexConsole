import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '../server/auth/totp.js';
import { parseProxyHeader } from '../server/lib/net.js';
import { Client, createKey, makeHarness, pairAndLogin, type Harness } from './helpers.js';

describe('MCP management', () => {
  let h: Harness;
  let admin: Client;
  beforeAll(async () => {
    h = await makeHarness();
    admin = await pairAndLogin(h);
  });
  afterAll(async () => {
    await h?.close();
  });

  const servers = async () => (await admin.get('/api/admin/mcp')).json().servers as Array<Record<string, any>>;

  it('adds, edits, disables and removes a local server without ever returning env values', async () => {
    const add = await admin.post('/api/admin/mcp', { name: 'docs', transport: 'stdio', command: 'npx', args: ['-y', 'docs-mcp'], env: { DOCS_TOKEN: 'super-secret-token' } });
    expect(add.statusCode, add.body).toBe(200);
    expect(add.body).not.toContain('super-secret-token');
    const [docs] = await servers();
    expect(docs).toMatchObject({ name: 'docs', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', 'docs-mcp'], envKeys: ['DOCS_TOKEN'], runtimeStatus: 'connected', authStatus: 'unsupported', tools: [{ name: 'echo' }] });
    // Blank value keeps the stored secret; new variables are added.
    await admin.req('PUT', '/api/admin/mcp/docs', { body: { transport: 'stdio', command: 'npx', args: ['-y', 'docs-mcp'], env: { DOCS_TOKEN: '', REGION: 'eu' } } });
    const cfg = await h.runtime.bridge.request<{ config: { mcp_servers: Record<string, { env: Record<string, string> }> } }>('config/read', {});
    expect(cfg.config.mcp_servers.docs!.env).toEqual({ DOCS_TOKEN: 'super-secret-token', REGION: 'eu' });
    await admin.post('/api/admin/mcp/docs/enabled', { enabled: false });
    expect((await servers())[0]).toMatchObject({ enabled: false, runtimeStatus: 'disabled' });
    await admin.post('/api/admin/mcp/docs/enabled', { enabled: true });
    expect((await admin.post('/api/admin/mcp', { name: 'docs', transport: 'stdio', command: 'x' })).json().error.code).toBe('mcp_server_exists');
    expect((await admin.post('/api/admin/mcp', { name: 'bad name', transport: 'stdio', command: 'x' })).statusCode).toBe(400);
    expect((await admin.req('DELETE', '/api/admin/mcp/docs')).statusCode).toBe(200);
    expect(await servers()).toEqual([]);
    const events = (await admin.get('/api/admin/security?limit=100')).json().rows.map((r: { kind: string }) => r.kind);
    expect(events).toEqual(expect.arrayContaining(['mcp_server_added', 'mcp_server_updated', 'mcp_server_removed']));
  });

  it('starts OAuth sign-in for remote servers and reports auth status', async () => {
    expect((await admin.post('/api/admin/mcp', { name: 'remote', transport: 'http', url: 'http://mcp.example.com/mcp' })).json().error.code).toBe('bad_request');
    await admin.post('/api/admin/mcp', { name: 'remote', transport: 'http', url: 'https://mcp.example.com/mcp' });
    expect((await servers()).find((s) => s.name === 'remote')).toMatchObject({ transport: 'http', authStatus: 'notLoggedIn' });
    const login = (await admin.post('/api/admin/mcp/remote/login')).json();
    expect(login.authorizationUrl).toMatch(/^https:\/\/auth\.example\.com\//);
    await new Promise((r) => setTimeout(r, 150));
    expect((await servers()).find((s) => s.name === 'remote')).toMatchObject({ authStatus: 'oAuth' });
  });

  it('is admin-only on the console and needs separate scopes on the API', async () => {
    await admin.post('/api/auth/admin/lock');
    expect((await admin.get('/api/admin/mcp')).json().error.code).toBe('admin_required');
    // Each authenticator code works once: unlock again with the next one.
    expect((await admin.post('/api/auth/admin/verify', { code: totpCode(h.totpSecret, Date.now() + 30_000) })).statusCode).toBe(200);
    const unlocked = admin;
    const reader = await createKey(h, unlocked, { scopes: ['mcp:read'] });
    expect((await reader.client.get('/v1/mcp')).json().servers.map((s: { name: string }) => s.name)).toContain('remote');
    expect((await reader.client.post('/v1/mcp', { name: 'x', transport: 'stdio', command: 'x' })).json().error.code).toBe('scope_missing');
    const manager = await createKey(h, unlocked, { scopes: ['mcp:read', 'mcp:manage'] });
    expect((await manager.client.post('/v1/mcp', { name: 'viaapi', transport: 'stdio', command: 'echo' })).statusCode).toBe(200);
    const sec = (await unlocked.get(`/api/admin/security?key=${manager.key.id}`)).json().rows.map((r: { kind: string }) => r.kind);
    expect(sec).toContain('mcp_server_added');
  });
});

describe('PROXY protocol', () => {
  const v2 = (src: number[], port: number) => {
    const header = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a, 0x21, 0x11, 0x00, 0x0c]);
    const body = Buffer.alloc(12);
    Buffer.from(src).copy(body, 0);
    Buffer.from([127, 0, 0, 1]).copy(body, 4);
    body.writeUInt16BE(port, 8);
    body.writeUInt16BE(443, 10);
    return Buffer.concat([header, body]);
  };

  it('parses v1 and v2 headers and leaves plain HTTP alone', () => {
    expect(parseProxyHeader(Buffer.from('PROXY TCP4 203.0.113.9 127.0.0.1 51000 443\r\nGET /'))).toEqual({ kind: 'ok', info: { sourceAddress: '203.0.113.9', sourcePort: 51000 }, length: 44 });
    expect(parseProxyHeader(Buffer.from('PROXY UNKNOWN\r\n'))).toMatchObject({ kind: 'ok', info: null });
    expect(parseProxyHeader(Buffer.from('PROXY TCP4 not-an-ip 1.1.1.1 1 2\r\n')).kind).toBe('invalid');
    expect(parseProxyHeader(Buffer.from('PROX')).kind).toBe('need-more');
    expect(parseProxyHeader(Buffer.from('GET /v1/me HTTP/1.1\r\n')).kind).toBe('none');
    const h2 = v2([198, 51, 100, 7], 40000);
    expect(parseProxyHeader(h2)).toEqual({ kind: 'ok', info: { sourceAddress: '198.51.100.7', sourcePort: 40000 }, length: 28 });
    expect(parseProxyHeader(h2.subarray(0, 20)).kind).toBe('need-more');
    const local = Buffer.from(h2);
    local[12] = 0x20;
    expect(parseProxyHeader(local)).toMatchObject({ kind: 'ok', info: null });
  });

  it('gives the public API the real client address over TCP', async () => {
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const h = await makeHarness({ env: { CC_API_PORT: String(port), CC_API_PROXY_PROTOCOL: 'optional' } });
    try {
      const admin = await pairAndLogin(h);
      const { secret, key } = await createKey(h, admin, { ipAllowlist: ['198.51.100.0/24'] });
      await h.publicApi.listen();
      const request = (prefix: Buffer | null, split = false) =>
        new Promise<string>((resolve, reject) => {
          const sock = net.connect(port, '127.0.0.1');
          let data = '';
          sock.on('data', (d) => (data += d.toString()));
          sock.on('end', () => resolve(data));
          sock.on('close', () => resolve(data));
          sock.on('error', reject);
          const http = Buffer.from(`GET /v1/me HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${secret}\r\nConnection: close\r\n\r\n`);
          if (prefix && split) {
            sock.write(prefix.subarray(0, 10));
            setTimeout(() => sock.write(Buffer.concat([prefix.subarray(10), http])), 30);
          } else {
            sock.write(prefix ? Buffer.concat([prefix, http]) : http);
          }
        });
      expect(await request(v2([198, 51, 100, 7], 40000))).toMatch(/^HTTP\/1\.1 200/);
      expect(await request(v2([198, 51, 100, 8], 40001), true)).toMatch(/^HTTP\/1\.1 200/);
      expect(await request(Buffer.from('PROXY TCP4 198.51.100.9 127.0.0.1 1234 443\r\n'))).toMatch(/^HTTP\/1\.1 200/);
      // Outside the allowlist (and a direct local connection) is refused.
      expect(await request(v2([203, 0, 113, 1], 40002))).toMatch(/^HTTP\/1\.1 403/);
      expect(await request(null)).toMatch(/^HTTP\/1\.1 403/);
      const info = (await admin.get('/api/admin/api-keys')).json().keys.find((k: { id: string }) => k.id === key.id);
      expect(info.lastIp).toMatch(/^198\.51\.100\./);
    } finally {
      await h.close();
    }
  });
});
