import { describe, expect, it } from 'vitest';
import { passwordProblem, hashPassword, verifyPassword } from '../server/auth/passwords.js';
import { base32Decode, base32Encode, generateTotpSecret, hotp, totpCode, verifyTotp } from '../server/auth/totp.js';
import { deriveKey, generatePairingCode, normalizePairingCode, seal, unseal } from '../server/lib/crypto.js';
import { RateLimiter } from '../server/lib/rateLimit.js';

describe('TOTP (RFC 6238)', () => {
  const key = Buffer.from('12345678901234567890', 'ascii');
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('matches the SHA-1 test vector at T=%i', (t, expected) => {
    expect(hotp(key, Math.floor(t / 30), 8)).toBe(expected);
  });

  it('round-trips base32 secrets', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(secret))).toBe(secret);
  });

  it('accepts one step of clock drift but not two, and never replays a step', () => {
    const secret = generateTotpSecret();
    const now = 1_800_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(secret, totpCode(secret, now), now, 0)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), now, 0)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, now + 30_000), now, 0)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, now - 60_000), now, 0)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now), now, step)).toBeNull();
    expect(verifyTotp(secret, '12a456', now, 0)).toBeNull();
    expect(verifyTotp(secret, `${totpCode(secret, now).slice(0, 3)} ${totpCode(secret, now).slice(3)}`, now, 0)).toBe(step);
  });
});

describe('passwords', () => {
  it('hashes with Argon2id and verifies', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'Correct horse battery staple')).toBe(false);
    expect(await verifyPassword('not a hash', 'x')).toBe(false);
  });

  it('enforces a minimum length (counting characters, not bytes)', () => {
    expect(passwordProblem('short')).toBe('too_short');
    expect(passwordProblem('长密码长密码长密码长密码')).toBeNull();
  });
});

describe('pairing codes and sealed secrets', () => {
  it('generates readable 100-bit codes and normalises user input', () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    const plain = code.replace(/-/g, '');
    expect(normalizePairingCode(code.toLowerCase())).toBe(plain);
    expect(normalizePairingCode(` ${plain.slice(0, 10)} ${plain.slice(10)} `)).toBe(plain);
    expect(normalizePairingCode('OOOOO-IIIII-LLLLL-00000')).toBe('00000111111111100000');
    expect(normalizePairingCode('UUUUU-UUUUU-UUUUU-UUUUU')).toBeNull();
    expect(normalizePairingCode('ABC')).toBeNull();
  });

  it('seals with AES-GCM and detects tampering', () => {
    const key = deriveKey(Buffer.alloc(32, 7), 'test');
    const sealed = seal(key, 'JBSWY3DPEHPK3PXP');
    expect(unseal(key, sealed)).toBe('JBSWY3DPEHPK3PXP');
    const parts = sealed.split('.');
    parts[2] = Buffer.from('tampered!!').toString('base64url');
    expect(() => unseal(key, parts.join('.'))).toThrow();
    expect(() => unseal(deriveKey(Buffer.alloc(32, 8), 'test'), sealed)).toThrow();
  });
});

describe('rate limiter', () => {
  it('allows up to the limit per window, then reports when to retry', () => {
    const rl = new RateLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect(rl.consume('k', 3, 60_000, 1, t0 + i).ok).toBe(true);
    const blocked = rl.consume('k', 3, 60_000, 1, t0 + 10);
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.retryAfterMs).toBe(60_000 - 10);
    expect(rl.consume('k', 3, 60_000, 1, t0 + 60_001).ok).toBe(true);
  });

  it('budgets weights such as bytes', () => {
    const rl = new RateLimiter();
    expect(rl.consume('b', 100, 1000, 60, 0).ok).toBe(true);
    expect(rl.consume('b', 100, 1000, 50, 1).ok).toBe(false);
    expect(rl.consume('b', 100, 1000, 40, 2).ok).toBe(true);
    expect(rl.usage('b', 1000, 3)).toBe(100);
  });
});
