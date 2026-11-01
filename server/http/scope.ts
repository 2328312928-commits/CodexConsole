import path from 'node:path';
import type { FastifyRequest } from 'fastify';
import type { SessionInfo } from '../../shared/api.js';
import { keyCaps, type ApiKey } from '../auth/apiKeys.js';
import type { KeyCaps } from '../codex/sessionOps.js';
import type { KeyContext } from '../codex/turns.js';
import { ApiError } from '../lib/errors.js';
import type { SessionRow } from '../services/sessions.js';
import { Workspace } from '../services/workspace.js';
import type { AppDeps } from './context.js';

const DROP = Symbol('drop');

/**
 * What the signed-in key reaches in the console. A full-console key sees every session and the
 * whole workspace; a folder key sees only its own sessions and its folder, with every path
 * relative to that folder. The key's caps (sandbox, network, approvals) and quota apply either way.
 */
export class ConsoleScope {
  readonly full: boolean;
  /** null when there is nothing left to cap (full access, network, approvals asked). */
  readonly caps: KeyCaps | null;
  private folderWs: Workspace | null = null;

  constructor(
    private readonly deps: AppDeps,
    readonly key: ApiKey,
  ) {
    this.full = key.consoleAccess === 'full';
    this.caps = keyCaps(key, true);
  }

  static of(deps: AppDeps, req: FastifyRequest): ConsoleScope {
    return new ConsoleScope(deps, req.auth.key!);
  }

  /** Quota, approval policy and usage attribution for turns this key starts. */
  keyCtx(): KeyContext {
    return { id: this.key.id, approvals: this.key.approvals, quotaRemaining: this.deps.keys.remaining(this.key) };
  }

  /** The workspace this key works in; refuses a folder that was swapped for a link elsewhere. */
  async workspace(): Promise<Workspace> {
    if (this.full) return this.deps.workspace;
    if (!this.folderWs) {
      const ws = new Workspace(path.join(this.deps.workspace.realRoot, this.key.folder), this.deps.workspace.opts);
      await ws.init();
      if (!this.deps.workspace.contains(ws.realRoot) || ws.realRoot === this.deps.workspace.realRoot) throw new ApiError(403, 'path_outside_workspace');
      this.folderWs = ws;
    }
    return this.folderWs;
  }

  /** The folder the UI shows paths relative to. */
  rootAbs(): string {
    return this.full ? this.deps.workspace.realRoot : path.join(this.deps.workspace.realRoot, this.key.folder);
  }

  visible(s: SessionRow): boolean {
    return this.full || s.api_key_id === this.key.id;
  }

  session(id: string): SessionRow {
    const s = this.deps.sessions.get(id);
    if (!s || !this.visible(s)) throw new ApiError(404, 'session_not_found');
    return s;
  }

  /**
   * Whether this key may make Codex do something in a session. A capped key works only in its
   * own sessions: elsewhere Codex would act with the session owner's rights (running turns,
   * goals it continues by itself, the owner's settings), not the key's.
   */
  canAct(s: SessionRow): boolean {
    return this.visible(s) && (this.caps === null || s.api_key_id === this.key.id);
  }

  /** A session this key may work in: 404 if it cannot see it, 403 if it may only look. */
  actSession(id: string): SessionRow {
    const s = this.session(id);
    if (!this.canAct(s)) throw new ApiError(403, 'setting_not_allowed', 'this key can only work in its own sessions');
    return s;
  }

  /** Steering or answering a running turn adds to what it does: only the key that started it, or an uncapped key. */
  assertCanJoin(sessionId: string): void {
    if (this.caps === null) return;
    const owner = this.deps.turns.runningKey(sessionId);
    if (owner !== undefined && owner !== this.key.id) throw new ApiError(403, 'setting_not_allowed', 'this turn was started with another key');
  }

  /** A workspace-relative path as seen by this key (null when it is outside its folder). */
  rel(mainRel: string | null): string | null {
    if (mainRel === null || this.full) return mainRel;
    const folder = this.key.folder;
    if (mainRel === folder) return '';
    return mainRel.startsWith(`${folder}/`) ? mainRel.slice(folder.length + 1) : null;
  }

  info(s: SessionRow): SessionInfo {
    const info = this.deps.ops.info(s);
    return this.full ? info : { ...info, workspacePath: this.rel(info.workspacePath) };
  }

  /** For a folder key: point workspace media (images Codex made or viewed) at its folder, drop the rest. */
  paths<T>(value: T): T {
    if (this.full) return value;
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(walk).filter((x) => x !== DROP);
      if (!v || typeof v !== 'object') return v;
      const o = v as Record<string, unknown>;
      if (o.source === 'workspace' && typeof o.path === 'string' && typeof o.mime === 'string') {
        const rel = this.rel(o.path);
        return rel === null ? DROP : { ...o, path: rel };
      }
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o)) {
        const w = walk(x);
        if (w !== DROP) out[k] = w;
      }
      return out;
    };
    return walk(value) as T;
  }
}
