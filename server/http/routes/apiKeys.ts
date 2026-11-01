import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { API_KEY_SCOPES, CONSOLE_ACCESS, DANGEROUS_SCOPES, QUOTA_PERIODS, type ApiKeySecret } from '../../../shared/api.js';
import type { ApiKeySettings } from '../../auth/apiKeys.js';
import { ApiError } from '../../lib/errors.js';
import { parseCidr } from '../../lib/net.js';
import { AdminQueries } from '../../services/adminQueries.js';
import { eventCtx, type AppDeps } from '../context.js';
import { defaultFolderName, makeSessionFolder } from './sessions.js';

const ADMIN = { config: { auth: 'admin' as const } };
const DAY = 86_400_000;
const idParam = z.object({ id: z.string().regex(/^[0-9a-f]{16}$/) });

const limitsSchema = z
  .object({
    perMinute: z.number().int().min(1).max(10_000),
    promptsPerMinute: z.number().int().min(1).max(1_000),
    concurrent: z.number().int().min(1).max(20),
    uploadMbPerHour: z.number().int().min(1).max(100_000),
  })
  .strict();

const cidr = z
  .string()
  .max(64)
  .refine((v) => parseCidr(v) !== null, 'not an IP address or CIDR range');

const settingsSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    scopes: z.array(z.enum(API_KEY_SCOPES)).max(API_KEY_SCOPES.length),
    consoleAccess: z.enum(CONSOLE_ACCESS),
    quotaTokens: z.number().int().min(1).max(1_000_000_000_000).nullable(),
    quotaPeriod: z.enum(QUOTA_PERIODS),
    maxSandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
    allowNetwork: z.boolean(),
    approvals: z.enum(['deny', 'ask']),
    limits: limitsSchema,
    ipAllowlist: z.array(cidr).max(50),
  })
  .strict();

const createSchema = settingsSchema.extend({
  expiresInDays: z.number().int().min(1).max(3650).nullable(),
  folder: z.string().max(500).optional(),
});

const updateSchema = settingsSchema.partial().extend({ expiresAt: z.number().int().nullable().optional() }).strict();

/** A key has to be good for something: the console, the API, or both. */
function assertUseful(consoleAccess: string, scopes: readonly string[]): void {
  if (consoleAccess === 'none' && scopes.length === 0) throw new ApiError(400, 'bad_request', 'give the key console access or at least one API scope');
}

