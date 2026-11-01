import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { choosePort, consentUrl, originFor, parseStatus, startWithTailscale, TailscaleModeError, versionAtLeast, type TailscaleMode } from '../server/tailscale.js';
import { FAKE_CODEX } from './helpers.js';

const FAKE_TAILSCALE = fileURLToPath(new URL('./fake-tailscale.mjs', import.meta.url));
const NAME = 'my-pc.tail0000.ts.net';

describe('reading Tailscale', () => {
  it('reads the status a running, signed-in Tailscale reports', () => {
    expect(
      parseStatus({ Version: '1.90.4-t1234-g5678', BackendState: 'Running', Self: { DNSName: 'My-PC.tail0000.ts.net.' }, CertDomains: ['my-pc.tail0000.ts.net'], CurrentTailnet: { MagicDNSEnabled: true } }),
    ).toEqual({ state: 'Running', version: '1.90.4', dnsName: NAME, certDomains: [NAME], magicDns: true });
    expect(parseStatus({ BackendState: 'NeedsLogin', Self: null, CertDomains: null })).toMatchObject({ state: 'NeedsLogin', dnsName: null, certDomains: [], magicDns: null });
  });

  it('compares versions', () => {
    expect(versionAtLeast('1.52.0', '1.52.0')).toBe(true);
    expect(versionAtLeast('1.90.4', '1.52.0')).toBe(true);
    expect(versionAtLeast('1.50.1', '1.52.0')).toBe(false);
    expect(versionAtLeast('2.0.0', '1.52.0')).toBe(true);
  });

  it('finds the link Tailscale prints when something must be allowed first', () => {
    expect(consentUrl('         https://login.tailscale.com/f/funnel?node=nAbc123')).toBe('https://login.tailscale.com/f/funnel?node=nAbc123');
    expect(consentUrl('Available on the internet: https://my-pc.tail0000.ts.net/')).toBeNull();
  });

  it('picks an https port without touching what you already serve', () => {
    const target = 'http://127.0.0.1:8787';
    const ours = (port: number, funnel: boolean) => ({
      TCP: { [port]: { HTTPS: true } },
      Web: { [`${NAME}:${port}`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' } } } },
      AllowFunnel: funnel ? { [`${NAME}:${port}`]: true } : {},
    });
    const someoneElse = { TCP: { 443: { HTTPS: true } }, Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } };

    expect(choosePort({}, NAME, target, true)).toEqual({ port: 443, reuse: false, wrongExposure: false });
    expect(choosePort(ours(443, true), NAME, target, true)).toEqual({ port: 443, reuse: true, wrongExposure: false });
    expect(choosePort(ours(443, false), NAME, target, true)).toEqual({ port: 443, reuse: false, wrongExposure: true });
    expect(choosePort(ours(443, true), NAME, target, false)).toEqual({ port: 443, reuse: false, wrongExposure: true });
    expect(choosePort(someoneElse, NAME, target, true)).toEqual({ port: 8443, reuse: false, wrongExposure: false });
    expect(choosePort({ ...someoneElse, TCP: { 443: { HTTPS: true }, 8443: { TCPForward: '127.0.0.1:22' }, 10000: { HTTPS: true } } }, NAME, target, true)).toBeNull();
    expect(originFor(NAME, 443)).toBe(`https://${NAME}`);
    expect(originFor(NAME, 8443)).toBe(`https://${NAME}:8443`);
  });
});

describe('starting the console with Tailscale', () => {
  const started: TailscaleMode[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(started.splice(0).map((m) => m.close()));
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  async function freePort(): Promise<number> {
    return new Promise((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address() as net.AddressInfo;
        s.close(() => resolve(port));
      });
    });
  }

  async function setup(fake: Record<string, string> = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tailscale-'));
    dirs.push(root);
    // The console starts `tailscale` itself, so the fake needs a launcher it can run directly.
    const bin = path.join(root, 'tailscale');
    fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_TAILSCALE}" "$@"\n`, { mode: 0o755 });
    const port = await freePort();
    const log = path.join(root, 'tailscale.log');
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: root,
      TAILSCALE_BIN: bin,
      CC_PORT: String(port),
      CC_DATA_DIR: path.join(root, 'data'),
      CC_WORKSPACE_ROOT: path.join(root, 'workspace'),
      CODEX_HOME: path.join(root, 'codex-home'),
      CODEX_BIN: FAKE_CODEX,
      FAKE_TS_LOG: log,
      ...fake,
    };
    const lines: string[] = [];
    const opened: string[] = [];
    const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]) : []);
    const start = async (opts: { funnel?: boolean } = {}) => {
      const mode = await startWithTailscale({ lang: 'en', env, out: (l) => lines.push(l), open: (u) => opened.push(u), check: false, ...opts });
      started.push(mode);
      return mode;
    };
    return { port, env, lines, opened, calls, start };
  }

  function get(port: number, route: string, host: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: route, headers: { host } }, (res) => {
          let body = '';
          res.on('data', (d: Buffer) => (body += d.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        })
        .on('error', reject);
    });
  }

  it('publishes the console with Funnel at the computer\'s fixed address', async () => {
    const t = await setup();
    const mode = await t.start();
    expect(mode).toMatchObject({ origin: `https://${NAME}`, funnel: true, reachable: true });
    expect(t.calls()).toEqual([['status', '--json'], ['serve', 'status', '--json'], ['funnel', '--bg', '--https=443', `http://127.0.0.1:${t.port}`]]);

    // The console listens on this computer only, and answers for its Tailscale name.
    expect(await get(t.port, '/api/health', NAME)).toEqual({ status: 200, body: '{"ok":true}' });
    expect((await get(t.port, '/api/health', 'evil.example')).status).not.toBe(200);
    expect(mode.console.newSetupLink()).toMatch(new RegExp(`^https://${NAME.replace(/\./g, '\\.')}/setup#token=[A-Za-z0-9_-]+$`));
  });

  it('asks you to allow Funnel once, with the link Tailscale gives', async () => {
    const t = await setup({ FAKE_TS_CONSENT: '1' });
    await t.start();
    expect(t.opened).toEqual(['https://login.tailscale.com/f/funnel?node=nTEST123']);
    expect(t.lines).toContain('Allow it for your tailnet (one time): open this link and confirm:');
  });

  it('changes nothing when Funnel already points at the console', async () => {
    const t = await setup();
    const port = t.port;
    t.env.FAKE_TS_SERVE_JSON = JSON.stringify({
      TCP: { 443: { HTTPS: true } },
      Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } },
      AllowFunnel: { [`${NAME}:443`]: true },
    });
    await t.start();
    expect(t.calls().map((c) => c[0] + ' ' + c[1])).toEqual(['status --json', 'serve status']);
  });

  it('keeps it private with --tailnet-only, taking a public entry down first', async () => {
    const t = await setup();
    t.env.FAKE_TS_SERVE_JSON = JSON.stringify({
      TCP: { 443: { HTTPS: true } },
      Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${t.port}` } } } },
      AllowFunnel: { [`${NAME}:443`]: true },
    });
    const mode = await t.start({ funnel: false });
    expect(mode.funnel).toBe(false);
    expect(t.calls().slice(2)).toEqual([['funnel', '--https=443', 'off'], ['serve', '--bg', '--https=443', `http://127.0.0.1:${t.port}`]]);
  });

  it('uses port 8443 when 443 already serves something else', async () => {
    const t = await setup({ FAKE_TS_SERVE_JSON: JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } }) });
    const mode = await t.start();
    expect(mode.origin).toBe(`https://${NAME}:8443`);
    expect(t.calls().at(-1)).toEqual(['funnel', '--bg', '--https=8443', `http://127.0.0.1:${t.port}`]);
  });

  it('says what to fix when Tailscale is missing, signed out or refuses Funnel', async () => {
    const message = async (fake: Record<string, string>, env: Record<string, string> = {}) => {
      const t = await setup(fake);
      Object.assign(t.env, env);
      const err = await t.start().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TailscaleModeError);
      return { text: (err as Error).message, port: t.port };
    };
    expect((await message({}, { TAILSCALE_BIN: '/nonexistent/tailscale' })).text).toContain('Tailscale is not installed');
    expect((await message({ FAKE_TS_STATE: 'down' })).text).toContain('Tailscale is not running');
    expect((await message({ FAKE_TS_STATE: 'NeedsLogin' })).text).toContain('Tailscale is not signed in');
    expect((await message({ FAKE_TS_VERSION: '1.40.0' })).text).toContain('too old');

    const refused = await message({ FAKE_TS_PUBLISH_FAIL: 'error: Funnel not available; "funnel" node attribute not set.' });
    expect(refused.text).toContain('Tailscale could not publish the address');
    expect(refused.text).toContain('https://tailscale.com/kb/1223/funnel');
    // The console it had started is stopped again.
    expect((await get(refused.port, '/api/health', NAME).catch(() => ({ status: 0 }))).status).toBe(0);
  });

  it('refuses to start twice on the same port', async () => {
    const t = await setup();
    await t.start();
    const err = await t.start().catch((e: unknown) => e);
    expect((err as Error).message).toContain(`Port ${t.port} is already in use`);
  });

  it('warns when this computer is not the one you expected', async () => {
    const t = await setup({ CC_TAILSCALE_NAME: 'other-pc.tail0000.ts.net' });
    const mode = await t.start();
    expect(mode.origin).toBe(`https://${NAME}`);
    expect(t.lines.join('\n')).toContain(`Tailscale calls this computer ${NAME}, not other-pc.tail0000.ts.net`);
  });
});
