import { SECURITY_ALERT_KINDS } from '../../shared/api.js';
import type {
  ApiKeyInfo,
  ApiKeyUsage,
  AdminOverview,
  FileTransferRow,
  Page,
  RequestRow,
  RequestStatus,
  SecurityEventKind,
  SecurityEventRow,
} from '../../shared/api.js';
import type { RateLimitSnapshot } from '../../shared/codex.js';
import { ApiKeyStore, quotaWindow, type ApiKey } from '../auth/apiKeys.js';
import type { Db } from '../db/db.js';

const DAY = 86_400_000;

export interface RequestFilter {
  deviceId?: string;
  apiKeyId?: string;
  status?: RequestStatus;
  sessionId?: string;
  from?: number;
  to?: number;
}

function requestWhere(f: RequestFilter): { sql: string; params: Array<string | number> } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (f.deviceId) {
    clauses.push('r.device_id = ?');
    params.push(f.deviceId);
  }
  if (f.apiKeyId) {
    clauses.push('r.api_key_id = ?');
    params.push(f.apiKeyId);
  }
  if (f.status) {
    clauses.push('r.status = ?');
    params.push(f.status);
  }
  if (f.sessionId) {
    clauses.push('r.session_id = ?');
    params.push(f.sessionId);
  }
  if (f.from !== undefined) {
    clauses.push('r.started_at >= ?');
    params.push(f.from);
  }
  if (f.to !== undefined) {
    clauses.push('r.started_at < ?');
    params.push(f.to);
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/** Read-only queries behind the admin dashboard. */
export class AdminQueries {
  constructor(private readonly db: Db) {}

  requests(f: RequestFilter, limit: number, offset: number): Page<RequestRow> {
    const { sql, params } = requestWhere(f);
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM requests r ${sql}`, ...params)!.n;
    const rows = this.db.all<Record<string, any>>(
      `SELECT r.*, d.name AS device_name, s.title AS current_title, k.label AS api_key_label FROM requests r
       LEFT JOIN devices d ON d.id = r.device_id
       LEFT JOIN sessions s ON s.id = r.session_id
       LEFT JOIN api_keys k ON k.id = r.api_key_id
       ${sql} ORDER BY r.started_at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        kind: r.kind ?? 'prompt',
        sessionId: r.session_id,
        sessionTitle: r.current_title ?? r.session_title ?? null,
        deviceId: r.device_id,
        deviceName: r.device_name ?? null,
        apiKeyId: r.api_key_id ?? null,
        apiKeyLabel: r.api_key_label ?? null,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        durationMs: r.duration_ms,
        status: r.status,
        promptChars: r.prompt_chars,
        promptBytes: r.prompt_bytes,
        attachmentCount: r.attachment_count,
        attachmentBytes: r.attachment_bytes,
        mediaCount: r.media_count,
        inputTokens: r.input_tokens,
        cachedInputTokens: r.cached_input_tokens,
        outputTokens: r.output_tokens,
        reasoningTokens: r.reasoning_tokens,
        model: r.model,
        error: r.error,
        ip: r.ip,
      })),
    };
  }

  transfers(f: { deviceId?: string; apiKeyId?: string; direction?: string }, limit: number, offset: number): Page<FileTransferRow> {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (f.deviceId) {
      clauses.push('t.device_id = ?');
      params.push(f.deviceId);
    }
    if (f.apiKeyId) {
      clauses.push('t.api_key_id = ?');
      params.push(f.apiKeyId);
    }
    if (f.direction) {
      clauses.push('t.direction = ?');
      params.push(f.direction);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM file_transfers t ${where}`, ...params)!.n;
    const rows = this.db.all<Record<string, any>>(
      `SELECT t.*, d.name AS device_name, k.label AS api_key_label FROM file_transfers t
       LEFT JOIN devices d ON d.id = t.device_id LEFT JOIN api_keys k ON k.id = t.api_key_id
       ${where} ORDER BY t.at DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        at: r.at,
        apiKeyId: r.api_key_id ?? null,
        apiKeyLabel: r.api_key_label ?? null,
        deviceId: r.device_id,
        deviceName: r.device_name ?? null,
        sessionId: r.session_id,
        direction: r.direction,
        path: r.path,
        bytes: r.bytes,
        ok: r.ok === 1,
      })),
    };
  }

  security(f: { kind?: SecurityEventKind; apiKeyId?: string }, limit: number, offset: number): Page<SecurityEventRow> {
    const clauses: string[] = [];
    const params: string[] = [];
    if (f.kind) {
      clauses.push('e.kind = ?');
      params.push(f.kind);
    }
    if (f.apiKeyId) {
      clauses.push('e.api_key_id = ?');
      params.push(f.apiKeyId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM security_events e ${where}`, ...params)!.n;
    const rows = this.db.all<Record<string, any>>(
      `SELECT e.*, d.name AS device_name, k.label AS api_key_label FROM security_events e
       LEFT JOIN devices d ON d.id = e.device_id LEFT JOIN api_keys k ON k.id = e.api_key_id
       ${where} ORDER BY e.at DESC, e.id DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        at: r.at,
        kind: r.kind,
        apiKeyId: r.api_key_id ?? null,
        apiKeyLabel: r.api_key_label ?? null,
        deviceId: r.device_id,
        deviceName: r.device_name ?? null,
        ip: r.ip,
        userAgent: r.user_agent,
        detail: r.detail,
      })),
    };
  }

  apiLog(f: { deviceId?: string; apiKeyId?: string }, limit: number, offset: number): Page<Record<string, unknown>> {
    const where = f.deviceId ? 'WHERE a.device_id = ?' : f.apiKeyId ? 'WHERE a.api_key_id = ?' : '';
    const params = f.deviceId ? [f.deviceId] : f.apiKeyId ? [f.apiKeyId] : [];
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM api_log a ${where}`, ...params)!.n;
    const rows = this.db.all<Record<string, unknown>>(
      `SELECT a.id, a.at, a.device_id AS deviceId, d.name AS deviceName, a.api_key_id AS apiKeyId, a.method, a.route, a.status,
              a.duration_ms AS durationMs, a.bytes_in AS bytesIn, a.bytes_out AS bytesOut, a.ip
       FROM api_log a LEFT JOIN devices d ON d.id = a.device_id ${where} ORDER BY a.at DESC, a.id DESC LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
    return { total, rows };
  }

  /** `signIns`: how many browsers are signed in to the console with this key right now. */
  keyInfo(key: ApiKey, store: ApiKeyStore, signIns = 0, now = Date.now()): ApiKeyInfo {
    const since = now - 30 * DAY;
    const r = this.db.get<{ n: number; i: number; o: number; f: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o,
              COALESCE(SUM(CASE WHEN status IN ('failed', 'error', 'usage_limited', 'quota_exceeded', 'rejected', 'rate_limited') THEN 1 ELSE 0 END), 0) AS f
       FROM requests WHERE api_key_id = ? AND started_at >= ?`,
      key.id,
      since,
    )!;
    const t = this.db.get<{ up: number; down: number }>(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'upload' THEN bytes ELSE 0 END), 0) AS up,
              COALESCE(SUM(CASE WHEN direction <> 'upload' THEN bytes ELSE 0 END), 0) AS down
       FROM file_transfers WHERE api_key_id = ? AND ok = 1 AND at >= ?`,
      key.id,
      since,
    )!;
    const calls = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM api_log WHERE api_key_id = ? AND at >= ?', key.id, since)!.n;
    const window = quotaWindow(key.quotaPeriod, now);
    return {
      id: key.id,
      label: key.label,
      display: ApiKeyStore.display(key),
      status: store.status(key, now),
      scopes: [...key.scopes],
      consoleAccess: key.consoleAccess,
      signIns,
      folder: key.folder,
      quota: { tokens: key.quotaTokens, period: key.quotaPeriod, used: store.usedTokens(key.id, key.quotaPeriod, now), resetsAt: window.resetsAt },
      maxSandbox: key.maxSandbox,
      allowNetwork: key.allowNetwork,
      approvals: key.approvals,
      limits: key.limits,
      ipAllowlist: key.ipAllowlist,
      createdAt: key.createdAt,
      updatedAt: key.updatedAt,
      expiresAt: key.expiresAt,
      revokedAt: key.revokedAt,
      rotatedAt: key.rotatedAt,
      graceUntil: key.graceUntil,
      lastUsedAt: key.lastUsedAt,
      lastIp: key.lastIp,
      usage30d: { requests: r.n, inputTokens: r.i, outputTokens: r.o, failed: r.f, uploadBytes: t.up, downloadBytes: t.down, apiCalls: calls },
    };
  }

  keyUsage(key: ApiKey, store: ApiKeyStore, tzOffsetMin: number, signIns = 0, now = Date.now()): ApiKeyUsage {
    const shiftSec = -tzOffsetMin * 60;
    const rows = this.db.all<{ day: string; n: number; t: number; f: number }>(
      `SELECT date(started_at / 1000 + ?, 'unixepoch') AS day, COUNT(*) AS n,
              COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS t,
              COALESCE(SUM(CASE WHEN status IN ('failed', 'error', 'usage_limited', 'quota_exceeded') THEN 1 ELSE 0 END), 0) AS f
       FROM requests WHERE api_key_id = ? AND started_at >= ? GROUP BY day ORDER BY day`,
      shiftSec,
      key.id,
      now - 30 * DAY,
    );
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const daily: ApiKeyUsage['daily'] = [];
    for (let i = 29; i >= 0; i--) {
      const day = new Date(now + shiftSec * 1000 - i * DAY).toISOString().slice(0, 10);
      const r = byDay.get(day);
      daily.push({ day, requests: r?.n ?? 0, tokens: r?.t ?? 0, failed: r?.f ?? 0 });
    }
    return { key: this.keyInfo(key, store, signIns, now), daily, recent: this.requests({ apiKeyId: key.id }, 20, 0).rows };
  }

  recordRateLimits(snapshot: RateLimitSnapshot, now = Date.now()): void {
    const last = this.db.get<{ at: number; data: string }>('SELECT at, data FROM rate_limit_snapshots ORDER BY at DESC LIMIT 1');
    const data = JSON.stringify(snapshot);
    // Keep the history compact: skip unchanged snapshots taken within 10 minutes.
    if (last && last.data === data && now - last.at < 10 * 60_000) return;
    this.db.run('INSERT INTO rate_limit_snapshots (at, data) VALUES (?, ?)', now, data);
  }

  overview(tzOffsetMin: number, signInIdleMs: number, now = Date.now()): Omit<AdminOverview, 'codex' | 'publicApi'> {
    const sum = (since: number) =>
      this.db.get<{ n: number; i: number; o: number; f: number }>(
        `SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o,
                COALESCE(SUM(CASE WHEN status IN ('failed', 'error', 'usage_limited') THEN 1 ELSE 0 END), 0) AS f
         FROM requests WHERE started_at >= ?`,
        since,
      )!;
    const d1 = sum(now - DAY);
    const d7 = sum(now - 7 * DAY);
    const bytes = (dirs: string[]) =>
      this.db.get<{ b: number }>(
        `SELECT COALESCE(SUM(bytes), 0) AS b FROM file_transfers WHERE ok = 1 AND at >= ? AND direction IN (${dirs.map(() => '?').join(',')})`,
        now - 7 * DAY,
        ...dirs,
      )!.b;
    const activeSignIns = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM login_sessions WHERE revoked_at IS NULL AND expires_at > ? AND last_seen_at >= ?',
      now,
      now - signInIdleMs,
    )!.n;
    const securityEvents24h = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM security_events WHERE at >= ? AND kind IN (${SECURITY_ALERT_KINDS.map(() => '?').join(',')})`,
      now - DAY,
      ...SECURITY_ALERT_KINDS,
    )!.n;

    const shiftSec = -tzOffsetMin * 60;
    const dailyRows = this.db.all<{ day: string; n: number; i: number; o: number; f: number }>(
      `SELECT date(started_at / 1000 + ?, 'unixepoch') AS day, COUNT(*) AS n,
              COALESCE(SUM(input_tokens), 0) AS i, COALESCE(SUM(output_tokens), 0) AS o,
              COALESCE(SUM(CASE WHEN status IN ('failed', 'error', 'usage_limited') THEN 1 ELSE 0 END), 0) AS f
       FROM requests WHERE started_at >= ? GROUP BY day ORDER BY day`,
      shiftSec,
      now - 14 * DAY,
    );
    const byDay = new Map(dailyRows.map((r) => [r.day, r]));
    const daily: AdminOverview['daily'] = [];
    for (let i = 13; i >= 0; i--) {
      const day = new Date(now + shiftSec * 1000 - i * DAY).toISOString().slice(0, 10);
      const r = byDay.get(day);
      daily.push({ day, requests: r?.n ?? 0, inputTokens: r?.i ?? 0, outputTokens: r?.o ?? 0, failed: r?.f ?? 0 });
    }

    const snaps = this.db.all<{ at: number; data: string }>('SELECT at, data FROM rate_limit_snapshots WHERE at >= ? ORDER BY at', now - 7 * DAY);
    const step = Math.max(1, Math.ceil(snaps.length / 500));
    const limitHistory: AdminOverview['limitHistory'] = [];
    for (let i = 0; i < snaps.length; i += step) {
      const s = JSON.parse(snaps[i]!.data) as RateLimitSnapshot;
      limitHistory.push({ at: snaps[i]!.at, primary: s.primary?.usedPercent ?? null, secondary: s.secondary?.usedPercent ?? null });
    }

    return {
      totals: {
        requests24h: d1.n,
        requests7d: d7.n,
        tokens24h: { input: d1.i, output: d1.o },
        tokens7d: { input: d7.i, output: d7.o },
        failed7d: d7.f,
        uploadBytes7d: bytes(['upload']),
        downloadBytes7d: bytes(['download', 'view']),
        activeSignIns,
        securityEvents24h,
      },
      daily,
      limitHistory,
    };
  }
}
