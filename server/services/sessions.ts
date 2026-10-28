import path from 'node:path';
import type { MediaRef, SessionInfo, SessionSettings, TranscriptEntry } from '../../shared/api.js';
import type { AskForApproval, SandboxMode } from '../../shared/codex.js';
import type { Db } from '../db/db.js';
import { randomId } from '../lib/crypto.js';

export interface SessionRow {
  id: string;
  thread_id: string | null;
  title: string;
  title_auto: number;
  cwd: string;
  model: string | null;
  effort: string | null;
  sandbox: string | null;
  approval_policy: string | null;
  network: number | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  created_by_device: string | null;
  imported: number;
  synced_turns: number;
  forked_from: string | null;
  api_key_id: string | null;
  api_key_label: string | null;
  /** JSON: the SessionSettings fields without their own column. */
  extra_settings: string | null;
}

type ExtraSettings = Pick<SessionSettings, 'summary' | 'serviceTier' | 'mode' | 'approvalsReviewer' | 'webSearch' | 'writableRoots' | 'memory'>;

function extrasOf(s: Partial<SessionSettings>): string | null {
  const e: Partial<ExtraSettings> = {};
  for (const k of ['summary', 'serviceTier', 'mode', 'approvalsReviewer', 'webSearch', 'writableRoots', 'memory'] as const) {
    if (s[k] !== undefined && s[k] !== null) (e as Record<string, unknown>)[k] = s[k];
  }
  return Object.keys(e).length ? JSON.stringify(e) : null;
}

function parseExtras(raw: string | null): Partial<ExtraSettings> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Partial<ExtraSettings>;
  } catch {
    return {};
  }
}

interface TranscriptRow {
  id: number;
  request_id: string | null;
  turn_id: string | null;
  kind: string;
  data: string;
  created_at: number;
}

export interface ItemData {
  item: unknown;
  media: MediaRef[];
  partial?: boolean;
}

export const MAX_TITLE_LENGTH = 200;
const SELECT = 'SELECT s.*, k.label AS api_key_label FROM sessions s LEFT JOIN api_keys k ON k.id = s.api_key_id';

