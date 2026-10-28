import path from 'node:path';
import { ApiKeyStore } from './auth/apiKeys.js';
import { DeviceStore } from './auth/devices.js';
import { LoginSessionStore } from './auth/loginSessions.js';
import { OwnerStore } from './auth/owner.js';
import { CodexBridge, type BridgeLogger } from './codex/bridge.js';
import { McpManager } from './codex/mcp.js';
import { PromptQueue } from './codex/queue.js';
import { SessionOps } from './codex/sessionOps.js';
import { TurnManager } from './codex/turns.js';
import type { AppConfig } from './config.js';
import { Db } from './db/db.js';
import type { AppDeps } from './http/context.js';
import { RateLimiter } from './lib/rateLimit.js';
import { loadOrCreateSecrets } from './lib/secrets.js';
import { appVersion } from './lib/version.js';
import { AdminQueries } from './services/adminQueries.js';
import { AuditLog } from './services/audit.js';
import { MediaStore } from './services/media.js';
import { RequestLog } from './services/requests.js';
import { SessionStore } from './services/sessions.js';
import { SettingsStore } from './services/settings.js';
import { Workspace } from './services/workspace.js';

const DAY = 86_400_000;

/** Storage + auth stores only (used by the setup CLI, which must not start Codex). */
export function openStores(config: AppConfig, warn: (msg: string) => void = console.warn) {
  const secrets = loadOrCreateSecrets(config.dataDir, warn);
  const db = new Db(path.join(config.dataDir, 'codexconsole.db'));
  return {
    db,
    secrets,
    owner: new OwnerStore(db, secrets.pepper),
    devices: new DeviceStore(db, secrets.pepper),
    logins: new LoginSessionStore(db, secrets.pepper, config.sessions),
    keys: new ApiKeyStore(db, secrets.pepper),
    audit: new AuditLog(db),
  };
}

export interface RuntimeOptions {
  codexArgs?: string[];
  codexEnv?: NodeJS.ProcessEnv;
  logger: BridgeLogger;
  minBackoffMs?: number;
}

/** Everything the HTTP app needs; the Codex bridge is created but not started. */
export async function createRuntime(config: AppConfig, opts: RuntimeOptions): Promise<AppDeps & { stop: () => Promise<void> }> {
  const stores = openStores(config, (m) => opts.logger.warn(m));
  const { db } = stores;
  const settings = new SettingsStore(db, {
    logRetentionDays: config.logRetentionDays,
    approvalTimeoutSec: Math.round(config.codex.approvalTimeoutMs / 1000),
    defaultSandbox: config.codex.sandbox,
    defaultApprovalPolicy: config.codex.approvalPolicy,
    defaultNetworkAccess: config.codex.networkAccess,
  });
  const workspace = new Workspace(config.workspaceRoot);
  await workspace.init();
  const media = new MediaStore(path.join(config.dataDir, 'media'), workspace);
  const sessions = new SessionStore(db, workspace.realRoot);
  const requests = new RequestLog(db);
  requests.closeDangling();
  const version = appVersion();
  const bridge = new CodexBridge({
    bin: config.codex.bin,
    args: opts.codexArgs,
    env: opts.codexEnv,
    clientVersion: version,
    logger: opts.logger,
    minBackoffMs: opts.minBackoffMs,
  });
  const turns = new TurnManager({
    bridge,
    sessions,
    requests,
    workspace,
    media,
    audit: stores.audit,
    logger: opts.logger,
    policy: {
      defaultModel: config.codex.defaultModel,
      approvalTimeoutMs: settings.get().approvalTimeoutSec * 1000,
    },
    keys: stores.keys,
  });
  const ops = new SessionOps({ bridge, turns, sessions, settings, audit: stores.audit, workspace });
  // Turns Codex starts by itself run under the session's settings and, for API-key sessions, the key's caps.
  turns.setAdoptionContext((session) => {
    const key = session.api_key_id ? stores.keys.get(session.api_key_id) : undefined;
    if (!key) return { settings: ops.effective(session), apiKey: null };
    return {
      settings: ops.effective(session, { maxSandbox: key.maxSandbox, allowNetwork: key.allowNetwork, approvals: key.approvals }),
      apiKey: { id: key.id, approvals: key.approvals, quotaRemaining: stores.keys.remaining(key) },
    };
  });
  const mcp = new McpManager(bridge, config.codex.bin);
  const queue = new PromptQueue({ turns, ops, sessions, keys: stores.keys, logger: opts.logger });
  const queries = new AdminQueries(db);
  bridge.on('rateLimits', (snap) => queries.recordRateLimits(snap));

  const housekeeping = () => {
    stores.audit.prune(settings.get().logRetentionDays);
    stores.logins.purgeExpired();
    db.run('DELETE FROM pairing_codes WHERE expires_at < ?', Date.now() - DAY);
  };
  housekeeping();
  const timers = [
    setInterval(housekeeping, 6 * 3_600_000),
    setInterval(() => {
      if (bridge.ready && bridge.signedIn) void bridge.refreshRateLimits();
    }, 5 * 60_000),
  ];
  for (const t of timers) t.unref();

  return {
    config,
    db,
    owner: stores.owner,
    devices: stores.devices,
    logins: stores.logins,
    keys: stores.keys,
    audit: stores.audit,
    sessions,
    requests,
    limiter: new RateLimiter(),
    settings,
    workspace,
    media,
    bridge,
    turns,
    ops,
    mcp,
    queue,
    appVersion: version,
    async stop() {
      for (const t of timers) clearInterval(t);
      await bridge.stop();
      db.close();
    },
  };
}
