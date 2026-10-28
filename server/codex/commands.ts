import type { ApiKeyScope, CommandResult, ReviewTarget, SessionInfo } from '../../shared/api.js';
import type { AskForApproval, SandboxMode } from '../../shared/codex.js';
import { ApiError } from '../lib/errors.js';
import type { EventContext } from '../services/audit.js';
import type { SessionRow } from '../services/sessions.js';
import type { Workspace } from '../services/workspace.js';
import type { McpManager } from './mcp.js';
import { INIT_PROMPT, type KeyCaps, type SessionOps } from './sessionOps.js';
import type { KeyContext, TurnManager } from './turns.js';

/** Commands understood by the console composer and by POST …/command. */
export const SLASH_COMMANDS: Array<{ name: string; args: string; scope: ApiKeyScope }> = [
  { name: '/help', args: '', scope: 'prompt' },
  { name: '/new', args: '[title]', scope: 'prompt' },
  { name: '/fork', args: '[turn id]', scope: 'sessions' },
  { name: '/undo', args: '[turn id]', scope: 'sessions' },
  { name: '/model', args: '[model] [effort]', scope: 'settings' },
  { name: '/approvals', args: 'untrusted | on-request | never', scope: 'settings' },
  { name: '/sandbox', args: 'read-only | workspace-write | danger-full-access', scope: 'settings' },
  { name: '/network', args: 'on | off', scope: 'settings' },
  { name: '/review', args: '[uncommitted | branch <name> | commit <sha> | <instructions>]', scope: 'sessions' },
  { name: '/compact', args: '', scope: 'sessions' },
  { name: '/diff', args: '', scope: 'prompt' },
  { name: '/init', args: '', scope: 'prompt' },
  { name: '/skills', args: '', scope: 'prompt' },
  { name: '/status', args: '', scope: 'prompt' },
  { name: '/mcp', args: '', scope: 'mcp:read' },
  { name: '/goal', args: '[objective | clear]', scope: 'sessions' },
  { name: '/plan', args: '[on | off]', scope: 'settings' },
  { name: '/permissions', args: 'read-only | auto | full-access', scope: 'settings' },
  { name: '/rename', args: '<title>', scope: 'sessions' },
  { name: '/archive', args: '', scope: 'sessions' },
  { name: '/unarchive', args: '', scope: 'sessions' },
  { name: '/cd', args: '<folder>', scope: 'sessions' },
  { name: '/pwd', args: '', scope: 'prompt' },
  { name: '/ps', args: '', scope: 'prompt' },
  { name: '/stop', args: '', scope: 'sessions' },
  { name: '/summary', args: '', scope: 'prompt' },
  { name: '/clear', args: '', scope: 'prompt' },
  { name: '!', args: '<shell command>', scope: 'shell' },
];

/** `/permissions` presets, as in the Codex TUI. */
const PERMISSION_PRESETS: Record<string, { sandbox: SandboxMode; approvalPolicy: AskForApproval }> = {
  'read-only': { sandbox: 'read-only', approvalPolicy: 'on-request' },
  auto: { sandbox: 'workspace-write', approvalPolicy: 'on-request' },
  'full-access': { sandbox: 'danger-full-access', approvalPolicy: 'never' },
};

const SUMMARY_PROMPT = 'Summarize this conversation so far: what was asked, what was done, the current state, and any open questions. Be brief.';

const APPROVALS: AskForApproval[] = ['untrusted', 'on-request', 'never'];
const SANDBOXES: SandboxMode[] = ['read-only', 'workspace-write', 'danger-full-access'];

export interface CommandContext {
  ops: SessionOps;
  turns: TurnManager;
  mcp: McpManager;
  session: SessionRow;
  ctx: EventContext;
  /** Present when an API key runs the command. */
  key: { caps: KeyCaps; context: KeyContext; hasScope: (s: ApiKeyScope) => boolean } | null;
  newSession: (title: string) => Promise<SessionInfo>;
  /** Where `/cd` may go (the key's folder for API keys). */
  folderRoot?: Workspace;
  rename: (title: string) => Promise<void>;
  archive: (archived: boolean) => Promise<void>;
}

export function parseReviewTarget(args: string): ReviewTarget {
  const a = args.trim();
  if (!a || a === 'uncommitted') return { type: 'uncommittedChanges' };
  const branch = /^branch\s+(\S+)$/.exec(a);
  if (branch) return { type: 'baseBranch', branch: branch[1]! };
  const commit = /^commit\s+([0-9a-fA-F]{4,64})$/.exec(a);
  if (commit) return { type: 'commit', sha: commit[1]!, title: null };
  return { type: 'custom', instructions: a.slice(0, 4000) };
}