/** Console sessions (one per Codex thread) and their stored transcript. */
export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly workspaceRoot: string,
  ) {}

  create(opts: {
    title: string;
    titleAuto: boolean;
    cwd: string;
    deviceId: string | null;
    apiKeyId?: string | null;
    threadId?: string | null;
    model?: string | null;
    effort?: string | null;
    imported?: boolean;
    forkedFrom?: string | null;
    settings?: Partial<SessionSettings>;
    now?: number;
  }): SessionRow {
    const id = randomId('ses');
    const now = opts.now ?? Date.now();
    const st = opts.settings ?? {};
    this.db.run(
      `INSERT INTO sessions (id, thread_id, title, title_auto, cwd, model, effort, sandbox, approval_policy, network,
         created_at, updated_at, created_by_device, api_key_id, imported, forked_from, extra_settings)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      opts.threadId ?? null,
      opts.title.slice(0, MAX_TITLE_LENGTH),
      opts.titleAuto,
      opts.cwd,
      opts.model ?? st.model ?? null,
      opts.effort ?? st.effort ?? null,
      st.sandbox ?? null,
      st.approvalPolicy ?? null,
      st.networkAccess === undefined || st.networkAccess === null ? null : st.networkAccess,
      now,
      now,
      opts.deviceId,
      opts.apiKeyId ?? null,
      opts.imported ?? false,
      opts.forkedFrom ?? null,
      extrasOf(st),
    );
    return this.get(id)!;
  }

  get(id: string): SessionRow | undefined {
    return this.db.get<SessionRow>(`${SELECT} WHERE s.id = ?`, id);
  }

  getByThread(threadId: string): SessionRow | undefined {
    return this.db.get<SessionRow>(`${SELECT} WHERE s.thread_id = ?`, threadId);
  }

  list(opts: { archived: boolean; q?: string; limit?: number; apiKeyId?: string }): SessionRow[] {
    const limit = Math.min(opts.limit ?? 200, 500);
    const clauses = [opts.archived ? 's.archived_at IS NOT NULL' : 's.archived_at IS NULL'];
    const params: Array<string | number> = [];
    if (opts.apiKeyId) {
      clauses.push('s.api_key_id = ?');
      params.push(opts.apiKeyId);
    }
    if (opts.q) {
      const like = `%${opts.q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      clauses.push(`(s.title LIKE ? ESCAPE '\\' OR EXISTS (
        SELECT 1 FROM transcript t WHERE t.session_id = s.id
          AND t.kind IN ('userMessage', 'agentMessage') AND t.data LIKE ? ESCAPE '\\'))`);
      params.push(like, like);
    }
    return this.db.all<SessionRow>(`${SELECT} WHERE ${clauses.join(' AND ')} ORDER BY s.updated_at DESC LIMIT ?`, ...params, limit);
  }

  allThreadIds(): string[] {
    return this.db.all<{ thread_id: string }>('SELECT thread_id FROM sessions WHERE thread_id IS NOT NULL').map((r) => r.thread_id);
  }

  setThread(id: string, threadId: string): void {
    this.db.run('UPDATE sessions SET thread_id = ? WHERE id = ?', threadId, id);
  }

  rename(id: string, title: string, auto: boolean): void {
    this.db.run('UPDATE sessions SET title = ?, title_auto = ? WHERE id = ?', title.slice(0, MAX_TITLE_LENGTH), auto, id);
  }

  setArchived(id: string, archived: boolean, now = Date.now()): void {
    this.db.run('UPDATE sessions SET archived_at = ? WHERE id = ?', archived ? now : null, id);
  }

  setSettings(id: string, s: SessionSettings): void {
    this.db.run(
      'UPDATE sessions SET model = ?, effort = ?, sandbox = ?, approval_policy = ?, network = ?, extra_settings = ? WHERE id = ?',
      s.model,
      s.effort,
      s.sandbox,
      s.approvalPolicy,
      s.networkAccess === null ? null : s.networkAccess,
      extrasOf(s),
      id,
    );
  }

  /** Move the session to another folder (Codex's `/cd`). */
  setCwd(id: string, cwd: string): void {
    this.db.run('UPDATE sessions SET cwd = ? WHERE id = ?', cwd, id);
  }

  settingsOf(row: SessionRow): SessionSettings {
    const e = parseExtras(row.extra_settings);
    return {
      model: row.model,
      effort: row.effort,
      summary: e.summary ?? null,
      serviceTier: e.serviceTier ?? null,
      mode: e.mode ?? null,
      sandbox: row.sandbox as SandboxMode | null,
      approvalPolicy: row.approval_policy as AskForApproval | null,
      approvalsReviewer: e.approvalsReviewer ?? null,
      networkAccess: row.network === null ? null : row.network === 1,
      webSearch: e.webSearch ?? null,
      writableRoots: Array.isArray(e.writableRoots) ? e.writableRoots : null,
      memory: typeof e.memory === 'boolean' ? e.memory : null,
    };
  }

  touch(id: string, now = Date.now()): void {
    this.db.run('UPDATE sessions SET updated_at = ? WHERE id = ?', now, id);
  }

  delete(id: string): boolean {
    return this.db.run('DELETE FROM sessions WHERE id = ?', id).changes === 1;
  }

  addTranscript(
    sessionId: string,
    entry: { requestId: string | null; turnId: string | null; itemId: string | null; kind: string; data: unknown },
    now = Date.now(),
  ): number {
    const json = JSON.stringify(entry.data);
    if (entry.itemId) {
      const existing = this.db.get<{ id: number }>(
        'SELECT id FROM transcript WHERE session_id = ? AND turn_id IS ? AND item_id = ?',
        sessionId,
        entry.turnId,
        entry.itemId,
      );
      if (existing) {
        this.db.run('UPDATE transcript SET data = ?, kind = ? WHERE id = ?', json, entry.kind, existing.id);
        return existing.id;
      }
    }
    return this.db.run(
      'INSERT INTO transcript (session_id, request_id, turn_id, item_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      sessionId,
      entry.requestId,
      entry.turnId,
      entry.itemId,
      entry.kind,
      json,
      now,
    ).lastInsertRowid;
  }

  updateTranscriptData(id: number, data: unknown): void {
    this.db.run('UPDATE transcript SET data = ? WHERE id = ?', JSON.stringify(data), id);
  }

  hasTurn(sessionId: string, turnId: string): boolean {
    return Boolean(this.db.get("SELECT 1 AS x FROM transcript WHERE session_id = ? AND turn_id = ? AND kind = 'turnEnd'", sessionId, turnId));
  }

  /** Codex turn ids in this session's transcript, oldest first. */
  turnIds(sessionId: string): string[] {
    return this.db
      .all<{ turn_id: string }>(
        "SELECT turn_id FROM transcript WHERE session_id = ? AND kind = 'turnEnd' AND turn_id IS NOT NULL ORDER BY id",
        sessionId,
      )
      .map((r) => r.turn_id);
  }

  /** Drop the transcript from the given turn onwards (after Codex rewound the thread). */
  deleteFromTurn(sessionId: string, turnId: string): number {
    const first = this.db.get<{ id: number }>('SELECT MIN(id) AS id FROM transcript WHERE session_id = ? AND turn_id = ?', sessionId, turnId);
    if (!first?.id) return 0;
    return this.db.run('DELETE FROM transcript WHERE session_id = ? AND id >= ?', sessionId, first.id).changes;
  }

  /** Transcript entries in order; `beforeId` pages backwards from the newest. */
  history(sessionId: string, opts: { beforeId?: number; limit?: number } = {}): { entries: TranscriptEntry[]; hasMore: boolean } {
    const limit = Math.min(opts.limit ?? 400, 2000);
    const rows = this.db.all<TranscriptRow>(
      `SELECT id, request_id, turn_id, kind, data, created_at FROM transcript
       WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
      sessionId,
      opts.beforeId ?? Number.MAX_SAFE_INTEGER,
      limit + 1,
    );
    const hasMore = rows.length > limit;
    const entries = rows
      .slice(0, limit)
      .reverse()
      .map((r) => ({ id: r.id, requestId: r.request_id, turnId: r.turn_id, kind: r.kind, data: JSON.parse(r.data), createdAt: r.created_at }));
    return { entries, hasMore };
  }

  /** All transcript entries of one request (for the API's turn result). */
  entriesForRequest(sessionId: string, requestId: string): TranscriptEntry[] {
    return this.db
      .all<TranscriptRow>('SELECT id, request_id, turn_id, kind, data, created_at FROM transcript WHERE session_id = ? AND request_id = ? ORDER BY id', sessionId, requestId)
      .map((r) => ({ id: r.id, requestId: r.request_id, turnId: r.turn_id, kind: r.kind, data: JSON.parse(r.data), createdAt: r.created_at }));
  }

  workspacePath(cwd: string): string | null {
    const rel = path.relative(this.workspaceRoot, cwd);
    if (rel === '') return '';
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  }

  toInfo(row: SessionRow, running: boolean): SessionInfo {
    return {
      id: row.id,
      title: row.title,
      cwd: row.cwd,
      workspacePath: this.workspacePath(row.cwd),
      threadId: row.thread_id,
      model: row.model,
      effort: row.effort,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      archivedAt: row.archived_at,
      imported: row.imported === 1,
      running,
      settings: this.settingsOf(row),
      forkedFrom: row.forked_from,
      apiKey: row.api_key_id ? { id: row.api_key_id, label: row.api_key_label ?? row.api_key_id } : null,
    };
  }
}
