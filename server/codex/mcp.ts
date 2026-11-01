import type { McpServerInput, McpServerView } from '../../shared/api.js';
import { ApiError } from '../lib/errors.js';
import type { CodexBridge } from './bridge.js';

export const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

interface McpConfigEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  bearer_token_env_var?: string;
  enabled?: boolean;
  enabled_tools?: string[];
  disabled_tools?: string[];
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
}

interface McpStatus {
  name: string;
  runtimeStatus: string | null;
  serverInfo: { name: string; version: string } | null;
  tools: Record<string, { name: string; description?: string } | undefined>;
  toolsError: string | null;
  resources: unknown[];
  authStatus: string;
}

function toEntry(input: McpServerInput, previousEnv: Record<string, string> = {}): McpConfigEntry {
  const entry: McpConfigEntry = {};
  if (input.transport === 'stdio') {
    if (!input.command?.trim()) throw new ApiError(400, 'bad_request', 'command is required for a local server');
    entry.command = input.command.trim();
    entry.args = (input.args ?? []).map(String);
    if (input.cwd) entry.cwd = input.cwd;
    // Env values are write-only: null deletes a variable, an omitted value keeps the old one.
    const env: Record<string, string> = { ...previousEnv };
    for (const [k, v] of Object.entries(input.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k)) throw new ApiError(400, 'bad_request', `invalid environment variable name: ${k}`);
      if (v === null) delete env[k];
      else if (v !== '') env[k] = v;
    }
    if (input.env) for (const k of Object.keys(env)) if (!(k in input.env)) delete env[k];
    if (Object.keys(env).length) entry.env = env;
  } else {
    let url: URL;
    try {
      url = new URL(input.url ?? '');
    } catch {
      throw new ApiError(400, 'bad_request', 'a valid https:// (or http://localhost) URL is required');
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new ApiError(400, 'bad_request', 'remote MCP servers must use https://');
    entry.url = url.toString();
    if (input.bearerTokenEnvVar) entry.bearer_token_env_var = input.bearerTokenEnvVar;
  }
  entry.enabled = input.enabled ?? true;
  if (input.enabledTools) entry.enabled_tools = input.enabledTools;
  if (input.disabledTools) entry.disabled_tools = input.disabledTools;
  if (input.startupTimeoutSec) entry.startup_timeout_sec = input.startupTimeoutSec;
  if (input.toolTimeoutSec) entry.tool_timeout_sec = input.toolTimeoutSec;
  return entry;
}

/**
 * Codex's MCP servers, managed through Codex itself: its config API (the same file
 * `codex mcp add/remove` edits), its live status list and its OAuth sign-in.
 */
export class McpManager {
  constructor(private readonly bridge: CodexBridge) {}

  private async config(): Promise<Record<string, McpConfigEntry>> {
    const res = await this.bridge.request<{ config: { mcp_servers?: Record<string, McpConfigEntry> } }>('config/read', {}).catch((err) => {
      throw new ApiError(502, 'mcp_error', (err as Error).message);
    });
    return res.config.mcp_servers ?? {};
  }

  private async write(keyPath: string, value: unknown): Promise<void> {
    await this.bridge.request('config/value/write', { keyPath, value, mergeStrategy: 'replace' }).catch((err) => {
      throw new ApiError(502, 'mcp_error', (err as Error).message);
    });
    await this.bridge.request('config/mcpServer/reload', undefined).catch(() => undefined);
  }

