import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ApprovalsReviewer,
  BackgroundTerminal,
  ReasoningSummary,
  SavedPrompt,
  WebSearchMode,
  EffectiveSettings,
  KeyApprovals,
  ModelInfo,
  ReviewTarget,
  SessionInfo,
  SessionSettings,
  SessionStatus,
  SkillInfo,
  ThreadGoal,
} from '../../shared/api.js';
import type { AskForApproval, CodexModel, SandboxMode, Thread, UserInput } from '../../shared/codex.js';
import { sandboxAllowed } from '../auth/apiKeys.js';
import { ApiError } from '../lib/errors.js';
import type { AuditLog, EventContext } from '../services/audit.js';
import type { SessionRow, SessionStore } from '../services/sessions.js';
import type { SettingsStore } from '../services/settings.js';
import type { Workspace } from '../services/workspace.js';
import type { CodexBridge } from './bridge.js';
import { toGoal, type KeyContext, type TurnManager } from './turns.js';

const GIT_DIFF_MAX_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_FILE_BYTES = 64 * 1024;

// `git diff HEAD` plus every untracked file, like Codex's /diff. A fixed script: nothing is interpolated.
const GIT_DIFF_SCRIPT = [
  'g() { git -c core.fsmonitor=false --no-pager "$@"; }',
  'g diff --no-color --no-ext-diff --no-textconv HEAD || exit $?',
  'g ls-files --others --exclude-standard -z | xargs -0 -r -n1 git -c core.fsmonitor=false --no-pager diff --no-color --no-ext-diff --no-textconv --no-index -- /dev/null',
  'exit 0',
].join('\n');

/** Codex's own defaults from config.toml (the user layer), used when a session doesn't choose. */
interface CodexDefaults {
  model: string | null;
  effort: string | null;
  summary: ReasoningSummary | null;
  approvalsReviewer: ApprovalsReviewer | null;
  webSearch: WebSearchMode | null;
}

/** What an API key may do to a session's Codex settings. */
export interface KeyCaps {
  maxSandbox: SandboxMode;
  allowNetwork: boolean;
  approvals: KeyApprovals;
}

export const INIT_PROMPT =
  'Create or update an AGENTS.md file at the root of this project for coding agents. Inspect the repository instead of guessing, ' +
  'then describe the project layout, how to build, run and test it, the coding conventions in use, and anything an agent should ' +
  'know before changing code. Keep it short and accurate.';

function describeTarget(t: ReviewTarget): string {
  if (t.type === 'uncommittedChanges') return 'uncommitted';
  if (t.type === 'baseBranch') return `branch ${t.branch}`;
  if (t.type === 'commit') return `commit ${t.sha}`;
  return t.instructions.slice(0, 200);
}

/** Codex operations on a session, shared by the console routes, the public API and slash commands. */
export class SessionOps {
  private modelCache: { at: number; models: ModelInfo[] } | null = null;
  private codexDefaults: CodexDefaults = { model: null, effort: null, summary: null, approvalsReviewer: null, webSearch: null };

  constructor(
    private readonly d: {
      bridge: CodexBridge;
      turns: TurnManager;
      sessions: SessionStore;
      settings: SettingsStore;
      audit: AuditLog;
      workspace: Workspace;
    },
  ) {
    d.bridge.on('ready', () => {
      this.modelCache = null;
      void this.refreshCodexDefaults();
    });
  }

  /** Load the model list (cached) so `effective()` can name the default model and effort. */
  async warm(): Promise<void> {
    await this.models().catch(() => undefined);
  }

  /** Re-read Codex's defaults (after config.toml changed). */
  async refreshCodexDefaults(): Promise<void> {
    const res = await this.d.bridge.request<{ config: Record<string, any> }>('config/read', {}).catch(() => null);
    const c = res?.config ?? {};
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    this.codexDefaults = {
      model: str(c.model),
      effort: str(c.model_reasoning_effort),
      summary: str(c.model_reasoning_summary) as ReasoningSummary | null,
      approvalsReviewer: c.approvals_reviewer === 'auto_review' || c.approvals_reviewer === 'guardian_subagent' ? 'auto_review' : c.approvals_reviewer === 'user' ? 'user' : null,
      webSearch: str(c.web_search) as WebSearchMode | null,
    };
  }

