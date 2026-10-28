import http from 'node:http';
import type net from 'node:net';
import path from 'node:path';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import { SAFE_APPROVAL_DECISIONS, type ApiKeyScope, type MediaRef, type ServerEvent, type TurnResult } from '../../shared/api.js';
import type { ApiKey, ApiKeyAuth } from '../auth/apiKeys.js';
import { runCommand } from '../codex/commands.js';
import type { KeyCaps } from '../codex/sessionOps.js';
import type { KeyContext } from '../codex/turns.js';
import { ApiError } from '../lib/errors.js';
import { buildAllowlist, ipAllowed, normalizeIp, proxiedAddress, proxyProtocolFront } from '../lib/net.js';
import { AdminQueries } from '../services/adminQueries.js';
import type { SessionRow } from '../services/sessions.js';
import { Workspace } from '../services/workspace.js';
import type { AppDeps } from './context.js';
import { handleError } from './errorHandler.js';
import { contentDisposition, FILE_CSP } from './headers.js';
import { mcpActions, mcpInputSchema, mcpNameParam } from './routes/mcp.js';
import { parseRange } from './routes/files.js';
import { answerBody, buildPromptInput, decisionBody, defaultFolderName, makeSessionFolder, reviewBody, settingsBody, turnSettingsBody } from './routes/sessions.js';

type Scope = ApiKeyScope | 'public' | 'key';

declare module 'fastify' {
  interface FastifyRequest {
    apiKey: ApiKey | null;
    clientIp: string;
  }
  interface FastifyContextConfig {
    scope?: Scope;
  }
}

const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
const BAD_AUTH_WINDOW_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;
const idParam = z.object({ id: z.string().regex(/^ses_[A-Za-z0-9_-]{1,40}$/) });

/**
 * The public API: a separate listener that serves only /v1 and authenticates only
 * with API keys. No cookies, no web UI, no admin routes exist here.
 */
