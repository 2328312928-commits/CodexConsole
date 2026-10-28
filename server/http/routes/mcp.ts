import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { McpServerInput } from '../../../shared/api.js';
import type { McpManager } from '../../codex/mcp.js';
import type { AuditLog, EventContext } from '../../services/audit.js';
import { eventCtx, type AppDeps } from '../context.js';

const ADMIN = { config: { auth: 'admin' as const } };
export const mcpNameParam = z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

export const mcpInputSchema = z
  .object({
    transport: z.enum(['stdio', 'http']),
    command: z.string().max(1000).optional(),
    args: z.array(z.string().max(2000)).max(100).optional(),
    cwd: z.string().max(1000).nullable().optional(),
    env: z.record(z.string().max(128), z.string().max(8000).nullable()).optional(),
    url: z.string().max(2000).optional(),
    bearerTokenEnvVar: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/).nullable().optional(),
    enabled: z.boolean().optional(),
    enabledTools: z.array(z.string().max(200)).max(500).nullable().optional(),
    disabledTools: z.array(z.string().max(200)).max(500).nullable().optional(),
    startupTimeoutSec: z.number().int().min(1).max(600).nullable().optional(),
    toolTimeoutSec: z.number().int().min(1).max(3600).nullable().optional(),
  })
  .strict();

/** The MCP operations shared by the admin routes and the public API's mcp:manage scope. */
export function mcpActions(mcp: McpManager, audit: AuditLog) {
  return {
    list: () => mcp.list(),
    async add(name: string, input: McpServerInput, ctx: EventContext) {
      await mcp.add(name, input);
      audit.security('mcp_server_added', ctx, { name, transport: input.transport, command: input.command ?? input.url });
    },
    async update(name: string, input: McpServerInput, ctx: EventContext) {
      await mcp.update(name, input);
      audit.security('mcp_server_updated', ctx, { name, transport: input.transport, command: input.command ?? input.url });
    },
    async setEnabled(name: string, enabled: boolean, ctx: EventContext) {
      await mcp.setEnabled(name, enabled);
      audit.security('mcp_server_updated', ctx, { name, enabled });
    },
    async remove(name: string, ctx: EventContext) {
      await mcp.remove(name);
      audit.security('mcp_server_removed', ctx, { name });
    },
    async login(name: string, ctx: EventContext) {
      const res = await mcp.login(name);
      audit.security('mcp_login_started', ctx, { name });
      return res;
    },
    logout: (name: string) => mcp.logout(name),
  };
}

export function registerMcpRoutes(app: FastifyInstance, deps: AppDeps): void {
  const actions = mcpActions(deps.mcp, deps.audit);

  app.get('/api/admin/mcp', ADMIN, async () => ({ servers: await actions.list() }));

  app.post('/api/admin/mcp', ADMIN, async (req) => {
    const body = mcpInputSchema.extend({ name: mcpNameParam.shape.name }).parse(req.body);
    const { name, ...input } = body;
    await actions.add(name, input, eventCtx(req));
    return { servers: await actions.list() };
  });

  app.put('/api/admin/mcp/:name', ADMIN, async (req) => {
    const { name } = mcpNameParam.parse(req.params);
    await actions.update(name, mcpInputSchema.parse(req.body), eventCtx(req));
    return { servers: await actions.list() };
  });

  app.post('/api/admin/mcp/:name/enabled', ADMIN, async (req) => {
    const { name } = mcpNameParam.parse(req.params);
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body);
    await actions.setEnabled(name, enabled, eventCtx(req));
    return { servers: await actions.list() };
  });

  app.delete('/api/admin/mcp/:name', ADMIN, async (req) => {
    const { name } = mcpNameParam.parse(req.params);
    await actions.remove(name, eventCtx(req));
    return { servers: await actions.list() };
  });

  app.post('/api/admin/mcp/:name/login', ADMIN, async (req) => {
    const { name } = mcpNameParam.parse(req.params);
    return actions.login(name, eventCtx(req));
  });

  app.post('/api/admin/mcp/:name/logout', ADMIN, async (req) => {
    const { name } = mcpNameParam.parse(req.params);
    await actions.logout(name);
    return { servers: await actions.list() };
  });
}
