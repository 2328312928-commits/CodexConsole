import type { Db } from '../db/db.js';
import { hmacHex, randomToken, safeEqual } from '../lib/crypto.js';

const KEY = 'setup_link';
export const SETUP_LINK_TTL_MS = 7 * 86_400_000;

interface Stored {
  hash: string;
  expiresAt: number;
}

/**
 * The one-time link that finishes setup in the browser (admin password, authenticator, first
 * key). Only its hash is stored; a new link replaces the old one, and it stops working once
 * the owner account exists.
 */
export class SetupLinkStore {
  constructor(
    private readonly db: Db,
    private readonly pepper: Buffer,
  ) {}

  private hash(token: string): string {
    return hmacHex(this.pepper, `setup-link:${token}`);
  }

  private stored(): Stored | null {
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', KEY);
    if (!row) return null;
    try {
      return JSON.parse(row.value) as Stored;
    } catch {
      return null;
    }
  }

  create(now = Date.now()): string {
    const token = randomToken(32);
    const value: Stored = { hash: this.hash(token), expiresAt: now + SETUP_LINK_TTL_MS };
    this.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(value));
    return token;
  }

  valid(token: string, now = Date.now()): boolean {
    const s = this.stored();
    if (!s || token.length > 128 || now >= s.expiresAt) return false;
    return safeEqual(this.hash(token), s.hash);
  }

  hasValid(now = Date.now()): boolean {
    const s = this.stored();
    return s !== null && now < s.expiresAt;
  }

  consume(): void {
    this.db.run('DELETE FROM settings WHERE key = ?', KEY);
  }
}

export function setupUrl(origin: string, token: string): string {
  // In the #fragment, so the token never reaches a server log or a Referer header.
  return `${origin}/setup#token=${token}`;
}
