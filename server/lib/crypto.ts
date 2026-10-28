import crypto from 'node:crypto';

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`;
}

/** Keyed hash used to store high-entropy secrets (tokens, session ids, pairing codes). */
export function hmacHex(key: Buffer, value: string): string {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

export function deriveKey(master: Buffer, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
}

/** AES-256-GCM encryption for small secrets stored in the database. */
export function seal(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), enc.toString('base64url'), tag.toString('base64url')].join('.');
}

export function unseal(key: Buffer, sealed: string): string {
  const [version, iv, enc, tag] = sealed.split('.');
  if (version !== 'v1' || !iv || !enc || !tag) throw new Error('Unsupported sealed secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'base64url')), decipher.final()]).toString('utf8');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Crockford base32 without I, L, O, U: easy to read aloud and type on a phone.
const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_LENGTH = 20; // 100 bits

export function generatePairingCode(): string {
  const bytes = crypto.randomBytes(PAIRING_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) out += PAIRING_ALPHABET[bytes[i]! & 31];
  return out.replace(/(.{5})(?=.)/g, '$1-');
}

/** Normalise user input: case-insensitive, ignores separators, maps look-alikes. */
export function normalizePairingCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  if (cleaned.length !== PAIRING_CODE_LENGTH) return null;
  for (const ch of cleaned) if (!PAIRING_ALPHABET.includes(ch)) return null;
  return cleaned;
}
