import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';

export interface AppConfig {
  host: string;
  port: number;
  publicOrigin: string;
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
  secureCookies: boolean;
  tls: { cert: string; key: string } | null;
  trustProxy: boolean | string;
  dataDir: string;
  workspaceRoot: string;
  webDir: string;
  codex: {
    bin: string;
    sandbox: SandboxMode;
    approvalPolicy: ApprovalPolicy;
    networkAccess: boolean;
    defaultModel: string | null;
    approvalTimeoutMs: number;
  };
  limits: {
    maxUploadBytes: number;
    maxPromptChars: number;
    promptsPerMinute: number;
    apiPerMinute: number;
    uploadBytesPerHour: number;
  };
  sessions: {
    idleMs: number;
    maxMs: number;
    adminIdleMs: number;
  };
  logRetentionDays: number;
  api: {
    enabled: boolean;
    host: string;
    port: number;
    publicOrigin: string;
    allowedHosts: Set<string>;
    proxyProtocol: 'off' | 'optional' | 'required';
    trustProxy: boolean | string;
    secure: boolean;
    globalPerMinute: number;
    badAuthPerWindow: number;
    maxWaitSec: number;
  };
}

export class ConfigError extends Error {}

const SANDBOX_MODES: readonly SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];
const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ['untrusted', 'on-request', 'never'];

type Env = Record<string, string | undefined>;

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function str(env: Env, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

function int(env: Env, key: string, def: number, min: number, max: number): number {
  const raw = str(env, key);
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${key} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return n;
}

function bool(env: Env, key: string, def: boolean): boolean {
  const raw = str(env, key)?.toLowerCase();
  if (raw === undefined) return def;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new ConfigError(`${key} must be true or false (got "${raw}")`);
}

function oneOf<T extends string>(env: Env, key: string, values: readonly T[], def: T): T {
  const raw = str(env, key);
  if (raw === undefined) return def;
  if (!(values as readonly string[]).includes(raw)) {
    throw new ConfigError(`${key} must be one of ${values.join(', ')} (got "${raw}")`);
  }
  return raw as T;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

function parseOrigin(raw: string, name = 'CC_PUBLIC_ORIGIN'): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} is not a valid URL: "${raw}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${name} must start with http:// or https://`);
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username) {
    throw new ConfigError(`${name} must be an origin only, e.g. https://console.example.com`);
  }
  return url;
}

