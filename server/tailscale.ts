import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { translate, type Lang, type MessageKey, type Vars } from '../shared/i18n/index.js';
import { loadConfig } from './config.js';
import { startConsole, type RunningConsole } from './start.js';

// Runs the console on this computer and gives it a fixed https address, https://<computer>.<tailnet>.ts.net:
// public on the internet through Tailscale Funnel, or only for your own Tailscale devices through Serve.

export const ADMIN_DNS_URL = 'https://console.tailscale.com/admin/dns';
export const FUNNEL_DOCS_URL = 'https://tailscale.com/kb/1223/funnel';
const MIN_VERSION = '1.52.0'; // `tailscale funnel|serve --bg --https=<port> <target>`
// The ports Funnel allows; Serve uses the same ones so the address never depends on the mode.
const HTTPS_PORTS = [443, 8443, 10000];
const DEFAULT_PORT = 8787;

export interface TailscaleStatus {
  state: string;
  version: string;
  /** This computer's name in the tailnet, e.g. "laptop.tail1234.ts.net". */
  dnsName: string | null;
  /** Names with HTTPS certificates; empty while HTTPS is off for the tailnet. */
  certDomains: string[];
  magicDns: boolean | null;
}

interface ServeHandler {
  Proxy?: string;
  Path?: string;
  Text?: string;
}

export interface ServeConfig {
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean; TCPForward?: string } | undefined>;
  Web?: Record<string, { Handlers?: Record<string, ServeHandler | undefined> } | undefined>;
  AllowFunnel?: Record<string, boolean | undefined>;
}

/** A problem the owner can fix; the message is already in their language. */
export class TailscaleModeError extends Error {}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The tailscale command: TAILSCALE_BIN, then PATH, then where the installers put it. */
export function findTailscale(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.TAILSCALE_BIN) return isFile(env.TAILSCALE_BIN) ? env.TAILSCALE_BIN : null;
  const name = process.platform === 'win32' ? 'tailscale.exe' : 'tailscale';
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (dir && isFile(path.join(dir, name))) return path.join(dir, name);
  }
  const known =
    process.platform === 'win32'
      ? [path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')]
      : process.platform === 'darwin'
        ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']
        : ['/usr/bin/tailscale', '/usr/local/bin/tailscale'];
  return known.find(isFile) ?? null;
}

export interface CommandResult {
  code: number | null;
  output: string;
}

export function runCommand(bin: string, args: string[], opts: { timeoutMs?: number; onLine?: (line: string) => void; env?: NodeJS.ProcessEnv } = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    let output = '';
    let partial = '';
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: opts.env });
    } catch (err) {
      resolve({ code: null, output: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 15_000);
    const feed = (d: Buffer) => {
      const s = d.toString('utf8');
      output += s;
      if (!opts.onLine) return;
      partial += s;
      let nl: number;
      while ((nl = partial.indexOf('\n')) !== -1) {
        opts.onLine(partial.slice(0, nl).replace(/\r$/, ''));
        partial = partial.slice(nl + 1);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, output: output + err.message });
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (partial && opts.onLine) opts.onLine(partial);
      resolve({ code, output });
    });
  });
}

export function parseStatus(raw: unknown): TailscaleStatus {
  const s = (raw ?? {}) as {
    BackendState?: string;
    Version?: string;
    Self?: { DNSName?: string } | null;
    CertDomains?: string[] | null;
    CurrentTailnet?: { MagicDNSEnabled?: boolean } | null;
  };
  const dnsName = (s.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase();
  return {
    state: s.BackendState ?? 'NoState',
    version: (s.Version ?? '').split('-')[0] ?? '',
    dnsName: dnsName || null,
    certDomains: (s.CertDomains ?? []).map((d) => d.replace(/\.$/, '').toLowerCase()),
    magicDns: typeof s.CurrentTailnet?.MagicDNSEnabled === 'boolean' ? s.CurrentTailnet.MagicDNSEnabled : null,
  };
}

export function versionAtLeast(version: string, min: string): boolean {
  const a = version.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const b = min.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

function sameTarget(a: string, b: string): boolean {
  const norm = (u: string) => {
    const withScheme = /^[a-z]+:\/\//i.test(u) ? u : `http://${u}`;
    return withScheme.toLowerCase().replace('://localhost:', '://127.0.0.1:').replace(/\/+$/, '');
  };
  return norm(a) === norm(b);
}

export interface PortChoice {
  port: number;
  /** Already set up exactly like this: nothing to change. */
  reuse: boolean;
  /** Pointing at the console but public when it should be private (or the reverse). */
  wrongExposure: boolean;
}

/**
 * The https port for the console: the one already pointing at it, else the first free one.
 * Never one of yours that serves something else.
 */
export function choosePort(config: ServeConfig, host: string, target: string, funnel: boolean): PortChoice | null {
  for (const port of HTTPS_PORTS) {
    const web = config.Web?.[`${host}:${port}`];
    const tcp = config.TCP?.[String(port)];
    if (!web && !tcp) return { port, reuse: false, wrongExposure: false };
    const handlers = Object.entries(web?.Handlers ?? {});
    const ours = handlers.length === 1 && handlers[0]![0] === '/' && Boolean(handlers[0]![1]?.Proxy) && sameTarget(handlers[0]![1]!.Proxy!, target);
    if (ours && tcp?.HTTPS && !tcp.TCPForward) {
      const isPublic = config.AllowFunnel?.[`${host}:${port}`] === true;
      return { port, reuse: isPublic === funnel, wrongExposure: isPublic !== funnel };
    }
  }
  return null;
}

export function originFor(host: string, port: number): string {
  return port === 443 ? `https://${host}` : `https://${host}:${port}`;
}

/** The link Tailscale prints when Serve or HTTPS still has to be allowed for the tailnet. */
export function consentUrl(line: string): string | null {
  return /https:\/\/(?:login|console)\.tailscale\.com\/f\/\S+/.exec(line)?.[0] ?? null;
}

export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

/** Ask the address itself until it answers (the first certificate can take a while). */
export async function waitForAddress(origin: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) return true;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return false;
}

export function openInBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined); // the link is printed anyway
    child.unref();
  } catch {
    // the link is printed anyway
  }
}