export function registerApiKeyRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, keys, logins, audit, workspace, config, turns } = deps;
  const queries = new AdminQueries(db);

  const signInCounts = () => {
    const counts = new Map<string, number>();
    for (const l of logins.listActive()) counts.set(l.api_key_id, (counts.get(l.api_key_id) ?? 0) + 1);
    return counts;
  };

  const info = (id: string) => {
    const key = keys.get(id);
    if (!key) throw new ApiError(404, 'api_key_not_found');
    return queries.keyInfo(key, keys, signInCounts().get(id) ?? 0);
  };

  app.get('/api/admin/api-keys', ADMIN, async () => {
    const counts = signInCounts();
    return {
      keys: keys.list().map((k) => queries.keyInfo(k, keys, counts.get(k.id) ?? 0)),
      api: { enabled: config.api.enabled, baseUrl: config.api.publicOrigin },
      console: { url: config.publicOrigin },
    };
  });

  app.post('/api/admin/api-keys', ADMIN, async (req): Promise<ApiKeySecret> => {
    const body = createSchema.parse(req.body);
    assertUseful(body.consoleAccess, body.scopes);
    const folderRel = body.folder?.trim() || `api/${defaultFolderName(body.label)}`;
    // Only a folder key or an API key works in its folder; a full-console key gets one when it needs it.
    const needsFolder = body.consoleAccess === 'folder' || body.scopes.length > 0;
    const resolved = needsFolder ? null : await workspace.resolve(folderRel);
    if (resolved?.rel === '') throw new ApiError(400, 'path_invalid');
    const abs = resolved ? resolved.abs : await makeSessionFolder(workspace, folderRel);
    const settings: ApiKeySettings = {
      label: body.label,
      scopes: body.scopes,
      consoleAccess: body.consoleAccess,
      quotaTokens: body.quotaTokens,
      quotaPeriod: body.quotaPeriod,
      maxSandbox: body.maxSandbox,
      allowNetwork: body.allowNetwork,
      approvals: body.approvals,
      limits: body.limits,
      ipAllowlist: body.ipAllowlist,
      expiresAt: body.expiresInDays ? Date.now() + body.expiresInDays * DAY : null,
    };
    const { key, secret } = keys.create(settings, workspace.relOf(abs)!);
    audit.security('api_key_created', { ...eventCtx(req), apiKeyId: key.id }, {
      label: key.label,
      scopes: body.scopes,
      consoleAccess: body.consoleAccess,
      dangerous: body.scopes.filter((s) => DANGEROUS_SCOPES.includes(s)),
      maxSandbox: body.maxSandbox,
    });
    return { key: queries.keyInfo(key, keys), secret, baseUrl: config.api.publicOrigin, consoleUrl: config.publicOrigin };
  });

  app.get('/api/admin/api-keys/:id/usage', ADMIN, async (req) => {
    const { id } = idParam.parse(req.params);
    const { tz } = z.object({ tz: z.coerce.number().int().min(-840).max(840).default(0) }).parse(req.query);
    const key = keys.get(id);
    if (!key) throw new ApiError(404, 'api_key_not_found');
    return queries.keyUsage(key, keys, tz, signInCounts().get(id) ?? 0);
  });

  app.patch('/api/admin/api-keys/:id', ADMIN, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = updateSchema.parse(req.body);
    const before = keys.get(id);
    if (!before) throw new ApiError(404, 'api_key_not_found');
    if (before.revokedAt !== null) throw new ApiError(409, 'api_key_revoked');
    assertUseful(body.consoleAccess ?? before.consoleAccess, body.scopes ?? [...before.scopes]);
    keys.update(id, body);
    // A new expiry applies to running turns too.
    turns.keyChanged(id);
    // Different console access means signing in again; other changes (expiry, IP allowlist)
    // are checked on every request, and live streams re-check now.
    if (body.consoleAccess !== undefined && body.consoleAccess !== before.consoleAccess) logins.endForKey(id);
    else logins.changes.emit('changed');
    audit.security('api_key_updated', { ...eventCtx(req), apiKeyId: id }, body);
    return { key: info(id) };
  });

  app.post('/api/admin/api-keys/:id/rotate', ADMIN, async (req): Promise<ApiKeySecret> => {
    const { id } = idParam.parse(req.params);
    const { graceSec } = z.object({ graceSec: z.union([z.literal(0), z.literal(3600), z.literal(86_400)]) }).strict().parse(req.body);
    const secret = keys.rotate(id, graceSec * 1000);
    if (!secret) throw new ApiError(404, 'api_key_not_found');
    // A new secret signs the key out of the console everywhere (the grace period is for API scripts).
    const ended = logins.endForKey(id);
    audit.security('api_key_rotated', { ...eventCtx(req), apiKeyId: id }, { graceSec, signedOut: ended });
    return { key: info(id), secret, baseUrl: config.api.publicOrigin, consoleUrl: config.publicOrigin };
  });

  app.post('/api/admin/api-keys/:id/revoke', ADMIN, async (req) => {
    const { id } = idParam.parse(req.params);
    if (!keys.get(id)) throw new ApiError(404, 'api_key_not_found');
    keys.revoke(id);
    const ended = logins.endForKey(id);
    turns.interruptForKey(id);
    deps.queue.clearKey(id);
    audit.security('api_key_revoked', { ...eventCtx(req), apiKeyId: id }, { signedOut: ended });
    return { key: info(id) };
  });
}
