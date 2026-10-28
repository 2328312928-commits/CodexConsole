import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { REQUEST_STATUSES, SECURITY_EVENT_KINDS, type LoginSessionInfo, type PairingInfo } from '../../../shared/api.js';
import { ApiError } from '../../lib/errors.js';
import { qrSvg } from '../../lib/qr.js';
import { AdminQueries, type RequestFilter } from '../../services/adminQueries.js';
import { eventCtx, type AppDeps } from '../context.js';
import { codexStatus } from './sessions.js';

const ADMIN = { config: { auth: 'admin' as const } };
const DAY = 86_400_000;
const page = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
});
const idParam = z.object({ id: z.string().min(1).max(100) });
const deviceName = z.string().trim().min(1).max(60);

const requestFilter = page.extend({
  device: z.string().max(100).optional(),
  key: z.string().max(100).optional(),
  status: z.enum(REQUEST_STATUSES).optional(),
  session: z.string().max(100).optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
});

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function registerAdminRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, devices, logins, audit, settings, bridge, turns, config } = deps;
  const queries = new AdminQueries(db);

  const toFilter = (q: z.infer<typeof requestFilter>): RequestFilter => ({
    deviceId: q.device,
    apiKeyId: q.key,
    status: q.status,
    sessionId: q.session,
    from: q.from,
    to: q.to,
  });

  async function pairingInfo(deviceId: string, code: string, expiresAt: number): Promise<PairingInfo> {
    const pairUrl = `${config.publicOrigin}/pair#code=${encodeURIComponent(code)}`;
    const usage = queries.usageByDevice(Date.now() - 30 * DAY).get(deviceId);
    return { device: queries.deviceInfo(devices.get(deviceId)!, usage), code, expiresAt, pairUrl, qrSvg: await qrSvg(pairUrl) };
  }

  app.get('/api/admin/overview', ADMIN, async (req) => {
    const { tz } = z.object({ tz: z.coerce.number().int().min(-840).max(840).default(0) }).parse(req.query);
    const now = Date.now();
    const activeKeys = deps.keys.list(now).filter((k) => deps.keys.status(k, now) === 'active').length;
    const apiRequests24h = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM requests WHERE api_key_id IS NOT NULL AND started_at >= ?', now - DAY)!.n;
    return {
      codex: codexStatus(deps, true),
      publicApi: {
        enabled: config.api.enabled,
        baseUrl: config.api.publicOrigin,
        listen: `${config.api.host}:${config.api.port}`,
        proxyProtocol: config.api.proxyProtocol,
        activeKeys,
        requests24h: apiRequests24h,
      },
      ...queries.overview(tz),
    };
  });

  app.get('/api/admin/requests', ADMIN, async (req) => {
    const q = requestFilter.parse(req.query);
    return queries.requests(toFilter(q), q.limit, q.offset);
  });

  app.get('/api/admin/requests.csv', ADMIN, async (req, reply) => {
    const q = requestFilter.parse(req.query);
    const { rows } = queries.requests(toFilter(q), 100_000, 0);
    const cols = [
      'id', 'kind', 'startedAt', 'completedAt', 'durationMs', 'status', 'sessionId', 'sessionTitle', 'deviceName', 'apiKeyLabel', 'promptChars', 'promptBytes',
      'attachmentCount', 'attachmentBytes', 'mediaCount', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'model', 'error', 'ip',
    ] as const;
    const lines = [cols.join(',')];
    for (const r of rows) {
      lines.push(
        cols
          .map((c) => (c === 'startedAt' || c === 'completedAt' ? (r[c] ? new Date(r[c]!).toISOString() : '') : csvCell(r[c])))
          .join(','),
      );
    }
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="codex-console-requests-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send('﻿' + lines.join('\r\n'));
  });

  app.get('/api/admin/devices', ADMIN, async () => {
    const usage = queries.usageByDevice(Date.now() - 30 * DAY);
    return { devices: devices.list().map((d) => queries.deviceInfo(d, usage.get(d.id))) };
  });

  app.post('/api/admin/devices', ADMIN, async (req) => {
    const body = z.object({ name: deviceName, expiresInDays: z.number().int().min(1).max(3650).nullable().optional() }).strict().parse(req.body);
    const expiresAt = body.expiresInDays ? Date.now() + body.expiresInDays * DAY : null;
    const { device, code, codeExpiresAt } = devices.create(body.name, expiresAt);
    audit.security('device_created', eventCtx(req), { device: device.id, name: device.name });
    return pairingInfo(device.id, code, codeExpiresAt);
  });

  app.post('/api/admin/devices/:id/pairing', ADMIN, async (req) => {
    const { id } = idParam.parse(req.params);
    const d = devices.get(id);
    if (!d) throw new ApiError(404, 'device_not_found');
    if (d.revoked_at !== null) throw new ApiError(409, 'bad_request', 'device revoked');
    const { code, expiresAt } = devices.issuePairingCode(id);
    audit.security('device_pairing_code', eventCtx(req), { device: id });
    return pairingInfo(id, code, expiresAt);
  });

  app.patch('/api/admin/devices/:id', ADMIN, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ name: deviceName.optional(), expiresAt: z.number().int().nullable().optional() }).strict().parse(req.body);
    if (!devices.get(id)) throw new ApiError(404, 'device_not_found');
    if (body.name !== undefined) {
      devices.rename(id, body.name);
      audit.security('device_renamed', eventCtx(req), { device: id, name: body.name });
    }
    if (body.expiresAt !== undefined) {
      devices.setExpiry(id, body.expiresAt);
      audit.security('device_expiry_changed', eventCtx(req), { device: id, expiresAt: body.expiresAt });
    }
    return { device: queries.deviceInfo(devices.get(id)!, queries.usageByDevice(Date.now() - 30 * DAY).get(id)) };
  });

  app.post('/api/admin/devices/:id/revoke', ADMIN, async (req) => {
    const { id } = idParam.parse(req.params);
    if (!devices.get(id)) throw new ApiError(404, 'device_not_found');
    devices.revoke(id);
    audit.security('device_revoked', eventCtx(req), { device: id, self: id === req.auth.device!.id });
    return { ok: true };
  });

  app.get('/api/admin/logins', ADMIN, async (req) => {
    const names = new Map(devices.list().map((d) => [d.id, d.name]));
    const rows: LoginSessionInfo[] = logins.listActive().map((l) => ({
      id: l.id,
      deviceId: l.device_id,
      deviceName: names.get(l.device_id) ?? null,
      createdAt: l.created_at,
      lastSeenAt: l.last_seen_at,
      expiresAt: l.expires_at,
      ip: l.ip,
      userAgent: l.user_agent,
      admin: logins.isAdmin(l),
      current: l.id === req.auth.login!.id,
    }));
    return { logins: rows };
  });

  app.post('/api/admin/logins/:id/revoke', ADMIN, async (req) => {
    const { id } = idParam.parse(req.params);
    logins.revoke(id);
    audit.security('login_session_revoked', eventCtx(req), { session: id });
    return { ok: true };
  });

  app.post('/api/admin/logins/revoke-others', ADMIN, async (req) => {
    const n = logins.revokeAll(req.auth.login!.id);
    audit.security('sessions_revoked', eventCtx(req), { count: n });
    return { revoked: n };
  });

  app.get('/api/admin/transfers', ADMIN, async (req) => {
    const q = page
      .extend({ device: z.string().max(100).optional(), key: z.string().max(100).optional(), direction: z.enum(['upload', 'download', 'view']).optional() })
      .parse(req.query);
    return queries.transfers({ deviceId: q.device, apiKeyId: q.key, direction: q.direction }, q.limit, q.offset);
  });

  app.get('/api/admin/security', ADMIN, async (req) => {
    const q = page.extend({ kind: z.enum(SECURITY_EVENT_KINDS).optional(), key: z.string().max(100).optional() }).parse(req.query);
    return queries.security({ kind: q.kind, apiKeyId: q.key }, q.limit, q.offset);
  });

  app.get('/api/admin/api-log', ADMIN, async (req) => {
    const q = page.extend({ device: z.string().max(100).optional(), key: z.string().max(100).optional() }).parse(req.query);
    return queries.apiLog({ deviceId: q.device, apiKeyId: q.key }, q.limit, q.offset);
  });

  app.get('/api/admin/settings', ADMIN, async () => settings.get());

  app.put('/api/admin/settings', ADMIN, async (req) => {
    const body = z
      .object({
        logRetentionDays: z.number().int().min(1).max(3650).optional(),
        approvalTimeoutSec: z.number().int().min(10).max(86_400).optional(),
        defaultSandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
        defaultApprovalPolicy: z.enum(['untrusted', 'on-request', 'never']).optional(),
        defaultNetworkAccess: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    const next = settings.update(body);
    turns.setApprovalTimeout(next.approvalTimeoutSec * 1000);
    audit.security('settings_changed', eventCtx(req), body);
    return next;
  });

  // Codex's own defaults (shared with the terminal Codex): model and reasoning effort.
  app.get('/api/admin/codex-defaults', ADMIN, async () => {
    const res = await bridge.request<{ config: { model?: string | null; model_reasoning_effort?: string | null } }>('config/read', {}).catch((err) => {
      throw new ApiError(502, 'codex_error', (err as Error).message);
    });
    return { model: res.config.model ?? null, effort: res.config.model_reasoning_effort ?? null };
  });

  app.put('/api/admin/codex-defaults', ADMIN, async (req) => {
    const body = z.object({ model: z.string().max(100).nullable(), effort: z.string().max(40).nullable() }).strict().parse(req.body);
    for (const [keyPath, value] of [['model', body.model], ['model_reasoning_effort', body.effort]] as const) {
      await bridge.request('config/value/write', { keyPath, value, mergeStrategy: 'replace' }).catch((err) => {
        throw new ApiError(502, 'codex_error', (err as Error).message);
      });
    }
    audit.security('codex_config_changed', eventCtx(req), body);
    return body;
  });

  app.get('/api/admin/codex', ADMIN, async () => ({
    status: codexStatus(deps, true),
    bin: config.codex.bin,
    stderr: bridge.stderr().slice(-200),
    runningTurns: turns.runningCount(),
  }));

  app.post('/api/admin/codex/refresh', ADMIN, async () => {
    await bridge.refreshAccount().catch((err) => {
      throw new ApiError(502, 'codex_error', (err as Error).message);
    });
    await bridge.refreshRateLimits();
    return { status: codexStatus(deps, true) };
  });
}
