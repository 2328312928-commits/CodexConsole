import { hash, verify } from '@node-rs/argon2';

// Argon2id (the library default) with 64 MiB memory, 3 passes.
const OPTIONS = { memoryCost: 65_536, timeCost: 3, parallelism: 1, outputLen: 32 };

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 1024;

export function passwordProblem(pw: string): 'too_short' | 'too_long' | null {
  if ([...pw].length < MIN_PASSWORD_LENGTH) return 'too_short';
  if (pw.length > MAX_PASSWORD_LENGTH) return 'too_long';
  return null;
}

export async function hashPassword(pw: string): Promise<string> {
  return hash(pw.normalize('NFKC'), OPTIONS);
}

export async function verifyPassword(stored: string, pw: string): Promise<boolean> {
  if (pw.length > MAX_PASSWORD_LENGTH) return false;
  try {
    return await verify(stored, pw.normalize('NFKC'));
  } catch {
    return false;
  }
}
