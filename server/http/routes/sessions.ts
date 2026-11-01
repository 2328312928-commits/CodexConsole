import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  APPROVAL_DECISIONS,
  REASONING_SUMMARIES,
  SAFE_APPROVAL_DECISIONS,
  WEB_SEARCH_MODES,
  type ApprovalDecision,
  type CodexStatusInfo,
  type CodexThreadSummary,
  type ServerEvent,
} from '../../../shared/api.js';
import { TESTED_CODEX_VERSION, type UserInput } from '../../../shared/codex.js';
import type { SessionRow } from '../../services/sessions.js';
import { runCommand } from '../../codex/commands.js';
import { TurnManager, type Attachment } from '../../codex/turns.js';
import { promptBucket, type ApiKey } from '../../auth/apiKeys.js';
import { ApiError } from '../../lib/errors.js';
import { defaultFolderName, type Workspace } from '../../services/workspace.js';
import { clientIp, eventCtx, keyCanAllow, type AppDeps } from '../context.js';
import { CSP } from '../headers.js';
import { ConsoleScope } from '../scope.js';

export { defaultFolderName };

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
  const { sessions, turns, bridge, workspace, config, limiter, requests, audit, media, keys, logins, ops, mcp, queue } = deps;
  const scopeOf = (req: FastifyRequest) => ConsoleScope.of(deps, req);

  /** Sending a prompt to an archived session brings it (and its Codex thread) back. */
  const unarchive = async (s: SessionRow) => {
    sessions.setArchived(s.id, false);
    s.archived_at = null;
    if (s.thread_id) await bridge.request('thread/unarchive', { threadId: s.thread_id }).catch(() => undefined);
    turns.emitSessionUpdated(s.id);
  };

  const newConsoleSession = async (scope: ConsoleScope, title: string, folder?: string) => {
    const abs = await makeSessionFolder(await scope.workspace(), folder?.trim() || defaultFolderName(title));
    return sessions.create({ title, titleAuto: !title, cwd: abs, deviceId: null, apiKeyId: scope.key.id });
  };

  const fullOnly = (scope: ConsoleScope, what: string) => {
    if (!scope.full) throw new ApiError(403, 'setting_not_allowed', `${what} needs a key with full console access`);
  };

  /** One prompt budget per key, shared by prompts sent now, queued prompts and the public API. */
  const takePromptBudget = (req: FastifyRequest, key: ApiKey) => {
    const limited = limiter.consume(promptBucket(key), Math.min(key.limits.promptsPerMinute, config.limits.promptsPerMinute), 60_000);
    if (limited.ok) return;
    audit.security('rate_limited', eventCtx(req), { scope: 'prompt' });
    throw new ApiError(429, 'rate_limited', undefined, Math.ceil(limited.retryAfterMs / 1000));
  };

  // Shell commands run outside Codex's sandbox with the service's full rights, so they would
  // lift any cap: only a key with full access and network may run them.
  const assertShellAllowed = (scope: ConsoleScope) => {
    if (!keyCanAllow(scope.key)) throw new ApiError(403, 'setting_not_allowed', 'shell commands run outside the sandbox: they need a key with full access and network');
  };

  // Codex downloads image links itself, outside the sandbox: that is network access.
  const checkImageLinks = (scope: ConsoleScope, imageUrls: string[]) => {
    if (imageUrls.length > 0 && scope.caps && !scope.caps.allowNetwork) {
      throw new ApiError(403, 'setting_not_allowed', 'image links need network access, which this key does not allow');
    }
  };

  app.get('/api/codex/status', async () => codexStatus(deps));
  app.get('/api/codex/models', async () => ({ models: await ops.models() }));

  app.get('/api/sessions', async (req) => {
    const scope = scopeOf(req);
    const q = z.object({ archived: z.enum(['0', '1']).optional(), q: z.string().max(200).optional() }).parse(req.query);
    const rows = sessions.list({ archived: q.archived === '1', q: q.q?.trim() || undefined, apiKeyId: scope.full ? undefined : scope.key.id });
    return { sessions: rows.map((r) => scope.info(r)), workspaceRoot: scope.rootAbs() };
  });

  app.post('/api/sessions', async (req) => {
    const body = z
      .object({ title: z.string().max(200).optional(), folder: z.string().max(1000).optional() })
      .strict()
      .parse(req.body ?? {});
    const scope = scopeOf(req);
    const row = await newConsoleSession(scope, body.title?.trim() ?? '', body.folder);
    return { session: scope.info(row) };
  });

  app.post('/api/sessions/import', async (req) => {
    const scope = scopeOf(req);
    fullOnly(scope, 'importing Codex sessions');
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
      deviceId: null,
      apiKeyId: scope.key.id,
      threadId,
      model: thread.model,
      imported: true,
    });
    await turns.syncHistory(row).catch((err) => req.log.warn({ err: err.message }, 'Thread history import failed'));
    return { session: scope.info(sessions.get(row.id)!) };
  });

  app.get('/api/codex/threads', async (req) => {
    fullOnly(scopeOf(req), 'importing Codex sessions');
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
    const scope = scopeOf(req);
    const s = scope.session(idParam.parse(req.params).id);
    return { session: scope.info(s), effective: ops.effective(s, scope.caps), turn: scope.paths(turns.snapshot(s.id)) };
  });

  app.patch('/api/sessions/:id', async (req) => {
    const scope = scopeOf(req);
    const s = scope.actSession(idParam.parse(req.params).id);
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
    if (body.model !== undefined || body.effort !== undefined) ops.updateSettings(s, { model: body.model, effort: body.effort }, scope.caps);
    turns.emitSessionUpdated(s.id);
    return { session: scope.info(sessions.get(s.id)!) };
  });

  app.patch('/api/sessions/:id/settings', async (req) => {
    const scope = scopeOf(req);
    const s = scope.actSession(idParam.parse(req.params).id);
    const body = settingsBody.parse(req.body);
    // A folder key works only in its own folder.
    if (body.writableRoots?.length && !scope.full) throw new ApiError(403, 'setting_not_allowed', 'extra writable folders need a key with full console access');
    if (body.writableRoots !== undefined) body.writableRoots = await ops.checkWritableRoots(body.writableRoots);
    const row = ops.updateSettings(s, body, scope.caps);
    return { session: scope.info(row), effective: ops.effective(row, scope.caps) };
  });

  // ---- queue: prompts sent while Codex is busy ----

  app.get('/api/sessions/:id/queue', async (req) => queue.list(scopeOf(req).session(idParam.parse(req.params).id).id));

  app.post('/api/sessions/:id/queue', async (req) => {
    const scope = scopeOf(req);
    const s = scope.actSession(idParam.parse(req.params).id);
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
    checkImageLinks(scope, body.imageUrls);
    takePromptBudget(req, scope.key);
    const { attachments, extra } = await buildPromptInput(await scope.workspace(), body);
    extra.push(...(await ops.skillInputs(s.cwd, body.skills)));
    return { queued: queue.add(s.id, { text: body.text, attachments, extraInput: extra, keyId: scope.key.id, channel: 'console', ctx: eventCtx(req) }) };
  });

  app.delete('/api/sessions/:id/queue/:itemId', async (req) => {
    const { id, itemId } = z.object({ id: idParam.shape.id, itemId: z.string().max(100) }).parse(req.params);
    queue.remove(scopeOf(req).actSession(id).id, itemId);
    return { ok: true };
  });

  app.post('/api/sessions/:id/queue/resume', async (req) => {
    queue.resume(scopeOf(req).actSession(idParam.parse(req.params).id).id);
    return { ok: true };
  });

  // ---- background terminals (`/ps`, `/stop`) ----

  app.get('/api/sessions/:id/terminals', async (req) => ({ terminals: await ops.terminals(scopeOf(req).session(idParam.parse(req.params).id)) }));

  app.post('/api/sessions/:id/terminals/stop', async (req) => {
    const s = scopeOf(req).actSession(idParam.parse(req.params).id);
    const { processId } = z.object({ processId: z.string().max(200).nullable() }).strict().parse(req.body);
    await ops.stopTerminal(s, processId);
    return { ok: true };
  });

  app.post('/api/sessions/:id/folder', async (req) => {
    const scope = scopeOf(req);
    const s = scope.actSession(idParam.parse(req.params).id);
    const { path: rel } = z.object({ path: z.string().max(4096) }).strict().parse(req.body);
    return { session: scope.info(await ops.changeFolder(s, rel, await scope.workspace())) };
  });

  app.post('/api/sessions/:id/feedback', async (req) => {
    const s = scopeOf(req).actSession(idParam.parse(req.params).id);
    const body = feedbackBody.parse(req.body);
    await ops.feedback(s, { classification: body.classification, reason: body.reason ?? null, includeLogs: body.includeLogs }, eventCtx(req));
    return { ok: true };
  });

  app.post('/api/sessions/:id/reviews/:reviewId/approve', async (req) => {
    const { id, reviewId } = z.object({ id: idParam.shape.id, reviewId: z.string().max(200) }).parse(req.params);
    const scope = scopeOf(req);
    const s = scope.actSession(id);
    if (!keyCanAllow(scope.key)) throw new ApiError(403, 'setting_not_allowed', 'this key can only decline');
    await turns.approveDenied(s.id, reviewId, eventCtx(req));
    return { ok: true };
  });

  app.get('/api/codex/prompts', async () => ({ prompts: await ops.savedPrompts() }));

  app.delete('/api/sessions/:id', async (req) => {
    const s = scopeOf(req).actSession(idParam.parse(req.params).id);
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
    const scope = scopeOf(req);
    const s = scope.session(idParam.parse(req.params).id);
    const q = z
      .object({ before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(2000).optional() })
      .parse(req.query);
    return scope.paths(sessions.history(s.id, { beforeId: q.before, limit: q.limit }));
  });

  app.post('/api/sessions/:id/sync', async (req) => {
    const s = scopeOf(req).session(idParam.parse(req.params).id);
    if (turns.isRunning(s.id)) throw new ApiError(409, 'turn_in_progress');
    const imported = await turns.syncHistory(s).catch((err) => {
      throw new ApiError(502, 'codex_error', (err as Error).message);
    });
    return { imported };
  });

  app.post('/api/sessions/:id/turns', async (req) => {
    const scope = scopeOf(req);
    const s = scope.actSession(idParam.parse(req.params).id);
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

    const key = scope.key;
    const limited = limiter.consume(promptBucket(key), Math.min(key.limits.promptsPerMinute, config.limits.promptsPerMinute), 60_000);
    if (!limited.ok) {
      requests.start({
        sessionId: s.id,
        sessionTitle: s.title,
        deviceId: null,
        apiKeyId: key.id,
        threadId: s.thread_id,
        prompt: body.text,
        attachmentCount: body.attachments.length,
        attachmentBytes: 0,
        model: body.model ?? s.model,
        effort: body.effort ?? s.effort,
        ip: clientIp(req),
        status: 'rate_limited',
      });
      audit.security('rate_limited', eventCtx(req), { scope: 'prompt' });
      throw new ApiError(429, 'rate_limited', undefined, Math.ceil(limited.retryAfterMs / 1000));
    }
    if (turns.runningForKey(key.id) >= key.limits.concurrent) throw new ApiError(429, 'too_many_turns');
    checkImageLinks(scope, body.imageUrls);

    const { attachments, extra } = await buildPromptInput(await scope.workspace(), body);
    extra.push(...(await ops.skillInputs(s.cwd, body.skills)));
    await ops.warm();
    let session = s;
    const { model, effort, summary, serviceTier, mode } = body;
    if ([model, effort, summary, serviceTier, mode].some((v) => v !== undefined)) session = ops.updateSettings(s, { model, effort, summary, serviceTier, mode }, scope.caps);
    if (session.archived_at !== null) await unarchive(session);
    return turns.startTurn({
      session,
      ctx: eventCtx(req),
      text: body.text,
      attachments,
      extraInput: extra,
      settings: ops.effective(session, scope.caps),
      apiKey: scope.keyCtx(),
    });
  });

  app.post('/api/sessions/:id/steer', async (req) => {
    const scope = scopeOf(req);
    const s = scope.actSession(idParam.parse(req.params).id);
    scope.assertCanJoin(s.id);
    const { text } = z.object({ text: z.string().min(1).max(config.limits.maxPromptChars) }).strict().parse(req.body);
    return turns.steer(s.id, text, eventCtx(req));
  });

  app.post('/api/sessions/:id/interrupt', async (req) => {
    const s = scopeOf(req).actSession(idParam.parse(req.params).id);
    await turns.interrupt(s.id);
    return { ok: true };
  });

  app.post('/api/sessions/:id/fork', async (req) => {
    const scope = scopeOf(req);
    const s = scope.session(idParam.parse(req.params).id);
    const { turnId } = z.object({ turnId: z.string().max(100).nullable().optional() }).strict().parse(req.body ?? {});
    return { session: scope.info(await ops.fork(s, turnId ?? null, eventCtx(req), scope.caps)) };
  });

  app.post('/api/sessions/:id/undo', async (req) => {
    const scope = scopeOf(req);
    const s = scope.actSession(idParam.parse(req.params).id);
    const { turnId } = z.object({ turnId: z.string().max(100).nullable().optional() }).strict().parse(req.body ?? {});
    return ops.undo(s, turnId ?? null, scope.caps);
  });

  app.post('/api/sessions/:id/compact', async (req) => {
    const scope = scopeOf(req);
    return ops.compact(scope.actSession(idParam.parse(req.params).id), eventCtx(req), scope.caps, scope.keyCtx());
  });

  app.post('/api/sessions/:id/review', async (req) => {
    const scope = scopeOf(req);
    const s = scope.actSession(idParam.parse(req.params).id);
    return ops.review(s, reviewBody.parse(req.body).target, eventCtx(req), scope.caps, scope.keyCtx());
  });

  app.post('/api/sessions/:id/shell', async (req) => {
    const scope = scopeOf(req);
    const s = scope.actSession(idParam.parse(req.params).id);
    const { command } = z.object({ command: z.string().min(1).max(8000) }).strict().parse(req.body);
    assertShellAllowed(scope);
    return ops.shell(s, command, eventCtx(req), scope.caps, scope.keyCtx());
  });

  app.post('/api/sessions/:id/command', async (req) => {
    const scope = scopeOf(req);
    const s = scope.actSession(idParam.parse(req.params).id);
    const { command } = z.object({ command: z.string().min(1).max(config.limits.maxPromptChars) }).strict().parse(req.body);
    if (command.trim().startsWith('!')) assertShellAllowed(scope);
    const result = await runCommand(
      {
        ops,
        turns,
        mcp,
        session: s,
        ctx: eventCtx(req),
        // `!command` runs outside Codex's sandbox: only for keys with nothing left to cap.
        key: { caps: scope.caps, context: scope.keyCtx(), hasScope: (sc) => sc !== 'shell' || keyCanAllow(scope.key) },
        newSession: async (title) => scope.info(await newConsoleSession(scope, title)),
        folderRoot: await scope.workspace(),
        rename: (title) => ops.rename(s, title),
        archive: (archived) => ops.archive(s, archived),
      },
      command,
    );
    return result.kind === 'settings' ? { ...result, session: scope.info(sessions.get(s.id)!) } : result;
  });

  app.get('/api/sessions/:id/diff', async (req) => ops.diff(scopeOf(req).session(idParam.parse(req.params).id)));
  app.get('/api/sessions/:id/status', async (req) => {
    const scope = scopeOf(req);
    const status = await ops.status(scope.session(idParam.parse(req.params).id), scope.caps);
    return { ...status, session: scope.info(sessions.get(status.session.id)!) };
  });

  app.get('/api/sessions/:id/goal', async (req) => ({ goal: await ops.goal(scopeOf(req).session(idParam.parse(req.params).id)) }));
  app.post('/api/sessions/:id/goal', async (req) => {
    const scope = scopeOf(req);
    const s = scope.actSession(idParam.parse(req.params).id);
    const body = z.object({ objective: z.string().min(1).max(4000), tokenBudget: z.number().int().positive().nullable().optional() }).strict().parse(req.body);
    return { goal: await ops.setGoal(s, body.objective, body.tokenBudget ?? null, scope.caps) };
  });
  app.delete('/api/sessions/:id/goal', async (req) => {
    await ops.clearGoal(scopeOf(req).actSession(idParam.parse(req.params).id));
    return { goal: null };
  });

  app.get('/api/sessions/:id/skills', async (req) => ({ skills: await ops.skills(scopeOf(req).session(idParam.parse(req.params).id).cwd) }));

  // Fuzzy search inside the session folder for @-mentions; paths come back relative to the key's root.
  app.get('/api/sessions/:id/search', async (req) => {
    const scope = scopeOf(req);
    const s = scope.session(idParam.parse(req.params).id);
    const { q } = z.object({ q: z.string().min(1).max(200) }).parse(req.query);
    const base = scope.rel(sessions.workspacePath(s.cwd));
    if (base === null) throw new ApiError(400, 'workspace_unavailable');
    const files = await ops.searchFiles(s.cwd, q);
    return { files: files.map((f) => ({ name: f.name, path: base ? `${base}/${f.path}` : f.path })) };
  });

  app.get('/api/approvals', async (req) => {
    const scope = scopeOf(req);
    const own = (sessionId: string) => {
      const s = sessions.get(sessionId);
      return Boolean(s && scope.canAct(s));
    };
    return { approvals: turns.pendingApprovals().filter((a) => own(a.sessionId)), questions: turns.pendingQuestions().filter((q) => own(q.sessionId)) };
  });

  app.post('/api/approvals/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const scope = scopeOf(req);
    const sid = turns.approvalSession(id);
    if (!sid) throw new ApiError(404, 'approval_not_found');
    scope.actSession(sid);
    const { decision, ruleIndex } = decisionBody.parse(req.body);
    // Allowing an approval can lift Codex past the sandbox (escalated commands, extra write roots,
    // network or file permissions). A key may only do that if its own caps already allow everything.
    if (!SAFE_APPROVAL_DECISIONS.includes(decision) && !keyCanAllow(scope.key)) {
      throw new ApiError(403, 'setting_not_allowed', 'this key can only decline: give it full access and network to allow');
    }
    turns.decide(id, decision, eventCtx(req), ruleIndex);
    return { ok: true };
  });

  app.post('/api/questions/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    const sid = turns.questionSession(id);
    if (!sid) throw new ApiError(404, 'question_not_found');
    const scope = scopeOf(req);
    scope.actSession(sid);
    scope.assertCanJoin(sid);
    turns.answer(id, answerBody.parse(req.body), eventCtx(req));
    return { ok: true };
  });

  // Server-sent events: a snapshot of the running turn, then live updates.
  app.get('/api/sessions/:id/events', async (req, reply) => {
    const scope = scopeOf(req);
    const s = scope.session(idParam.parse(req.params).id);
    const keyId = scope.key.id;
    const loginId = req.auth.login!.id;
    const ip = clientIp(req);
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
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify(scope.paths(ev))}\n\n`);
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
    // A sign-out, or a revoked, expired or narrowed key, must not keep receiving events.
    const recheck = () => {
      const login = logins.get(loginId);
      const key = keys.get(keyId);
      if (!login || !logins.isLive(login) || !key || keys.consoleProblem(key, ip) !== null) close();
    };
    const timer = setInterval(recheck, SSE_AUTH_RECHECK_MS);
    logins.changes.on('changed', recheck);
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      clearInterval(timer);
      logins.changes.off('changed', recheck);
      turns.off('event', listener);
      res.end();
      audit.api({ deviceId: null, apiKeyId: keyId, method: 'GET', route: '/api/sessions/:id/events', status: 200, durationMs: Date.now() - startedAt, bytesIn: null, bytesOut: null, ip });
    }
    req.raw.on('close', close);
  });
}
