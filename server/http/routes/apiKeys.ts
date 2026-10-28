import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { API_KEY_SCOPES, DANGEROUS_SCOPES, QUOTA_PERIODS, type ApiKeySecret } from '../../../shared/api.js';
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
    scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length),
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

export function registerApiKeyRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { db, keys, audit, workspace, config, turns } = deps;
  const queries = new AdminQueries(db);

  const info = (id: string) => {
    const key = keys.get(id);
    if (!key) throw new ApiError(404, 'api_key_not_found');
    return queries.keyInfo(key, keys);
  };

  app.get('/api/admin/api-keys', ADMIN, async () => ({
    keys: keys.list().map((k) => queries.keyInfo(k, keys)),
    api: { enabled: config.api.enabled, baseUrl: config.api.publicOrigin },
  }));

  app.post('/api/admin/api-keys', ADMIN, async (req): Promise<ApiKeySecret> => {
    const body = createSchema.parse(req.body);
    const folderRel = body.folder?.trim() || `api/${defaultFolderName(body.label)}`;
    const abs = await makeSessionFolder(workspace, folderRel);
    const settings: ApiKeySettings = {
      label: body.label,
      scopes: body.scopes,
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
      dangerous: body.scopes.filter((s) => DANGEROUS_SCOPES.includes(s)),
      maxSandbox: body.maxSandbox,
    });
    return { key: queries.keyInfo(key, keys), secret, baseUrl: config.api.publicOrigin };
  });

  app.get('/api/admin/api-keys/:id/usage', ADMIN, async (req) => {
    const { id } = idParam.parse(req.params);
    const { tz } = z.object({ tz: z.coerce.number().int().min(-840).max(840).default(0) }).parse(req.query);
    const key = keys.get(id);
    if (!key) throw new ApiError(404, 'api_key_not_found');
    return queries.keyUsage(key, keys, tz);
  });

  app.patch('/api/admin/api-keys/:id', ADMIN, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = updateSchema.parse(req.body);
    const before = keys.get(id);
    if (!before) throw new ApiError(404, 'api_key_not_found');
    if (before.revokedAt !== null) throw new ApiError(409, 'api_key_revoked');
    keys.update(id, body);
    // A new expiry applies to running turns too.
    turns.keyChanged(id);
    audit.security('api_key_updated', { ...eventCtx(req), apiKeyId: id }, body);
    return { key: info(id) };
  });

  app.post('/api/admin/api-keys/:id/rotate', ADMIN, async (req): Promise<ApiKeySecret> => {
    const { id } = idParam.parse(req.params);
    const { graceSec } = z.object({ graceSec: z.union([z.literal(0), z.literal(3600), z.literal(86_400)]) }).strict().parse(req.body);
    const secret = keys.rotate(id, graceSec * 1000);
    if (!secret) throw new ApiError(404, 'api_key_not_found');
    audit.security('api_key_rotated', { ...eventCtx(req), apiKeyId: id }, { graceSec });
    return { key: info(id), secret, baseUrl: config.api.publicOrigin };
  });

  app.post('/api/admin/api-keys/:id/revoke', ADMIN, async (req) => {
    const { id } = idParam.parse(req.params);
    if (!keys.get(id)) throw new ApiError(404, 'api_key_not_found');
    keys.revoke(id);
    turns.interruptForKey(id);
    deps.queue.clearKey(id);
    audit.security('api_key_revoked', { ...eventCtx(req), apiKeyId: id });
    return { key: info(id) };
  });
}
