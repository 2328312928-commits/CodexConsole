import type { Db } from '../db/db.js';
import { deriveKey, seal, unseal } from '../lib/crypto.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { verifyTotp } from './totp.js';

interface OwnerRow {
  password_hash: string;
  totp_secret_enc: string;
  totp_last_step: number;
}

/** The single owner account: Argon2id password + TOTP secret (encrypted at rest). */
export class OwnerStore {
  private readonly totpKey: Buffer;

  constructor(
    private readonly db: Db,
    pepper: Buffer,
  ) {
    this.totpKey = deriveKey(pepper, 'codex-console/totp-secret/v1');
  }

  exists(): boolean {
    return Boolean(this.db.get('SELECT 1 AS x FROM owner WHERE id = 1'));
  }

  async create(password: string, totpSecret: string, now = Date.now()): Promise<void> {
    const hash = await hashPassword(password);
    this.db.run(
      `INSERT INTO owner (id, password_hash, totp_secret_enc, totp_last_step, created_at, updated_at)
       VALUES (1, ?, ?, 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET password_hash = excluded.password_hash,
         totp_secret_enc = excluded.totp_secret_enc, totp_last_step = 0, updated_at = excluded.updated_at`,
      hash,
      seal(this.totpKey, totpSecret),
      now,
      now,
    );
  }

  async setPassword(password: string, now = Date.now()): Promise<void> {
    const hash = await hashPassword(password);
    this.db.run('UPDATE owner SET password_hash = ?, updated_at = ? WHERE id = 1', hash, now);
  }

  setTotpSecret(totpSecret: string, now = Date.now()): void {
    this.db.run(
      'UPDATE owner SET totp_secret_enc = ?, totp_last_step = 0, updated_at = ? WHERE id = 1',
      seal(this.totpKey, totpSecret),
      now,
    );
  }

  async checkPassword(password: string): Promise<boolean> {
    const row = this.db.get<OwnerRow>('SELECT password_hash FROM owner WHERE id = 1');
    if (!row) return false;
    return verifyPassword(row.password_hash, password);
  }

  /** Verifies and consumes a TOTP code (each time step can be used once). */
  consumeTotp(code: string, now = Date.now()): boolean {
    const row = this.db.get<OwnerRow>('SELECT totp_secret_enc, totp_last_step FROM owner WHERE id = 1');
    if (!row) return false;
    const secret = unseal(this.totpKey, row.totp_secret_enc);
    const step = verifyTotp(secret, code, now, Number(row.totp_last_step));
    if (step === null) return false;
    const r = this.db.run('UPDATE owner SET totp_last_step = ? WHERE id = 1 AND totp_last_step < ?', step, step);
    return r.changes === 1;
  }
}
