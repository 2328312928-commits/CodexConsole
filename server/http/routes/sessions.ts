import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  APPROVAL_DECISIONS,
  REASONING_SUMMARIES,
  WEB_SEARCH_MODES,
  type ApprovalDecision,
  type CodexStatusInfo,
  type CodexThreadSummary,
  type ServerEvent,
} from '../../../shared/api.js';
import { TESTED_CODEX_VERSION, type UserInput } from '../../../shared/codex.js';
import type { LoginSessionRow } from '../../auth/loginSessions.js';
import type { SessionRow } from '../../services/sessions.js';
import { runCommand } from '../../codex/commands.js';
import { TurnManager, type Attachment } from '../../codex/turns.js';
import { ApiError } from '../../lib/errors.js';
import type { Workspace } from '../../services/workspace.js';
import { eventCtx, type AppDeps } from '../context.js';
import { CSP } from '../headers.js';

const idParam = z.object({ id: z.string().min(1).max(100) });
const SSE_PING_MS = 15_000;
const SSE_AUTH_RECHECK_MS = 30_000;

export const settingsBody = z
  .object({
    model: z.string().max(100).nullable().optional(),
    effort: z.string().max(40).nullable().optional(),
    summary: z.enum(REASONING_SUMMARIES).nullable().optional(),
    serviceTier: z.string().max(40).nullable().optional(),
    mode: z.enum(['default', 'plan']).nullable().optional(),
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).nullable().optional(),
    approvalPolicy: z.enum(['untrusted', 'on-request', 'never']).nullable().optional(),
    approvalsReviewer: z.enum(['user', 'auto_review']).nullable().optional(),
    networkAccess: z.boolean().nullable().optional(),
    webSearch: z.enum(WEB_SEARCH_MODES).nullable().optional(),
    writableRoots: z.array(z.string().max(4096)).max(20).nullable().optional(),
    memory: z.boolean().nullable().optional(),
  })
  .strict();

/** Per-turn choices a prompt can carry; they are kept as the session's settings. */
export const turnSettingsBody = {
  model: z.string().max(100).nullable().optional(),
  effort: z.string().max(40).nullable().optional(),
  summary: z.enum(REASONING_SUMMARIES).nullable().optional(),
  serviceTier: z.string().max(40).nullable().optional(),
  mode: z.enum(['default', 'plan']).nullable().optional(),
};

export const decisionBody = z
  .object({ decision: z.enum(APPROVAL_DECISIONS as [ApprovalDecision, ...ApprovalDecision[]]), ruleIndex: z.number().int().min(0).max(20).optional() })
  .strict();

export const feedbackBody = z
  .object({ classification: z.enum(['bug', 'bad_result', 'good_result', 'other']), reason: z.string().max(4000).nullable().optional(), includeLogs: z.boolean().default(false) })
  .strict();

export const reviewBody = z
  .object({
    target: z.discriminatedUnion('type', [
      z.object({ type: z.literal('uncommittedChanges') }),
      z.object({ type: z.literal('baseBranch'), branch: z.string().min(1).max(200) }),
      z.object({ type: z.literal('commit'), sha: z.string().regex(/^[0-9a-fA-F]{4,64}$/), title: z.string().max(200).nullable().optional() }),
      z.object({ type: z.literal('custom'), instructions: z.string().min(1).max(4000) }),
    ]),
  })
  .strict();

export const answerBody = z.union([
  z.object({ kind: z.literal('input'), answers: z.record(z.string().max(200), z.array(z.string().max(4000)).max(20)) }).strict(),
  z
    .object({ kind: z.literal('elicitation'), action: z.enum(['accept', 'decline', 'cancel']), content: z.record(z.string().max(200), z.unknown()).optional() })
    .strict(),
]);

