import type { RequestStatus, TurnKind } from '../../shared/api.js';
import type { TokenUsageBreakdown } from '../../shared/codex.js';
import type { Db } from '../db/db.js';
import { randomId } from '../lib/crypto.js';

export interface RequestStart {
  sessionId: string;
  sessionTitle: string;
  deviceId: string | null;
  apiKeyId?: string | null;
  kind?: TurnKind;
  threadId: string | null;
  prompt: string;
  attachmentCount: number;
  attachmentBytes: number;
  model: string | null;
  effort: string | null;
  ip: string | null;
  status?: RequestStatus;
  error?: string | null;
}

/** One row per prompt: what the admin dashboard lists as "requests". */
export class RequestLog {
  constructor(private readonly db: Db) {}

  start(r: RequestStart, now = Date.now()): string {
    const id = randomId('req');
    const finished = r.status !== undefined && r.status !== 'running';
    this.db.run(
      `INSERT INTO requests (id, session_id, session_title, device_id, api_key_id, kind, thread_id, started_at, completed_at, duration_ms, status,
         prompt_chars, prompt_bytes, attachment_count, attachment_bytes, model, effort, error, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      r.sessionId,
      r.sessionTitle,
      r.deviceId,
      r.apiKeyId ?? null,
      r.kind ?? 'prompt',
      r.threadId,
      now,
      finished ? now : null,
      finished ? 0 : null,
      r.status ?? 'running',
      [...r.prompt].length,
      Buffer.byteLength(r.prompt, 'utf8'),
      r.attachmentCount,
      r.attachmentBytes,
      r.model,
      r.effort,
      r.error ?? null,
      r.ip,
    );
    return id;
  }

  setTurn(id: string, threadId: string, turnId: string | null): void {
    this.db.run('UPDATE requests SET thread_id = ?, turn_id = ? WHERE id = ?', threadId, turnId, id);
  }

  setUsage(id: string, u: TokenUsageBreakdown): void {
    this.db.run(
      'UPDATE requests SET input_tokens = ?, cached_input_tokens = ?, output_tokens = ?, reasoning_tokens = ? WHERE id = ?',
      u.inputTokens,
      u.cachedInputTokens,
      u.outputTokens,
      u.reasoningOutputTokens,
      id,
    );
  }

  finish(id: string, f: { status: RequestStatus; error: string | null; durationMs: number; mediaCount: number; model?: string | null }, now = Date.now()): void {
    this.db.run(
      `UPDATE requests SET status = ?, error = ?, completed_at = ?, duration_ms = ?, media_count = ?, model = COALESCE(?, model)
       WHERE id = ?`,
      f.status,
      f.error?.slice(0, 2000) ?? null,
      now,
      Math.max(0, Math.round(f.durationMs)),
      f.mediaCount,
      f.model ?? null,
      id,
    );
  }

  /** Requests left "running" by a crash are closed on startup. */
  closeDangling(now = Date.now()): void {
    this.db.run(
      "UPDATE requests SET status = 'error', error = 'console restarted', completed_at = ?, duration_ms = ? - started_at WHERE status = 'running'",
      now,
      now,
    );
  }
}