export interface TailscaleModeOptions {
  lang: Lang;
  /** Public through Funnel (default), or only for your Tailscale devices through Serve. */
  funnel?: boolean;
  env?: NodeJS.ProcessEnv;
  out: (line: string) => void;
  /** Opens a link in this computer's browser; none means print only. */
  open?: (url: string) => void;
  /** Wait until the address answers through Tailscale (default true). */
  check?: boolean;
  checkTimeoutMs?: number;
}

export interface TailscaleMode {
  origin: string;
  funnel: boolean;
  /** The address answered through Tailscale (always true when not checked). */
  reachable: boolean;
  console: RunningConsole;
  close(): Promise<void>;
}

export async function startWithTailscale(opts: TailscaleModeOptions): Promise<TailscaleMode> {
  const env = opts.env ?? process.env;
  const t = (k: MessageKey, v?: Vars) => translate(opts.lang, k, v);
  const funnel = opts.funnel !== false;
  const fail = (k: MessageKey, v?: Vars, detail = '') => new TailscaleModeError(detail ? `${t(k, v)}\n${detail}` : t(k, v));

  const bin = findTailscale(env);
  if (!bin) throw fail('tailscale.notInstalled');
  const statusRun = await runCommand(bin, ['status', '--json'], { env });
  let status: TailscaleStatus;
  try {
    status = parseStatus(JSON.parse(statusRun.output.slice(statusRun.output.indexOf('{'))));
  } catch {
    throw fail('tailscale.notRunning', undefined, statusRun.output.trim().slice(0, 500));
  }
  if (status.state === 'NeedsLogin') throw fail('tailscale.needsLogin');
  if (status.state === 'NeedsMachineAuth') throw fail('tailscale.needsApproval');
  if (status.state !== 'Running') throw fail('tailscale.stopped');
  if (status.version && !versionAtLeast(status.version, MIN_VERSION)) throw fail('tailscale.tooOld', { version: status.version });
  if (!status.dnsName || status.magicDns === false) throw fail('tailscale.noMagicDns', { url: ADMIN_DNS_URL });
  const host = status.dnsName;
  const expected = (env.CC_TAILSCALE_NAME ?? '').trim().replace(/\.$/, '').toLowerCase();
  if (expected && expected !== host) opts.out(t('tailscale.otherName', { expected, actual: host }));

  const port = Number(env.CC_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !(await portFree(port))) throw fail('tailscale.portBusy', { port: env.CC_PORT ?? DEFAULT_PORT });
  const target = `http://127.0.0.1:${port}`;
  const serveRun = await runCommand(bin, ['serve', 'status', '--json'], { env });
  let serveConfig: ServeConfig = {};
  try {
    serveConfig = JSON.parse(serveRun.output.slice(serveRun.output.indexOf('{'))) as ServeConfig;
  } catch {
    // no Serve configuration yet
  }
  const chosen = choosePort(serveConfig, host, target, funnel);
  if (!chosen) throw fail('tailscale.noPort');
  const origin = originFor(host, chosen.port);

  const config = loadConfig({ ...env, CC_HOST: '127.0.0.1', CC_PORT: String(port), CC_PUBLIC_ORIGIN: origin, CC_TRUST_PROXY: 'loopback' });
  const running = await startConsole(config, { logLevel: 'warn' });
  const close = () => running.close();

  if (!chosen.reuse) {
    // Going from public to private: take the old entry down first, so nothing stays public.
    if (chosen.wrongExposure && !funnel) await runCommand(bin, ['funnel', `--https=${chosen.port}`, 'off'], { env });
    const publish = await runCommand(bin, [funnel ? 'funnel' : 'serve', '--bg', `--https=${chosen.port}`, target], {
      // Waits while you allow Funnel (or Serve, or HTTPS) for the tailnet, if you have not yet.
      timeoutMs: 10 * 60_000,
      env,
      onLine: (line) => {
        const url = consentUrl(line);
        if (!url) return;
        opts.out(t('tailscale.allowFeature'));
        opts.out(`    ${url}`);
        opts.open?.(url);
      },
    });
    if (publish.code !== 0) {
      await close();
      const detail = publish.output.trim().split('\n').slice(-6).join('\n');
      const hint = /operator|access denied|permission denied/i.test(detail)
        ? `\n${t('tailscale.operator')}`
        : /funnel/i.test(detail)
          ? `\n${t('tailscale.enableFunnel', { url: FUNNEL_DOCS_URL })}`
          : /https|cert/i.test(detail)
            ? `\n${t('tailscale.enableHttps', { url: ADMIN_DNS_URL })}`
            : '';
      throw fail('tailscale.publishFailed', undefined, `${detail}${hint}`);
    }
  }

  let reachable = true;
  if (opts.check !== false) {
    opts.out(t('tailscale.checking'));
    reachable = await waitForAddress(origin, opts.checkTimeoutMs ?? 90_000);
    if (!reachable) opts.out(t(status.certDomains.length ? 'tailscale.notReachable' : 'tailscale.enableHttps', { url: ADMIN_DNS_URL }));
  }
  return { origin, funnel, reachable, console: running, close };
}
