import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { consoleKeySettings } from '../../auth/apiKeys.js';
import { passwordProblem } from '../../auth/passwords.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from '../../auth/totp.js';
import { ApiError } from '../../lib/errors.js';
import { qrSvg } from '../../lib/qr.js';
import { defaultFolderName } from '../../services/workspace.js';
import { authState, clientIp, cookieOptions, eventCtx, sessionCookie, type AppDeps } from '../context.js';

const LOCK_WINDOW_MS = 15 * 60_000;
const FAILS_PER_IP = 10;

const tokenBody = z.object({ token: z.string().min(1).max(128) }).strict();
const finishBody = z
  .object({
    token: z.string().min(1).max(128),
    password: z.string().min(1).max(1024),
    totpSecret: z.string().regex(/^[A-Z2-7]{16,64}$/),
    code: z.string().min(1).max(16),
    keyLabel: z.string().trim().max(60).optional(),
  })
  .strict();

/**
 * Finish setup in the browser with the one-time link the installer prints: admin password,
 * authenticator, and the first key, which signs this browser in. Nothing needs a terminal.
 */
export function registerSetupRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config, limiter, audit, owner, keys, logins, setupLinks } = deps;
  const cookieName = sessionCookie(config);

  /** The link must be current and the owner account not exist yet. */
  function checkLink(token: string, ip: string): void {
    if (owner.exists()) throw new ApiError(409, 'setup_already_done');
    const wait = limiter.retryAfter(`setup:ip:${ip}`, FAILS_PER_IP, LOCK_WINDOW_MS);
    if (wait > 0) throw new ApiError(429, 'login_locked', undefined, Math.ceil(wait / 1000));
    if (!setupLinks.valid(token)) {
      limiter.record(`setup:ip:${ip}`, LOCK_WINDOW_MS);
      audit.security('login_failure', { ip }, { via: 'setup_link' });
      throw new ApiError(401, 'invalid_setup_link');
    }
  }

  app.get('/api/setup/state', { config: { auth: 'public' } }, async () => ({ needed: !owner.exists() }));

  // A fresh authenticator secret for this setup; it is kept only once the owner confirms a code.
  app.post('/api/setup/authenticator', { config: { auth: 'public' } }, async (req) => {
    const { token } = tokenBody.parse(req.body);
    checkLink(token, clientIp(req));
    const secret = generateTotpSecret();
    const uri = otpauthUri(secret);
    return { secret, otpauthUri: uri, qrSvg: await qrSvg(uri) };
  });

  app.post('/api/setup/finish', { config: { auth: 'public' } }, async (req, reply) => {
    const body = finishBody.parse(req.body);
    const ip = clientIp(req);
    checkLink(body.token, ip);
    if (passwordProblem(body.password)) throw new ApiError(400, 'password_too_short');
    if (verifyTotp(body.totpSecret, body.code, Date.now(), 0) === null) {
      limiter.record(`setup:ip:${ip}`, LOCK_WINDOW_MS);
      throw new ApiError(401, 'invalid_totp');
    }
    await owner.create(body.password, body.totpSecret);
    // Spend the code just used, so it cannot also unlock the admin area a second time.
    owner.consumeTotp(body.code);
    setupLinks.consume();
    audit.security('setup_completed', eventCtx(req), { via: 'web' });

    const label = body.keyLabel || 'My first device';
    const { key, secret } = keys.create(consoleKeySettings(label), `api/${defaultFolderName(label)}`);
    audit.security('api_key_created', { ...eventCtx(req), apiKeyId: key.id }, { label: key.label, consoleAccess: 'full', via: 'setup' });
    // The owner has just proved the password and the authenticator: this browser starts signed
    // in, with the admin area open, so Codex can be signed in right away.
    const { row, secret: cookie } = logins.create(key.id, ip, req.headers['user-agent']);
    logins.markAdminVerified(row.id);
    reply.setCookie(cookieName, cookie, cookieOptions(config, Math.floor(config.sessions.maxMs / 1000)));
    req.auth = { login: logins.get(row.id)!, key, admin: true };
    audit.security('login_success', eventCtx(req), { via: 'setup', session: row.id });
    return { auth: authState(deps, req), key: secret, consoleUrl: config.publicOrigin };
  });
}
