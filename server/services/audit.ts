import type { SecurityEventKind } from '../../shared/api.js';
import type { Db } from '../db/db.js';

const FLOOD_PRONE = new Set<SecurityEventKind>([
  'rate_limited',
  'host_rejected',
  'origin_rejected',
  'revoked_device_used',
  'expired_device_used',
  'login_locked',
  'pair_failure',
  'api_key_rejected',
]);

export interface EventContext {
  deviceId?: string | null;
  apiKeyId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** Writes the security log, the API access log and the file-transfer log. */
export class AuditLog {
  // Collapse floods (e.g. a script hammering the login) into one row per minute.
  private readonly recent = new Map<string, number>();

  constructor(private readonly db: Db) {}

  security(kind: SecurityEventKind, ctx: EventContext, detail?: string | Record<string, unknown>, now = Date.now()): void {
    const text = detail === undefined ? null : typeof detail === 'string' ? detail : JSON.stringify(detail);
    if (FLOOD_PRONE.has(kind)) {
      const key = `${kind}|${ctx.ip ?? ''}|${text ?? ''}`;
      const last = this.recent.get(key);
      if (last !== undefined && now - last < 60_000) return;
      this.recent.set(key, now);
      if (this.recent.size > 5000) this.recent.clear();
    }
    this.db.run(
      'INSERT INTO security_events (at, kind, device_id, api_key_id, ip, user_agent, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      now,
      kind,
      ctx.deviceId ?? null,
      ctx.apiKeyId ?? null,
      ctx.ip ?? null,
      ctx.userAgent?.slice(0, 300) ?? null,
      text?.slice(0, 2000) ?? null,
    );
  }

  api(entry: {
    deviceId: string | null;
    apiKeyId?: string | null;
    method: string;
    route: string;
    status: number;
    durationMs: number;
    bytesIn: number | null;
    bytesOut: number | null;
    ip: string;
  }): void {
    this.db.run(
      'INSERT INTO api_log (at, device_id, api_key_id, method, route, status, duration_ms, bytes_in, bytes_out, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      Date.now(),
      entry.deviceId,
      entry.apiKeyId ?? null,
      entry.method,
      entry.route.slice(0, 200),
      entry.status,
      Math.round(entry.durationMs),
      entry.bytesIn,
      entry.bytesOut,
      entry.ip,
    );
  }

  transfer(entry: {
    deviceId: string | null;
    apiKeyId?: string | null;
    sessionId: string | null;
    direction: 'upload' | 'download' | 'view';
    path: string;
    bytes: number;
    ok: boolean;
  }): void {
    this.db.run(
      'INSERT INTO file_transfers (at, device_id, api_key_id, session_id, direction, path, bytes, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      Date.now(),
      entry.deviceId,
      entry.apiKeyId ?? null,
      entry.sessionId,
      entry.direction,
      entry.path.slice(0, 1000),
      entry.bytes,
      entry.ok,
    );
  }

  /** Delete log rows older than the retention period. */
  prune(retentionDays: number, now = Date.now()): void {
    const cutoff = now - retentionDays * 86_400_000;
    this.db.tx(() => {
      this.db.run('DELETE FROM api_log WHERE at < ?', cutoff);
      this.db.run('DELETE FROM security_events WHERE at < ?', cutoff);
      this.db.run('DELETE FROM file_transfers WHERE at < ?', cutoff);
      this.db.run('DELETE FROM requests WHERE started_at < ?', cutoff);
      this.db.run('DELETE FROM rate_limit_snapshots WHERE at < ?', cutoff);
    });
  }
}
