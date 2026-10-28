import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { ApiError } from '../lib/errors.js';
import { cookieNames, eventCtx, type AppDeps } from './context.js';
import { handleError } from './errorHandler.js';
import { CSP } from './headers.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerApiKeyRoutes } from './routes/apiKeys.js';
import { registerMcpRoutes } from './routes/mcp.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerFileRoutes } from './routes/files.js';
import { registerSessionRoutes } from './routes/sessions.js';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const UNAUTH_API_PER_MIN = 120;
/** Client-side routes of the web app; every other non-API path is a 404. */
const APP_ROUTES = ['/', '/pair', '/s/:sessionId', '/admin', '/admin/:tab'];

/**
 * Whether the /api guards apply. The router matches on the *decoded* path, so the raw
 * URL alone is not enough: check the matched route pattern as well. (Raw paths with
 * percent-escapes or backslashes are rejected before this is consulted.)
 */
function isApi(req: FastifyRequest): boolean {
  return Boolean(req.routeOptions.url?.startsWith('/api/')) || req.url.startsWith('/api/');
}

export async function buildApp(deps: AppDeps, opts: { logger?: FastifyServerOptions['logger'] } = {}): Promise<FastifyInstance> {
  const { config, limiter, audit } = deps;
  const names = cookieNames(config);
  const servedOverHttps = Boolean(config.tls) || (config.secureCookies && config.trustProxy !== false);

  const app = Fastify({
    logger: opts.logger ?? { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    // Requests are recorded in the api_log table instead of the process log.
    logController: new LogController({ disableRequestLogging: true }),
    routerOptions: { maxParamLength: 200 },
    ...(config.tls ? { https: { cert: fs.readFileSync(config.tls.cert), key: fs.readFileSync(config.tls.key) } } : {}),
  } as FastifyServerOptions);

  await app.register(cookie);
  await app.register(multipart, {
    limits: { fileSize: config.limits.maxUploadBytes + 1, files: 20, fields: 10, fieldSize: 4096, parts: 40, headerPairs: 200 },
  });

  app.decorateRequest('auth', null as never);

  // 1. Host allowlist (blocks DNS-rebinding), 2. resolve device + login, 3. rate limit, 4. CSRF/Origin.
  app.addHook('onRequest', async (req, reply) => {
    const host = (req.headers.host ?? '').toLowerCase();
    const forwardedHost = config.trustProxy !== false ? req.host.toLowerCase() : host;
    if (!config.allowedHosts.has(host) && !config.allowedHosts.has(forwardedHost)) {
      audit.security('host_rejected', { ip: req.ip, userAgent: req.headers['user-agent'] }, { host: host.slice(0, 200) });
      return reply.status(421).send({ error: { code: 'forbidden_host' } });
    }
    // No route needs escapes in its path; refusing them keeps the guards and the router
    // looking at the same string (e.g. /%61pi/... must never reach an /api handler).
    if (/[%\\]/.test(req.url.split('?', 1)[0]!)) {
      return reply.status(400).send({ error: { code: 'path_invalid' } });
    }

    req.auth = { device: null, login: null, admin: false, bearer: false };
    const authz = req.headers.authorization;
    const bearer = typeof authz === 'string' && authz.startsWith('Bearer ');
    const token = bearer ? authz.slice(7).trim() : req.cookies[names.device];
    if (token) {
      const r = deps.devices.authenticate(token);
      if (r.ok) {
        req.auth.device = r.device;
        req.auth.bearer = bearer;
        deps.devices.touch(r.device, req.ip, req.headers['user-agent']);
      } else if (r.device) {
        audit.security(r.reason === 'revoked' ? 'revoked_device_used' : 'expired_device_used', { deviceId: r.device.id, ip: req.ip, userAgent: req.headers['user-agent'] });
      }
    }
    const secret = req.cookies[names.session];
    if (req.auth.device && secret) {
      const login = deps.logins.validate(secret, req.auth.device.id);
      if (login) {
        req.auth.login = login;
        req.auth.admin = deps.logins.isAdmin(login);
        deps.logins.touch(login, req.ip);
      }
    }

    if (!isApi(req)) return;
    const device = req.auth.device;
    const limited = limiter.consume(
      device ? `api:dev:${device.id}` : `api:ip:${req.ip}`,
      device ? config.limits.apiPerMinute : UNAUTH_API_PER_MIN,
      60_000,
    );
    if (!limited.ok) {
      audit.security('rate_limited', eventCtx(req), { scope: 'api' });
      const retryAfterSec = Math.ceil(limited.retryAfterMs / 1000);
      return reply.status(429).header('Retry-After', String(retryAfterSec)).send({ error: { code: 'rate_limited', retryAfterSec } });
    }

    if (STATE_CHANGING.has(req.method)) {
      const origin = req.headers.origin;
      if (origin !== undefined && !config.allowedOrigins.has(origin)) {
        audit.security('origin_rejected', eventCtx(req), { origin: origin.slice(0, 200) });
        return reply.status(403).send({ error: { code: 'forbidden_origin' } });
      }
      if (!req.auth.bearer && req.headers['x-codex-console'] !== '1') {
        return reply.status(403).send({ error: { code: 'csrf_header_missing' } });
      }
    }
  });

  // Every /api route requires a login unless it opts out via config.auth.
  app.addHook('preHandler', async (req) => {
    if (!isApi(req)) return;
    const level = req.routeOptions.config?.auth ?? 'login';
    if (level === 'public') return;
    if (!deps.owner.exists()) throw new ApiError(503, 'setup_required');
    if (!req.auth.device) throw new ApiError(401, 'device_required');
    if (level === 'device') return;
    if (!req.auth.login) throw new ApiError(401, 'login_required');
    if (level === 'login') return;
    if (!req.auth.admin) throw new ApiError(403, 'admin_required');
    deps.logins.touchAdmin(req.auth.login);
  });

  app.addHook('onSend', async (req, reply, payload) => {
    if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    if (servedOverHttps) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (isApi(req) && !reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    if (!isApi(req)) return;
    const len = reply.getHeader('content-length');
    audit.api({
      deviceId: req.auth?.device?.id ?? null,
      method: req.method,
      route: req.routeOptions.url ?? req.url.split('?')[0]!,
      status: reply.statusCode,
      durationMs: reply.elapsedTime,
      bytesIn: Number(req.headers['content-length'] ?? 0) || null,
      bytesOut: len === undefined ? null : Number(len),
      ip: req.ip,
    });
  });

  app.setErrorHandler(handleError);

  registerAuthRoutes(app, deps);
  registerSessionRoutes(app, deps);
  registerFileRoutes(app, deps);
  registerAdminRoutes(app, deps);
  registerApiKeyRoutes(app, deps);
  registerMcpRoutes(app, deps);
  app.get('/api/health', { config: { auth: 'public' } }, async () => ({ ok: true }));

  const hasWeb = fs.existsSync(path.join(config.webDir, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: config.webDir,
      prefix: '/',
      index: false,
      // Serve whatever is in dist/web now (rebuilds during `npm run dev`); misses fall through to the SPA handler.
      wildcard: true,
      setHeaders(res, filePath) {
        const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
        res.header('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  // The app shell, on the client-side routes only (the static plugin answers "/" with 403).
  for (const route of APP_ROUTES) {
    app.get(route, { config: { auth: 'public' } }, (_req, reply) => {
      if (!hasWeb) return reply.status(404).type('text/plain; charset=utf-8').send('Web UI not built: run `npm run build`.');
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    });
  }

  app.setNotFoundHandler((req, reply) => {
    if (isApi(req)) return reply.status(404).send({ error: { code: 'not_found' } });
    return reply.status(404).type('text/plain; charset=utf-8').send('Not found');
  });

  return app;
}
