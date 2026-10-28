import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../../lib/errors.js';
import { authState, cookieNames, cookieOptions, eventCtx, type AppDeps } from '../context.js';

const LOCK_WINDOW_MS = 15 * 60_000;
const LOGIN_FAILS_PER_IP = 5;
const LOGIN_FAILS_GLOBAL = 20;
const PAIR_FAILS_PER_IP = 10;
const DEVICE_COOKIE_MAX_AGE_SEC = 400 * 86_400; // browsers cap cookies at 400 days

const pairBody = z.object({ code: z.string().min(1).max(64) }).strict();
const loginBody = z.object({ password: z.string().min(1).max(1024), code: z.string().min(1).max(16) }).strict();
const totpBody = z.object({ code: z.string().min(1).max(16) }).strict();

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config, limiter, audit, owner, devices, logins } = deps;
  const names = cookieNames(config);

  /** Throws login_locked when too many recent failures share this IP (or overall, if `global` is set). */
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

  app.post('/api/auth/pair', { config: { auth: 'public' } }, async (req, reply) => {
    if (!owner.exists()) throw new ApiError(503, 'setup_required');
    const { code } = pairBody.parse(req.body);
    try {
      // No global cap: pairing codes carry 100 bits, so spreading guesses over many IPs gains nothing.
      assertNotLocked('pair', req.ip, PAIR_FAILS_PER_IP, null);
    } catch (err) {
      audit.security('rate_limited', eventCtx(req), { scope: 'pair' });
      throw err;
    }
    const result = devices.pair(code);
    if (!result) {
      recordFailure('pair', req.ip);
      audit.security('pair_failure', eventCtx(req));
      throw new ApiError(400, 'invalid_pairing_code');
    }
    // A new device token replaces any login cookie from a previous pairing.
    reply.setCookie(names.device, result.token, cookieOptions(config, DEVICE_COOKIE_MAX_AGE_SEC));
    reply.clearCookie(names.session, { path: '/' });
    audit.security('pair_success', { deviceId: result.device.id, ip: req.ip, userAgent: req.headers['user-agent'] }, { name: result.device.name });
    return {
      setupComplete: true,
      device: { id: result.device.id, name: result.device.name },
      loggedIn: false,
      admin: false,
      ...(req.headers['x-codex-console-token'] === 'return' ? { token: result.token } : {}),
    };
  });

  app.post('/api/auth/login', { config: { auth: 'device' } }, async (req, reply) => {
    const { password, code } = loginBody.parse(req.body);
    const device = req.auth.device!;
    try {
      assertNotLocked('login', req.ip, LOGIN_FAILS_PER_IP, LOGIN_FAILS_GLOBAL);
    } catch (err) {
      audit.security('login_locked', eventCtx(req));
      throw err;
    }
    const passwordOk = await owner.checkPassword(password);
    // Only spend the TOTP step when the password is right, so guesses can't burn codes.
    const codeOk = passwordOk && owner.consumeTotp(code);
    if (!passwordOk || !codeOk) {
      recordFailure('login', req.ip);
      audit.security('login_failure', eventCtx(req), { reason: passwordOk ? 'totp' : 'password' });
      throw new ApiError(401, 'invalid_credentials');
    }
    limiter.reset(`login:ip:${req.ip}`);
    const { row, secret } = logins.create(device.id, req.ip, req.headers['user-agent'], true);
    reply.setCookie(names.session, secret, cookieOptions(config, Math.floor(config.sessions.maxMs / 1000)));
    audit.security('login_success', eventCtx(req), { session: row.id });
    req.auth.login = row;
    req.auth.admin = true;
    return authState(deps, req);
  });

  app.post('/api/auth/logout', { config: { auth: 'login' } }, async (req, reply) => {
    logins.revoke(req.auth.login!.id);
    reply.clearCookie(names.session, { path: '/' });
    audit.security('logout', eventCtx(req));
    req.auth.login = null;
    req.auth.admin = false;
    return authState(deps, req);
  });

  app.post('/api/auth/admin/verify', { config: { auth: 'login' } }, async (req) => {
    const { code } = totpBody.parse(req.body);
    assertNotLocked('admin', req.ip, LOGIN_FAILS_PER_IP, LOGIN_FAILS_GLOBAL);
    if (!owner.consumeTotp(code)) {
      recordFailure('admin', req.ip);
      audit.security('admin_verify_failure', eventCtx(req));
      throw new ApiError(401, 'invalid_totp');
    }
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