  /** What a turn runs with: the session's choices, then the console's and Codex's defaults, then the key's caps. */
  effective(session: SessionRow, caps?: KeyCaps | null): EffectiveSettings {
    const defaults = this.d.settings.get();
    const s = this.d.sessions.settingsOf(session);
    const cfg = this.codexDefaults;
    const models = this.modelCache?.models ?? [];
    // Always name the model and effort: Codex keeps a turn's override for the next turns, so
    // "default" has to be spelled out to switch back.
    const model = s.model ?? cfg.model ?? models.find((m) => m.isDefault)?.id ?? null;
    const info = models.find((m) => m.id === model);
    const supported = (e: string | null | undefined): e is string => !!e && (!info || info.efforts.length === 0 || info.efforts.includes(e));
    const effort = supported(s.effort) ? s.effort : supported(cfg.effort) ? cfg.effort : (info?.defaultEffort ?? null);
    const tier = s.serviceTier && (!info || info.serviceTiers.some((t) => t.id === s.serviceTier)) ? s.serviceTier : null;
    let sandbox: SandboxMode = s.sandbox ?? defaults.defaultSandbox;
    let networkAccess = s.networkAccess ?? defaults.defaultNetworkAccess;
    let approvalPolicy: AskForApproval = s.approvalPolicy ?? defaults.defaultApprovalPolicy;
    let approvalsReviewer: ApprovalsReviewer = s.approvalsReviewer ?? cfg.approvalsReviewer ?? 'user';
    let webSearch: WebSearchMode | null = s.webSearch;
    let writableRoots = (s.writableRoots ?? []).map((rel) => this.d.workspace.absOf(rel)).filter((p): p is string => p !== null);
    if (caps) {
      if (!sandboxAllowed(sandbox, caps.maxSandbox)) sandbox = caps.maxSandbox;
      if (!caps.allowNetwork) {
        networkAccess = false;
        webSearch = 'disabled';
      }
      if (caps.approvals === 'deny') approvalPolicy = 'never';
      // An automatic reviewer could allow what the key's caps forbid.
      approvalsReviewer = 'user';
      if (caps.maxSandbox !== 'danger-full-access') writableRoots = [];
    }
    return {
      model,
      effort,
      summary: s.summary ?? cfg.summary ?? null,
      serviceTier: tier,
      mode: s.mode ?? 'default',
      sandbox,
      approvalPolicy,
      approvalsReviewer,
      networkAccess,
      webSearch,
      writableRoots,
      memory: s.memory,
    };
  }

  info(session: SessionRow): SessionInfo {
    return this.d.sessions.toInfo(session, this.d.turns.isRunning(session.id));
  }

  updateSettings(session: SessionRow, patch: Partial<SessionSettings>, caps?: KeyCaps | null): SessionRow {
    const cur = this.d.sessions.settingsOf(session);
    const pick = <K extends keyof SessionSettings>(k: K): SessionSettings[K] => (patch[k] === undefined ? cur[k] : (patch[k] as SessionSettings[K]));
    const next: SessionSettings = {
      model: pick('model'),
      effort: pick('effort'),
      summary: pick('summary'),
      serviceTier: pick('serviceTier'),
      mode: pick('mode'),
      sandbox: pick('sandbox'),
      approvalPolicy: pick('approvalPolicy'),
      approvalsReviewer: pick('approvalsReviewer'),
      networkAccess: pick('networkAccess'),
      webSearch: pick('webSearch'),
      writableRoots: pick('writableRoots'),
      memory: pick('memory'),
    };
    if (caps) {
      const deny = (detail: string) => new ApiError(403, 'setting_not_allowed', detail);
      if (next.sandbox && !sandboxAllowed(next.sandbox, caps.maxSandbox)) throw deny(`sandbox above ${caps.maxSandbox}`);
      if (next.networkAccess && !caps.allowNetwork) throw deny('network access is not allowed for this key');
      if (caps.approvals === 'deny' && next.approvalPolicy && next.approvalPolicy !== 'never') throw deny('this key denies all approvals');
      if (next.approvalsReviewer === 'auto_review') throw deny('approvals of an API key are answered by you or denied, never by the automatic reviewer');
      if (next.webSearch && next.webSearch !== 'disabled' && !caps.allowNetwork) throw deny('web search needs network access');
      if (next.writableRoots?.length && caps.maxSandbox !== 'danger-full-access') throw deny('extra writable folders need full access');
    }
    for (const rel of next.writableRoots ?? []) if (this.d.workspace.absOf(rel) === null) throw new ApiError(400, 'path_outside_workspace', rel);
    this.d.sessions.setSettings(session.id, next);
    const threadId = session.thread_id;
    if (threadId && next.webSearch !== cur.webSearch) {
      // Web search is thread configuration: load the thread again with it on the next turn.
      this.d.bridge.markThreadUnloaded(threadId);
      void this.d.bridge.request('thread/unsubscribe', { threadId }).catch(() => undefined);
    }
    if (threadId && next.memory !== null && next.memory !== cur.memory) {
      void this.d.bridge.request('thread/memoryMode/set', { threadId, mode: next.memory ? 'enabled' : 'disabled' }).catch(() => undefined);
    }
    this.d.turns.emitSessionUpdated(session.id);
    return this.d.sessions.get(session.id)!;
  }

