import type { QueuedPrompt } from '../../shared/api.js';
import type { UserInput } from '../../shared/codex.js';
import type { ApiKeyStore } from '../auth/apiKeys.js';
import { randomId } from '../lib/crypto.js';
import { ApiError } from '../lib/errors.js';
import type { EventContext } from '../services/audit.js';
import type { SessionStore } from '../services/sessions.js';
import type { BridgeLogger } from './bridge.js';
import type { SessionOps } from './sessionOps.js';
import type { Attachment, TurnManager } from './turns.js';

const MAX_QUEUED = 20;

interface QueueItem extends QueuedPrompt {
  attachments: Attachment[];
  extraInput: UserInput[];
  keyId: string | null;
  ctx: EventContext;
}

/**
 * Prompts sent while Codex is busy, run one after another once the current turn completes
 * (like typing ahead in the Codex TUI). A turn that fails or is stopped pauses the queue.
 */
export class PromptQueue {
  private readonly items = new Map<string, QueueItem[]>();
  private readonly paused = new Set<string>();

  constructor(
    private readonly d: { turns: TurnManager; ops: SessionOps; sessions: SessionStore; keys: ApiKeyStore; logger: BridgeLogger },
  ) {
    d.turns.on('event', (sessionId, ev) => {
      if (ev.type !== 'turn_completed' || !this.items.get(sessionId)?.length) return;
      if (ev.end.status !== 'completed') {
        this.paused.add(sessionId);
        this.publish(sessionId);
        return;
      }
      // Let the finished turn close completely first.
      setImmediate(() => void this.next(sessionId));
    });
  }

  list(sessionId: string): { queue: QueuedPrompt[]; paused: boolean } {
    const queue = (this.items.get(sessionId) ?? []).map(({ id, text, attachmentCount, createdAt }) => ({ id, text, attachmentCount, createdAt }));
    return { queue, paused: this.paused.has(sessionId) };
  }

  add(
    sessionId: string,
    item: { text: string; attachments: Attachment[]; extraInput: UserInput[]; keyId: string | null; ctx: EventContext },
  ): QueuedPrompt {
    const list = this.items.get(sessionId) ?? [];
    if (list.length >= MAX_QUEUED) throw new ApiError(429, 'too_many_turns', `at most ${MAX_QUEUED} queued prompts`);
    const queued: QueueItem = {
      id: randomId('que'),
      text: item.text,
      attachmentCount: item.attachments.length + item.extraInput.length,
      createdAt: Date.now(),
      attachments: item.attachments,
      extraInput: item.extraInput,
      keyId: item.keyId,
      ctx: item.ctx,
    };
    list.push(queued);
    this.items.set(sessionId, list);
    this.publish(sessionId);
    if (!this.d.turns.isRunning(sessionId) && !this.paused.has(sessionId)) setImmediate(() => void this.next(sessionId));
    return { id: queued.id, text: queued.text, attachmentCount: queued.attachmentCount, createdAt: queued.createdAt };
  }

  remove(sessionId: string, id: string): void {
    const list = this.items.get(sessionId) ?? [];
    const i = list.findIndex((q) => q.id === id);
    if (i === -1) throw new ApiError(404, 'not_found');
    list.splice(i, 1);
    if (list.length === 0) this.clear(sessionId);
    else this.publish(sessionId);
  }

  /** Continue a paused queue. */
  resume(sessionId: string): void {
    this.paused.delete(sessionId);
    this.publish(sessionId);
    void this.next(sessionId);
  }

  clear(sessionId: string): void {
    this.items.delete(sessionId);
    this.paused.delete(sessionId);
    this.publish(sessionId);
  }

  /** Drop everything a revoked key had queued. */
  clearKey(keyId: string): void {
    for (const [sessionId, list] of this.items) {
      const kept = list.filter((q) => q.keyId !== keyId);
      if (kept.length === list.length) continue;
      if (kept.length) this.items.set(sessionId, kept);
      else this.items.delete(sessionId);
      this.publish(sessionId);
    }
  }

  private publish(sessionId: string): void {
    const { queue, paused } = this.list(sessionId);
    this.d.turns.emitTo(sessionId, { type: 'queue_updated', queue, paused });
  }

  private async next(sessionId: string): Promise<void> {
    if (this.d.turns.isRunning(sessionId) || this.paused.has(sessionId)) return;
    const list = this.items.get(sessionId);
    const item = list?.shift();
    if (!item) return;
    if (list!.length === 0) this.items.delete(sessionId);
    this.publish(sessionId);
    const session = this.d.sessions.get(sessionId);
    if (!session) return this.clear(sessionId);
    let caps = null;
    let apiKey = null;
    if (item.keyId) {
      // A key queues under its rights at the time the prompt actually runs.
      const k = this.d.keys.get(item.keyId);
      if (!k || this.d.keys.status(k) !== 'active') return this.clearKey(item.keyId);
      caps = { maxSandbox: k.maxSandbox, allowNetwork: k.allowNetwork, approvals: k.approvals };
      apiKey = { id: k.id, approvals: k.approvals, quotaRemaining: this.d.keys.remaining(k) };
    }
    try {
      await this.d.ops.warm();
      await this.d.turns.startTurn({
        session,
        ctx: item.ctx,
        text: item.text,
        attachments: item.attachments,
        extraInput: item.extraInput,
        settings: this.d.ops.effective(session, caps),
        apiKey,
      });
    } catch (err) {
      this.d.logger.warn({ err: (err as Error).message, session: sessionId }, 'Queued prompt could not start');
      if (this.items.get(sessionId)?.length) {
        this.paused.add(sessionId);
        this.publish(sessionId);
      }
    }
  }
}
