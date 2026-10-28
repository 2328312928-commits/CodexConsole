import crypto from 'node:crypto';
import { safeEqual } from '../lib/crypto.js';

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — what every authenticator app supports.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD_SEC = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

export function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SEC);
}

export function totpCode(secretB32: string, nowMs: number): string {
  return hotp(base32Decode(secretB32), totpStep(nowMs));
}

/**
 * Checks a code against the previous, current and next time step.
 * Steps at or below `lastUsedStep` are rejected so a code can't be replayed.
 * Returns the matched step, or null.
 */
export function verifyTotp(secretB32: string, code: string, nowMs: number, lastUsedStep: number): number | null {
  const clean = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const key = base32Decode(secretB32);
  const step = totpStep(nowMs);
  let matched: number | null = null;
  for (const s of [step - 1, step, step + 1]) {
    const ok = safeEqual(hotp(key, s), clean);
    if (ok && s > lastUsedStep && matched === null) matched = s;
  }
  return matched;
}

export function otpauthUri(secretB32: string, label = 'owner', issuer = 'Codex Console'): string {
  const i = encodeURIComponent(issuer);
  return `otpauth://totp/${i}:${encodeURIComponent(label)}?secret=${secretB32}&issuer=${i}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD_SEC}`;
}
