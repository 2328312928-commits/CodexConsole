import { EventEmitter } from 'node:events';
import path from 'node:path';
import type {
  AutoReview,
  ActiveTurnSnapshot,
  ApprovalDecision,
  ApprovalInfo,
  ApprovalKind,
  EffectiveSettings,
  KeyApprovals,
  LiveItem,
  MediaRef,
  PendingQuestion,
  QuestionAnswer,
  RequestStatus,
  ServerEvent,
  ThreadGoal,
  TurnEndData,
  TurnKind,
  UserInputQuestion,
} from '../../shared/api.js';
import type { SandboxPolicy, Thread, ThreadItem, TokenUsageBreakdown, Turn, TurnPlanStep, UserInput } from '../../shared/codex.js';
import type { ApiKeyStore } from '../auth/apiKeys.js';
import { randomId } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import type { AuditLog, EventContext } from '../services/audit.js';
import type { MediaStore } from '../services/media.js';
import type { RequestLog } from '../services/requests.js';
import type { SessionRow, SessionStore } from '../services/sessions.js';
import type { Workspace } from '../services/workspace.js';
import type { BridgeLogger, CodexBridge } from './bridge.js';
import type { RpcId } from './rpc.js';

const MAX_LIVE_OUTPUT = 256 * 1024;
// Streamed reply/reasoning text kept in memory; the completed item still carries the full text.
const MAX_LIVE_TEXT = 1024 * 1024;
const MAX_STORED_OUTPUT = 64 * 1024;
const MAX_STORED_DIFF = 128 * 1024;
// An operation Codex starts on its own (review, compact, shell) must report a turn within this time.
const EXTERNAL_START_TIMEOUT_MS = 30_000;
/** Longest delay setTimeout supports (~24.8 days); key expiries further out need no timer. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface CodexPolicy {
  defaultModel: string | null;
  approvalTimeoutMs: number;
}

export interface Attachment {
  /** Absolute path inside the workspace. */
  abs: string;
  rel: string;
  size: number;
  isImage: boolean;
}

/** Who started a turn on behalf of an API key, and what the key allows. */
export interface KeyContext {
  id: string;
  approvals: KeyApprovals;
  /** Tokens left in the key's quota period when the turn starts (null = unlimited). */
  quotaRemaining: number | null;
}

interface LiveItemState {
  item: ThreadItem & Record<string, any>;
  done: boolean;
  media: MediaRef[];
  outputBytes: number;
  transcriptId: number | null;
  progress: string | null;
}

interface ActiveTurn {
  requestId: string;
  kind: TurnKind;
  session: SessionRow;
  threadId: string | null;
  turnId: string | null;
  startedAt: number;
  prompt: string;
  items: Map<string, LiveItemState>;
  plan: { explanation: string | null; steps: TurnPlanStep[] } | null;
  diff: string | null;
  usage: TokenUsageBreakdown | null;
  /** Thread token totals before this turn, to count the whole turn (not just its last step). */
  usageStart: TokenUsageBreakdown | null;
  statusMessage: string | null;
  lastError: { message: string; info: unknown } | null;
  model: string | null;
  settings: EffectiveSettings;
  apiKey: KeyContext | null;
  quotaStop: boolean;
  scanDir: string | null;
  attachmentRels: Set<string>;
  finished: boolean;
  turnIdWaiters: Array<(id: string | null) => void>;
  doneWaiters: Array<() => void>;
  interruptTimer: NodeJS.Timeout | null;
  startTimer: NodeJS.Timeout | null;
  /** Stops an API key's turn when the key expires. */
  expiryTimer: NodeJS.Timeout | null;
  /** Item completions still capturing media; the turn waits for them before closing. */
  pendingItems: Set<Promise<void>>;
  /** Codex's automatic reviews of this turn's approval requests. */
  reviews: Map<string, AutoReview>;
}

interface PendingApproval {
  info: ApprovalInfo;
  rpcId: RpcId;
  method: string;
  params: any;
  timer: NodeJS.Timeout;
}

interface PendingQuestionState {
  info: PendingQuestion;
  rpcId: RpcId;
  timer: NodeJS.Timeout;
}

interface TurnEvents {
  event: [sessionId: string, event: ServerEvent];
}

const ZERO_USAGE: TokenUsageBreakdown = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };

function usageDiff(total: TokenUsageBreakdown, start: TokenUsageBreakdown): TokenUsageBreakdown {
  const d = (k: keyof TokenUsageBreakdown) => Math.max(0, (total[k] ?? 0) - (start[k] ?? 0));
  return { totalTokens: d('totalTokens'), inputTokens: d('inputTokens'), cachedInputTokens: d('cachedInputTokens'), outputTokens: d('outputTokens'), reasoningOutputTokens: d('reasoningOutputTokens') };
}