  async models(): Promise<ModelInfo[]> {
    if (!this.modelCache || Date.now() - this.modelCache.at > 10 * 60_000) {
      const res = await this.d.bridge.request<{ data: CodexModel[] }>('model/list', { limit: 100 }).catch((err) => {
        throw new ApiError(502, 'codex_error', (err as Error).message);
      });
      this.modelCache = {
        at: Date.now(),
        models: res.data
          .filter((m) => !m.hidden)
          .map((m) => ({
            id: m.id,
            displayName: m.displayName || m.id,
            description: m.description ?? '',
            isDefault: m.isDefault,
            defaultEffort: m.defaultReasoningEffort,
            efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
            effortOptions: (m.supportedReasoningEfforts ?? []).map((e) => ({ effort: e.reasoningEffort, description: e.description ?? '' })),
            serviceTiers: (m.serviceTiers ?? []).map((t) => ({ id: t.id, name: t.name, description: t.description ?? '' })),
            defaultServiceTier: m.defaultServiceTier ?? null,
            inputModalities: m.inputModalities ?? ['text'],
          })),
      };
    }
    return this.modelCache.models;
  }

  private requireIdle(session: SessionRow): void {
    if (this.d.turns.isRunning(session.id)) throw new ApiError(409, 'turn_in_progress');
  }

  private requireThread(session: SessionRow): string {
    if (!session.thread_id) throw new ApiError(400, 'thread_not_found', 'this session has no Codex thread yet: send a prompt first');
    return session.thread_id;
  }

  /** Fork the session (optionally keeping history only up to `turnId`) into a new session. */
  async fork(session: SessionRow, turnId: string | null, ctx: EventContext, caps?: KeyCaps | null): Promise<SessionRow> {
    this.requireIdle(session);
    const threadId = this.requireThread(session);
    if (turnId && !this.d.sessions.turnIds(session.id).includes(turnId)) throw new ApiError(404, 'turn_not_found');
    const s = this.effective(session, caps);
    const res = await this.d.bridge
      .request<{ thread: Thread; cwd?: string }>('thread/fork', {
        threadId,
        lastTurnId: turnId,
        approvalPolicy: s.approvalPolicy,
        sandbox: s.sandbox,
        config: { sandbox_workspace_write: { network_access: s.networkAccess } },
        excludeTurns: true,
      })
      .catch((err) => {
        throw new ApiError(502, 'codex_error', (err as Error).message);
      });
    this.d.bridge.markThreadLoaded(res.thread.id);
    const row = this.d.sessions.create({
      title: `${session.title || 'Session'} (fork)`,
      titleAuto: false,
      cwd: session.cwd,
      deviceId: ctx.deviceId ?? null,
      apiKeyId: session.api_key_id,
      threadId: res.thread.id,
      settings: this.d.sessions.settingsOf(session),
      forkedFrom: session.id,
    });
    await this.d.turns.syncHistory(row).catch(() => 0);
    return this.d.sessions.get(row.id)!;
  }

