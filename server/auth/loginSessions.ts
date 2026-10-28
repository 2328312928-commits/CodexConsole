import type { Db } from '../db/db.js';
import { hmacHex, randomId, randomToken } from '../lib/crypto.js';

export const ADMIN_MAX_MS = 12 * 3_600_000;

export interface LoginSessionRow {
  id: string;
  id_hash: string;
  device_id: string;
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

/** Console logins. Each is bound to one device; the cookie holds a random secret. */
export class LoginSessionStore {
  constructor(
    private readonly db: Db,
    private readonly pepper: Buffer,
    private readonly timeouts: SessionTimeouts,
  ) {}

  create(deviceId: string, ip: string, userAgent: string | undefined, adminVerified: boolean, now = Date.now()): { row: LoginSessionRow; secret: string } {
    const secret = randomToken(32);
    const id = randomId('ls');
    this.db.run(
      `INSERT INTO login_sessions (id, id_hash, device_id, created_at, last_seen_at, expires_at, admin_verified_at, admin_seen_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      hmacHex(this.pepper, secret),
      deviceId,
      now,
      now,
      now + this.timeouts.maxMs,
      adminVerified ? now : null,
      adminVerified ? now : null,
      ip,
      userAgent?.slice(0, 300) ?? null,
    );
    return { row: this.db.get<LoginSessionRow>('SELECT * FROM login_sessions WHERE id = ?', id)!, secret };
  }

  validate(secret: string, deviceId: string, now = Date.now()): LoginSessionRow | null {
    if (secret.length > 128) return null;
    const row = this.db.get<LoginSessionRow>('SELECT * FROM login_sessions WHERE id_hash = ?', hmacHex(this.pepper, secret));
    if (!row || row.revoked_at !== null || row.device_id !== deviceId) return null;
    if (now >= row.expires_at || now - row.last_seen_at > this.timeouts.idleMs) return null;
    return row;
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
    return this.db.run('UPDATE login_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now, id).changes === 1;
  }

  revokeAll(exceptId: string | null, now = Date.now()): number {
    return this.db.run('UPDATE login_sessions SET revoked_at = ? WHERE revoked_at IS NULL AND id IS NOT ?', now, exceptId).changes;
  }

  listActive(now = Date.now()): LoginSessionRow[] {
    return this.db.all<LoginSessionRow>(
      'SELECT * FROM login_sessions WHERE revoked_at IS NULL AND expires_at > ? AND last_seen_at > ? ORDER BY last_seen_at DESC',
      now,
      now - this.timeouts.idleMs,
    );
  }

  purgeExpired(now = Date.now()): void {
    this.db.run('DELETE FROM login_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)', now - 86_400_000, now - 30 * 86_400_000);
  }
}