export function headTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n… [${text.length - max} characters omitted] …\n${text.slice(-half)}`;
}

/** Trim very large payloads before they go into the transcript. */
function forStorage(item: any): any {
  if (item?.type === 'commandExecution' && typeof item.aggregatedOutput === 'string') {
    return { ...item, aggregatedOutput: headTail(item.aggregatedOutput, MAX_STORED_OUTPUT) };
  }
  if (item?.type === 'fileChange' && Array.isArray(item.changes)) {
    return { ...item, changes: item.changes.map((c: any) => ({ ...c, diff: typeof c.diff === 'string' ? headTail(c.diff, MAX_STORED_DIFF) : c.diff })) };
  }
  if (item?.type === 'imageGeneration' && typeof item.result === 'string' && item.result.length > 1024) {
    return { ...item, result: '[stored separately]' };
  }
  return item;
}

function isUsageLimit(info: unknown): boolean {
  return info === 'usageLimitExceeded' || info === 'rateLimitExceeded' || info === 'sessionBudgetExceeded';
}

export function sandboxPolicyFor(s: EffectiveSettings): SandboxPolicy {
  if (s.sandbox === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (s.sandbox === 'read-only') return { type: 'readOnly', networkAccess: s.networkAccess };
  return { type: 'workspaceWrite', writableRoots: s.writableRoots, networkAccess: s.networkAccess, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

/** One line describing what an automatic review looked at. */
function describeReviewAction(a: any): string {
  if (!a || typeof a !== 'object') return '';
  const text = a.command ?? (Array.isArray(a.argv) ? a.argv.join(' ') : null) ?? a.host ?? a.path ?? a.type ?? '';
  return String(text).slice(0, 500);
}

/** Codex's core form of a review event, rebuilt from the notification for thread/approveGuardianDeniedAction. */
function guardianEvent(p: any): unknown {
  return {
    id: p.reviewId,
    turn_id: p.turnId,
    target_item_id: p.targetItemId ?? null,
    status: p.review?.status,
    risk_level: p.review?.riskLevel ?? null,
    user_authorization: p.review?.userAuthorization ?? null,
    rationale: p.review?.rationale ?? null,
    decision_source: p.decisionSource ?? null,
    action: p.action,
  };
}

export function toGoal(g: any): ThreadGoal | null {
  if (!g || typeof g.objective !== 'string') return null;
  return { objective: g.objective, status: String(g.status), tokenBudget: g.tokenBudget ?? null, tokensUsed: Number(g.tokensUsed ?? 0), timeUsedSeconds: Number(g.timeUsedSeconds ?? 0) };
}

/**
 * Runs work through the bridge and turns Codex notifications into console events,
 * transcript rows and request-log entries. One turn per session at a time.
 */
export class TurnManager extends EventEmitter<TurnEvents> {
  private readonly bySession = new Map<string, ActiveTurn>();
  private readonly byThread = new Map<string, ActiveTurn>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly questions = new Map<string, PendingQuestionState>();
  /** Model Codex reported for each loaded thread (used when the prompt picks the default). */
  private readonly threadModels = new Map<string, string>();
  /** Latest cumulative token totals and context window per thread. */
  readonly threadTotals = new Map<string, TokenUsageBreakdown>();
  /** Last collaboration mode sent per thread (Plan mode sticks until switched back). */
  private readonly threadModes = new Map<string, 'default' | 'plan'>();
  /** Denied automatic reviews that can still be approved once, by review id. */
  private readonly deniedReviews = new Map<string, { sessionId: string; threadId: string; event: unknown }>();
  readonly contextWindows = new Map<string, number>();

  constructor(
    private readonly deps: {
      bridge: CodexBridge;
      sessions: SessionStore;
      requests: RequestLog;
      workspace: Workspace;
      media: MediaStore;
      audit: AuditLog;
      logger: BridgeLogger;
      policy: CodexPolicy;
      keys: ApiKeyStore;
    },
  ) {
    super();
    this.setMaxListeners(500);
    deps.bridge.on('notification', (method, params) => {
      try {
        this.onNotification(method, params);
      } catch (err) {
        deps.logger.error({ err: (err as Error).message, method }, 'Failed to handle Codex notification');
      }
    });
    deps.bridge.on('serverRequest', (id, method, params) => this.onServerRequest(id, method, params));
    deps.bridge.on('exit', () => this.onBridgeExit());
  }

  isRunning(sessionId: string): boolean {
    return this.bySession.has(sessionId);
  }

  setApprovalTimeout(ms: number): void {
    this.deps.policy.approvalTimeoutMs = ms;
  }

  private adoption: ((session: SessionRow) => { settings: EffectiveSettings; apiKey: KeyContext | null }) | null = null;

  /** How to run a turn Codex starts by itself in a session (settings with caps, and its key). */
  setAdoptionContext(fn: (session: SessionRow) => { settings: EffectiveSettings; apiKey: KeyContext | null }): void {
    this.adoption = fn;
  }

  runningCount(): number {
    return this.bySession.size;
  }

  runningForKey(keyId: string): number {
    let n = 0;
    for (const t of this.bySession.values()) if (t.apiKey?.id === keyId) n++;
    return n;
  }

  /** The key whose turn is running in this session (null: none), or undefined when nothing runs. */
  runningKey(sessionId: string): string | null | undefined {
    const t = this.bySession.get(sessionId);
    return t ? (t.apiKey?.id ?? null) : undefined;
  }

  private emitEvent(sessionId: string, event: ServerEvent): void {
    this.emit('event', sessionId, event);
  }

  /** Publish an event for a session from outside (e.g. the prompt queue). */
  emitTo(sessionId: string, event: ServerEvent): void {
    this.emitEvent(sessionId, event);
  }

  private threadConfig(s: EffectiveSettings): Record<string, unknown> {
    return { sandbox_workspace_write: { network_access: s.networkAccess }, ...(s.webSearch ? { web_search: s.webSearch } : {}) };
  }

  /** Collaboration mode only needs sending to enter Plan mode, or to leave it again. */
  private collaborationMode(threadId: string, s: EffectiveSettings): Record<string, unknown> | undefined {
    const previous = this.threadModes.get(threadId) ?? 'default';
    if (!s.model || (s.mode === 'default' && previous === 'default')) return undefined;
    this.threadModes.set(threadId, s.mode);
    return { mode: s.mode, settings: { model: s.model, reasoning_effort: s.effort ?? null, developer_instructions: null } };
  }

  /** Per-turn overrides shared by prompts and the operations that start turns. */
  private turnOverrides(session: SessionRow, threadId: string, s: EffectiveSettings): Record<string, unknown> {
    const mode = this.collaborationMode(threadId, s);
    return {
      cwd: session.cwd,
      model: s.model ?? null,
      effort: s.effort ?? null,
      summary: s.summary ?? null,
      // Per turn only; "default" is standard speed.
      serviceTierForTurn: s.serviceTier ?? 'default',
      approvalPolicy: s.approvalPolicy,
      approvalsReviewer: s.approvalsReviewer,
      sandboxPolicy: sandboxPolicyFor(s),
      ...(mode ? { collaborationMode: mode } : {}),
    };
  }

  /** Make sure the session has a loaded Codex thread (starting or resuming one). */
  async ensureThread(session: SessionRow, s: EffectiveSettings): Promise<string> {
    const { bridge, sessions } = this.deps;
    let threadId = session.thread_id;
    if (!threadId) {
      const res = await bridge.request<{ thread: Thread; model?: string }>('thread/start', {
        cwd: session.cwd,
        approvalPolicy: s.approvalPolicy,
        sandbox: s.sandbox,
        model: s.model ?? this.deps.policy.defaultModel ?? null,
        config: this.threadConfig(s),
      });
      threadId = res.thread.id;
      if (res.model) this.threadModels.set(threadId, res.model);
      this.threadTotals.set(threadId, ZERO_USAGE);
      if (s.memory !== null) {
        await bridge.request('thread/memoryMode/set', { threadId, mode: s.memory ? 'enabled' : 'disabled' }).catch(() => undefined);
      }
      sessions.setThread(session.id, threadId);
      session.thread_id = threadId;
      bridge.markThreadLoaded(threadId);
    } else if (!bridge.isThreadLoaded(threadId)) {
      const resumed = await bridge.request<{ model?: string }>('thread/resume', {
        threadId,
        approvalPolicy: s.approvalPolicy,
        sandbox: s.sandbox,
        config: this.threadConfig(s),
        excludeTurns: true,
      });
      if (resumed.model) this.threadModels.set(threadId, resumed.model);
      bridge.markThreadLoaded(threadId);
    }
    return threadId;
  }

  private newTurn(opts: {
    requestId: string;
    kind: TurnKind;
    session: SessionRow;
    prompt: string;
    settings: EffectiveSettings;
    apiKey: KeyContext | null;
    attachments?: Attachment[];
  }): ActiveTurn {
    const relCwd = this.deps.sessions.workspacePath(opts.session.cwd);
    return {
      requestId: opts.requestId,
      kind: opts.kind,
      session: opts.session,
      threadId: opts.session.thread_id,
      turnId: null,
      startedAt: Date.now(),
      prompt: opts.prompt,
      items: new Map(),
      plan: null,
      diff: null,
      usage: null,
      usageStart: null,
      statusMessage: null,
      lastError: null,
      model: opts.settings.model,
      settings: opts.settings,
      apiKey: opts.apiKey,
      quotaStop: false,
      scanDir: relCwd === null ? null : opts.session.cwd,
      attachmentRels: new Set((opts.attachments ?? []).map((a) => a.rel)),
      finished: false,
      turnIdWaiters: [],
      doneWaiters: [],
      interruptTimer: null,
      startTimer: null,
      expiryTimer: null,
      pendingItems: new Set(),
      reviews: new Map(),
    };
  }

  private precheck(session: SessionRow, needsSignIn: boolean): void {
    if (this.bySession.has(session.id)) throw new ApiError(409, 'turn_in_progress');
    if (!this.deps.bridge.ready) throw new ApiError(503, 'codex_unavailable');
    if (needsSignIn && !this.deps.bridge.signedIn) throw new ApiError(409, 'codex_not_signed_in');
  }

  async startTurn(opts: {
    session: SessionRow;
    ctx: EventContext;
    text: string;
    attachments: Attachment[];
    /** Extra input items: mentions, skills, image URLs. */
    extraInput?: UserInput[];
    settings: EffectiveSettings;
    apiKey?: KeyContext | null;
    /** JSON Schema for the final answer (`codex exec --output-schema`). */
    outputSchema?: unknown;
  }): Promise<{ requestId: string; turnId: string | null }> {
    const { bridge, requests, sessions } = this.deps;
    const { session, settings } = opts;
    const apiKey = opts.apiKey ?? null;
    const base = {
      sessionId: session.id,
      sessionTitle: session.title,
      deviceId: opts.ctx.deviceId ?? null,
      apiKeyId: apiKey?.id ?? null,
      threadId: session.thread_id,
      prompt: opts.text,
      attachmentCount: opts.attachments.length + (opts.extraInput?.length ?? 0),
      attachmentBytes: opts.attachments.reduce((s, a) => s + a.size, 0),
      model: settings.model,
      effort: settings.effort,
      ip: opts.ctx.ip ?? null,
      kind: 'prompt' as const,
    };
    try {
      this.precheck(session, true);
    } catch (err) {
      if (err instanceof ApiError && err.code !== 'turn_in_progress') requests.start({ ...base, status: 'rejected', error: err.code });
      throw err;
    }
    if (apiKey?.quotaRemaining !== null && apiKey?.quotaRemaining !== undefined && apiKey.quotaRemaining <= 0) {
      requests.start({ ...base, status: 'quota_exceeded', error: 'quota_exceeded' });
      throw new ApiError(429, 'quota_exceeded');
    }

    const requestId = requests.start(base);
    const turn = this.newTurn({ requestId, kind: 'prompt', session, prompt: opts.text, settings, apiKey, attachments: opts.attachments });
    this.bySession.set(session.id, turn);
    this.armKeyExpiry(turn);

    if (session.title_auto === 1 && !session.title) {
      const title = opts.text.replace(/\s+/g, ' ').trim().slice(0, 80);
      if (title) {
        sessions.rename(session.id, title, true);
        session.title = title;
        this.emitSessionUpdated(session.id);
      }
    }

    try {
      const threadId = await this.ensureThread(session, settings);
      this.attachThread(turn, threadId);

      let text = opts.text;
      const files = opts.attachments.filter((a) => !a.isImage);
      if (files.length > 0) {
        text += `\n\n[Attached files in the workspace: ${files.map((f) => f.abs).join(', ')}]`;
      }
      const input: UserInput[] = [{ type: 'text', text, text_elements: [] }];
      for (const img of opts.attachments.filter((a) => a.isImage)) input.push({ type: 'localImage', path: img.abs });
      input.push(...(opts.extraInput ?? []));

      const res = await bridge.request<{ turn: Turn }>('turn/start', {
        threadId,
        input,
        ...this.turnOverrides(session, threadId, settings),
        ...(opts.outputSchema !== undefined ? { outputSchema: opts.outputSchema } : {}),
      });
      if (!turn.turnId) this.setTurnId(turn, res.turn.id);
      requests.setTurn(requestId, threadId, turn.turnId);
      sessions.touch(session.id);
      this.emitEvent(session.id, { type: 'turn_started', requestId, turnId: turn.turnId, prompt: opts.text, startedAt: turn.startedAt, kind: 'prompt' });
      return { requestId, turnId: turn.turnId };
    } catch (err) {
      const message = (err as Error).message;
      this.deps.logger.warn({ err: message, session: session.id }, 'Could not start Codex turn');
      if (!turn.finished) await this.finish(turn, null, { status: 'error', error: message });
      throw new ApiError(502, 'codex_error', message);
    }
  }

  /**
   * Run an operation that makes Codex start its own turn (review, compact, `!command`).
   * The turn is registered first so its notifications are captured.
   */
  async runExternal(opts: {
    session: SessionRow;
    ctx: EventContext;
    kind: Exclude<TurnKind, 'prompt'>;
    label: string;
    settings: EffectiveSettings;
    apiKey?: KeyContext | null;
    invoke: (threadId: string) => Promise<{ turnId?: string | null } | void>;
  }): Promise<{ requestId: string; turnId: string | null }> {
    const { requests, sessions } = this.deps;
    const { session, settings } = opts;
    const apiKey = opts.apiKey ?? null;
    // A shell command runs locally and works even when Codex is signed out.
    this.precheck(session, opts.kind !== 'shell');
    if (opts.kind !== 'shell' && apiKey?.quotaRemaining !== null && apiKey?.quotaRemaining !== undefined && apiKey.quotaRemaining <= 0) {
      throw new ApiError(429, 'quota_exceeded');
    }
    const requestId = requests.start({
      sessionId: session.id,
      sessionTitle: session.title,
      deviceId: opts.ctx.deviceId ?? null,
      apiKeyId: apiKey?.id ?? null,
      threadId: session.thread_id,
      prompt: opts.label,
      attachmentCount: 0,
      attachmentBytes: 0,
      model: settings.model,
      effort: settings.effort,
      ip: opts.ctx.ip ?? null,
      kind: opts.kind,
    });
    const turn = this.newTurn({ requestId, kind: opts.kind, session, prompt: opts.label, settings, apiKey });
    this.bySession.set(session.id, turn);
    this.armKeyExpiry(turn);
    try {
      const threadId = await this.ensureThread(session, settings);
      this.attachThread(turn, threadId);
      const res = await opts.invoke(threadId);
      if (res && res.turnId && !turn.turnId) this.setTurnId(turn, res.turnId);
      requests.setTurn(requestId, threadId, turn.turnId);
      sessions.touch(session.id);
      this.emitEvent(session.id, { type: 'turn_started', requestId, turnId: turn.turnId, prompt: opts.label, startedAt: turn.startedAt, kind: opts.kind });
      if (!turn.turnId && !turn.finished) {
        turn.startTimer = setTimeout(() => {
          if (!turn.turnId) void this.finish(turn, null, { status: 'error', error: 'Codex did not start the operation' });
        }, EXTERNAL_START_TIMEOUT_MS);
        turn.startTimer.unref();
      }
      return { requestId, turnId: turn.turnId };
    } catch (err) {
      const message = (err as Error).message;
      if (!turn.finished) await this.finish(turn, null, { status: 'error', error: message });
      throw new ApiError(502, 'codex_error', message);
    }
  }

  private attachThread(turn: ActiveTurn, threadId: string): void {
    turn.threadId = threadId;
    turn.model = turn.settings.model ?? this.threadModels.get(threadId) ?? null;
    turn.usageStart = this.threadTotals.get(threadId) ?? null;
    this.byThread.set(threadId, turn);
  }

  /** Add input to the running turn (Codex "steering"). */
  async steer(sessionId: string, text: string, ctx: EventContext): Promise<{ turnId: string }> {
    const t = this.bySession.get(sessionId);
    if (!t || t.finished || !t.threadId) throw new ApiError(404, 'no_active_turn');
    const turnId = t.turnId ?? (await this.waitTurnId(t));
    if (!turnId) throw new ApiError(404, 'no_active_turn');
    const res = await this.deps.bridge
      .request<{ turnId: string }>('turn/steer', { threadId: t.threadId, input: [{ type: 'text', text, text_elements: [] }], expectedTurnId: turnId })
      .catch((err) => {
        throw new ApiError(409, 'codex_error', (err as Error).message);
      });
    this.deps.sessions.addTranscript(t.session.id, { requestId: t.requestId, turnId, itemId: null, kind: 'steer', data: { text, by: ctx.deviceId ?? null } });
    return res;
  }

  private waitTurnId(t: ActiveTurn, timeoutMs = 5000): Promise<string | null> {
    if (t.turnId) return Promise.resolve(t.turnId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      t.turnIdWaiters.push((id) => {
        clearTimeout(timer);
        resolve(id);
      });
    });
  }

  /** Resolves when the request's turn has finished (true) or the timeout passes (false). */
  waitForRequest(requestId: string, timeoutMs: number): Promise<boolean> {
    const t = [...this.bySession.values()].find((x) => x.requestId === requestId);
    if (!t) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      t.doneWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  activeRequestId(sessionId: string): string | null {
    return this.bySession.get(sessionId)?.requestId ?? null;
  }

  private setTurnId(turn: ActiveTurn, id: string): void {
    turn.turnId = id;
    if (turn.startTimer) clearTimeout(turn.startTimer);
    for (const w of turn.turnIdWaiters.splice(0)) w(id);
  }

  private turnFor(threadId: unknown, turnId?: unknown): ActiveTurn | null {
    if (typeof threadId !== 'string') return null;
    const t = this.byThread.get(threadId);
    if (!t || t.finished) return null;
    if (typeof turnId === 'string') {
      if (t.turnId && t.turnId !== turnId) return null;
      if (!t.turnId) this.setTurnId(t, turnId);
    }
    return t;
  }

  private sessionForThread(threadId: unknown): SessionRow | undefined {
    if (typeof threadId !== 'string') return undefined;
    return this.byThread.get(threadId)?.session ?? this.deps.sessions.getByThread(threadId);
  }

  private onNotification(method: string, p: any): void {
    switch (method) {
      case 'turn/started':
        if (!this.turnFor(p?.threadId, p?.turn?.id)) this.adoptTurn(p?.threadId, p?.turn?.id);
        return;
      case 'item/started': {
        const t = this.turnFor(p?.threadId, p?.turnId);
        if (!t || !p?.item?.id) return;
        t.items.set(p.item.id, { item: { ...p.item }, done: false, media: [], outputBytes: 0, transcriptId: null, progress: null });
        this.emitEvent(t.session.id, { type: 'item_started', turnId: t.turnId!, item: p.item });
        return;
      }
      case 'item/agentMessage/delta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
      case 'item/commandExecution/outputDelta': {
        const t = this.turnFor(p?.threadId, p?.turnId);
        if (!t || typeof p?.delta !== 'string') return;
        const live = t.items.get(p.itemId);
        if (!live) return;
        let field: 'text' | 'summary' | 'output' | 'content';
        if (method === 'item/commandExecution/outputDelta') {
          field = 'output';
          if (live.outputBytes >= MAX_LIVE_OUTPUT) return;
          live.item.aggregatedOutput = (live.item.aggregatedOutput ?? '') + p.delta;
        } else {
          if (live.outputBytes >= MAX_LIVE_TEXT) return;
          if (method === 'item/agentMessage/delta') {
            field = 'text';
            live.item.text = (live.item.text ?? '') + p.delta;
          } else if (method === 'item/reasoning/textDelta') {
            field = 'content';
            const idx = Number(p.contentIndex ?? 0);
            const content: string[] = Array.isArray(live.item.content) ? [...live.item.content] : [];
            while (content.length <= idx) content.push('');
            content[idx] += p.delta;
            live.item.content = content;
          } else {
            field = 'summary';
            const idx = Number(p.summaryIndex ?? 0);
            const summary: string[] = Array.isArray(live.item.summary) ? [...live.item.summary] : [];
            while (summary.length <= idx) summary.push('');
            summary[idx] += p.delta;
            live.item.summary = summary;
          }
        }
        live.outputBytes += p.delta.length;
        this.emitEvent(t.session.id, {
          type: 'item_delta',
          turnId: t.turnId!,
          itemId: p.itemId,
          field,
          ...(field === 'summary' ? { index: Number(p.summaryIndex ?? 0) } : field === 'content' ? { index: Number(p.contentIndex ?? 0) } : {}),
          delta: p.delta,
        });
        return;
      }
      case 'item/mcpToolCall/progress': {
        const t = this.turnFor(p?.threadId, p?.turnId);
        const live = t?.items.get(p?.itemId);
        if (!t || !live || typeof p.message !== 'string') return;
        const message = String(p.message).slice(0, 2000);
        live.progress = message;
        this.emitEvent(t.session.id, { type: 'item_progress', turnId: t.turnId!, itemId: p.itemId, message });
        return;
      }
      case 'item/completed': {
        const t = this.turnFor(p?.threadId, p?.turnId);
        if (!t || !p?.item?.id) return;
        const pending = this.completeItem(t, p.item).finally(() => t.pendingItems.delete(pending));
        t.pendingItems.add(pending);
        return;
      }
      case 'turn/plan/updated': {
        const t = this.turnFor(p?.threadId, p?.turnId);
        if (!t) return;
        t.plan = { explanation: p.explanation ?? null, steps: Array.isArray(p.plan) ? p.plan : [] };
        this.emitEvent(t.session.id, { type: 'plan', turnId: t.turnId!, explanation: t.plan.explanation, steps: t.plan.steps });
        return;
      }
      case 'turn/diff/updated': {
        const t = this.turnFor(p?.threadId, p?.turnId);
        if (!t || typeof p.diff !== 'string') return;
        t.diff = p.diff;
        this.emitEvent(t.session.id, { type: 'diff', turnId: t.turnId!, diff: p.diff });
        return;
      }
      case 'thread/tokenUsage/updated': {
        const total = p?.tokenUsage?.total as TokenUsageBreakdown | undefined;
        const last = p?.tokenUsage?.last as TokenUsageBreakdown | undefined;
        if (typeof p?.threadId !== 'string' || !total) return;
        const before = this.threadTotals.get(p.threadId);
        this.threadTotals.set(p.threadId, total);
        if (typeof p.tokenUsage.modelContextWindow === 'number') this.contextWindows.set(p.threadId, p.tokenUsage.modelContextWindow);
        const t = this.turnFor(p.threadId, p.turnId);
        if (!t) return;
        // Codex reports cumulative thread totals; a turn's usage is the growth since it began.
        if (!t.usageStart) t.usageStart = before ?? usageDiff(total, last ?? ZERO_USAGE);
        const usage = usageDiff(total, t.usageStart);
        t.usage = usage;
        this.deps.requests.setUsage(t.requestId, usage);
        this.emitEvent(t.session.id, { type: 'usage', turnId: t.turnId!, usage });
        // Usage is already stored, so this counts every running turn of the key, not just this one.
        if (t.apiKey && !t.quotaStop) {
          const left = this.quotaLeft(t.apiKey.id);
          if (left !== null && left <= 0) this.stopForQuota(t.apiKey.id);
        }
        return;
      }
      case 'error': {
        const t = this.turnFor(p?.threadId, p?.turnId);
        if (!t) return;
        const message = String(p?.error?.message ?? 'Codex error');
        if (p?.willRetry) t.statusMessage = message;
        else t.lastError = { message, info: p?.error?.codexErrorInfo };
        this.emitEvent(t.session.id, { type: 'status', turnId: t.turnId, message });
        return;
      }
      case 'turn/completed': {
        const t = this.turnFor(p?.threadId, p?.turn?.id);
        if (!t) return;
        void this.finish(t, p.turn as Turn);
        return;
      }
      case 'item/autoApprovalReview/started':
      case 'item/autoApprovalReview/completed': {
        const t = this.turnFor(p?.threadId, p?.turnId);
        const session = t?.session ?? this.sessionForThread(p?.threadId);
        if (!session || typeof p?.reviewId !== 'string') return;
        const done = method === 'item/autoApprovalReview/completed';
        const review: AutoReview = {
          reviewId: p.reviewId,
          turnId: typeof p.turnId === 'string' ? p.turnId : null,
          status: (p.review?.status as AutoReview['status']) ?? (done ? 'approved' : 'inProgress'),
          riskLevel: typeof p.review?.riskLevel === 'string' ? p.review.riskLevel : null,
          rationale: typeof p.review?.rationale === 'string' ? p.review.rationale.slice(0, 4000) : null,
          action: describeReviewAction(p.action),
        };
        t?.reviews.set(review.reviewId, review);
        if (done) {
          this.deps.sessions.addTranscript(session.id, { requestId: t?.requestId ?? null, turnId: review.turnId, itemId: null, kind: 'autoReview', data: review });
          if (review.status === 'denied') this.deniedReviews.set(review.reviewId, { sessionId: session.id, threadId: p.threadId, event: guardianEvent(p) });
        }
        this.emitEvent(session.id, { type: 'auto_review', review });
        return;
      }
      case 'thread/name/updated': {
        const session = this.sessionForThread(p?.threadId);
        if (session && session.title_auto === 1 && typeof p.threadName === 'string' && p.threadName.trim()) {
          this.deps.sessions.rename(session.id, p.threadName.trim(), true);
          this.emitSessionUpdated(session.id);
        }
        return;
      }
      case 'thread/goal/updated':
      case 'thread/goal/cleared': {
        const session = this.sessionForThread(p?.threadId);
        if (session) this.emitEvent(session.id, { type: 'goal_updated', goal: method === 'thread/goal/updated' ? toGoal(p.goal) : null });
        return;
      }
      case 'serverRequest/resolved': {
        for (const [id, a] of this.approvals) {
          if (a.rpcId === p?.requestId && a.params?.threadId === p?.threadId) this.dropApproval(id, 'cancelled');
        }
        for (const [id, q] of this.questions) {
          if (q.rpcId === p?.requestId) this.dropQuestion(id, 'cancelled');
        }
        return;
      }
      default:
        return;
    }
  }

  private async completeItem(t: ActiveTurn, item: ThreadItem & Record<string, any>): Promise<void> {
    const live = t.items.get(item.id) ?? { item, done: false, media: [], outputBytes: 0, transcriptId: null, progress: null };
    live.item = item;
    live.done = true;
    t.items.set(item.id, live);
    const { sessions, media } = this.deps;
    live.transcriptId = sessions.addTranscript(t.session.id, {
      requestId: t.requestId,
      turnId: t.turnId,
      itemId: item.id,
      kind: item.type,
      data: { item: forStorage(item), media: [] },
    });
    try {
      if (item.type === 'imageView' && typeof item.path === 'string') {
        const ref = await media.fromPath(item.path, t.session.id, item.id);
        if (ref) live.media.push(ref);
      } else if (item.type === 'imageGeneration') {
        const ref =
          typeof item.savedPath === 'string'
            ? await media.fromPath(item.savedPath, t.session.id, item.id)
            : typeof item.result === 'string'
              ? await media.fromBase64(item.result, t.session.id, item.id)
              : null;
        if (ref) live.media.push(ref);
      }
      if (live.media.length > 0) {
        sessions.updateTranscriptData(live.transcriptId, { item: forStorage(item), media: live.media });
      }
    } catch (err) {
      this.deps.logger.warn({ err: (err as Error).message }, 'Could not capture image from Codex item');
    }
    this.emitEvent(t.session.id, { type: 'item_completed', turnId: t.turnId!, item: forStorage(item), media: live.media });
  }

  private async finish(t: ActiveTurn, turn: Turn | null, override?: { status: RequestStatus; error: string }): Promise<void> {
    if (t.finished) return;
    t.finished = true;
    if (t.interruptTimer) clearTimeout(t.interruptTimer);
    if (t.startTimer) clearTimeout(t.startTimer);
    if (t.expiryTimer) clearTimeout(t.expiryTimer);
    for (const w of t.turnIdWaiters.splice(0)) w(t.turnId);
    await Promise.allSettled([...t.pendingItems]);
    const { sessions, requests, workspace } = this.deps;

    for (const [id, a] of this.approvals) {
      if (a.info.sessionId === t.session.id) this.respondApproval(id, 'decline', 'cancelled', {});
    }
    for (const [id, q] of this.questions) {
      if (q.info.sessionId === t.session.id && q.info.turnId === t.turnId) this.respondQuestion(id, null, 'cancelled', {});
    }
    // Keep whatever streamed before an interruption so history shows it.
    for (const live of t.items.values()) {
      if (live.done) continue;
      sessions.addTranscript(t.session.id, {
        requestId: t.requestId,
        turnId: t.turnId,
        itemId: live.item.id,
        kind: live.item.type,
        data: { item: forStorage(live.item), media: [], partial: true },
      });
    }

    let status: RequestStatus;
    if (override) status = override.status;
    else if (turn?.status === 'completed') status = 'completed';
    else if (turn?.status === 'interrupted') status = 'interrupted';
    else if (turn?.status === 'failed') status = isUsageLimit(turn.error?.codexErrorInfo ?? t.lastError?.info) ? 'usage_limited' : 'failed';
    else status = 'error';
    let error =
      override?.error ?? turn?.error?.message ?? (status === 'failed' || status === 'usage_limited' ? (t.lastError?.message ?? null) : null);
    if (t.quotaStop && status !== 'completed') {
      status = 'quota_exceeded';
      error = 'The API key reached its token quota, so the turn was stopped.';
    }

    let produced: MediaRef[] = [];
    if (t.scanDir && status !== 'error') {
      produced = await workspace.scanMedia(t.scanDir, t.startedAt - 2000, t.attachmentRels).catch(() => []);
    }
    const seen = new Set<string>();
    for (const live of t.items.values()) for (const m of live.media) seen.add(`${m.source}:${m.path}`);
    produced = produced.filter((m) => !seen.has(`${m.source}:${m.path}`));
    if (produced.length > 0) {
      sessions.addTranscript(t.session.id, { requestId: t.requestId, turnId: t.turnId, itemId: null, kind: 'media', data: { files: produced } });
    }

    const durationMs = turn?.durationMs ?? Date.now() - t.startedAt;
    const end: TurnEndData = {
      status,
      error,
      durationMs,
      usage: t.usage,
      model: t.model,
      kind: t.kind,
      diff: t.diff ? headTail(t.diff, MAX_STORED_DIFF * 2) : null,
    };
    // The prompt is kept so history still shows it when Codex never echoed a userMessage.
    sessions.addTranscript(t.session.id, { requestId: t.requestId, turnId: t.turnId, itemId: null, kind: 'turnEnd', data: { ...end, prompt: t.prompt } });
    const mediaCount = produced.length + [...t.items.values()].reduce((s, l) => s + l.media.length, 0);
    requests.finish(t.requestId, { status, error, durationMs, mediaCount, model: t.model });
    sessions.touch(t.session.id);

    this.bySession.delete(t.session.id);
    if (t.threadId && this.byThread.get(t.threadId) === t) this.byThread.delete(t.threadId);
    this.emitEvent(t.session.id, { type: 'turn_completed', requestId: t.requestId, turnId: t.turnId, end, media: produced });
    this.emitSessionUpdated(t.session.id);
    for (const w of t.doneWaiters.splice(0)) w();
    if (t.kind !== 'shell') void this.deps.bridge.refreshRateLimits();
  }

  private async stopTurn(t: ActiveTurn): Promise<void> {
    const turnId = t.turnId ?? (await this.waitTurnId(t));
    if (!turnId || !t.threadId || t.finished) throw new ApiError(404, 'no_active_turn');
    await this.deps.bridge.request('turn/interrupt', { threadId: t.threadId, turnId });
    // If Codex never confirms, close the turn ourselves.
    t.interruptTimer = setTimeout(() => void this.finish(t, null, { status: 'interrupted', error: 'interrupt not confirmed' }), 20_000);
    t.interruptTimer.unref();
  }

  async interrupt(sessionId: string): Promise<void> {
    const t = this.bySession.get(sessionId);
    if (!t) throw new ApiError(404, 'no_active_turn');
    await this.stopTurn(t);
  }

  /** Stop every turn started with this API key (used when the key is revoked). */
  interruptForKey(keyId: string): void {
    for (const t of this.bySession.values()) if (t.apiKey?.id === keyId) void this.stopTurn(t).catch(() => undefined);
    for (const [id, a] of this.approvals) if (this.bySession.get(a.info.sessionId)?.apiKey?.id === keyId) this.respondApproval(id, 'decline', 'cancelled', {});
  }

  /** The key's settings changed (e.g. its expiry): re-check its running turns. */
  keyChanged(keyId: string): void {
    for (const t of this.bySession.values()) if (t.apiKey?.id === keyId) this.armKeyExpiry(t);
  }

  /** Tokens the key may still use right now (null = no quota). A missing key has none. */
  private quotaLeft(keyId: string): number | null {
    const key = this.deps.keys.get(keyId);
    return key ? this.deps.keys.remaining(key) : 0;
  }

  /** The key's quota is used up: stop all of its turns that spend tokens. */
  private stopForQuota(keyId: string): void {
    for (const t of this.bySession.values()) {
      if (t.apiKey?.id !== keyId || t.kind === 'shell' || t.quotaStop || t.finished) continue;
      t.quotaStop = true;
      void this.stopTurn(t).catch(() => undefined);
    }
  }

  /** Stop an API key's turn as soon as the key is revoked or expires. */
  private armKeyExpiry(t: ActiveTurn): void {
    if (t.expiryTimer) clearTimeout(t.expiryTimer);
    t.expiryTimer = null;
    if (!t.apiKey || t.finished) return;
    const key = this.deps.keys.get(t.apiKey.id);
    if (!key || this.deps.keys.status(key) !== 'active') {
      void this.stopTurn(t).catch(() => undefined);
      return;
    }
    if (key.expiresAt === null) return;
    const ms = key.expiresAt - Date.now();
    if (ms > MAX_TIMER_MS) return;
    t.expiryTimer = setTimeout(() => {
      if (!t.finished) void this.stopTurn(t).catch(() => undefined);
    }, ms);
    t.expiryTimer.unref();
  }

  /** A turn Codex started by itself (for example to continue a thread goal): track it like any other. */
  private adoptTurn(threadId: unknown, turnId: unknown): void {
    if (typeof threadId !== 'string' || typeof turnId !== 'string') return;
    const session = this.deps.sessions.getByThread(threadId);
    if (!session || this.bySession.has(session.id)) return;
    const ctx = this.adoption?.(session) ?? null;
    const settings: EffectiveSettings = ctx?.settings ?? {
      model: session.model,
      effort: session.effort,
      summary: null,
      serviceTier: null,
      mode: 'default',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      networkAccess: false,
      webSearch: null,
      writableRoots: [],
      memory: null,
    };
    const apiKey = ctx?.apiKey ?? null;
    const requestId = this.deps.requests.start({
      sessionId: session.id,
      sessionTitle: session.title,
      deviceId: null,
      apiKeyId: apiKey?.id ?? session.api_key_id ?? null,
      threadId,
      prompt: '',
      attachmentCount: 0,
      attachmentBytes: 0,
      model: settings.model,
      effort: settings.effort,
      ip: null,
      kind: 'auto',
    });
    const turn = this.newTurn({ requestId, kind: 'auto', session, prompt: '', settings, apiKey });
    this.bySession.set(session.id, turn);
    this.attachThread(turn, threadId);
    this.setTurnId(turn, turnId);
    this.deps.requests.setTurn(requestId, threadId, turnId);
    this.emitEvent(session.id, { type: 'turn_started', requestId, turnId, prompt: '', startedAt: turn.startedAt, kind: 'auto' });
    this.emitSessionUpdated(session.id);
    if (apiKey) {
      this.armKeyExpiry(turn);
      const left = this.quotaLeft(apiKey.id);
      if (left !== null && left <= 0) this.stopForQuota(apiKey.id);
    }
  }

  private onServerRequest(id: RpcId, method: string, p: any): void {
    const { bridge, policy } = this.deps;
    const kinds: Record<string, ApprovalKind> = {
      'item/commandExecution/requestApproval': 'command',
      'item/fileChange/requestApproval': 'fileChange',
      'item/permissions/requestApproval': 'permissions',
    };
    const kind = kinds[method];
    const declineApproval = () => bridge.respond(id, kind === 'permissions' ? { permissions: {}, scope: 'turn' } : { decision: 'decline' });
    if (kind) {
      const t = this.turnFor(p?.threadId, p?.turnId);
      if (!t) {
        declineApproval();
        return;
      }
      const now = Date.now();
      // Keys set to "deny" never wait for a person: anything that needs approval is refused.
      if (t.apiKey?.approvals === 'deny') {
        declineApproval();
        this.deps.sessions.addTranscript(t.session.id, {
          requestId: t.requestId,
          turnId: p.turnId ?? t.turnId,
          itemId: null,
          kind: 'approval',
          data: { kind, command: typeof p.command === 'string' ? p.command : null, cwd: p.cwd ?? null, reason: p.reason ?? null, grantRoot: p.grantRoot ?? null, outcome: 'decline', auto: true },
        });
        return;
      }
      const approvalId = randomId('apr');
      const fileItem = t.items.get(p.itemId)?.item;
      const info: ApprovalInfo = {
        id: approvalId,
        sessionId: t.session.id,
        turnId: p.turnId,
        itemId: p.itemId,
        kind,
        command: typeof p.command === 'string' ? p.command : null,
        cwd: typeof p.cwd === 'string' ? p.cwd : null,
        reason: typeof p.reason === 'string' ? p.reason : null,
        grantRoot: typeof p.grantRoot === 'string' ? p.grantRoot : null,
        permissions: p.permissions ?? null,
        changes: fileItem?.type === 'fileChange' && Array.isArray(fileItem.changes) ? forStorage(fileItem).changes : null,
        proposedRule: Array.isArray(p.proposedExecpolicyAmendment) && p.proposedExecpolicyAmendment.length ? p.proposedExecpolicyAmendment.map(String) : null,
        networkRules: Array.isArray(p.proposedNetworkPolicyAmendments) && p.proposedNetworkPolicyAmendments.length
          ? p.proposedNetworkPolicyAmendments.map((r: { action?: unknown; host?: unknown }) => ({ action: String(r?.action ?? 'allow'), host: String(r?.host ?? '') }))
          : null,
        createdAt: now,
        expiresAt: now + policy.approvalTimeoutMs,
      };
      const timer = setTimeout(() => this.respondApproval(approvalId, 'decline', 'timeout', {}), policy.approvalTimeoutMs);
      timer.unref();
      this.approvals.set(approvalId, { info, rpcId: id, method, params: p, timer });
      this.emitEvent(t.session.id, { type: 'approval_requested', approval: info });
      return;
    }
    if (method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request') {
      this.onQuestion(id, method, p);
      return;
    }
    bridge.respondError(id, -32601, `Codex Console does not support ${method}`);
  }

  private onQuestion(id: RpcId, method: string, p: any): void {
    const { bridge, policy } = this.deps;
    const input = method === 'item/tool/requestUserInput';
    const decline = () => bridge.respond(id, input ? { answers: {} } : { action: 'decline', content: null, _meta: null });
    const t = input ? this.turnFor(p?.threadId, p?.turnId) : this.byThread.get(p?.threadId) ?? null;
    const session = t?.session ?? this.sessionForThread(p?.threadId);
    if (!session || t?.apiKey?.approvals === 'deny') {
      decline();
      return;
    }
    const now = Date.now();
    const questionId = randomId('q');
    const questions: UserInputQuestion[] | null = input && Array.isArray(p.questions)
      ? p.questions.map((q: any) => ({
          id: String(q.id),
          header: String(q.header ?? ''),
          question: String(q.question ?? ''),
          isOther: Boolean(q.isOther),
          isSecret: Boolean(q.isSecret),
          options: Array.isArray(q.options) ? q.options.map((o: any) => ({ label: String(o.label), description: String(o.description ?? '') })) : null,
        }))
      : null;
    const info: PendingQuestion = {
      id: questionId,
      sessionId: session.id,
      turnId: typeof p.turnId === 'string' ? p.turnId : (t?.turnId ?? null),
      kind: input ? 'input' : 'elicitation',
      questions,
      server: input ? null : String(p.serverName ?? ''),
      message: input ? null : String(p.message ?? ''),
      mode: input ? null : p.mode === 'url' ? 'url' : 'form',
      schema: input ? null : (p.requestedSchema ?? null),
      url: input ? null : typeof p.url === 'string' ? p.url : null,
      createdAt: now,
      expiresAt: now + policy.approvalTimeoutMs,
    };
    const timer = setTimeout(() => this.respondQuestion(questionId, null, 'timeout', {}), policy.approvalTimeoutMs);
    timer.unref();
    this.questions.set(questionId, { info, rpcId: id, timer });
    this.emitEvent(session.id, { type: 'question_requested', question: info });
  }

  pendingApprovals(sessionId?: string): ApprovalInfo[] {
    return [...this.approvals.values()].filter((a) => !sessionId || a.info.sessionId === sessionId).map((a) => a.info);
  }

  pendingQuestions(sessionId?: string): PendingQuestion[] {
    return [...this.questions.values()].filter((q) => !sessionId || q.info.sessionId === sessionId).map((q) => q.info);
  }

  approvalSession(approvalId: string): string | null {
    return this.approvals.get(approvalId)?.info.sessionId ?? null;
  }

  questionSession(questionId: string): string | null {
    return this.questions.get(questionId)?.info.sessionId ?? null;
  }

  decide(approvalId: string, decision: ApprovalDecision, ctx: EventContext, ruleIndex = 0): ApprovalInfo {
    const a = this.approvals.get(approvalId);
    if (!a) throw new ApiError(404, 'approval_not_found');
    if (decision === 'acceptAlways' && a.info.kind === 'command' && !a.info.proposedRule) throw new ApiError(400, 'bad_request', 'Codex proposed no rule for this command');
    if (decision === 'applyNetworkRule' && !a.info.networkRules?.[ruleIndex]) throw new ApiError(400, 'bad_request', 'no such network rule');
    this.respondApproval(approvalId, decision, decision, ctx, ruleIndex);
    return a.info;
  }

  /** Allow, once, an action Codex's automatic reviewer denied (Codex's `/approve`). */
  async approveDenied(sessionId: string, reviewId: string, ctx: EventContext): Promise<void> {
    const d = this.deniedReviews.get(reviewId);
    if (!d || d.sessionId !== sessionId) throw new ApiError(404, 'approval_not_found');
    await this.deps.bridge.request('thread/approveGuardianDeniedAction', { threadId: d.threadId, event: d.event }).catch((err) => {
      throw new ApiError(502, 'codex_error', (err as Error).message);
    });
    this.deniedReviews.delete(reviewId);
    this.deps.audit.security('approval_decided', ctx, { kind: 'autoReview', decision: 'accept', review: reviewId, session: sessionId });
  }

  answer(questionId: string, answer: QuestionAnswer, ctx: EventContext): PendingQuestion {
    const q = this.questions.get(questionId);
    if (!q) throw new ApiError(404, 'question_not_found');
    if (answer.kind !== q.info.kind) throw new ApiError(400, 'bad_request', 'answer kind does not match the question');
    this.respondQuestion(questionId, answer, 'answered', ctx);
    return q.info;
  }

  private respondQuestion(questionId: string, answer: QuestionAnswer | null, outcome: 'answered' | 'timeout' | 'cancelled', ctx: EventContext): void {
    const q = this.questions.get(questionId);
    if (!q) return;
    let result: unknown;
    if (q.info.kind === 'input') {
      const answers: Record<string, { answers: string[] }> = {};
      if (answer?.kind === 'input') for (const [k, v] of Object.entries(answer.answers)) answers[k] = { answers: v.map(String).slice(0, 20) };
      result = { answers };
    } else {
      const action = answer?.kind === 'elicitation' ? answer.action : 'decline';
      result = { action, content: action === 'accept' ? (answer?.kind === 'elicitation' ? (answer.content ?? {}) : {}) : null, _meta: null };
    }
    this.deps.bridge.respond(q.rpcId, result);
    if (outcome !== 'cancelled') {
      this.deps.sessions.addTranscript(q.info.sessionId, {
        requestId: this.bySession.get(q.info.sessionId)?.requestId ?? null,
        turnId: q.info.turnId,
        itemId: null,
        kind: 'question',
        data: {
          kind: q.info.kind,
          server: q.info.server,
          message: q.info.message,
          questions: q.info.questions?.map((x) => ({ id: x.id, question: x.question, isSecret: x.isSecret })) ?? null,
          // Secret answers are never stored.
          answers:
            answer?.kind === 'input'
              ? Object.fromEntries(Object.entries(answer.answers).map(([k, v]) => [k, q.info.questions?.find((x) => x.id === k)?.isSecret ? ['••••'] : v]))
              : null,
          action: answer?.kind === 'elicitation' ? answer.action : outcome === 'timeout' ? 'decline' : null,
          outcome,
          by: ctx.deviceId ?? null,
        },
      });
    }
    clearTimeout(q.timer);
    this.questions.delete(questionId);
    const resolved = outcome === 'answered' ? (answer?.kind === 'elicitation' && answer.action !== 'accept' ? 'declined' : 'answered') : outcome;
    this.emitEvent(q.info.sessionId, { type: 'question_resolved', questionId, outcome: resolved });
  }

  private dropQuestion(questionId: string, outcome: 'cancelled'): void {
    const q = this.questions.get(questionId);
    if (!q) return;
    clearTimeout(q.timer);
    this.questions.delete(questionId);
    this.emitEvent(q.info.sessionId, { type: 'question_resolved', questionId, outcome });
  }

  private respondApproval(approvalId: string, decision: ApprovalDecision, outcome: ApprovalDecision | 'timeout' | 'cancelled', ctx: EventContext, ruleIndex = 0): void {
    const a = this.approvals.get(approvalId);
    if (!a) return;
    let result: unknown;
    const allow = decision !== 'decline' && decision !== 'cancel';
    if (a.method === 'item/permissions/requestApproval') {
      const requested = (a.params?.permissions ?? {}) as Record<string, unknown>;
      const granted: Record<string, unknown> = {};
      if (allow) {
        if (requested.network) granted.network = requested.network;
        if (requested.fileSystem) granted.fileSystem = requested.fileSystem;
      }
      result = { permissions: granted, scope: decision === 'acceptForSession' || decision === 'acceptAlways' ? 'session' : 'turn' };
    } else if (a.method === 'item/commandExecution/requestApproval' && decision === 'acceptAlways' && a.info.proposedRule) {
      result = { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: a.info.proposedRule } } };
    } else if (a.method === 'item/commandExecution/requestApproval' && decision === 'applyNetworkRule' && a.info.networkRules?.[ruleIndex]) {
      result = { decision: { applyNetworkPolicyAmendment: { network_policy_amendment: a.info.networkRules[ruleIndex] } } };
    } else {
      result = { decision: decision === 'acceptAlways' ? 'acceptForSession' : decision === 'applyNetworkRule' ? 'accept' : decision };
    }
    this.deps.bridge.respond(a.rpcId, result);
    // Permission requests have no "cancel" answer: decline, then stop the turn.
    if (decision === 'cancel' && a.method === 'item/permissions/requestApproval') {
      const t = this.bySession.get(a.info.sessionId);
      if (t) void this.stopTurn(t).catch(() => undefined);
    }
    if (outcome !== 'cancelled') {
      const t = this.bySession.get(a.info.sessionId);
      this.deps.sessions.addTranscript(a.info.sessionId, {
        requestId: t?.requestId ?? null,
        turnId: a.info.turnId,
        itemId: null,
        kind: 'approval',
        data: { kind: a.info.kind, command: a.info.command, cwd: a.info.cwd, reason: a.info.reason, grantRoot: a.info.grantRoot, outcome },
      });
      this.deps.audit.security(outcome === 'timeout' ? 'approval_timed_out' : 'approval_decided', ctx, {
        kind: a.info.kind,
        decision: outcome,
        command: a.info.command?.slice(0, 300) ?? undefined,
        session: a.info.sessionId,
      });
    }
    this.dropApproval(approvalId, outcome);
  }

  private dropApproval(approvalId: string, outcome: ApprovalDecision | 'timeout' | 'cancelled'): void {
    const a = this.approvals.get(approvalId);
    if (!a) return;
    clearTimeout(a.timer);
    this.approvals.delete(approvalId);
    this.emitEvent(a.info.sessionId, { type: 'approval_resolved', approvalId, decision: outcome });
  }

  private onBridgeExit(): void {
    for (const id of [...this.approvals.keys()]) this.dropApproval(id, 'cancelled');
    for (const id of [...this.questions.keys()]) this.dropQuestion(id, 'cancelled');
    for (const t of [...this.bySession.values()]) void this.finish(t, null, { status: 'error', error: 'Codex app-server exited' });
  }

  snapshot(sessionId: string): ActiveTurnSnapshot | null {
    const t = this.bySession.get(sessionId);
    if (!t) return null;
    const items: LiveItem[] = [...t.items.values()].map((l) => ({ item: l.item, done: l.done, media: l.media, progress: l.progress }));
    return {
      requestId: t.requestId,
      kind: t.kind,
      turnId: t.turnId,
      startedAt: t.startedAt,
      prompt: t.prompt,
      items,
      plan: t.plan,
      diff: t.diff,
      approvals: this.pendingApprovals(sessionId),
      questions: this.pendingQuestions(sessionId),
      reviews: [...t.reviews.values()],
      statusMessage: t.statusMessage,
      usage: t.usage,
    };
  }

  emitSessionUpdated(sessionId: string): void {
    const row = this.deps.sessions.get(sessionId);
    if (row) this.emitEvent(sessionId, { type: 'session_updated', session: this.deps.sessions.toInfo(row, this.isRunning(sessionId)) });
  }

  emitTranscriptChanged(sessionId: string): void {
    this.emitEvent(sessionId, { type: 'transcript_changed' });
  }

  /** Copy turns made outside the console (e.g. in the terminal) into the transcript. */
  async syncHistory(session: SessionRow): Promise<number> {
    if (!session.thread_id) return 0;
    const { bridge, sessions } = this.deps;
    let cursor: string | null = null;
    let imported = 0;
    let pages = 0;
    do {
      const res: { data: Turn[]; nextCursor: string | null } = await bridge.request('thread/turns/list', {
        threadId: session.thread_id,
        cursor,
        limit: 50,
        sortDirection: 'asc',
        itemsView: 'full',
      });
      for (const turn of res.data) {
        if (turn.status === 'inProgress' || sessions.hasTurn(session.id, turn.id)) continue;
        for (const item of turn.items ?? []) {
          sessions.addTranscript(session.id, { requestId: null, turnId: turn.id, itemId: item.id, kind: item.type, data: { item: forStorage(item), media: [] } });
        }
        const end: TurnEndData = {
          status: turn.status === 'completed' ? 'completed' : turn.status === 'interrupted' ? 'interrupted' : 'failed',
          error: turn.error?.message ?? null,
          durationMs: turn.durationMs,
          usage: null,
          model: null,
        };
        sessions.addTranscript(session.id, { requestId: null, turnId: turn.id, itemId: null, kind: 'turnEnd', data: end });
        imported++;
      }
      cursor = res.nextCursor;
      pages++;
    } while (cursor && pages < 100);
    if (imported > 0) sessions.touch(session.id);
    return imported;
  }

  /** Threads Codex knows about that are not yet console sessions. */
  async listImportable(cursor: string | null): Promise<{ threads: Thread[]; nextCursor: string | null }> {
    const res = await this.deps.bridge.request<{ data: Thread[]; nextCursor: string | null }>('thread/list', {
      cursor,
      limit: 30,
      excludedThreadIds: this.deps.sessions.allThreadIds().slice(0, 100),
      sortKey: 'updated_at',
      sortDirection: 'desc',
    });
    return { threads: res.data, nextCursor: res.nextCursor };
  }

  async readThread(threadId: string): Promise<Thread> {
    const res = await this.deps.bridge.request<{ thread: Thread }>('thread/read', { threadId, includeTurns: false });
    return res.thread;
  }

  async archiveThread(threadId: string): Promise<void> {
    await this.deps.bridge.request('thread/archive', { threadId });
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    await this.deps.bridge.request('thread/name/set', { threadId, name });
  }

  static isImagePath(p: string): boolean {
    return /\.(png|jpe?g|gif|webp|bmp)$/i.test(path.basename(p));
  }
}