  /** Rewind the conversation to before `turnId` (default: the last turn). Files are not restored. */
  async undo(session: SessionRow, turnId: string | null, caps?: KeyCaps | null): Promise<{ removedTurnId: string }> {
    this.requireIdle(session);
    this.requireThread(session);
    const ids = this.d.sessions.turnIds(session.id);
    const target = turnId ?? ids[ids.length - 1];
    if (!target || !ids.includes(target)) throw new ApiError(404, 'turn_not_found');
    const threadId = await this.d.turns.ensureThread(session, this.effective(session, caps));
    await this.d.bridge.request('thread/revert', { threadId, beforeTurnId: target }).catch((err) => {
      throw new ApiError(502, 'codex_error', (err as Error).message);
    });
    this.d.sessions.deleteFromTurn(session.id, target);
    this.d.sessions.touch(session.id);
    this.d.turns.emitTranscriptChanged(session.id);
    return { removedTurnId: target };
  }

  compact(session: SessionRow, ctx: EventContext, caps?: KeyCaps | null, apiKey?: KeyContext | null) {
    return this.d.turns.runExternal({
      session,
      ctx,
      kind: 'compact',
      label: '/compact',
      settings: this.effective(session, caps),
      apiKey,
      invoke: (threadId) => this.d.bridge.request('thread/compact/start', { threadId }).then(() => undefined),
    });
  }

  review(session: SessionRow, target: ReviewTarget, ctx: EventContext, caps?: KeyCaps | null, apiKey?: KeyContext | null) {
    return this.d.turns.runExternal({
      session,
      ctx,
      kind: 'review',
      label: `/review ${describeTarget(target)}`,
      settings: this.effective(session, caps),
      apiKey,
      invoke: async (threadId) => {
        const r = await this.d.bridge.request<{ turn?: { id: string } }>('review/start', { threadId, target, delivery: 'inline' });
        return { turnId: r.turn?.id ?? null };
      },
    });
  }

  /** `!command`: run a shell command in the session folder, outside the model. */
  shell(session: SessionRow, command: string, ctx: EventContext, caps?: KeyCaps | null, apiKey?: KeyContext | null) {
    this.d.audit.security('shell_command', ctx, { session: session.id, command: command.slice(0, 500) });
    return this.d.turns.runExternal({
      session,
      ctx,
      kind: 'shell',
      label: `!${command}`,
      settings: this.effective(session, caps),
      apiKey,
      invoke: (threadId) => this.d.bridge.request('thread/shellCommand', { threadId, command }).then(() => undefined),
    });
  }