export async function buildPublicApi(deps: AppDeps, opts: { logger?: FastifyServerOptions['logger'] } = {}) {
  const { config, keys, limiter, audit, sessions, turns, ops, workspace, requests, media, db, mcp, queue } = deps;
  const queries = new AdminQueries(db);
  const api = config.api;
  const sockets = new Set<net.Socket>();
  let front: net.Server | null = null;

  const app: FastifyInstance = Fastify({
    logger: opts.logger ?? { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: api.trustProxy,
    bodyLimit: 1024 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
    routerOptions: { maxParamLength: 200 },
    requestTimeout: 15 * 60_000,
    serverFactory: (handler) => {
      const server = http.createServer(handler);
      server.headersTimeout = 30_000;
      server.on('connection', (s) => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
      });
      return server;
    },
  } as FastifyServerOptions);

  app.decorateRequest('apiKey', null as never);
  app.decorateRequest('clientIp', '');

  const reject = (reply: FastifyReply, status: number, code: string, retryAfterSec?: number) => {
    if (retryAfterSec) reply.header('Retry-After', String(retryAfterSec));
    return reply.status(status).send({ error: { code, ...(retryAfterSec ? { retryAfterSec } : {}) } });
  };

  app.addHook('onRequest', async (req, reply) => {
    const proxied = proxiedAddress(req.raw.socket);
    req.clientIp = normalizeIp(proxied?.sourceAddress ?? req.ip);
    const rawPath = req.url.split('?', 1)[0]!;
    if (/[%\\]/.test(rawPath)) return reject(reply, 400, 'path_invalid');
    if (rawPath !== '/v1' && !rawPath.startsWith('/v1/')) return reject(reply, 404, 'not_found');
    const host = (req.headers.host ?? '').toLowerCase();
    if (!api.allowedHosts.has(host) && !(api.trustProxy !== false && api.allowedHosts.has(req.host.toLowerCase()))) {
      audit.security('host_rejected', { ip: req.clientIp }, { host: host.slice(0, 200), listener: 'public' });
      return reject(reply, 421, 'forbidden_host');
    }
    // Unauthenticated calls get their own budget, so nobody without a key can use up the keys' budget.
    if (req.routeOptions.config?.scope === 'public') {
      const anon = limiter.consume('pub:anon', api.globalPerMinute, 60_000);
      if (!anon.ok) return reject(reply, 429, 'rate_limited', Math.ceil(anon.retryAfterMs / 1000));
      return;
    }

    const authz = req.headers.authorization;
    const token = typeof authz === 'string' && authz.startsWith('Bearer ') ? authz.slice(7).trim() : '';
    const result: ApiKeyAuth = token ? keys.authenticate(token) : { ok: false, reason: 'malformed' };
    if (!result.ok) {
      // Only failed attempts count towards an IP's block, so a valid key is never locked out by others.
      const badKey = `pubbad:ip:${req.clientIp}`;
      limiter.record(badKey, BAD_AUTH_WINDOW_MS);
      audit.security('api_key_rejected', { ip: req.clientIp, apiKeyId: result.key?.id ?? null, userAgent: req.headers['user-agent'] }, { reason: result.reason });
      if (limiter.usage(badKey, BAD_AUTH_WINDOW_MS) > api.badAuthPerWindow) {
        return reject(reply, 429, 'rate_limited', Math.ceil(limiter.retryAfter(badKey, api.badAuthPerWindow, BAD_AUTH_WINDOW_MS) / 1000));
      }
      const code = result.reason === 'revoked' ? 'api_key_revoked' : result.reason === 'expired' ? 'api_key_expired' : 'invalid_api_key';
      return reject(reply, 401, code);
    }
    const key = result.key;
    const global = limiter.consume('pub:all', api.globalPerMinute, 60_000);
    if (!global.ok) return reject(reply, 429, 'rate_limited', Math.ceil(global.retryAfterMs / 1000));
    if (!ipAllowed(buildAllowlist(key.ipAllowlist), req.clientIp)) {
      audit.security('api_key_rejected', { ip: req.clientIp, apiKeyId: key.id }, { reason: 'ip_not_allowed' });
      return reject(reply, 403, 'ip_not_allowed');
    }
    const perKey = limiter.consume(`apikey:req:${key.id}`, key.limits.perMinute, 60_000);
    if (!perKey.ok) {
      audit.security('rate_limited', { ip: req.clientIp, apiKeyId: key.id }, { scope: 'api_key' });
      return reject(reply, 429, 'rate_limited', Math.ceil(perKey.retryAfterMs / 1000));
    }
    keys.touch(key, req.clientIp);
    req.apiKey = key;
  });

  app.addHook('preHandler', async (req) => {
    const scope = req.routeOptions.config?.scope;
    if (scope === 'public') return;
    if (!req.apiKey) throw new ApiError(401, 'invalid_api_key');
    if (scope && scope !== 'key' && !req.apiKey.scopes.has(scope)) throw new ApiError(403, 'scope_missing', scope);
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('Content-Security-Policy')) reply.header('Content-Security-Policy', API_CSP);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    if (api.secure) reply.header('Strict-Transport-Security', 'max-age=31536000');
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    const len = reply.getHeader('content-length');
    audit.api({
      deviceId: null,
      apiKeyId: req.apiKey?.id ?? null,
      method: req.method,
      route: req.routeOptions.url ?? req.url.split('?')[0]!,
      status: reply.statusCode,
      durationMs: reply.elapsedTime,
      bytesIn: Number(req.headers['content-length'] ?? 0) || null,
      bytesOut: len === undefined ? null : Number(len),
      ip: req.clientIp,
    });
  });

  app.setErrorHandler(handleError);
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'not_found' } }));

  // ---- helpers ----

  const key = (req: FastifyRequest) => req.apiKey!;
  const caps = (k: ApiKey): KeyCaps => ({ maxSandbox: k.maxSandbox, allowNetwork: k.allowNetwork, approvals: k.approvals });
  const keyCtx = (k: ApiKey): KeyContext => ({ id: k.id, approvals: k.approvals, quotaRemaining: keys.remaining(k) });
  const evCtx = (req: FastifyRequest) => ({ deviceId: null, apiKeyId: req.apiKey?.id ?? null, ip: req.clientIp, userAgent: req.headers['user-agent'] ?? null });
  const need = (req: FastifyRequest, scope: ApiKeyScope) => {
    if (!key(req).scopes.has(scope)) throw new ApiError(403, 'scope_missing', scope);
  };

  /** The key's folder as its own workspace; refuses if it was swapped for a link elsewhere. */
  async function keyWorkspace(k: ApiKey): Promise<Workspace> {
    const ws = new Workspace(path.join(workspace.realRoot, k.folder));
    await ws.init();
    if (!workspace.contains(ws.realRoot) || ws.realRoot === workspace.realRoot) throw new ApiError(403, 'path_outside_workspace');
    return ws;
  }

  /** Sessions are visible only to the key that created them. */
  function ownSession(req: FastifyRequest, id: string): SessionRow {
    const s = sessions.get(id);
    if (!s || s.api_key_id !== key(req).id) throw new ApiError(404, 'session_not_found');
    return s;
  }

  function relToKey(k: ApiKey, mainRel: string): string | null {
    if (mainRel === k.folder) return '';
    return mainRel.startsWith(`${k.folder}/`) ? mainRel.slice(k.folder.length + 1) : null;
  }

  function mediaForKey(k: ApiKey, refs: MediaRef[]): MediaRef[] {
    const out: MediaRef[] = [];
    for (const m of refs) {
      if (m.source === 'store') out.push(m);
      else {
        const rel = relToKey(k, m.path);
        if (rel !== null) out.push({ ...m, path: rel });
      }
    }
    return out;
  }

  function turnResult(req: FastifyRequest, s: SessionRow, requestId: string): TurnResult {
    const k = key(req);
    const row = db.get<Record<string, any>>('SELECT * FROM requests WHERE id = ? AND session_id = ? AND api_key_id = ?', requestId, s.id, k.id);
    if (!row) throw new ApiError(404, 'turn_not_found');
    const entries = sessions.entriesForRequest(s.id, requestId);
    let text: string | null = null;
    const commands: TurnResult['commands'] = [];
    const files: TurnResult['files'] = [];
    let mediaRefs: MediaRef[] = [];
    let diff: string | null = null;
    for (const e of entries) {
      const item = e.data?.item;
      if (e.kind === 'agentMessage' && typeof item?.text === 'string') text = item.text;
      else if (e.kind === 'commandExecution') commands.push({ command: String(item?.command ?? ''), exitCode: item?.exitCode ?? null, status: String(item?.status ?? '') });
      else if (e.kind === 'fileChange') {
        for (const c of item?.changes ?? []) {
          const rel = workspace.relOf(String(c.path));
          files.push({ path: (rel !== null ? relToKey(k, rel) : null) ?? path.basename(String(c.path)), kind: String(c.kind?.type ?? 'update') });
        }
      } else if (e.kind === 'media') mediaRefs = mediaRefs.concat(e.data.files ?? []);
      else if (e.kind === 'turnEnd') diff = e.data?.diff ?? null;
      if (Array.isArray(e.data?.media)) mediaRefs = mediaRefs.concat(e.data.media);
    }
    const running = row.status === 'running';
    return {
      requestId,
      sessionId: s.id,
      turnId: row.turn_id,
      status: row.status,
      error: row.error,
      text,
      durationMs: row.duration_ms,
      usage:
        row.input_tokens === null
          ? null
          : { inputTokens: row.input_tokens, cachedInputTokens: row.cached_input_tokens ?? 0, outputTokens: row.output_tokens ?? 0, reasoningTokens: row.reasoning_tokens ?? 0 },
      files,
      media: mediaForKey(k, mediaRefs),
      commands,
      diff,
      pendingApprovals: running ? turns.pendingApprovals(s.id) : [],
      pendingQuestions: running ? turns.pendingQuestions(s.id) : [],
    };
  }

  async function newKeySession(req: FastifyRequest, title: string) {
    const k = key(req);
    const kws = await keyWorkspace(k);
    const abs = await makeSessionFolder(kws, defaultFolderName(title));
    return sessions.create({ title, titleAuto: !title, cwd: abs, deviceId: null, apiKeyId: k.id });
  }

  // ---- routes ----

  app.get('/v1/health', { config: { scope: 'public' } }, async () => ({ ok: true }));

  app.get('/v1/me', { config: { scope: 'key' } }, async (req) => {
    const k = key(req);
    const remaining = keys.remaining(k);
    return {
      id: k.id,
      label: k.label,
      scopes: [...k.scopes],
      folder: k.folder,
      maxSandbox: k.maxSandbox,
      allowNetwork: k.allowNetwork,
      approvals: k.approvals,
      limits: k.limits,
      expiresAt: k.expiresAt,
      quota: { tokens: k.quotaTokens, period: k.quotaPeriod, used: keys.usedTokens(k.id, k.quotaPeriod), remaining },
    };
  });

  app.get('/v1/usage', { config: { scope: 'key' } }, async (req) => {
    const k = key(req);
    const { tz } = z.object({ tz: z.coerce.number().int().min(-840).max(840).default(0) }).parse(req.query);
    const u = queries.keyUsage(k, keys, tz);
    return { quota: { ...u.key.quota, remaining: keys.remaining(k) }, daily: u.daily };
  });

  app.get('/v1/models', { config: { scope: 'prompt' } }, async () => ({ models: await ops.models() }));

  app.get('/v1/sessions', { config: { scope: 'prompt' } }, async (req) => {
    const q = z.object({ archived: z.enum(['0', '1']).optional() }).parse(req.query);
    const rows = sessions.list({ archived: q.archived === '1', apiKeyId: key(req).id });
    return { sessions: rows.map((r) => ops.info(r)) };
  });

  app.post('/v1/sessions', { config: { scope: 'prompt' } }, async (req) => {
    const { title } = z.object({ title: z.string().max(200).optional() }).strict().parse(req.body ?? {});
    const row = await newKeySession(req, title?.trim() ?? '');
    return { session: ops.info(row) };
  });

  app.get('/v1/sessions/:id', { config: { scope: 'prompt' } }, async (req) => {
    const s = ownSession(req, idParam.parse(req.params).id);
    return { session: ops.info(s), effective: ops.effective(s, caps(key(req))), turn: turns.snapshot(s.id) };
  });

  app.delete('/v1/sessions/:id', { config: { scope: 'sessions' } }, async (req) => {
    const s = ownSession(req, idParam.parse(req.params).id);
    if (turns.isRunning(s.id)) throw new ApiError(409, 'turn_in_progress');
    sessions.delete(s.id);
    await media.removeSession(s.id);
    return { ok: true };
  });

  app.get('/v1/sessions/:id/history', { config: { scope: 'prompt' } }, async (req) => {
    const s = ownSession(req, idParam.parse(req.params).id);
    const q = z
      .object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(2000).optional() })
      .parse(req.query);
    return sessions.history(s.id, { beforeId: q.before, limit: q.limit });
  });

  app.patch('/v1/sessions/:id/settings', { config: { scope: 'settings' } }, async (req) => {
    const s = ownSession(req, idParam.parse(req.params).id);
    const k = key(req);
    const body = settingsBody.parse(req.body);
    // Keys work only in their own folder: no extra writable folders.
    if (body.writableRoots?.length) throw new ApiError(403, 'setting_not_allowed', 'extra writable folders are not available to API keys');
    const row = ops.updateSettings(s, body, caps(k));
    return { session: ops.info(row), effective: ops.effective(row, caps(k)) };
  });

  app.post('/v1/sessions/:id/turns', { config: { scope: 'prompt' } }, async (req, reply) => {
    const s = ownSession(req, idParam.parse(req.params).id);
    const k = key(req);
    const body = z
      .object({
        text: z.string().max(config.limits.maxPromptChars * 4),
        files: z.array(z.string().max(4096)).max(20).default([]),
        mentions: z.array(z.string().max(4096)).max(20).default([]),
        skills: z.array(z.string().max(200)).max(10).default([]),
        imageUrls: z.array(z.string().max(4096)).max(10).default([]),
        ...turnSettingsBody,
        /** JSON Schema for the final answer, like `codex exec --output-schema`. */
        outputSchema: z.record(z.string(), z.unknown()).optional(),
        wait: z.boolean().default(false),
        timeoutSec: z.number().int().min(1).max(api.maxWaitSec).optional(),
      })
      .strict()
      .parse(req.body);
    if (!body.text.trim() && body.files.length + body.mentions.length + body.skills.length + body.imageUrls.length === 0) throw new ApiError(400, 'prompt_empty');
    if ([...body.text].length > config.limits.maxPromptChars) throw new ApiError(413, 'prompt_too_long');
    const limited = limiter.consume(`apikey:prompt:${k.id}`, k.limits.promptsPerMinute, 60_000);
    if (!limited.ok) {
      requests.start({
        sessionId: s.id,
        sessionTitle: s.title,
        deviceId: null,
        apiKeyId: k.id,
        threadId: s.thread_id,
        prompt: body.text,
        attachmentCount: 0,
        attachmentBytes: 0,
        model: s.model,
        effort: s.effort,
        ip: req.clientIp,
        status: 'rate_limited',
      });
      throw new ApiError(429, 'rate_limited', undefined, Math.ceil(limited.retryAfterMs / 1000));
    }
    if (turns.runningForKey(k.id) >= k.limits.concurrent) throw new ApiError(429, 'too_many_turns');
    // Codex downloads image links itself, outside the sandbox: that is network access.
    if (body.imageUrls.length > 0 && !k.allowNetwork) throw new ApiError(403, 'setting_not_allowed', 'image links need network access, which this key does not allow');
    const kws = await keyWorkspace(k);
    const { attachments, extra } = await buildPromptInput(kws, { attachments: body.files, mentions: body.mentions, imageUrls: body.imageUrls });
    extra.push(...(await ops.skillInputs(s.cwd, body.skills)));
    await ops.warm();
    let session = s;
    const { model, effort, summary, serviceTier, mode } = body;
    if ([model, effort, summary, serviceTier, mode].some((v) => v !== undefined)) {
      need(req, 'settings');
      session = ops.updateSettings(s, { model, effort, summary, serviceTier, mode }, caps(k));
    }
    const started = await turns.startTurn({
      session,
      ctx: evCtx(req),
      text: body.text,
      attachments,
      extraInput: extra,
      settings: ops.effective(session, caps(k)),
      apiKey: keyCtx(k),
      outputSchema: body.outputSchema,
    });
    if (!body.wait) return reply.status(202).send({ ...started, status: 'running' });
    const done = await turns.waitForRequest(started.requestId, (body.timeoutSec ?? Math.min(120, api.maxWaitSec)) * 1000);
    return reply.status(done ? 200 : 202).send(turnResult(req, sessions.get(s.id)!, started.requestId));
  });

  app.get('/v1/sessions/:id/turns/:requestId', { config: { scope: 'prompt' } }, async (req) => {
    const { id, requestId } = z.object({ id: idParam.shape.id, requestId: z.string().regex(/^req_[A-Za-z0-9_-]{1,40}$/) }).parse(req.params);
    const s = ownSession(req, id);
    const { wait } = z.object({ wait: z.coerce.number().int().min(0).max(api.maxWaitSec).optional() }).parse(req.query);
    if (wait) await turns.waitForRequest(requestId, wait * 1000);
    return turnResult(req, s, requestId);
  });

  app.post('/v1/sessions/:id/steer', { config: { scope: 'prompt' } }, async (req) => {
    const s = ownSession(req, idParam.parse(req.params).id);
    const { text } = z.object({ text: z.string().min(1).max(config.limits.maxPromptChars) }).strict().parse(req.body);
    return turns.steer(s.id, text, evCtx(req));
  });

  // Prompts sent while Codex is busy run in order afterwards.
  app.get('/v1/sessions/:id/queue', { config: { scope: 'prompt' } }, async (req) => queue.list(ownSession(req, idParam.parse(req.params).id).id));
  app.post('/v1/sessions/:id/queue', { config: { scope: 'prompt' } }, async (req) => {
    const s = ownSession(req, idParam.parse(req.params).id);
    const k = key(req);
    const body = z
      .object({
        text: z.string().max(config.limits.maxPromptChars * 4),
        files: z.array(z.string().max(4096)).max(20).default([]),
        mentions: z.array(z.string().max(4096)).max(20).default([]),
        skills: z.array(z.string().max(200)).max(10).default([]),
        imageUrls: z.array(z.string().max(4096)).max(10).default([]),
      })
      .strict()
      .parse(req.body);
    if (!body.text.trim() && body.files.length + body.mentions.length + body.skills.length + body.imageUrls.length === 0) throw new ApiError(400, 'prompt_empty');
    if ([...body.text].length > config.limits.maxPromptChars) throw new ApiError(413, 'prompt_too_long');
    if (body.imageUrls.length > 0 && !k.allowNetwork) throw new ApiError(403, 'setting_not_allowed', 'image links need network access, which this key does not allow');
    const { attachments, extra } = await buildPromptInput(await keyWorkspace(k), { attachments: body.files, mentions: body.mentions, imageUrls: body.imageUrls });
    extra.push(...(await ops.skillInputs(s.cwd, body.skills)));
    return { queued: queue.add(s.id, { text: body.text, attachments, extraInput: extra, keyId: k.id, ctx: evCtx(req) }) };
  });
  app.delete('/v1/sessions/:id/queue/:itemId', { config: { scope: 'prompt' } }, async (req) => {
    const { id, itemId } = z.object({ id: idParam.shape.id, itemId: z.string().max(100) }).parse(req.params);
    queue.remove(ownSession(req, id).id, itemId);
    return { ok: true };
  });
  app.post('/v1/sessions/:id/queue/resume', { config: { scope: 'prompt' } }, async (req) => {
    queue.resume(ownSession(req, idParam.parse(req.params).id).id);
    return { ok: true };
  });

  app.get('/v1/sessions/:id/terminals', { config: { scope: 'prompt' } }, async (req) => ({ terminals: await ops.terminals(ownSession(req, idParam.parse(req.params).id)) }));
  app.post('/v1/sessions/:id/terminals/stop', { config: { scope: 'sessions' } }, async (req) => {
    const s = ownSession(req, idParam.parse(req.params).id);
    const { processId } = z.object({ processId: z.string().max(200).nullable() }).strict().parse(req.body);
    await ops.stopTerminal(s, processId);
    return { ok: true };
  });
  app.post('/v1/sessions/:id/folder', { config: { scope: 'sessions' } }, async (req) => {
    const s = ownSession(req, idParam.parse(req.params).id);
    const { path: rel } = z.object({ path: z.string().max(4096) }).strict().parse(req.body);
    return { session: ops.info(await ops.changeFolder(s, rel, await keyWorkspace(key(req)))) };
  });

  app.post('/v1/sessions/:id/interrupt', { config: { scope: 'prompt' } }, async (req) => {
    const s = ownSession(req, idParam.parse(req.params).id);
    await turns.interrupt(s.id);
    return { ok: true };
  });

  app.post('/v1/sessions/:id/fork', { config: { scope: 'sessions' } }, async (req) => {
    const s = ownSession(req, idParam.parse(req.params).id);
    const { turnId } = z.object({ turnId: z.string().max(100).nullable().optional() }).strict().parse(req.body ?? {});
    return { session: ops.info(await ops.fork(s, turnId ?? null, evCtx(req), caps(key(req)))) };
  });

  app.post('/v1/sessions/:id/undo', { config: { scope: 'sessions' } }, async (req) => {
    const s = ownSession(req, idParam.parse(req.params).id);
    const { turnId } = z.object({ turnId: z.string().max(100).nullable().optional() }).strict().parse(req.body ?? {});
    return ops.undo(s, turnId ?? null, caps(key(req)));
  });

  app.post('/v1/sessions/:id/compact', { config: { scope: 'sessions' } }, async (req) => {
    const s = ownSession(req, idParam.parse(req.params).id);
    const k = key(req);
    return ops.compact(s, evCtx(req), caps(k), keyCtx(k));
  });

  app.post('/v1/sessions/:id/review', { config: { scope: 'sessions' } }, async (req) => {
    const s = ownSession(req, idParam.parse(req.params).id);
    const k = key(req);
    return ops.review(s, reviewBody.parse(req.body).target, evCtx(req), caps(k), keyCtx(k));
  });

  app.post('/v1/sessions/:id/shell', { config: { scope: 'shell' } }, async (req) => {
    const s = ownSession(req, idParam.parse(req.params).id);
    const k = key(req);
    const { command } = z.object({ command: z.string().min(1).max(8000) }).strict().parse(req.body);
    return ops.shell(s, command, evCtx(req), caps(k), keyCtx(k));
  });

  app.post('/v1/sessions/:id/command', { config: { scope: 'prompt' } }, async (req) => {
    const s = ownSession(req, idParam.parse(req.params).id);
    const k = key(req);
    const { command } = z.object({ command: z.string().min(1).max(config.limits.maxPromptChars) }).strict().parse(req.body);
    return runCommand(
      {
        ops,
        turns,
        mcp,
        session: s,
        ctx: evCtx(req),
        key: { caps: caps(k), context: keyCtx(k), hasScope: (sc) => k.scopes.has(sc) },
        newSession: async (title) => ops.info(await newKeySession(req, title)),
        folderRoot: await keyWorkspace(k),
        rename: (title) => ops.rename(s, title),
        archive: (archived) => ops.archive(s, archived),
      },
      command,
    );
  });

  app.get('/v1/sessions/:id/diff', { config: { scope: 'prompt' } }, async (req) => ops.diff(ownSession(req, idParam.parse(req.params).id)));
  app.get('/v1/sessions/:id/status', { config: { scope: 'prompt' } }, async (req) => ops.status(ownSession(req, idParam.parse(req.params).id), caps(key(req))));
  app.get('/v1/sessions/:id/skills', { config: { scope: 'prompt' } }, async (req) => ({ skills: await ops.skills(ownSession(req, idParam.parse(req.params).id).cwd) }));

  app.get('/v1/sessions/:id/goal', { config: { scope: 'sessions' } }, async (req) => ({ goal: await ops.goal(ownSession(req, idParam.parse(req.params).id)) }));
  app.post('/v1/sessions/:id/goal', { config: { scope: 'sessions' } }, async (req) => {
    const s = ownSession(req, idParam.parse(req.params).id);
    const body = z.object({ objective: z.string().min(1).max(4000), tokenBudget: z.number().int().positive().nullable().optional() }).strict().parse(req.body);
    return { goal: await ops.setGoal(s, body.objective, body.tokenBudget ?? null, caps(key(req))) };
  });
  app.delete('/v1/sessions/:id/goal', { config: { scope: 'sessions' } }, async (req) => {
    await ops.clearGoal(ownSession(req, idParam.parse(req.params).id));
    return { goal: null };
  });

  // Approvals and questions for this key's sessions (keys set to "ask").
  const ownedSessionIds = (req: FastifyRequest) => new Set(sessions.list({ archived: false, apiKeyId: key(req).id, limit: 500 }).map((s) => s.id));
  app.get('/v1/approvals', { config: { scope: 'approvals' } }, async (req) => {
    const own = ownedSessionIds(req);
    return { approvals: turns.pendingApprovals().filter((a) => own.has(a.sessionId)), questions: turns.pendingQuestions().filter((q) => own.has(q.sessionId)) };
  });
  app.post('/v1/approvals/:approvalId', { config: { scope: 'approvals' } }, async (req) => {
    const { approvalId } = z.object({ approvalId: z.string().max(100) }).parse(req.params);
    const sid = turns.approvalSession(approvalId);
    if (!sid) throw new ApiError(404, 'approval_not_found');
    ownSession(req, sid);
    const { decision, ruleIndex } = decisionBody.parse(req.body);
    // Allowing an approval can lift Codex past the sandbox (escalated commands, extra write roots,
    // network or file permissions). A key may only do that if its own caps already allow everything.
    const k = key(req);
    if (!SAFE_APPROVAL_DECISIONS.includes(decision) && !(k.maxSandbox === 'danger-full-access' && k.allowNetwork)) {
      throw new ApiError(403, 'setting_not_allowed', 'this key can only decline: allow it in the console, or give the key full access and network');
    }
    turns.decide(approvalId, decision, evCtx(req), ruleIndex);
    return { ok: true };
  });
  app.post('/v1/questions/:questionId', { config: { scope: 'approvals' } }, async (req) => {
    const { questionId } = z.object({ questionId: z.string().max(100) }).parse(req.params);
    const sid = turns.questionSession(questionId);
    if (!sid) throw new ApiError(404, 'question_not_found');
    ownSession(req, sid);
    turns.answer(questionId, answerBody.parse(req.body), evCtx(req));
    return { ok: true };
  });

  // Live events for one of the key's sessions (same format as the console).
  app.get('/v1/sessions/:id/events', { config: { scope: 'prompt' } }, async (req, reply) => {
    const s = ownSession(req, idParam.parse(req.params).id);
    const keyId = key(req).id;
    const startedAt = Date.now();
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
    const send = (ev: ServerEvent) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    res.write('retry: 3000\n\n');
    send({ type: 'snapshot', turn: turns.snapshot(s.id) });
    const queued = queue.list(s.id);
    if (queued.queue.length) send({ type: 'queue_updated', ...queued });
    const listener = (sid: string, ev: ServerEvent) => {
      if (sid === s.id) send(ev);
    };
    turns.on('event', listener);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    const recheck = setInterval(() => {
      const k = keys.get(keyId);
      if (!k || keys.status(k) !== 'active') close();
    }, 30_000);
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      clearInterval(recheck);
      turns.off('event', listener);
      res.end();
      audit.api({ deviceId: null, apiKeyId: keyId, method: 'GET', route: '/v1/sessions/:id/events', status: 200, durationMs: Date.now() - startedAt, bytesIn: null, bytesOut: null, ip: req.clientIp });
    }
    req.raw.on('close', close);
  });

  // ---- files, relative to the key's folder ----

  const pathQuery = z.object({ path: z.string().max(4096).default('') });

  app.get('/v1/files', { config: { scope: 'files:read' } }, async (req) => (await keyWorkspace(key(req))).list(pathQuery.parse(req.query).path));

  app.get('/v1/files/search', { config: { scope: 'files:read' } }, async (req) => {
    const { q } = z.object({ q: z.string().min(1).max(200) }).parse(req.query);
    return { files: await ops.searchFiles((await keyWorkspace(key(req))).realRoot, q) };
  });

  app.get('/v1/files/content', { config: { scope: 'files:read' } }, async (req, reply) => {
    const k = key(req);
    const f = await (await keyWorkspace(k)).openForRead(pathQuery.parse(req.query).path);
    const range = parseRange(req.headers.range, f.size);
    if (range === 'invalid') {
      await f.handle.close();
      return reply.status(416).header('Content-Range', `bytes */${f.size}`).send({ error: { code: 'bad_request' } });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? f.size - 1;
    const length = f.size === 0 ? 0 : end - start + 1;
    reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Disposition', contentDisposition('attachment', f.name))
      .header('Content-Security-Policy', FILE_CSP)
      .header('Accept-Ranges', 'bytes')
      .header('Content-Length', String(length));
    if (range) reply.status(206).header('Content-Range', `bytes ${start}-${end}/${f.size}`);
    audit.transfer({ deviceId: null, apiKeyId: k.id, sessionId: null, direction: 'download', path: `${k.folder}/${f.rel}`, bytes: length, ok: true });
    if (f.size === 0) {
      await f.handle.close();
      return reply.send('');
    }
    return reply.send(f.handle.createReadStream({ start, end, autoClose: true }));
  });

  // Raw uploads (curl -T / --data-binary), whatever the content type.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    scope.put('/v1/files/content', { config: { scope: 'files:write' } }, async (req) => {
      const k = key(req);
      const q = z.object({ path: z.string().min(1).max(4096), overwrite: z.enum(['0', '1']).optional() }).parse(req.query);
      const quotaKey = `apikey:upload:${k.id}`;
      const quota = k.limits.uploadMbPerHour * 1024 * 1024;
      if (limiter.usage(quotaKey, HOUR_MS) >= quota) throw new ApiError(429, 'upload_quota_exceeded');
      const kws = await keyWorkspace(k);
      const segs = Workspace.segments(q.path);
      if (segs.length === 0) throw new ApiError(400, 'path_invalid');
      const name = segs.pop()!;
      const max = Math.min(config.limits.maxUploadBytes, Math.max(1, quota - limiter.usage(quotaKey, HOUR_MS)));
      const body = req.body as NodeJS.ReadableStream | undefined;
      if (!body || typeof (body as { pipe?: unknown }).pipe !== 'function') throw new ApiError(400, 'bad_request', 'request body required');
      try {
        const saved = await kws.upload(segs.join('/'), name, body as never, max, q.overwrite === '1');
        limiter.record(quotaKey, HOUR_MS, saved.size);
        audit.transfer({ deviceId: null, apiKeyId: k.id, sessionId: null, direction: 'upload', path: `${k.folder}/${saved.path}`, bytes: saved.size, ok: true });
        return { file: saved };
      } catch (err) {
        audit.transfer({ deviceId: null, apiKeyId: k.id, sessionId: null, direction: 'upload', path: `${k.folder}/${q.path}`, bytes: 0, ok: false });
        throw err;
      }
    });
  });

  app.post('/v1/files/mkdir', { config: { scope: 'files:write' } }, async (req) => {
    const { path: p } = z.object({ path: z.string().min(1).max(4096) }).strict().parse(req.body);
    return { path: await (await keyWorkspace(key(req))).mkdir(p) };
  });

  app.delete('/v1/files', { config: { scope: 'files:write' } }, async (req) => {
    const { path: p } = z.object({ path: z.string().min(1).max(4096) }).parse(req.query);
    await (await keyWorkspace(key(req))).remove(p);
    return { ok: true };
  });

  app.get('/v1/media/:sessionId/:name', { config: { scope: 'prompt' } }, async (req, reply) => {
    const { sessionId, name } = z.object({ sessionId: idParam.shape.id, name: z.string().max(120) }).parse(req.params);
    ownSession(req, sessionId);
    const f = await media.open(sessionId, name);
    return reply
      .header('Content-Type', f.mime)
      .header('Content-Length', String(f.size))
      .header('Content-Security-Policy', FILE_CSP)
      .header('Content-Disposition', contentDisposition('attachment', name))
      .send(f.handle.createReadStream({ autoClose: true }));
  });

  // ---- MCP ----

  const mcpOps = mcpActions(mcp, audit);
  app.get('/v1/mcp', { config: { scope: 'mcp:read' } }, async () => ({ servers: await mcpOps.list() }));
  app.post('/v1/mcp', { config: { scope: 'mcp:manage' } }, async (req) => {
    const { name, ...input } = mcpInputSchema.extend({ name: mcpNameParam.shape.name }).parse(req.body);
    await mcpOps.add(name, input, evCtx(req));
    return { servers: await mcpOps.list() };
  });
  app.put('/v1/mcp/:name', { config: { scope: 'mcp:manage' } }, async (req) => {
    const { name } = mcpNameParam.parse(req.params);
    await mcpOps.update(name, mcpInputSchema.parse(req.body), evCtx(req));
    return { servers: await mcpOps.list() };
  });
  app.post('/v1/mcp/:name/enabled', { config: { scope: 'mcp:manage' } }, async (req) => {
    const { name } = mcpNameParam.parse(req.params);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    await mcpOps.setEnabled(name, enabled, evCtx(req));
    return { servers: await mcpOps.list() };
  });
  app.delete('/v1/mcp/:name', { config: { scope: 'mcp:manage' } }, async (req) => {
    await mcpOps.remove(mcpNameParam.parse(req.params).name, evCtx(req));
    return { servers: await mcpOps.list() };
  });
  app.post('/v1/mcp/:name/login', { config: { scope: 'mcp:manage' } }, async (req) => mcpOps.login(mcpNameParam.parse(req.params).name, evCtx(req)));
  app.post('/v1/mcp/:name/logout', { config: { scope: 'mcp:manage' } }, async (req) => {
    await mcpOps.logout(mcpNameParam.parse(req.params).name);
    return { servers: await mcpOps.list() };
  });


  return {
    app,
    async listen(): Promise<void> {
      if (api.proxyProtocol === 'off') {
        await app.listen({ host: api.host, port: api.port });
        return;
      }
      await app.ready();
      front = proxyProtocolFront(app.server, api.proxyProtocol);
      front.on('connection', (s) => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
      });
      await new Promise<void>((resolve, reject) => {
        front!.once('error', reject);
        front!.listen(api.port, api.host, () => resolve());
      });
    },
    address(): { port: number } | null {
      const a = (front ?? app.server).address();
      return a && typeof a === 'object' ? { port: a.port } : null;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => (front ? front.close(() => resolve()) : resolve()));
      for (const s of sockets) s.destroy();
      await app.close();
    },
  };
}