  async list(): Promise<McpServerView[]> {
    const config = await this.config();
    const statusRes = await this.bridge
      .request<{ data: McpStatus[] }>('mcpServerStatus/list', { detail: 'full', limit: 200 })
      .catch(() => ({ data: [] as McpStatus[] }));
    const status = new Map(statusRes.data.map((s) => [s.name, s]));
    const names = new Set([...Object.keys(config), ...status.keys()]);
    return [...names].sort().map((name) => {
      const c = config[name] ?? {};
      const s = status.get(name);
      return {
        name,
        enabled: c.enabled !== false,
        transport: c.url ? 'http' : 'stdio',
        command: c.command ?? null,
        args: c.args ?? [],
        cwd: c.cwd ?? null,
        envKeys: Object.keys(c.env ?? {}).sort(),
        url: c.url ?? null,
        bearerTokenEnvVar: c.bearer_token_env_var ?? null,
        enabledTools: c.enabled_tools ?? null,
        disabledTools: c.disabled_tools ?? null,
        startupTimeoutSec: c.startup_timeout_sec ?? null,
        toolTimeoutSec: c.tool_timeout_sec ?? null,
        runtimeStatus: c.enabled === false ? 'disabled' : (s?.runtimeStatus ?? null),
        authStatus: s?.authStatus ?? null,
        serverInfo: s?.serverInfo ? { name: s.serverInfo.name, version: s.serverInfo.version } : null,
        tools: Object.values(s?.tools ?? {})
          .filter((t): t is { name: string; description?: string } => Boolean(t))
          .map((t) => ({ name: t.name, description: t.description ?? null })),
        resourceCount: s?.resources?.length ?? 0,
        error: s?.toolsError ?? null,
      };
    });
  }

  async add(name: string, input: McpServerInput): Promise<void> {
    if (!MCP_NAME_RE.test(name)) throw new ApiError(400, 'invalid_name');
    const config = await this.config();
    if (config[name]) throw new ApiError(409, 'mcp_server_exists');
    await this.write(`mcp_servers.${name}`, toEntry(input));
  }

  async update(name: string, input: McpServerInput): Promise<void> {
    const config = await this.config();
    const cur = config[name];
    if (!cur) throw new ApiError(404, 'mcp_server_not_found');
    await this.write(`mcp_servers.${name}`, toEntry(input, cur.env));
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const config = await this.config();
    if (!config[name]) throw new ApiError(404, 'mcp_server_not_found');
    await this.write(`mcp_servers.${name}.enabled`, enabled);
  }

  async remove(name: string): Promise<void> {
    const config = await this.config();
    if (!config[name]) throw new ApiError(404, 'mcp_server_not_found');
    await this.write(`mcp_servers.${name}`, null);
  }

  /** Starts OAuth sign-in and returns the link for the owner to open (never opened here). */
  async login(name: string): Promise<{ authorizationUrl: string }> {
    if (!MCP_NAME_RE.test(name)) throw new ApiError(400, 'invalid_name');
    const res = await this.bridge.request<{ authorizationUrl: string }>('mcpServer/oauth/login', { name }).catch((err) => {
      throw new ApiError(502, 'mcp_error', (err as Error).message);
    });
    if (!/^https?:\/\//i.test(res.authorizationUrl)) throw new ApiError(502, 'mcp_error', 'unexpected sign-in link');
    return { authorizationUrl: res.authorizationUrl };
  }

  /** Read one of a server's resources (Codex's MCP resource tool). */
  async readResource(name: string, uri: string): Promise<{ contents: unknown[] }> {
    if (!MCP_NAME_RE.test(name)) throw new ApiError(400, 'invalid_name');
    const res = await this.bridge.request<{ contents: unknown[] }>('mcpServer/resource/read', { server: name, uri }).catch((err) => {
      throw new ApiError(502, 'mcp_error', (err as Error).message);
    });
    return { contents: Array.isArray(res.contents) ? res.contents : [] };
  }

  async logout(name: string): Promise<void> {
    if (!MCP_NAME_RE.test(name)) throw new ApiError(400, 'invalid_name');
    // Through the bridge, so it also works when Codex runs as its own user behind the relay.
    const r = await this.bridge.runCli(['mcp', 'logout', name], 30_000);
    if (!r.ok) throw new ApiError(502, 'mcp_error', r.output.slice(0, 500));
  }
}