  /** The latest turn's diff, plus `git diff HEAD` and untracked files when the folder is a repository. */
  async diff(session: SessionRow): Promise<{ turnDiff: string | null; gitDiff: string | null; gitError: string | null }> {
    const live = this.d.turns.snapshot(session.id)?.diff ?? null;
    let turnDiff = live;
    if (!turnDiff) {
      const { entries } = this.d.sessions.history(session.id, { limit: 200 });
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]!;
        if (e.kind === 'turnEnd' && e.data?.diff) {
          turnDiff = e.data.diff as string;
          break;
        }
      }
    }
    try {
      // Run git inside Codex's own read-only sandbox (no writes, no network): Codex can write to
      // this repository, so its git config, filters or fsmonitor must never run unsandboxed.
      const res = await this.d.bridge.request<{ exitCode: number; stdout: string; stderr: string }>('command/exec', {
        command: ['sh', '-c', GIT_DIFF_SCRIPT],
        cwd: session.cwd,
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        timeoutMs: 15_000,
        outputBytesCap: GIT_DIFF_MAX_BYTES,
      });
      if (res.exitCode !== 0) return { turnDiff, gitDiff: null, gitError: res.stderr.trim().split('\n')[0]?.slice(0, 300) || `git exited with ${res.exitCode}` };
      return { turnDiff, gitDiff: res.stdout, gitError: null };
    } catch (err) {
      return { turnDiff, gitDiff: null, gitError: (err as Error).message };
    }
  }

  async goal(session: SessionRow): Promise<ThreadGoal | null> {
    if (!session.thread_id) return null;
    const res = await this.d.bridge.request<{ goal: unknown }>('thread/goal/get', { threadId: session.thread_id }).catch(() => ({ goal: null }));
    return toGoal(res.goal);
  }

  async setGoal(session: SessionRow, objective: string, tokenBudget: number | null, caps?: KeyCaps | null): Promise<ThreadGoal | null> {
    const threadId = await this.d.turns.ensureThread(session, this.effective(session, caps));
    const res = await this.d.bridge
      .request<{ goal: unknown }>('thread/goal/set', { threadId, objective, status: 'active', tokenBudget })
      .catch((err) => {
        throw new ApiError(502, 'codex_error', (err as Error).message);
      });
    return toGoal(res.goal);
  }

  async clearGoal(session: SessionRow): Promise<void> {
    if (!session.thread_id) return;
    await this.d.bridge.request('thread/goal/clear', { threadId: session.thread_id }).catch((err) => {
      throw new ApiError(502, 'codex_error', (err as Error).message);
    });
  }

  async skills(cwd: string): Promise<SkillInfo[]> {
    const res = await this.d.bridge
      .request<{ data: Array<{ skills: Array<{ name: string; description: string; path: string; scope: string; enabled: boolean }> }> }>('skills/list', { cwds: [cwd] })
      .catch((err) => {
        throw new ApiError(502, 'codex_error', (err as Error).message);
      });
    return (res.data[0]?.skills ?? []).map((s) => ({ name: s.name, description: s.description, path: s.path, scope: s.scope, enabled: s.enabled }));
  }

  /** Turn skill names into input items, rejecting names Codex doesn't know for this folder. */
  async skillInputs(cwd: string, names: string[]): Promise<UserInput[]> {
    if (names.length === 0) return [];
    const known = await this.skills(cwd);
    return names.map((n) => {
      const s = known.find((k) => k.name === n && k.enabled);
      if (!s) throw new ApiError(400, 'bad_request', `unknown skill: ${n}`);
      return { type: 'skill', name: s.name, path: s.path };
    });
  }

  /** Fuzzy file search for @-mentions, limited to `rootAbs`. Paths come back relative to it. */
  async searchFiles(rootAbs: string, query: string, limit = 30): Promise<Array<{ path: string; name: string }>> {
    const res = await this.d.bridge
      .request<{ files: Array<{ root: string; path: string; file_name: string }> }>('fuzzyFileSearch', { query, roots: [rootAbs], cancellationToken: null })
      .catch((err) => {
        throw new ApiError(502, 'codex_error', (err as Error).message);
      });
    return res.files
      .filter((f) => !path.isAbsolute(f.path) && !f.path.split(/[\\/]/).includes('..'))
      .slice(0, limit)
      .map((f) => ({ path: f.path.split(path.sep).join('/'), name: f.file_name }));
  }

  // ---- background terminals (`/ps`, `/stop`) ----

  async terminals(session: SessionRow): Promise<BackgroundTerminal[]> {
    if (!session.thread_id || !this.d.bridge.isThreadLoaded(session.thread_id)) return [];
    const res = await this.d.bridge
      .request<{ data: Array<Record<string, any>> }>('thread/backgroundTerminals/list', { threadId: session.thread_id })
      .catch((err) => {
        throw new ApiError(502, 'codex_error', (err as Error).message);
      });
    return res.data.map((t) => ({
      processId: String(t.processId),
      command: String(t.command ?? ''),
      cwd: String(t.cwd ?? ''),
      osPid: typeof t.osPid === 'number' ? t.osPid : null,
      cpuPercent: typeof t.cpuPercent === 'number' ? t.cpuPercent : null,
      rssKb: typeof t.rssKb === 'number' ? t.rssKb : null,
    }));
  }

  async stopTerminal(session: SessionRow, processId: string | null): Promise<void> {
    const threadId = this.requireThread(session);
    const call =
      processId === null
        ? this.d.bridge.request('thread/backgroundTerminals/clean', { threadId })
        : this.d.bridge.request('thread/backgroundTerminals/terminate', { threadId, processId });
    await call.catch((err) => {
      throw new ApiError(502, 'codex_error', (err as Error).message);
    });
  }

  async rename(session: SessionRow, title: string): Promise<void> {
    const t = title.trim();
    this.d.sessions.rename(session.id, t, t === '');
    if (session.thread_id && t) await this.d.turns.renameThread(session.thread_id, t).catch(() => undefined);
    this.d.turns.emitSessionUpdated(session.id);
  }

  /** Archive in the console and in Codex (like `/archive` and `codex unarchive`). */
  async archive(session: SessionRow, archived: boolean): Promise<void> {
    this.d.sessions.setArchived(session.id, archived);
    if (session.thread_id) await this.d.bridge.request(archived ? 'thread/archive' : 'thread/unarchive', { threadId: session.thread_id }).catch(() => undefined);
    this.d.turns.emitSessionUpdated(session.id);
  }

  /** Move the session to another folder inside `root` (Codex's `/cd`). */
  async changeFolder(session: SessionRow, rel: string, root: Workspace = this.d.workspace): Promise<SessionRow> {
    this.requireIdle(session);
    const r = await root.folder(rel);
    this.d.sessions.setCwd(session.id, r.abs);
    this.d.turns.emitSessionUpdated(session.id);
    return this.d.sessions.get(session.id)!;
  }

  /** Extra writable folders must be real folders inside the workspace. */
  async checkWritableRoots(roots: string[] | null | undefined): Promise<string[] | null> {
    if (!roots) return roots ?? null;
    const out: string[] = [];
    for (const rel of roots) out.push((await this.d.workspace.folder(rel)).rel);
    return [...new Set(out)];
  }

  /** Send feedback (and optionally logs) to the Codex maintainers, like `/feedback`. */
  async feedback(session: SessionRow | null, body: { classification: string; reason: string | null; includeLogs: boolean }, ctx: EventContext): Promise<void> {
    await this.d.bridge
      .request('feedback/upload', { classification: body.classification, reason: body.reason, includeLogs: body.includeLogs, threadId: session?.thread_id ?? null })
      .catch((err) => {
        throw new ApiError(502, 'codex_error', (err as Error).message);
      });
    this.d.audit.security('feedback_sent', ctx, { classification: body.classification, includeLogs: body.includeLogs, session: session?.id });
  }

  /** Codex's reusable prompts: Markdown files in $CODEX_HOME/prompts (`/prompts:<name>`). */
  async savedPrompts(): Promise<SavedPrompt[]> {
    const dir = path.join(this.d.bridge.codexHome, 'prompts');
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const out: SavedPrompt[] = [];
    for (const file of names.filter((n) => n.endsWith('.md')).sort().slice(0, 200)) {
      const st = await fs.lstat(path.join(dir, file)).catch(() => null);
      if (!st?.isFile() || st.size > MAX_PROMPT_FILE_BYTES) continue;
      const raw = await fs.readFile(path.join(dir, file), 'utf8').catch(() => '');
      const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
      const description = fm ? (/^description:\s*(.+)$/m.exec(fm[1]!)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '') : '';
      out.push({ name: file.slice(0, -3), description, content: fm ? raw.slice(fm[0].length) : raw });
    }
    return out;
  }

  async status(session: SessionRow, caps?: KeyCaps | null): Promise<SessionStatus> {
    const { turns, bridge } = this.d;
    const threadId = session.thread_id;
    const total = threadId ? turns.threadTotals.get(threadId) : undefined;
    const lastTurnTokens = turns.snapshot(session.id)?.usage ?? null;
    return {
      session: this.info(session),
      effective: this.effective(session, caps),
      contextWindow: threadId ? (turns.contextWindows.get(threadId) ?? null) : null,
      totalTokens: total ? { input: total.inputTokens, cachedInput: total.cachedInputTokens, output: total.outputTokens, reasoning: total.reasoningOutputTokens } : null,
      lastTurnTokens,
      goal: await this.goal(session),
      rateLimits: bridge.status.rateLimits,
      pendingApprovals: turns.pendingApprovals(session.id).length,
      pendingQuestions: turns.pendingQuestions(session.id).length,
    };
  }
}