/** Locate the codex binary pinned in package.json (native binary, not the JS launcher). */
export function resolvePinnedCodexBin(): string | null {
  const require = createRequire(import.meta.url);
  const triples: Record<string, string> = {
    'linux-x64': 'x86_64-unknown-linux-musl',
    'linux-arm64': 'aarch64-unknown-linux-musl',
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
  };
  const platformKey = `${process.platform}-${process.arch}`;
  const triple = triples[platformKey];
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates: string[] = [];
  // Same lookup as @openai/codex's bin/codex.js launcher: <pkg>/vendor/<triple>/bin/codex.
  for (const pkg of [`@openai/codex-${platformKey}`, '@openai/codex']) {
    try {
      const pkgDir = path.dirname(require.resolve(`${pkg}/package.json`));
      if (triple) candidates.push(path.join(pkgDir, 'vendor', triple, 'bin', exe));
    } catch {
      // package not installed for this platform
    }
  }
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

export function loadConfig(env: Env = process.env): AppConfig {
  const host = str(env, 'CC_HOST') ?? '127.0.0.1';
  const port = int(env, 'CC_PORT', 8787, 1, 65535);
  const certFile = str(env, 'CC_TLS_CERT');
  const keyFile = str(env, 'CC_TLS_KEY');
  if (Boolean(certFile) !== Boolean(keyFile)) {
    throw new ConfigError('Set both CC_TLS_CERT and CC_TLS_KEY, or neither');
  }
  let tls: AppConfig['tls'] = null;
  if (certFile && keyFile) {
    for (const f of [certFile, keyFile]) {
      if (!fs.existsSync(expandHome(f))) throw new ConfigError(`TLS file not found: ${f}`);
    }
    tls = { cert: expandHome(certFile), key: expandHome(keyFile) };
  }

  const loopback = isLoopbackHost(host);
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const defaultOrigin = `${tls ? 'https' : 'http'}://${urlHost === '0.0.0.0' || urlHost === '[::]' ? 'localhost' : urlHost}:${port}`;
  const originUrl = parseOrigin(str(env, 'CC_PUBLIC_ORIGIN') ?? defaultOrigin);
  const publicOrigin = originUrl.origin;
  const secureCookies = originUrl.protocol === 'https:';

  const trustRaw = str(env, 'CC_TRUST_PROXY');
  let trustProxy: boolean | string = false;
  if (trustRaw !== undefined) {
    const lower = trustRaw.toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(lower)) trustProxy = false;
    else if (['1', 'true', 'yes', 'on'].includes(lower)) trustProxy = true;
    else trustProxy = trustRaw;
  }

  const allowInsecure = bool(env, 'CC_ALLOW_INSECURE_HTTP', false);
  const servedOverHttps = Boolean(tls) || (secureCookies && trustProxy !== false);
  if (!loopback && !servedOverHttps && !allowInsecure) {
    throw new ConfigError(
      `Refusing to serve plain HTTP on non-loopback address ${host}. ` +
        'Use CC_TLS_CERT/CC_TLS_KEY, or bind to 127.0.0.1 behind an HTTPS reverse proxy ' +
        '(CC_TRUST_PROXY + https CC_PUBLIC_ORIGIN).',
    );
  }

  const allowedHosts = new Set<string>([originUrl.host.toLowerCase()]);
  const allowedOrigins = new Set<string>([publicOrigin]);
  if (loopback || host === '0.0.0.0' || host === '::') {
    for (const h of ['127.0.0.1', 'localhost', '[::1]']) {
      allowedHosts.add(`${h}:${port}`);
      allowedOrigins.add(`${tls ? 'https' : 'http'}://${h}:${port}`);
    }
  }
  for (const extra of (str(env, 'CC_ALLOWED_HOSTS') ?? '').split(',')) {
    const h = extra.trim().toLowerCase();
    if (!h) continue;
    allowedHosts.add(h);
    allowedOrigins.add(`${secureCookies || tls ? 'https' : 'http'}://${h}`);
  }

  const dataDir = path.resolve(expandHome(str(env, 'CC_DATA_DIR') ?? '~/.codexconsole'));
  const workspaceRoot = path.resolve(expandHome(str(env, 'CC_WORKSPACE_ROOT') ?? '~/codex-workspace'));
  if (workspaceRoot === dataDir || workspaceRoot.startsWith(dataDir + path.sep) || dataDir.startsWith(workspaceRoot + path.sep)) {
    throw new ConfigError('CC_WORKSPACE_ROOT and CC_DATA_DIR must not contain each other');
  }
  const home = os.homedir();
  if (workspaceRoot === home || workspaceRoot === path.parse(workspaceRoot).root) {
    throw new ConfigError('CC_WORKSPACE_ROOT must be a dedicated folder, not your home or the filesystem root');
  }

  // Public API listener (off by default). It serves only /v1 and is meant to sit behind a
  // tunnel or reverse proxy that terminates TLS (Tailscale Funnel, Cloudflare Tunnel, Caddy).
  const apiEnabled = bool(env, 'CC_API_ENABLED', false);
  const apiHost = str(env, 'CC_API_HOST') ?? '127.0.0.1';
  const apiPort = int(env, 'CC_API_PORT', 8788, 1, 65535);
  if (apiEnabled && apiPort === port && apiHost === host) throw new ConfigError('CC_API_PORT must differ from CC_PORT');
  if (apiEnabled && !isLoopbackHost(apiHost) && !allowInsecure) {
    throw new ConfigError(`Refusing to serve the public API as plain HTTP on ${apiHost}. Keep CC_API_HOST=127.0.0.1 behind a TLS tunnel or proxy.`);
  }
  const apiUrlHost = apiHost.includes(':') && !apiHost.startsWith('[') ? `[${apiHost}]` : apiHost;
  const apiOrigin = parseOrigin(str(env, 'CC_API_PUBLIC_ORIGIN') ?? `http://${apiUrlHost === '0.0.0.0' ? 'localhost' : apiUrlHost}:${apiPort}`, 'CC_API_PUBLIC_ORIGIN');
  const apiAllowedHosts = new Set<string>([apiOrigin.host.toLowerCase()]);
  for (const h of ['127.0.0.1', 'localhost', '[::1]']) apiAllowedHosts.add(`${h}:${apiPort}`);
  const proxyProtocol = oneOf(env, 'CC_API_PROXY_PROTOCOL', ['off', 'optional', 'required'] as const, 'optional');
  const apiTrustRaw = str(env, 'CC_API_TRUST_PROXY');
  let apiTrustProxy: boolean | string = false;
  if (apiTrustRaw !== undefined) {
    const lower = apiTrustRaw.toLowerCase();
    apiTrustProxy = ['0', 'false', 'no', 'off'].includes(lower) ? false : ['1', 'true', 'yes', 'on'].includes(lower) ? true : apiTrustRaw;
  }

  const codexBin = str(env, 'CODEX_BIN') ?? resolvePinnedCodexBin() ?? 'codex';
  // Built UI lives in dist/web: next to dist/server when compiled, under dist/ when run from source.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const compiled = path.basename(path.dirname(here)) === 'dist';
  const webDir = compiled ? path.resolve(here, '..', 'web') : path.resolve(here, '..', 'dist', 'web');

  return {
    host,
    port,
    publicOrigin,
    allowedHosts,
    allowedOrigins,
    secureCookies,
    tls,
    trustProxy,
    dataDir,
    workspaceRoot,
    webDir,
    codex: {
      bin: expandHome(codexBin),
      sandbox: oneOf(env, 'CC_CODEX_SANDBOX', SANDBOX_MODES, 'workspace-write'),
      approvalPolicy: oneOf(env, 'CC_CODEX_APPROVAL', APPROVAL_POLICIES, 'on-request'),
      networkAccess: bool(env, 'CC_CODEX_NETWORK', false),
      defaultModel: str(env, 'CC_CODEX_MODEL') ?? null,
      approvalTimeoutMs: int(env, 'CC_APPROVAL_TIMEOUT_SEC', 600, 10, 86_400) * 1000,
    },
    limits: {
      maxUploadBytes: int(env, 'CC_MAX_UPLOAD_MB', 200, 1, 100_000) * 1024 * 1024,
      maxPromptChars: int(env, 'CC_MAX_PROMPT_CHARS', 100_000, 100, 10_000_000),
      promptsPerMinute: int(env, 'CC_RATE_PROMPTS_PER_MIN', 20, 1, 10_000),
      apiPerMinute: int(env, 'CC_RATE_API_PER_MIN', 600, 10, 100_000),
      uploadBytesPerHour: int(env, 'CC_RATE_UPLOAD_MB_PER_HOUR', 2048, 1, 10_000_000) * 1024 * 1024,
    },
    sessions: {
      idleMs: int(env, 'CC_SESSION_IDLE_DAYS', 7, 1, 365) * 86_400_000,
      maxMs: int(env, 'CC_SESSION_MAX_DAYS', 30, 1, 3650) * 86_400_000,
      adminIdleMs: int(env, 'CC_ADMIN_IDLE_MIN', 15, 1, 1440) * 60_000,
    },
    logRetentionDays: int(env, 'CC_LOG_RETENTION_DAYS', 180, 1, 3650),
    api: {
      enabled: apiEnabled,
      host: apiHost,
      port: apiPort,
      publicOrigin: apiOrigin.origin,
      allowedHosts: apiAllowedHosts,
      proxyProtocol,
      trustProxy: apiTrustProxy,
      secure: apiOrigin.protocol === 'https:',
      globalPerMinute: int(env, 'CC_API_MAX_PER_MIN', 600, 10, 100_000),
      badAuthPerWindow: int(env, 'CC_API_BAD_KEY_LIMIT', 20, 1, 10_000),
      maxWaitSec: int(env, 'CC_API_MAX_WAIT_SEC', 600, 10, 3600),
    },
  };
}

/** Load `.env` from the working directory if present (Node >= 20.12). */
export function loadDotEnv(file = '.env'): void {
  if (!fs.existsSync(file)) return;
  const loader = (process as unknown as { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (loader) loader(file);
}