export async function runCommand(c: CommandContext, input: string): Promise<CommandResult> {
  const text = input.trim();
  const caps = c.key?.caps ?? null;
  const apiKey = c.key?.context ?? null;
  const need = (scope: ApiKeyScope) => {
    if (c.key && !c.key.hasScope(scope)) throw new ApiError(403, 'scope_missing', scope);
  };

  if (text.startsWith('!')) {
    need('shell');
    const command = text.slice(1).trim();
    if (!command) throw new ApiError(400, 'bad_request', 'empty shell command');
    const r = await c.ops.shell(c.session, command, c.ctx, caps, apiKey);
    return { kind: 'turn', ...r };
  }
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) throw new ApiError(400, 'unknown_command');
  const name = `/${m[1]}`;
  const args = (m[2] ?? '').trim();
  const def = SLASH_COMMANDS.find((d) => d.name === name);
  if (!def) throw new ApiError(400, 'unknown_command', name);
  need(def.scope);

  switch (name) {
    case '/help':
      return { kind: 'help', commands: SLASH_COMMANDS.map(({ name: n, args: a }) => ({ name: n, args: a })) };
    case '/new':
    case '/clear':
      return { kind: 'session', session: await c.newSession(args) };
    case '/plan': {
      const on = args === '' ? c.ops.effective(c.session, caps).mode !== 'plan' : args === 'on';
      if (args && args !== 'on' && args !== 'off') throw new ApiError(400, 'bad_request', 'on | off');
      const row = c.ops.updateSettings(c.session, { mode: on ? 'plan' : 'default' }, caps);
      return { kind: 'settings', session: c.ops.info(row), effective: c.ops.effective(row, caps) };
    }
    case '/permissions': {
      const preset = PERMISSION_PRESETS[args];
      if (!preset) throw new ApiError(400, 'bad_request', Object.keys(PERMISSION_PRESETS).join(' | '));
      const row = c.ops.updateSettings(c.session, preset, caps);
      return { kind: 'settings', session: c.ops.info(row), effective: c.ops.effective(row, caps) };
    }
    case '/rename':
      if (!args) throw new ApiError(400, 'bad_request', 'a title is required');
      await c.rename(args.slice(0, 200));
      return { kind: 'done' };
    case '/archive':
    case '/unarchive':
      await c.archive(name === '/archive');
      return { kind: 'done' };
    case '/cd': {
      if (!args) throw new ApiError(400, 'bad_request', 'a folder is required');
      const row = await c.ops.changeFolder(c.session, args, c.folderRoot);
      return { kind: 'session', session: c.ops.info(row) };
    }
    case '/pwd':
      return { kind: 'info', text: c.session.cwd };
    case '/ps':
      return { kind: 'terminals', terminals: await c.ops.terminals(c.session) };
    case '/stop':
      await c.ops.stopTerminal(c.session, null);
      return { kind: 'done' };
    case '/summary': {
      const r = await c.turns.startTurn({ session: c.session, ctx: c.ctx, text: SUMMARY_PROMPT, attachments: [], settings: c.ops.effective(c.session, caps), apiKey });
      return { kind: 'turn', ...r };
    }
    case '/fork':
      return { kind: 'session', session: c.ops.info(await c.ops.fork(c.session, args || null, c.ctx, caps)) };
    case '/undo':
      await c.ops.undo(c.session, args || null, caps);
      return { kind: 'done' };
    case '/model': {
      if (!args) return { kind: 'models', models: await c.ops.models(), current: c.session.model };
      const [model, effort] = args.split(/\s+/);
      const models = await c.ops.models();
      const chosen = model === 'default' ? null : model!;
      if (chosen && models.length > 0 && !models.some((x) => x.id === chosen)) throw new ApiError(400, 'bad_request', `unknown model: ${chosen}`);
      const row = c.ops.updateSettings(c.session, { model: chosen, ...(effort ? { effort: effort === 'default' ? null : effort } : {}) }, caps);
      return { kind: 'settings', session: c.ops.info(row), effective: c.ops.effective(row, caps) };
    }
    case '/approvals':
    case '/sandbox':
    case '/network': {
      let patch;
      if (name === '/approvals') {
        if (!APPROVALS.includes(args as AskForApproval)) throw new ApiError(400, 'bad_request', APPROVALS.join(' | '));
        patch = { approvalPolicy: args as AskForApproval };
      } else if (name === '/sandbox') {
        if (!SANDBOXES.includes(args as SandboxMode)) throw new ApiError(400, 'bad_request', SANDBOXES.join(' | '));
        patch = { sandbox: args as SandboxMode };
      } else {
        if (args !== 'on' && args !== 'off') throw new ApiError(400, 'bad_request', 'on | off');
        patch = { networkAccess: args === 'on' };
      }
      const row = c.ops.updateSettings(c.session, patch, caps);
      return { kind: 'settings', session: c.ops.info(row), effective: c.ops.effective(row, caps) };
    }
    case '/review':
      return { kind: 'turn', ...(await c.ops.review(c.session, parseReviewTarget(args), c.ctx, caps, apiKey)) };
    case '/compact':
      return { kind: 'turn', ...(await c.ops.compact(c.session, c.ctx, caps, apiKey)) };
    case '/diff':
      return { kind: 'diff', ...(await c.ops.diff(c.session)) };
    case '/init': {
      const r = await c.turns.startTurn({
        session: c.session,
        ctx: c.ctx,
        text: INIT_PROMPT,
        attachments: [],
        settings: c.ops.effective(c.session, caps),
        apiKey,
      });
      return { kind: 'turn', ...r };
    }
    case '/skills':
      return { kind: 'skills', skills: await c.ops.skills(c.session.cwd) };
    case '/status':
      return { kind: 'status', status: await c.ops.status(c.session, caps) };
    case '/mcp':
      return { kind: 'mcp', servers: await c.mcp.list() };
    case '/goal': {
      if (!args) return { kind: 'goal', goal: await c.ops.goal(c.session) };
      if (args === 'clear') {
        await c.ops.clearGoal(c.session);
        return { kind: 'goal', goal: null };
      }
      return { kind: 'goal', goal: await c.ops.setGoal(c.session, args.slice(0, 4000), null, caps) };
    }
    default:
      throw new ApiError(400, 'unknown_command', name);
  }
}