export function codexStatus(deps: AppDeps, includeEmail = false): CodexStatusInfo {
  const s = deps.bridge.status;
  const acct = s.account as { type: string; planType?: string; email?: string | null } | null;
  const defaults = deps.settings.get();
  return {
    state: s.state,
    version: s.version,
    testedVersion: TESTED_CODEX_VERSION,
    versionMismatch: s.version !== null && s.version !== TESTED_CODEX_VERSION,
    signedIn: s.state === 'ready' && deps.bridge.signedIn,
    account: acct ? { type: acct.type, planType: acct.planType ?? null, ...(includeEmail ? { email: acct.email ?? null } : {}) } : null,
    rateLimits: s.rateLimits,
    rateLimitsByLimitId: s.rateLimitsByLimitId,
    rateLimitsAt: s.rateLimitsAt,
    lastError: s.lastError,
    restarts: s.restarts,
    sandbox: defaults.defaultSandbox,
    approvalPolicy: defaults.defaultApprovalPolicy,
    networkAccess: defaults.defaultNetworkAccess,
  };
}

/** A readable, unique folder name for a new session. */
export function defaultFolderName(title: string | undefined, now = new Date()): string {
  const slug = (title ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${slug || 'session'}-${date}-${suffix}`;
}

/** Create a session folder (inside `ws`) and return its absolute path. */
export async function makeSessionFolder(ws: Workspace, rel: string): Promise<string> {
  const r = await ws.resolve(rel);
  if (r.rel === '') throw new ApiError(400, 'path_invalid');
  if (r.exists) {
    if (!(await fsp.stat(r.abs)).isDirectory()) throw new ApiError(400, 'not_a_directory');
  } else {
    await fsp.mkdir(r.abs, { recursive: true });
  }
  return r.abs;
}

/** Resolve prompt attachments, @-mentions and image links against a workspace. */
export async function buildPromptInput(
  ws: Workspace,
  body: { attachments?: string[]; mentions?: string[]; imageUrls?: string[] },
): Promise<{ attachments: Attachment[]; extra: UserInput[] }> {
  const attachments: Attachment[] = [];
  for (const rel of body.attachments ?? []) {
    const f = await ws.openForRead(rel);
    await f.handle.close();
    attachments.push({ abs: path.join(ws.realRoot, ...f.rel.split('/')), rel: f.rel, size: f.size, isImage: TurnManager.isImagePath(f.rel) });
  }
  const extra: UserInput[] = [];
  for (const rel of body.mentions ?? []) {
    const r = await ws.resolve(rel);
    if (!r.exists) throw new ApiError(404, 'file_not_found', rel);
    extra.push({ type: 'mention', name: path.basename(r.abs) || r.rel, path: r.abs });
  }
  for (const url of body.imageUrls ?? []) {
    if (!/^https:\/\//i.test(url)) throw new ApiError(400, 'bad_request', 'image links must be https://');
    extra.push({ type: 'image', url });
  }
  return { attachments, extra };
}

export function registerSessionRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { sessions, turns, bridge, workspace, config, limiter, requests, audit, media, devices, db, ops, mcp, queue } = deps;

  /** Sending a prompt to an archived session brings it (and its Codex thread) back. */
  const unarchive = async (s: SessionRow) => {
    sessions.setArchived(s.id, false);
    s.archived_at = null;
    if (s.thread_id) await bridge.request('thread/unarchive', { threadId: s.thread_id }).catch(() => undefined);
    turns.emitSessionUpdated(s.id);
  };

  const getSession = (id: string) => {
    const s = sessions.get(id);
    if (!s) throw new ApiError(404, 'session_not_found');
    return s;
  };

  const newConsoleSession = async (title: string, deviceId: string, folder?: string) => {
    const abs = await makeSessionFolder(workspace, folder?.trim() || defaultFolderName(title));
    return sessions.create({ title, titleAuto: !title, cwd: abs, deviceId });
  };

  app.get('/api/codex/status', async () => codexStatus(deps));
  app.get('/api/codex/models', async () => ({ models: await ops.models() }));

  app.get('/api/sessions', async (req) => {
    const q = z.object({ archived: z.enum(['0', '1']).optional(), q: z.string().max(200).optional() }).parse(req.query);
    const rows = sessions.list({ archived: q.archived === '1', q: q.q?.trim() || undefined });
    return { sessions: rows.map((r) => sessions.toInfo(r, turns.isRunning(r.id))), workspaceRoot: workspace.realRoot };
  });

  app.post('/api/sessions', async (req) => {
    const body = z
      .object({ title: z.string().max(200).optional(), folder: z.string().max(1000).optional() })
      .strict()
      .parse(req.body ?? {});
    const row = await newConsoleSession(body.title?.trim() ?? '', req.auth.device!.id, body.folder);
    return { session: sessions.toInfo(row, false) };
  });

  app.post('/api/sessions/import', async (req) => {
    const { threadId } = z.object({ threadId: z.string().min(1).max(100) }).strict().parse(req.body);
    if (sessions.getByThread(threadId)) throw new ApiError(409, 'thread_already_imported');
    const thread = await turns.readThread(threadId).catch(() => {
      throw new ApiError(404, 'thread_not_found');
    });
    const name = thread.name?.trim();
    const row = sessions.create({
      title: name || thread.preview.replace(/\s+/g, ' ').trim().slice(0, 80),
      titleAuto: !name,
      cwd: thread.cwd,
      deviceId: req.auth.device!.id,
      threadId,
      model: thread.model,
      imported: true,
    });
    await turns.syncHistory(row).catch((err) => req.log.warn({ err: err.message }, 'Thread history import failed'));
    return { session: sessions.toInfo(sessions.get(row.id)!, false) };
  });

  app.get('/api/codex/threads', async (req) => {
    const { cursor } = z.object({ cursor: z.string().max(500).optional() }).parse(req.query);
    const res = await turns.listImportable(cursor ?? null).catch((err) => {
      throw new ApiError(502, 'codex_error', (err as Error).message);
    });
    const known = new Set(sessions.allThreadIds());
    const threads: CodexThreadSummary[] = res.threads
      .filter((t) => !known.has(t.id))
      .map((t) => ({
        id: t.id,
        preview: (t.preview ?? '').slice(0, 300),
        name: t.name,
        cwd: t.cwd,
        createdAt: t.createdAt * 1000,
        updatedAt: t.updatedAt * 1000,
        insideWorkspace: workspace.relOf(t.cwd) !== null,
      }));
    return { threads, nextCursor: res.nextCursor };
  });

  app.get('/api/sessions/:id', async (req) => {
    const s = getSession(idParam.parse(req.params).id);
    return { session: ops.info(s), effective: ops.effective(s), turn: turns.snapshot(s.id) };
  });

  app.patch('/api/sessions/:id', async (req) => {
    const s = getSession(idParam.parse(req.params).id);
    const body = z
      .object({
        title: z.string().max(200).optional(),
        archived: z.boolean().optional(),
        model: z.string().max(100).nullable().optional(),
        effort: z.string().max(40).nullable().optional(),
      })
      .strict()
      .parse(req.body);
    if (body.title !== undefined) await ops.rename(s, body.title);
    if (body.archived !== undefined) await ops.archive(s, body.archived);
    if (body.model !== undefined || body.effort !== undefined) ops.updateSettings(s, { model: body.model, effort: body.effort });
    turns.emitSessionUpdated(s.id);
    return { session: ops.info(sessions.get(s.id)!) };
  });

  app.patch('/api/sessions/:id/settings', async (req) => {
    const s = getSession(idParam.parse(req.params).id);
    const body = settingsBody.parse(req.body);
    if (body.writableRoots !== undefined) body.writableRoots = await ops.checkWritableRoots(body.writableRoots);
    const row = ops.updateSettings(s, body);
    return { session: ops.info(row), effective: ops.effective(row) };
  });

  // ---- queue: prompts sent while Codex is busy ----

  app.get('/api/sessions/:id/queue', async (req) => queue.list(getSession(idParam.parse(req.params).id).id));

  app.post('/api/sessions/:id/queue', async (req) => {
    const s = getSession(idParam.parse(req.params).id);
    const body = z
      .object({
        text: z.string().max(config.limits.maxPromptChars * 4),
        attachments: z.array(z.string().max(4096)).max(20).default([]),
        mentions: z.array(z.string().max(4096)).max(20).default([]),
        skills: z.array(z.string().max(200)).max(10).default([]),
        imageUrls: z.array(z.string().max(4096)).max(10).default([]),
      })
      .strict()
      .parse(req.body);
    if (!body.text.trim() && body.attachments.length + body.mentions.length + body.skills.length + body.imageUrls.length === 0) throw new ApiError(400, 'prompt_empty');
    if ([...body.text].length > config.limits.maxPromptChars) throw new ApiError(413, 'prompt_too_long');
    const { attachments, extra } = await buildPromptInput(workspace, body);
    extra.push(...(await ops.skillInputs(s.cwd, body.skills)));
    return { queued: queue.add(s.id, { text: body.text, attachments, extraInput: extra, keyId: null, ctx: eventCtx(req) }) };
  });

  app.delete('/api/sessions/:id/queue/:itemId', async (req) => {
    const { id, itemId } = z.object({ id: idParam.shape.id, itemId: z.string().max(100) }).parse(req.params);
    queue.remove(getSession(id).id, itemId);
    return { ok: true };
  });

  app.post('/api/sessions/:id/queue/resume', async (req) => {
    queue.resume(getSession(idParam.parse(req.params).id).id);
    return { ok: true };
  });

  // ---- background terminals (`/ps`, `/stop`) ----

  app.get('/api/sessions/:id/terminals', async (req) => ({ terminals: await ops.terminals(getSession(idParam.parse(req.params).id)) }));

  app.post('/api/sessions/:id/terminals/stop', async (req) => {
    const s = getSession(idParam.parse(req.params).id);
    const { processId } = z.object({ processId: z.string().max(200).nullable() }).strict().parse(req.body);
    await ops.stopTerminal(s, processId);
    return { ok: true };
  });

  app.post('/api/sessions/:id/folder', async (req) => {
    const s = getSession(idParam.parse(req.params).id);
    const { path: rel } = z.object({ path: z.string().max(4096) }).strict().parse(req.body);
    return { session: ops.info(await ops.changeFolder(s, rel)) };
  });

  app.post('/api/sessions/:id/feedback', async (req) => {
    const s = getSession(idParam.parse(req.params).id);
    const body = feedbackBody.parse(req.body);
    await ops.feedback(s, { classification: body.classification, reason: body.reason ?? null, includeLogs: body.includeLogs }, eventCtx(req));
    return { ok: true };
  });

  app.post('/api/sessions/:id/reviews/:reviewId/approve', async (req) => {
    const { id, reviewId } = z.object({ id: idParam.shape.id, reviewId: z.string().max(200) }).parse(req.params);
    await turns.approveDenied(getSession(id).id, reviewId, eventCtx(req));
    return { ok: true };
  });

  app.get('/api/codex/prompts', async () => ({ prompts: await ops.savedPrompts() }));

  app.delete('/api/sessions/:id', async (req) => {
    const s = getSession(idParam.parse(req.params).id);
    const { archiveThread, deleteThread } = z.object({ archiveThread: z.enum(['0', '1']).optional(), deleteThread: z.enum(['0', '1']).optional() }).parse(req.query);
    if (turns.isRunning(s.id)) throw new ApiError(409, 'turn_in_progress');
    if (deleteThread === '1' && s.thread_id) await bridge.request('thread/delete', { threadId: s.thread_id }).catch(() => undefined);
    else if (archiveThread === '1' && s.thread_id) await turns.archiveThread(s.thread_id).catch(() => undefined);
    queue.clear(s.id);
    sessions.delete(s.id);
    await media.removeSession(s.id);
    return { ok: true };
  });

  app.get('/api/sessions/:id/history', async (req) => {
    const s = getSession(idParam.parse(req.params).id);
    const q = z
      .object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(2000).optional() })
      .parse(req.query);
    return sessions.history(s.id, { beforeId: q.before, limit: q.limit });
  });

  app.post('/api/sessions/:id/sync', async (req) => {
    const s = getSession(idParam.parse(req.params).id);
    if (turns.isRunning(s.id)) throw new ApiError(409, 'turn_in_progress');
    const imported = await turns.syncHistory(s).catch((err) => {
      throw new ApiError(502, 'codex_error', (err as Error).message);
    });
    return { imported };
  });

  app.post('/api/sessions/:id/turns', async (req) => {
    const s = getSession(idParam.parse(req.params).id);
    const body = z
      .object({
        text: z.string().max(config.limits.maxPromptChars * 4),
        attachments: z.array(z.string().max(4096)).max(20).default([]),
        mentions: z.array(z.string().max(4096)).max(20).default([]),
        skills: z.array(z.string().max(200)).max(10).default([]),
        imageUrls: z.array(z.string().max(4096)).max(10).default([]),
        ...turnSettingsBody,
      })
      .strict()
      .parse(req.body);
    const empty = !body.text.trim() && body.attachments.length + body.mentions.length + body.skills.length + body.imageUrls.length === 0;
    if (empty) throw new ApiError(400, 'prompt_empty');
    if ([...body.text].length > config.limits.maxPromptChars) throw new ApiError(413, 'prompt_too_long');

    const device = req.auth.device!;
    const limited = limiter.consume(`prompt:dev:${device.id}`, config.limits.promptsPerMinute, 60_000);
    if (!limited.ok) {
      requests.start({
        sessionId: s.id,
        sessionTitle: s.title,
        deviceId: device.id,
        threadId: s.thread_id,
        prompt: body.text,
        attachmentCount: body.attachments.length,
        attachmentBytes: 0,
        model: body.model ?? s.model,
        effort: body.effort ?? s.effort,
        ip: req.ip,
        status: 'rate_limited',
      });
      audit.security('rate_limited', eventCtx(req), { scope: 'prompt' });
      throw new ApiError(429, 'rate_limited', undefined, Math.ceil(limited.retryAfterMs / 1000));
    }

    const { attachments, extra } = await buildPromptInput(workspace, body);
    extra.push(...(await ops.skillInputs(s.cwd, body.skills)));
    await ops.warm();
    let session = s;
    const { model, effort, summary, serviceTier, mode } = body;
    if ([model, effort, summary, serviceTier, mode].some((v) => v !== undefined)) session = ops.updateSettings(s, { model, effort, summary, serviceTier, mode });
    if (session.archived_at !== null) await unarchive(session);
    return turns.startTurn({ session, ctx: eventCtx(req), text: body.text, attachments, extraInput: extra, settings: ops.effective(session) });
  });

  app.post('/api/sessions/:id/steer', async (req) => {
    const s = getSession(idParam.parse(req.params).id);
    const { text } = z.object({ text: z.string().min(1).max(config.limits.maxPromptChars) }).strict().parse(req.body);
    return turns.steer(s.id, text, eventCtx(req));
  });

  app.post('/api/sessions/:id/interrupt', async (req) => {
    const s = getSession(idParam.parse(req.params).id);
    await turns.interrupt(s.id);
    return { ok: true };
  });

  app.post('/api/sessions/:id/fork', async (req) => {
    const s = getSession(idParam.parse(req.params).id);
    const { turnId } = z.object({ turnId: z.string().max(100).nullable().optional() }).strict().parse(req.body ?? {});
    return { session: ops.info(await ops.fork(s, turnId ?? null, eventCtx(req))) };
  });

  app.post('/api/sessions/:id/undo', async (req) => {
    const s = getSession(idParam.parse(req.params).id);
    const { turnId } = z.object({ turnId: z.string().max(100).nullable().optional() }).strict().parse(req.body ?? {});
    return ops.undo(s, turnId ?? null);
  });

  app.post('/api/sessions/:id/compact', async (req) => ops.compact(getSession(idParam.parse(req.params).id), eventCtx(req)));

  app.post('/api/sessions/:id/review', async (req) => {
    const s = getSession(idParam.parse(req.params).id);
    return ops.review(s, reviewBody.parse(req.body).target, eventCtx(req));
  });

  app.post('/api/sessions/:id/shell', async (req) => {
    const s = getSession(idParam.parse(req.params).id);
    const { command } = z.object({ command: z.string().min(1).max(8000) }).strict().parse(req.body);
    return ops.shell(s, command, eventCtx(req));
  });

  app.post('/api/sessions/:id/command', async (req) => {
    const s = getSession(idParam.parse(req.params).id);
    const { command } = z.object({ command: z.string().min(1).max(config.limits.maxPromptChars) }).strict().parse(req.body);
    return runCommand(
      {
        ops,
        turns,
        mcp,
        session: s,
        ctx: eventCtx(req),
        key: null,
        newSession: async (title) => ops.info(await newConsoleSession(title, req.auth.device!.id)),
        folderRoot: workspace,
        rename: (title) => ops.rename(s, title),
        archive: (archived) => ops.archive(s, archived),
      },
      command,
    );
  });

  app.get('/api/sessions/:id/diff', async (req) => ops.diff(getSession(idParam.parse(req.params).id)));
  app.get('/api/sessions/:id/status', async (req) => ops.status(getSession(idParam.parse(req.params).id)));

  app.get('/api/sessions/:id/goal', async (req) => ({ goal: await ops.goal(getSession(idParam.parse(req.params).id)) }));
  app.post('/api/sessions/:id/goal', async (req) => {
    const s = getSession(idParam.parse(req.params).id);
    const body = z.object({ objective: z.string().min(1).max(4000), tokenBudget: z.number().int().positive().nullable().optional() }).strict().parse(req.body);
    return { goal: await ops.setGoal(s, body.objective, body.tokenBudget ?? null) };
  });
  app.delete('/api/sessions/:id/goal', async (req) => {
    await ops.clearGoal(getSession(idParam.parse(req.params).id));
    return { goal: null };
  });

  app.get('/api/sessions/:id/skills', async (req) => ({ skills: await ops.skills(getSession(idParam.parse(req.params).id).cwd) }));

  // Fuzzy search inside the session folder for @-mentions; paths come back workspace-relative.
  app.get('/api/sessions/:id/search', async (req) => {
    const s = getSession(idParam.parse(req.params).id);
    const { q } = z.object({ q: z.string().min(1).max(200) }).parse(req.query);
    const base = sessions.workspacePath(s.cwd);
    if (base === null) throw new ApiError(400, 'workspace_unavailable');
    const files = await ops.searchFiles(s.cwd, q);
    return { files: files.map((f) => ({ name: f.name, path: base ? `${base}/${f.path}` : f.path })) };
  });

  app.get('/api/approvals', async () => ({ approvals: turns.pendingApprovals(), questions: turns.pendingQuestions() }));

  app.post('/api/approvals/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const { decision, ruleIndex } = decisionBody.parse(req.body);
    turns.decide(id, decision, eventCtx(req), ruleIndex);
    return { ok: true };
  });

  app.post('/api/questions/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    turns.answer(id, answerBody.parse(req.body), eventCtx(req));
    return { ok: true };
  });

  // Server-sent events: a snapshot of the running turn, then live updates.
  app.get('/api/sessions/:id/events', async (req, reply) => {
    const s = getSession(idParam.parse(req.params).id);
    const deviceId = req.auth.device!.id;
    const loginId = req.auth.login!.id;
    const startedAt = Date.now();
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
    });
    const send = (ev: ServerEvent) => {
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    };
    res.write('retry: 3000\n\n');
    send({ type: 'snapshot', turn: turns.snapshot(s.id) });
    const queued = queue.list(s.id);
    if (queued.queue.length) send({ type: 'queue_updated', ...queued });
    const listener = (sessionId: string, ev: ServerEvent) => {
      if (sessionId === s.id) send(ev);
    };
    turns.on('event', listener);
    const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS);
    // A revoked device or ended login must not keep receiving events.
    const recheck = setInterval(() => {
      const dev = devices.get(deviceId);
      const login = db.get<LoginSessionRow>('SELECT * FROM login_sessions WHERE id = ?', loginId);
      const now = Date.now();
      const deviceOk = dev && dev.revoked_at === null && (dev.expires_at === null || dev.expires_at > now);
      const loginOk = login && login.revoked_at === null && login.expires_at > now;
      if (!deviceOk || !loginOk) close();
    }, SSE_AUTH_RECHECK_MS);
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      clearInterval(recheck);
      turns.off('event', listener);
      res.end();
      audit.api({ deviceId, method: 'GET', route: '/api/sessions/:id/events', status: 200, durationMs: Date.now() - startedAt, bytesIn: null, bytesOut: null, ip: req.ip });
    }
    req.raw.on('close', close);
  });
}
