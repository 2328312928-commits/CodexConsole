import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface Secrets {
  /** Master key: HMAC key for stored token hashes and source for derived encryption keys. */
  pepper: Buffer;
}

/** Create the data directory with owner-only permissions, tightening it if needed. */
export function ensurePrivateDir(dir: string, warn: (msg: string) => void = console.warn): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  const mode = fs.statSync(dir).mode & 0o777;
  if (mode & 0o077) {
    fs.chmodSync(dir, 0o700);
    warn(`Tightened permissions on ${dir} to 0700 (was ${mode.toString(8)})`);
  }
}

export function writePrivateFile(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}

export function loadOrCreateSecrets(dataDir: string, warn: (msg: string) => void = console.warn): Secrets {
  ensurePrivateDir(dataDir, warn);
  const file = path.join(dataDir, 'secrets.json');
  if (!fs.existsSync(file)) {
    const pepper = crypto.randomBytes(32);
    writePrivateFile(file, JSON.stringify({ version: 1, pepper: pepper.toString('base64'), createdAt: new Date().toISOString() }, null, 2));
    return { pepper };
  }
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777;
    if (mode & 0o077) {
      fs.chmodSync(file, 0o600);
      warn(`Tightened permissions on ${file} to 0600 (was ${mode.toString(8)})`);
    }
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: number; pepper?: string };
  if (parsed.version !== 1 || typeof parsed.pepper !== 'string') throw new Error(`Unrecognised secrets file: ${file}`);
  const pepper = Buffer.from(parsed.pepper, 'base64');
  if (pepper.length !== 32) throw new Error(`Corrupt secrets file: ${file}`);
  return { pepper };
}
