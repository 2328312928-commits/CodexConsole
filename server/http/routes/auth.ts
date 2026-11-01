import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../../lib/errors.js';
import { authState, clientIp, cookieOptions, eventCtx, sessionCookie, type AppDeps } from '../context.js';

const LOCK_WINDOW_MS = 15 * 60_000;
const ADMIN_FAILS_PER_IP = 5;
const ADMIN_FAILS_GLOBAL = 20;
// Keys carry 256 random bits, so the lock only stops noise. It is per address: a global
// lock would let anyone keep the owner out by failing on purpose. During a flood (many
// failures overall) an address is locked after its first failure instead, so a valid key
// from an address that has not failed still gets in.
const KEY_FAILS_PER_IP = 10;
const KEY_FAILS_FLOOD = 100;

const keyBody = z.object({ key: z.string().min(1).max(200) }).strict();
const adminBody = z.object({ password: z.string().min(1).max(1024), code: z.string().min(1).max(16) }).strict();

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config, limiter, audit, owner, logins, keys } = deps;
  const cookieName = sessionCookie(config);

  /** Throws login_locked when too many recent failures share this address (or overall, if `global` is set). */
  function assertNotLocked(scope: string, ip: string, perIp: number, global: number | null): void {
    const ipWait = limiter.retryAfter(`${scope}:ip:${ip}`, perIp, LOCK_WINDOW_MS);
    const allWait = global === null ? 0 : limiter.retryAfter(`${scope}:all`, global, LOCK_WINDOW_MS);
    const wait = Math.max(ipWait, allWait);
    if (wait > 0) throw new ApiError(429, 'login_locked', undefined, Math.ceil(wait / 1000));
  }

  function recordFailure(scope: string, ip: string): void {
    limiter.record(`${scope}:ip:${ip}`, LOCK_WINDOW_MS);
    limiter.record(`${scope}:all`, LOCK_WINDOW_MS);
  }

  app.get('/api/auth/state', { config: { auth: 'public' } }, async (req) => authState(deps, req));

  // Sign in with an API key: the only thing a browser needs.
  app.post('/api/auth/key', { config: { auth: 'public' } }, async (req, reply) => {
    if (!owner.exists()) throw new ApiError(503, 'setup_required');
    const { key: token } = keyBody.parse(req.body);
    const ip = clientIp(req);
    const flood = limiter.usage('key:all', LOCK_WINDOW_MS) >= KEY_FAILS_FLOOD;
    try {
      assertNotLocked('key', ip, flood ? 1 : KEY_FAILS_PER_IP, null);
    } catch (err) {
      audit.security('login_locked', eventCtx(req), { via: 'key', flood });
      throw err;
    }

    const result = keys.authenticate(token.trim());
    const fail = (status: number, code: 'invalid_api_key' | 'api_key_revoked' | 'api_key_expired' | 'console_not_allowed' | 'ip_not_allowed', reason: string, keyId?: string) => {
      recordFailure('key', ip);
      audit.security('login_failure', { ...eventCtx(req), apiKeyId: keyId ?? null }, { via: 'key', reason });
      return new ApiError(status, code);
    };
    if (!result.ok) {
      if (result.reason === 'revoked') throw fail(401, 'api_key_revoked', result.reason, result.key?.id);
      if (result.reason === 'expired') throw fail(401, 'api_key_expired', result.reason, result.key?.id);
      throw fail(401, 'invalid_api_key', result.reason, result.key?.id);
    }
    const key = result.key;
    // After a rotation the old secret may still work for the API during its grace period, never for the console.
    if (result.viaPrevious) throw fail(401, 'invalid_api_key', 'rotated', key.id);
    const problem = keys.consoleProblem(key, ip);
    if (problem === 'console_not_allowed') throw fail(403, problem, problem, key.id);
    if (problem === 'ip_not_allowed') throw fail(403, problem, problem, key.id);
    if (problem) throw fail(401, problem, problem, key.id);

    // A new sign-in replaces whatever this browser was signed in with before.
    const previous = req.cookies[cookieName] ? logins.validate(req.cookies[cookieName]!) : null;
    if (previous) logins.revoke(previous.id);
    limiter.reset(`key:ip:${ip}`);
    const { row, secret } = logins.create(key.id, ip, req.headers['user-agent']);
    keys.touch(key, ip);
    reply.setCookie(cookieName, secret, cookieOptions(config, Math.floor(config.sessions.maxMs / 1000)));
    req.auth = { login: row, key, admin: false };
    audit.security('login_success', eventCtx(req), { via: 'key', session: row.id, access: key.consoleAccess });
    return authState(deps, req);
  });

  app.post('/api/auth/logout', { config: { auth: 'public' } }, async (req, reply) => {
    if (req.auth.login) {
      logins.revoke(req.auth.login.id);
      audit.security('logout', eventCtx(req));
    }
    reply.clearCookie(cookieName, { path: '/' });
    req.auth = { login: null, key: null, admin: false };
    return authState(deps, req);
  });

  // The admin area needs the owner password and an authenticator code on top of a key sign-in.
  app.post('/api/auth/admin', { config: { auth: 'login' } }, async (req) => {
    const { password, code } = adminBody.parse(req.body);
    const ip = clientIp(req);
    try {
      assertNotLocked('admin', ip, ADMIN_FAILS_PER_IP, ADMIN_FAILS_GLOBAL);
    } catch (err) {
      audit.security('login_locked', eventCtx(req), { via: 'admin' });
      throw err;
    }
    const passwordOk = await owner.checkPassword(password);
    // Only spend the TOTP step when the password is right, so guesses can't burn codes.
    const codeOk = passwordOk && owner.consumeTotp(code.replace(/\s/g, ''));
    if (!passwordOk || !codeOk) {
      recordFailure('admin', ip);
      audit.security('admin_verify_failure', eventCtx(req), { reason: passwordOk ? 'totp' : 'password' });
      throw new ApiError(401, 'invalid_credentials');
    }
    limiter.reset(`admin:ip:${ip}`);
    logins.markAdminVerified(req.auth.login!.id);
    audit.security('admin_verify_success', eventCtx(req));
    req.auth.admin = true;
    return authState(deps, req);
  });

  app.post('/api/auth/admin/lock', { config: { auth: 'login' } }, async (req) => {
    logins.dropAdmin(req.auth.login!.id);
    req.auth.admin = false;
    return authState(deps, req);
  });
}
