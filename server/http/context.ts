import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthState } from '../../shared/api.js';
import type { ApiKeyStore } from '../auth/apiKeys.js';
import type { DeviceStore, DeviceRow } from '../auth/devices.js';
import type { LoginSessionRow, LoginSessionStore } from '../auth/loginSessions.js';
import type { OwnerStore } from '../auth/owner.js';
import type { CodexBridge } from '../codex/bridge.js';
import type { McpManager } from '../codex/mcp.js';
import type { SessionOps } from '../codex/sessionOps.js';
import type { TurnManager } from '../codex/turns.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/db.js';
import type { RateLimiter } from '../lib/rateLimit.js';
import type { AuditLog, EventContext } from '../services/audit.js';
import type { MediaStore } from '../services/media.js';
import type { RequestLog } from '../services/requests.js';
import type { SessionStore } from '../services/sessions.js';
import type { SettingsStore } from '../services/settings.js';
import type { Workspace } from '../services/workspace.js';

/** Who may call a route. Every level includes the ones before it. */
export type AuthLevel = 'public' | 'device' | 'login' | 'admin';

export interface AuthContext {
  device: DeviceRow | null;
  login: LoginSessionRow | null;
  admin: boolean;
  bearer: boolean;
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
  devices: DeviceStore;
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
  keys: ApiKeyStore;
  appVersion: string;
}

export function cookieNames(config: AppConfig): { device: string; session: string } {
  return config.secureCookies ? { device: '__Host-ccdev', session: '__Host-ccsess' } : { device: 'ccdev', session: 'ccsess' };
}

export function cookieOptions(config: AppConfig, maxAgeSec: number) {
  return { path: '/', httpOnly: true, secure: config.secureCookies, sameSite: 'strict' as const, maxAge: maxAgeSec };
}

export function eventCtx(req: FastifyRequest): EventContext {
  return { deviceId: req.auth?.device?.id ?? null, ip: req.ip, userAgent: req.headers['user-agent'] ?? null };
}

export function authState(deps: AppDeps, req: FastifyRequest): AuthState {
  return {
    setupComplete: deps.owner.exists(),
    device: req.auth.device ? { id: req.auth.device.id, name: req.auth.device.name } : null,
    loggedIn: req.auth.login !== null,
    admin: req.auth.admin,
  };
}

export function noStore(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store');
}
