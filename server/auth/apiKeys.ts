import crypto from 'node:crypto';
import type { ApiKeyLimits, ApiKeyScope, ApiKeyStatus, ConsoleAccess, KeyApprovals, QuotaPeriod } from '../../shared/api.js';
import type { SandboxMode } from '../../shared/codex.js';
import type { KeyCaps } from '../codex/sessionOps.js';
import type { Db } from '../db/db.js';
import { hmacHex, safeEqual } from '../lib/crypto.js';
import { buildAllowlist, ipAllowed } from '../lib/net.js';

export const API_KEY_PREFIX = 'cck_';
const KEY_RE = /^cck_([0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/;
const SANDBOX_RANK: Record<SandboxMode, number> = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 };

export function sandboxAllowed(requested: SandboxMode, max: SandboxMode): boolean {
  return SANDBOX_RANK[requested] <= SANDBOX_RANK[max];
}

interface ApiKeyRow {
  id: string;
  label: string;
  secret_hash: string;
  secret_hint: string;
  prev_secret_hash: string | null;
  prev_valid_until: number | null;
  scopes: string;
  console_access: string;
  folder: string;
  quota_tokens: number | null;
  quota_period: string;
  max_sandbox: string;
  allow_network: number;
  approvals: string;
  rate_per_min: number;
  prompts_per_min: number;
  max_concurrent: number;
  upload_mb_per_hour: number;
  ip_allowlist: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  rotated_at: number | null;
  last_used_at: number | null;
  last_ip: string | null;
}

export interface ApiKey {
  id: string;
  label: string;
  hint: string;
  scopes: Set<ApiKeyScope>;
  consoleAccess: ConsoleAccess;
  folder: string;
  quotaTokens: number | null;
  quotaPeriod: QuotaPeriod;
  maxSandbox: SandboxMode;
  allowNetwork: boolean;
  approvals: KeyApprovals;
  limits: ApiKeyLimits;
  ipAllowlist: string[];
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  rotatedAt: number | null;
  graceUntil: number | null;
  lastUsedAt: number | null;
  lastIp: string | null;
}

export interface ApiKeySettings {
  label: string;
  scopes: ApiKeyScope[];
  consoleAccess: ConsoleAccess;
  quotaTokens: number | null;
  quotaPeriod: QuotaPeriod;
  maxSandbox: SandboxMode;
  allowNetwork: boolean;
  approvals: KeyApprovals;
  limits: ApiKeyLimits;
  ipAllowlist: string[];
  expiresAt: number | null;
}

/** The rate-limit bucket for a key's prompts, shared by the console, the queue and the public API. */
export function promptBucket(key: Pick<ApiKey, 'id'>): string {
  return `apikey:prompt:${key.id}`;
}

/** A key with full access and network has nothing left to cap: it may allow any approval. */
export function keyCanAllow(key: Pick<ApiKey, 'maxSandbox' | 'allowNetwork'>): boolean {
  return key.maxSandbox === 'danger-full-access' && key.allowNetwork;
}

/**
 * The caps a key's turns run under. In the console a key with nothing left to cap works like
 * the owner (null: no caps, so the automatic reviewer is available); the API always caps.
 */
export function keyCaps(key: ApiKey, inConsole: boolean): KeyCaps | null {
  if (inConsole && keyCanAllow(key) && key.approvals === 'ask') return null;
  return { maxSandbox: key.maxSandbox, allowNetwork: key.allowNetwork, approvals: key.approvals };
}

/** A key for one of your own devices: the whole console (never admin), no quota, no expiry. */
export function consoleKeySettings(label: string): ApiKeySettings {
  return {
    label: label.slice(0, 60),
    scopes: [],
    consoleAccess: 'full',
    quotaTokens: null,
    quotaPeriod: 'month',
    maxSandbox: 'danger-full-access',
    allowNetwork: true,
    approvals: 'ask',
    limits: { perMinute: 600, promptsPerMinute: 20, concurrent: 4, uploadMbPerHour: 2048 },
    ipAllowlist: [],
    expiresAt: null,
  };
}

export type ApiKeyAuth =
  | { ok: true; key: ApiKey; viaPrevious: boolean }
  | { ok: false; reason: 'malformed' | 'unknown' | 'bad_secret' | 'revoked' | 'expired'; key?: ApiKey };

function fromRow(r: ApiKeyRow, now = Date.now()): ApiKey {
  return {
    id: r.id,
    label: r.label,
    hint: r.secret_hint,
    scopes: new Set(JSON.parse(r.scopes) as ApiKeyScope[]),
    consoleAccess: r.console_access === 'full' || r.console_access === 'folder' ? r.console_access : 'none',
    folder: r.folder,
    quotaTokens: r.quota_tokens,
    quotaPeriod: r.quota_period as QuotaPeriod,
    maxSandbox: r.max_sandbox as SandboxMode,
    allowNetwork: r.allow_network === 1,
    approvals: r.approvals as KeyApprovals,
    limits: {
      perMinute: r.rate_per_min,
      promptsPerMinute: r.prompts_per_min,
      concurrent: r.max_concurrent,
      uploadMbPerHour: r.upload_mb_per_hour,
    },
    ipAllowlist: r.ip_allowlist ? (JSON.parse(r.ip_allowlist) as string[]) : [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    rotatedAt: r.rotated_at,
    graceUntil: r.prev_secret_hash && r.prev_valid_until && r.prev_valid_until > now ? r.prev_valid_until : null,
    lastUsedAt: r.last_used_at,
    lastIp: r.last_ip,
  };
}

/** Start of the current quota period (server-local time), and when it resets. */
export function quotaWindow(period: QuotaPeriod, now = Date.now()): { start: number; resetsAt: number | null } {
  if (period === 'total') return { start: 0, resetsAt: null };
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (period === 'day') {
    const next = new Date(d);
    next.setDate(d.getDate() + 1);
    return { start: d.getTime(), resetsAt: next.getTime() };
  }
  d.setDate(1);
  const next = new Date(d);
  next.setMonth(d.getMonth() + 1);
  return { start: d.getTime(), resetsAt: next.getTime() };
}

/**
 * API keys: for signing in to the console and for the public API. A key is `cck_<id>.<secret>`:
 * the id locates the row, the 256-bit secret is only ever stored as HMAC-SHA256 with the server pepper.
 */
export class ApiKeyStore {
  constructor(
    private readonly db: Db,
    private readonly pepper: Buffer,
  ) {}

  private hash(secret: string): string {
    return hmacHex(this.pepper, `apikey:${secret}`);
  }

  static display(key: Pick<ApiKey, 'id' | 'hint'>): string {
    return `${API_KEY_PREFIX}${key.id}.…${key.hint}`;
  }

  get(id: string, now = Date.now()): ApiKey | undefined {
    const r = this.db.get<ApiKeyRow>('SELECT * FROM api_keys WHERE id = ?', id);
    return r ? fromRow(r, now) : undefined;
  }

  list(now = Date.now()): ApiKey[] {
    return this.db.all<ApiKeyRow>('SELECT * FROM api_keys ORDER BY created_at DESC').map((r) => fromRow(r, now));
  }

  status(key: ApiKey, now = Date.now()): ApiKeyStatus {
    if (key.revokedAt !== null) return 'revoked';
    if (key.expiresAt !== null && key.expiresAt <= now) return 'expired';
    return 'active';
  }

  /** Why this key may not use the console from `ip` right now, or null if it may. */
  consoleProblem(key: ApiKey, ip: string, now = Date.now()): 'api_key_revoked' | 'api_key_expired' | 'console_not_allowed' | 'ip_not_allowed' | null {
    const status = this.status(key, now);
    if (status !== 'active') return status === 'revoked' ? 'api_key_revoked' : 'api_key_expired';
    if (key.consoleAccess === 'none') return 'console_not_allowed';
    if (!ipAllowed(buildAllowlist(key.ipAllowlist), ip)) return 'ip_not_allowed';
    return null;
  }

  create(settings: ApiKeySettings, folder: string, now = Date.now()): { key: ApiKey; secret: string } {
    const id = crypto.randomBytes(8).toString('hex');
    const secret = crypto.randomBytes(32).toString('base64url');
    this.db.run(
      `INSERT INTO api_keys (id, label, secret_hash, secret_hint, scopes, console_access, folder, quota_tokens, quota_period, max_sandbox, allow_network,
         approvals, rate_per_min, prompts_per_min, max_concurrent, upload_mb_per_hour, ip_allowlist, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      settings.label,
      this.hash(secret),
      secret.slice(-4),
      JSON.stringify([...new Set(settings.scopes)]),
      settings.consoleAccess,
      folder,
      settings.quotaTokens,
      settings.quotaPeriod,
      settings.maxSandbox,
      settings.allowNetwork,
      settings.approvals,
      settings.limits.perMinute,
      settings.limits.promptsPerMinute,
      settings.limits.concurrent,
      settings.limits.uploadMbPerHour,
      settings.ipAllowlist.length ? JSON.stringify(settings.ipAllowlist) : null,
      now,
      now,
      settings.expiresAt,
    );
    return { key: this.get(id, now)!, secret: `${API_KEY_PREFIX}${id}.${secret}` };
  }

  update(id: string, s: Partial<ApiKeySettings>, now = Date.now()): ApiKey | undefined {
    const cur = this.get(id, now);
    if (!cur) return undefined;
    const next: ApiKeySettings = {
      label: s.label ?? cur.label,
      scopes: s.scopes ?? [...cur.scopes],
      consoleAccess: s.consoleAccess ?? cur.consoleAccess,
      quotaTokens: s.quotaTokens === undefined ? cur.quotaTokens : s.quotaTokens,
      quotaPeriod: s.quotaPeriod ?? cur.quotaPeriod,
      maxSandbox: s.maxSandbox ?? cur.maxSandbox,
      allowNetwork: s.allowNetwork ?? cur.allowNetwork,
      approvals: s.approvals ?? cur.approvals,
      limits: { ...cur.limits, ...s.limits },
      ipAllowlist: s.ipAllowlist ?? cur.ipAllowlist,
      expiresAt: s.expiresAt === undefined ? cur.expiresAt : s.expiresAt,
    };
    this.db.run(
      `UPDATE api_keys SET label = ?, scopes = ?, console_access = ?, quota_tokens = ?, quota_period = ?, max_sandbox = ?, allow_network = ?, approvals = ?,
         rate_per_min = ?, prompts_per_min = ?, max_concurrent = ?, upload_mb_per_hour = ?, ip_allowlist = ?, expires_at = ?, updated_at = ?
       WHERE id = ?`,
      next.label,
      JSON.stringify([...new Set(next.scopes)]),
      next.consoleAccess,
      next.quotaTokens,
      next.quotaPeriod,
      next.maxSandbox,
      next.allowNetwork,
      next.approvals,
      next.limits.perMinute,
      next.limits.promptsPerMinute,
      next.limits.concurrent,
      next.limits.uploadMbPerHour,
      next.ipAllowlist.length ? JSON.stringify(next.ipAllowlist) : null,
      next.expiresAt,
      now,
      id,
    );
    return this.get(id, now);
  }

  /** New secret for the same key; the old one keeps working for `graceMs` (0 = never). */
  rotate(id: string, graceMs: number, now = Date.now()): string | null {
    const row = this.db.get<ApiKeyRow>('SELECT * FROM api_keys WHERE id = ? AND revoked_at IS NULL', id);
    if (!row) return null;
    const secret = crypto.randomBytes(32).toString('base64url');
    this.db.run(
      `UPDATE api_keys SET secret_hash = ?, secret_hint = ?, prev_secret_hash = ?, prev_valid_until = ?, rotated_at = ?, updated_at = ? WHERE id = ?`,
      this.hash(secret),
      secret.slice(-4),
      graceMs > 0 ? row.secret_hash : null,
      graceMs > 0 ? now + graceMs : null,
      now,
      now,
      id,
    );
    return `${API_KEY_PREFIX}${id}.${secret}`;
  }

  revoke(id: string, now = Date.now()): boolean {
    return (
      this.db.run('UPDATE api_keys SET revoked_at = ?, prev_secret_hash = NULL, prev_valid_until = NULL, updated_at = ? WHERE id = ? AND revoked_at IS NULL', now, now, id)
        .changes === 1
    );
  }

  authenticate(token: string, now = Date.now()): ApiKeyAuth {
    const m = KEY_RE.exec(token);
    if (!m) return { ok: false, reason: 'malformed' };
    const row = this.db.get<ApiKeyRow>('SELECT * FROM api_keys WHERE id = ?', m[1]!);
    if (!row) return { ok: false, reason: 'unknown' };
    const hash = this.hash(m[2]!);
    const current = safeEqual(hash, row.secret_hash);
    const previous = !current && row.prev_secret_hash !== null && row.prev_valid_until !== null && row.prev_valid_until > now && safeEqual(hash, row.prev_secret_hash);
    if (!current && !previous) return { ok: false, reason: 'bad_secret' };
    const key = fromRow(row, now);
    if (key.revokedAt !== null) return { ok: false, reason: 'revoked', key };
    if (key.expiresAt !== null && key.expiresAt <= now) return { ok: false, reason: 'expired', key };
    return { ok: true, key, viaPrevious: previous };
  }

  touch(key: ApiKey, ip: string, now = Date.now()): void {
    if (key.lastUsedAt !== null && now - key.lastUsedAt < 30_000 && key.lastIp === ip) return;
    this.db.run('UPDATE api_keys SET last_used_at = ?, last_ip = ? WHERE id = ?', now, ip, key.id);
  }

  usedTokens(id: string, period: QuotaPeriod, now = Date.now()): number {
    const { start } = quotaWindow(period, now);
    return this.db.get<{ n: number }>(
      'SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS n FROM requests WHERE api_key_id = ? AND started_at >= ?',
      id,
      start,
    )!.n;
  }

  /** Tokens still available in the current period (null = unlimited). */
  remaining(key: ApiKey, now = Date.now()): number | null {
    if (key.quotaTokens === null) return null;
    return Math.max(0, key.quotaTokens - this.usedTokens(key.id, key.quotaPeriod, now));
  }
}
