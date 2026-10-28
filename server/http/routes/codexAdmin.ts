import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../../lib/errors.js';
import { eventCtx, type AppDeps } from '../context.js';
import { feedbackBody } from './sessions.js';

const ADMIN = { config: { auth: 'admin' as const } };
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const KEY_PATH = z.string().regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/).max(200);

/**
 * Codex itself, managed from the admin area: account, config.toml, feature flags, hooks,
 * plugins, apps, skills, memories, imports from other agents and diagnostics.
 */
export function registerCodexAdminRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { bridge, audit, ops, workspace } = deps;

  const codex = async <T>(method: string, params: unknown): Promise<T> =>
    bridge.request<T>(method, params).catch((err) => {
      throw new ApiError(502, 'codex_error', (err as Error).message);
    });
  /** For panels that may simply be unavailable (signed out, feature off): show them empty. */
  const optional = <T>(method: string, params: unknown) => bridge.request<T>(method, params).catch((err) => ({ unavailable: (err as Error).message }));

  // ---- account ----

  app.get('/api/admin/codex/account', ADMIN, async () => ({
    account: bridge.status.account,
    signedIn: bridge.signedIn,
    rateLimits: bridge.status.rateLimits,
    usage: await optional('account/usage/read', {}),
  }));

  app.post('/api/admin/codex/login', ADMIN, async (req) => {
    const { mode } = z.object({ mode: z.enum(['deviceCode', 'browser']) }).strict().parse(req.body);
    // ChatGPT sign-in only: this console is for a ChatGPT plan, never API credits.
    const res = await codex<Record<string, unknown>>('account/login/start', { type: mode === 'deviceCode' ? 'chatgptDeviceCode' : 'chatgpt' });
    audit.security('codex_login_started', eventCtx(req), { mode });
    const url = (res.verificationUrl ?? res.authUrl) as string | undefined;
    if (url && !/^https?:\/\//i.test(url)) throw new ApiError(502, 'codex_error', 'unexpected sign-in link');
    return { loginId: res.loginId ?? null, url: url ?? null, userCode: res.userCode ?? null };
  });

  app.post('/api/admin/codex/login/cancel', ADMIN, async (req) => {
    const { loginId } = z.object({ loginId: z.string().max(200) }).strict().parse(req.body);
    await codex('account/login/cancel', { loginId });
    return { ok: true };
  });

  app.post('/api/admin/codex/logout', ADMIN, async (req) => {
    await codex('account/logout', {});
    audit.security('codex_logout', eventCtx(req));
    await bridge.refreshAccount().catch(() => undefined);
    return { ok: true };
  });

  app.post('/api/admin/codex/limit-reset', ADMIN, async (req) => {
    const res = await codex<{ outcome?: string }>('account/rateLimitResetCredit/consume', { idempotencyKey: crypto.randomUUID(), creditId: null });
    audit.security('limit_reset_used', eventCtx(req), { outcome: res.outcome ?? null });
    await bridge.refreshRateLimits();
    return { outcome: res.outcome ?? null };
  });

  // ---- config.toml ----

  app.get('/api/admin/codex/config', ADMIN, async () => codex('config/read', { includeLayers: true }));

  app.put('/api/admin/codex/config', ADMIN, async (req) => {
    const { edits } = z
      .object({ edits: z.array(z.object({ keyPath: KEY_PATH, value: z.unknown() }).strict()).min(1).max(50) })
      .strict()
      .parse(req.body);
    if (JSON.stringify(edits).length > 64_000) throw new ApiError(413, 'payload_too_large');
    await codex('config/batchWrite', { edits: edits.map((e) => ({ keyPath: e.keyPath, value: e.value ?? null, mergeStrategy: 'replace' })), reloadUserConfig: true });
    await ops.refreshCodexDefaults();
    audit.security('codex_config_changed', eventCtx(req), { keys: edits.map((e) => e.keyPath) });
    return { ok: true };
  });

  // ---- feature flags (`codex features`, `/experimental`) ----

  app.get('/api/admin/codex/features', ADMIN, async () => {
    const all: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const res: { data: unknown[]; nextCursor?: string | null } = await codex('experimentalFeature/list', { cursor });
      all.push(...res.data);
      cursor = res.nextCursor ?? null;
      if (!cursor) break;
    }
    return { features: all };
  });

  app.put('/api/admin/codex/features', ADMIN, async (req) => {
    const { enablement } = z.object({ enablement: z.record(z.string().regex(/^[a-z0-9_]{1,100}$/), z.boolean()) }).strict().parse(req.body);
    await codex('experimentalFeature/enablement/set', { enablement });
    audit.security('codex_features_changed', eventCtx(req), enablement);
    return { ok: true };
  });

  // ---- hooks, plugins, apps, skills ----

  app.get('/api/admin/codex/hooks', ADMIN, async () => codex('hooks/list', { cwds: [workspace.realRoot] }));

  app.get('/api/admin/codex/plugins', ADMIN, async () => optional('plugin/list', {}));

  app.post('/api/admin/codex/plugins/install', ADMIN, async (req) => {
    const body = z
      .object({ pluginName: z.string().min(1).max(200), marketplacePath: z.string().max(4096).nullable().optional(), remoteMarketplaceName: z.string().max(200).nullable().optional() })
      .strict()
      .parse(req.body);
    const res = await codex('plugin/install', { pluginName: body.pluginName, marketplacePath: body.marketplacePath ?? null, remoteMarketplaceName: body.remoteMarketplaceName ?? null, installAttemptId: null });
    audit.security('plugin_installed', eventCtx(req), { plugin: body.pluginName });
    return res;
  });

  app.post('/api/admin/codex/plugins/uninstall', ADMIN, async (req) => {
    const { pluginId } = z.object({ pluginId: z.string().min(1).max(300) }).strict().parse(req.body);
    await codex('plugin/uninstall', { pluginId });
    audit.security('plugin_uninstalled', eventCtx(req), { plugin: pluginId });
    return { ok: true };
  });

  app.get('/api/admin/codex/apps', ADMIN, async () => optional('app/list', {}));

  app.get('/api/admin/codex/skills', ADMIN, async () => ({ skills: await ops.skills(workspace.realRoot) }));

  app.post('/api/admin/codex/skills', ADMIN, async (req) => {
    const { path, enabled } = z.object({ path: z.string().min(1).max(4096), enabled: z.boolean() }).strict().parse(req.body);
    const known = await ops.skills(workspace.realRoot);
    if (!known.some((s) => s.path === path)) throw new ApiError(404, 'not_found', 'unknown skill');
    await codex('skills/config/write', { path, enabled, name: null });
    audit.security('codex_config_changed', eventCtx(req), { skill: path, enabled });
    return { ok: true };
  });

  // ---- memories (`/memories`) ----

  app.get('/api/admin/codex/memory', ADMIN, async () => optional('memory/status', {}));

  app.post('/api/admin/codex/memory/reset', ADMIN, async (req) => {
    await codex('memory/reset', {});
    audit.security('memory_reset', eventCtx(req));
    return { ok: true };
  });

  // ---- import from other coding agents (`/import`) ----

  app.get('/api/admin/codex/import', ADMIN, async () => optional('externalAgentConfig/detect', { cwds: [workspace.realRoot], includeHome: true }));

  app.post('/api/admin/codex/import', ADMIN, async (req) => {
    const { items } = z.object({ items: z.array(z.record(z.string(), z.unknown())).min(1).max(100) }).strict().parse(req.body);
    const res = await codex('externalAgentConfig/import', { migrationItems: items });
    audit.security('agent_config_imported', eventCtx(req), { count: items.length });
    return res;
  });

  // ---- feedback and diagnostics ----

  app.post('/api/admin/codex/feedback', ADMIN, async (req) => {
    const body = feedbackBody.parse(req.body);
    await ops.feedback(null, { classification: body.classification, reason: body.reason ?? null, includeLogs: body.includeLogs }, eventCtx(req));
    return { ok: true };
  });

  app.get('/api/admin/codex/warnings', ADMIN, async () => ({ warnings: bridge.warnings().reverse() }));

  // `codex doctor`: read-only checks of the installation, config, auth and runtime.
  app.post('/api/admin/codex/doctor', ADMIN, async () => {
    const res = await bridge.runCli(['doctor'], 90_000);
    return { ok: res.ok, output: res.output.replace(ANSI, '').slice(0, 200_000) };
  });
}
