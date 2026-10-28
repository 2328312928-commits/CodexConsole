import type { Db } from '../db/db.js';
import { generatePairingCode, hmacHex, normalizePairingCode, randomId, randomToken } from '../lib/crypto.js';

export const PAIRING_TTL_MS = 15 * 60_000;
export const DEVICE_TOKEN_PREFIX = 'ccd_';

export interface DeviceRow {
  id: string;
  name: string;
  token_hash: string | null;
  token_hint: string | null;
  created_at: number;
  paired_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  last_ip: string | null;
  last_user_agent: string | null;
}

export type DeviceAuthResult =
  | { ok: true; device: DeviceRow }
  | { ok: false; reason: 'unknown' | 'revoked' | 'expired'; device?: DeviceRow };

/** Per-device access tokens. Only hashes are stored; the token itself lives on the device. */
export class DeviceStore {
  constructor(
    private readonly db: Db,
    private readonly pepper: Buffer,
  ) {}

  private hash(value: string): string {
    return hmacHex(this.pepper, value);
  }

  get(id: string): DeviceRow | undefined {
    return this.db.get<DeviceRow>('SELECT * FROM devices WHERE id = ?', id);
  }

  list(): DeviceRow[] {
    return this.db.all<DeviceRow>('SELECT * FROM devices ORDER BY created_at DESC');
  }

  create(name: string, expiresAt: number | null, now = Date.now()): { device: DeviceRow; code: string; codeExpiresAt: number } {
    const id = randomId('dev');
    return this.db.tx(() => {
      this.db.run('INSERT INTO devices (id, name, created_at, expires_at) VALUES (?, ?, ?, ?)', id, name, now, expiresAt);
      const { code, expiresAt: codeExpiresAt } = this.issuePairingCode(id, now);
      return { device: this.get(id)!, code, codeExpiresAt };
    });
  }

  /** Issue a one-time pairing code; earlier unused codes for the device stop working. */
  issuePairingCode(deviceId: string, now = Date.now()): { code: string; expiresAt: number } {
    const code = generatePairingCode();
    const expiresAt = now + PAIRING_TTL_MS;
    this.db.tx(() => {
      this.db.run('DELETE FROM pairing_codes WHERE device_id = ? AND used_at IS NULL', deviceId);
      this.db.run(
        'INSERT INTO pairing_codes (code_hash, device_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
        this.hash(normalizePairingCode(code)!),
        deviceId,
        now,
        expiresAt,
      );
    });
    return { code, expiresAt };
  }

  /** Redeem a pairing code. Returns a fresh device token (replacing any previous one). */
  pair(codeInput: string, now = Date.now()): { device: DeviceRow; token: string } | null {
    const code = normalizePairingCode(codeInput);
    if (!code) return null;
    const codeHash = this.hash(code);
    return this.db.tx(() => {
      const row = this.db.get<{ device_id: string; expires_at: number; used_at: number | null }>(
        'SELECT device_id, expires_at, used_at FROM pairing_codes WHERE code_hash = ?',
        codeHash,
      );
      if (!row || row.used_at !== null || row.expires_at <= now) return null;
      const device = this.get(row.device_id);
      if (!device || device.revoked_at !== null || (device.expires_at !== null && device.expires_at <= now)) return null;
      this.db.run('UPDATE pairing_codes SET used_at = ? WHERE code_hash = ?', now, codeHash);
      const token = DEVICE_TOKEN_PREFIX + randomToken(32);
      this.db.run(
        'UPDATE devices SET token_hash = ?, token_hint = ?, paired_at = ? WHERE id = ?',
        this.hash(token),
        token.slice(0, DEVICE_TOKEN_PREFIX.length + 6),
        now,
        device.id,
      );
      // Re-pairing rotates the token, so end any logins made with the old one.
      this.db.run('UPDATE login_sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL', now, device.id);
      return { device: this.get(device.id)!, token };
    });
  }

  authenticate(token: string, now = Date.now()): DeviceAuthResult {
    if (!token.startsWith(DEVICE_TOKEN_PREFIX) || token.length > 128) return { ok: false, reason: 'unknown' };
    const device = this.db.get<DeviceRow>('SELECT * FROM devices WHERE token_hash = ?', this.hash(token));
    if (!device) return { ok: false, reason: 'unknown' };
    if (device.revoked_at !== null) return { ok: false, reason: 'revoked', device };
    if (device.expires_at !== null && device.expires_at <= now) return { ok: false, reason: 'expired', device };
    return { ok: true, device };
  }

  /** Record last use; throttled to one write per minute per device. */
  touch(device: DeviceRow, ip: string, userAgent: string | undefined, now = Date.now()): void {
    if (device.last_used_at !== null && now - device.last_used_at < 60_000 && device.last_ip === ip) return;
    this.db.run(
      'UPDATE devices SET last_used_at = ?, last_ip = ?, last_user_agent = ? WHERE id = ?',
      now,
      ip,
      userAgent?.slice(0, 300) ?? null,
      device.id,
    );
  }

  rename(id: string, name: string): boolean {
    return this.db.run('UPDATE devices SET name = ? WHERE id = ?', name, id).changes === 1;
  }

  setExpiry(id: string, expiresAt: number | null): boolean {
    return this.db.run('UPDATE devices SET expires_at = ? WHERE id = ?', expiresAt, id).changes === 1;
  }

  /** Revocation is permanent: the token stops working and its logins end. */
  revoke(id: string, now = Date.now()): boolean {
    return this.db.tx(() => {
      const r = this.db.run('UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now, id);
      this.db.run('DELETE FROM pairing_codes WHERE device_id = ? AND used_at IS NULL', id);
      this.db.run('UPDATE login_sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL', now, id);
      return r.changes === 1;
    });
  }
}
