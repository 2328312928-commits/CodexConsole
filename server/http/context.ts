import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthState } from '../../shared/api.js';
import { keyCanAllow, type ApiKey, type ApiKeyStore } from '../auth/apiKeys.js';
import type { LoginSessionRow, LoginSessionStore } from '../auth/loginSessions.js';
import type { OwnerStore } from '../auth/owner.js';
import type { CodexBridge } from '../codex/bridge.js';
import type { McpManager } from '../codex/mcp.js';
import type { PromptQueue } from '../codex/queue.js';
import type { SessionOps } from '../codex/sessionOps.js';
import type { TurnManager } from '../codex/turns.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/db.js';
import { normalizeIp } from '../lib/net.js';
import type { RateLimiter } from '../lib/rateLimit.js';
import type { AuditLog, EventContext } from '../services/audit.js';
import type { MediaStore } from '../services/media.js';
import type { RequestLog } from '../services/requests.js';
import type { SessionStore } from '../services/sessions.js';
import type { SettingsStore } from '../services/settings.js';
import type { Workspace } from '../services/workspace.js';

/** Who may call a route. Every level includes the ones before it. */
export type AuthLevel = 'public' | 'login' | 'admin';

export interface AuthContext {
  /** The console sign-in (made with an API key), if any. */
  login: LoginSessionRow | null;
  /** The key behind that sign-in; still valid and allowed in the console from this address. */
  key: ApiKey | null;
  /** Admin area unlocked with the owner password and an authenticator code. */
  admin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
  interface FastifyContextConfig {
    auth?: AuthLevel;
  }
}

export interface AppDeps {
  config: AppConfig;
  db: Db;
  owner: OwnerStore;
  logins: LoginSessionStore;
  sessions: SessionStore;
  requests: RequestLog;
  audit: AuditLog;
  limiter: RateLimiter;
  settings: SettingsStore;
  workspace: Workspace;
  media: MediaStore;
  bridge: CodexBridge;
  turns: TurnManager;
  ops: SessionOps;
  mcp: McpManager;
  queue: PromptQueue;
  keys: ApiKeyStore;
  appVersion: string;
}

export function sessionCookie(config: AppConfig): string {
  return config.secureCookies ? '__Host-ccsess' : 'ccsess';
}

export function cookieOptions(config: AppConfig, maxAgeSec: number) {
  return { path: '/', httpOnly: true, secure: config.secureCookies, sameSite: 'strict' as const, maxAge: maxAgeSec };
}

export { keyCanAllow };

/** The browser's address (behind Caddy: from X-Forwarded-For, trusted from loopback only). */
export function clientIp(req: FastifyRequest): string {
  return normalizeIp(req.ip);
}

export function eventCtx(req: FastifyRequest): EventContext {
  return { deviceId: null, apiKeyId: req.auth?.key?.id ?? null, ip: clientIp(req), userAgent: req.headers['user-agent'] ?? null };
}

export function authState(deps: AppDeps, req: FastifyRequest): AuthState {
  const k = req.auth.key;
  return {
    setupComplete: deps.owner.exists(),
    loggedIn: req.auth.login !== null,
    admin: req.auth.admin,
    key:
      k && k.consoleAccess !== 'none'
        ? { id: k.id, label: k.label, access: k.consoleAccess, maxSandbox: k.maxSandbox, allowNetwork: k.allowNetwork, approvals: k.approvals, canAllow: keyCanAllow(k) }
        : null,
  };
}

export function noStore(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
}
