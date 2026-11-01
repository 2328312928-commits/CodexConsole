import { EventEmitter } from 'node:events';
import type { Db } from '../db/db.js';
import { hmacHex, randomId, randomToken } from '../lib/crypto.js';

export const ADMIN_MAX_MS = 12 * 3_600_000;

export interface LoginSessionRow {
  id: string;
  id_hash: string;
  api_key_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  admin_verified_at: number | null;
  admin_seen_at: number | null;
  ip: string | null;
  user_agent: string | null;
  revoked_at: number | null;
}

export interface SessionTimeouts {
  idleMs: number;
  maxMs: number;
  adminIdleMs: number;
}

/**
 * Console sign-ins. Each one was made with an API key and stays bound to it; the cookie
 * holds a random secret. `changes` fires whenever sign-ins end, so live streams can stop.
 */
export class LoginSessionStore {
  readonly changes = new EventEmitter();

  constructor(
    private readonly db: Db,
    private readonly pepper: Buffer,
    private readonly timeouts: SessionTimeouts,
  ) {
    this.changes.setMaxListeners(0);
  }

  create(apiKeyId: string, ip: string, userAgent: string | undefined, now = Date.now()): { row: LoginSessionRow; secret: string } {
    const secret = randomToken(32);
    const id = randomId('ls');
    this.db.run(
      `INSERT INTO login_sessions (id, id_hash, api_key_id, created_at, last_seen_at, expires_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      hmacHex(this.pepper, secret),
      apiKeyId,
      now,
      now,
      now + this.timeouts.maxMs,
      ip,
      userAgent?.slice(0, 300) ?? null,
    );
    return { row: this.get(id)!, secret };
  }

  get(id: string): LoginSessionRow | undefined {
    return this.db.get<LoginSessionRow>('SELECT * FROM login_sessions WHERE id = ?', id);
  }

  validate(secret: string, now = Date.now()): LoginSessionRow | null {
    if (secret.length > 128) return null;
    const row = this.db.get<LoginSessionRow>('SELECT * FROM login_sessions WHERE id_hash = ?', hmacHex(this.pepper, secret));
    return row && this.isLive(row, now) ? row : null;
  }

  isLive(row: LoginSessionRow, now = Date.now()): boolean {
    return row.revoked_at === null && now < row.expires_at && now - row.last_seen_at <= this.timeouts.idleMs;
  }

  touch(row: LoginSessionRow, ip: string, now = Date.now()): void {
    if (now - row.last_seen_at < 60_000 && row.ip === ip) return;
    this.db.run('UPDATE login_sessions SET last_seen_at = ?, ip = ? WHERE id = ?', now, ip, row.id);
  }

  isAdmin(row: LoginSessionRow, now = Date.now()): boolean {
    if (row.admin_verified_at === null) return false;
    if (now - row.admin_verified_at > ADMIN_MAX_MS) return false;
    const lastAdmin = row.admin_seen_at ?? row.admin_verified_at;
    return now - lastAdmin <= this.timeouts.adminIdleMs;
  }

  markAdminVerified(id: string, now = Date.now()): void {
    this.db.run('UPDATE login_sessions SET admin_verified_at = ?, admin_seen_at = ? WHERE id = ?', now, now, id);
  }

  touchAdmin(row: LoginSessionRow, now = Date.now()): void {
    if (row.admin_seen_at !== null && now - row.admin_seen_at < 15_000) return;
    this.db.run('UPDATE login_sessions SET admin_seen_at = ? WHERE id = ?', now, row.id);
  }

  dropAdmin(id: string): void {
    this.db.run('UPDATE login_sessions SET admin_verified_at = NULL, admin_seen_at = NULL WHERE id = ?', id);
  }

  revoke(id: string, now = Date.now()): boolean {
    const ok = this.db.run('UPDATE login_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now, id).changes === 1;
    if (ok) this.changes.emit('changed');
    return ok;
  }

  revokeAll(exceptId: string | null, now = Date.now()): number {
    const n = this.db.run('UPDATE login_sessions SET revoked_at = ? WHERE revoked_at IS NULL AND id IS NOT ?', now, exceptId).changes;
    if (n) this.changes.emit('changed');
    return n;
  }

  /** Sign a key out everywhere (revoked, rotated, or no longer allowed in the console). */
  endForKey(apiKeyId: string, now = Date.now()): number {
    const n = this.db.run('UPDATE login_sessions SET revoked_at = ? WHERE api_key_id = ? AND revoked_at IS NULL', now, apiKeyId).changes;
    // Fire even when no rows changed: the key itself may have changed (IP allowlist, expiry).
    this.changes.emit('changed');
    return n;
  }

  listActive(now = Date.now()): LoginSessionRow[] {
    return this.db.all<LoginSessionRow>(
      'SELECT * FROM login_sessions WHERE revoked_at IS NULL AND expires_at > ? AND last_seen_at >= ? ORDER BY last_seen_at DESC',
      now,
      now - this.timeouts.idleMs,
    );
  }

  purgeExpired(now = Date.now()): void {
    this.db.run('DELETE FROM login_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)', now - 86_400_000, now - 30 * 86_400_000);
  }
}
