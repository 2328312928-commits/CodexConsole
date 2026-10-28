import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../server/config.js';
import { sanitizeFilename, Workspace } from '../server/services/workspace.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-unit-'));
const base = { CC_DATA_DIR: path.join(tmp, 'data'), CC_WORKSPACE_ROOT: path.join(tmp, 'ws') };
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('config', () => {
  it('defaults to loopback HTTP with matching Host/Origin allowlists', () => {
    const c = loadConfig(base);
    expect(c.host).toBe('127.0.0.1');
    expect(c.secureCookies).toBe(false);
    expect([...c.allowedHosts]).toEqual(expect.arrayContaining(['127.0.0.1:8787', 'localhost:8787']));
    expect(c.allowedOrigins.has('http://127.0.0.1:8787')).toBe(true);
  });

  it('refuses plain HTTP on a public interface', () => {
    expect(() => loadConfig({ ...base, CC_HOST: '0.0.0.0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CC_HOST: '192.168.1.5' })).toThrow(/Refusing to serve plain HTTP/);
    expect(loadConfig({ ...base, CC_HOST: '0.0.0.0', CC_ALLOW_INSECURE_HTTP: 'true' }).host).toBe('0.0.0.0');
  });

  it('uses secure cookies behind an HTTPS proxy', () => {
    const c = loadConfig({ ...base, CC_PUBLIC_ORIGIN: 'https://box.tailnet.ts.net', CC_TRUST_PROXY: 'loopback' });
    expect(c.secureCookies).toBe(true);
    expect(c.allowedHosts.has('box.tailnet.ts.net')).toBe(true);
    expect(c.trustProxy).toBe('loopback');
  });

  it('validates the public origin and folders', () => {
    expect(() => loadConfig({ ...base, CC_PUBLIC_ORIGIN: 'https://x.example/path' })).toThrow(/origin only/);
    expect(() => loadConfig({ ...base, CC_PUBLIC_ORIGIN: 'ftp://x' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CC_WORKSPACE_ROOT: os.homedir() })).toThrow(/dedicated folder/);
    expect(() => loadConfig({ ...base, CC_WORKSPACE_ROOT: path.join(tmp, 'data', 'ws') })).toThrow(/must not contain/);
    expect(() => loadConfig({ ...base, CC_PORT: '99999' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, CC_CODEX_APPROVAL: 'on-failure' })).toThrow(ConfigError);
  });
});

describe('workspace confinement', () => {
  let ws: Workspace;
  const outside = path.join(tmp, 'outside');
  beforeAll(async () => {
    ws = new Workspace(path.join(tmp, 'ws2'));
    await ws.init();
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'nope');
    fs.mkdirSync(path.join(ws.realRoot, 'proj', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(ws.realRoot, 'proj', 'a.txt'), 'hello');
    fs.symlinkSync(outside, path.join(ws.realRoot, 'proj', 'out'));
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(ws.realRoot, 'proj', 'secret-link.txt'));
    fs.symlinkSync(path.join(ws.realRoot, 'proj', 'a.txt'), path.join(ws.realRoot, 'proj', 'inside-link.txt'));
    fs.symlinkSync(path.join(outside, 'missing'), path.join(ws.realRoot, 'proj', 'dangling'));
  });

  it('rejects traversal and odd paths', () => {
    for (const bad of ['..', 'proj/../..', 'a\\b', 'a\0b', 123, 'x'.repeat(5000)]) {
      expect(() => Workspace.segments(bad)).toThrow();
    }
    expect(Workspace.segments('/proj//./a.txt')).toEqual(['proj', 'a.txt']);
  });

  it('follows symlinks only when they stay inside the root', async () => {
    await expect(ws.resolve('proj/out/secret.txt')).rejects.toMatchObject({ code: 'path_outside_workspace' });
    await expect(ws.openForRead('proj/secret-link.txt')).rejects.toMatchObject({ code: 'path_outside_workspace' });
    await expect(ws.resolve('proj/dangling')).rejects.toMatchObject({ code: 'path_outside_workspace' });
    const f = await ws.openForRead('proj/inside-link.txt');
    expect(f.size).toBe(5);
    await f.handle.close();
    const listing = await ws.list('proj');
    expect(listing.entries.find((e) => e.name === 'out')?.type).toBe('link');
    expect(listing.entries.find((e) => e.name === 'inside-link.txt')?.type).toBe('file');
  });

  it('caps uploads at the byte limit and leaves nothing behind', async () => {
    const ok = await ws.upload('proj/up', 'ok.bin', Readable.from([Buffer.alloc(100)]), 100, false);
    expect(ok).toMatchObject({ path: 'proj/up/ok.bin', size: 100 });
    await expect(ws.upload('proj/up', 'big.bin', Readable.from([Buffer.alloc(60), Buffer.alloc(41)]), 100, false)).rejects.toMatchObject({ code: 'file_too_large' });
    expect(fs.readdirSync(path.join(ws.realRoot, 'proj', 'up'))).toEqual(['ok.bin']);
    const again = await ws.upload('proj/up', 'ok.bin', Readable.from([Buffer.alloc(1)]), 100, false);
    expect(again.name).toBe('ok (1).bin');
    const replaced = await ws.upload('proj/up', 'ok.bin', Readable.from([Buffer.alloc(2)]), 100, true);
    expect(replaced).toMatchObject({ name: 'ok.bin', size: 2 });
  });

  it('cleans file names', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(sanitizeFilename('a\u0000b\nc.txt')).toBe('abc.txt');
    expect(sanitizeFilename('..')).toBeNull();
    expect(Buffer.byteLength(sanitizeFilename(`${'长'.repeat(200)}.png`)!)).toBeLessThanOrEqual(200);
  });

  it('finds newly produced media but skips dependencies and excluded files', async () => {
    const since = Date.now() - 1000;
    fs.writeFileSync(path.join(ws.realRoot, 'proj', 'chart.png'), 'x');
    fs.writeFileSync(path.join(ws.realRoot, 'proj', 'node_modules', 'icon.png'), 'x');
    fs.writeFileSync(path.join(ws.realRoot, 'proj', 'input.jpg'), 'x');
    const media = await ws.scanMedia(path.join(ws.realRoot, 'proj'), since, new Set(['proj/input.jpg']));
    expect(media.map((m) => m.path)).toEqual(['proj/chart.png']);
    expect(await ws.scanMedia(outside, since)).toEqual([]);
  });

  it('never deletes the workspace root', async () => {
    await expect(ws.remove('')).rejects.toMatchObject({ code: 'path_invalid' });
    await expect(ws.remove('/')).rejects.toMatchObject({ code: 'path_invalid' });
  });
});
