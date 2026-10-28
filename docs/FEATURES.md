# Codex feature checklist

[中文版](FEATURES.zh-CN.md)

What Codex CLI 0.164.0 offers (its CLI, TUI slash commands and app-server protocol) and where each part lives in the console. **Console** = web UI, **API** = public `/v1` API with keys, **Admin** = admin area (fresh TOTP). `npm run codex:check` verifies every protocol method the console uses against the installed Codex.

✅ supported · ⚠️ supported with a limit (see note) · — not applicable

## Conversations

| Codex feature | Console | API | Notes |
| --- | --- | --- | --- |
| Send a prompt, stream the answer (`codex`, `codex exec`) | ✅ | ✅ | API: `wait`, SSE, or polling |
| Structured output (`exec --output-schema`) | — | ✅ | `outputSchema` on `/turns` |
| Steer the running turn | ✅ | ✅ | Steer button / `POST …/steer` |
| Queue messages while busy (`codex queue`) | ✅ | ✅ | Runs in order; pauses if a turn fails or is stopped |
| Interrupt | ✅ | ✅ | |
| Plan mode (`/plan`) | ✅ | ✅ | Plan toggle in the composer |
| Reasoning summaries and raw reasoning | ✅ | ✅ | |
| Plans, todo lists, turn diffs, token usage | ✅ | ✅ | |
| Codex's own questions and MCP elicitations (forms and links) | ✅ | ✅ | |
| Turns Codex starts by itself (goal continuation) | ✅ | ✅ | Tracked, logged and charged to the key |
| Context compaction (`/compact`), summary (`/summary`) | ✅ | ✅ | |
| Goals for long tasks (`/goal`) | ✅ | ✅ | |
| Copy last answer (`/copy`), export as Markdown (`/export`) | ✅ | — | Copy buttons on answers and code blocks |

## Models and reasoning

| Codex feature | Console | API | Notes |
| --- | --- | --- | --- |
| Choose the model (`/model`, `-m`) | ✅ | ✅ | From Codex's own model list |
| Reasoning level, per model (low … ultra) | ✅ | ✅ | Only the levels each model supports, with Codex's descriptions |
| Speed tier (fast / `priority`) | ✅ | ✅ | When the model offers it |
| Reasoning summary detail | ✅ | ✅ | Auto, concise, detailed, hidden |
| Per session and per turn | ✅ | ✅ | The choice applies to the next turn and stays with the session |
| Codex defaults (`config.toml`) | Admin | — | Model, reasoning, summary, speed, web search, reviewer |

## Permissions

| Codex feature | Console | API | Notes |
| --- | --- | --- | --- |
| Sandbox: read-only, workspace-write, full access (`-s`, `/permissions`) | ✅ | ✅ | Keys are capped |
| Approval policy: untrusted, on-request, never (`-a`) | ✅ | ✅ | |
| Approve once / for the session / always for similar commands | ✅ | ⚠️ | Keys can only decline unless they have full access and network |
| Network rules (allow / block a host) | ✅ | ⚠️ | Same rule |
| Permission requests (extra network or file access) | ✅ | ⚠️ | Same rule |
| Stop the turn from an approval (cancel) | ✅ | ✅ | |
| Automatic reviewer (`--approve-for-me`, auto-review) | ✅ | — | Never for keys; denials can be allowed once ⚠️ verified with the fake Codex only |
| Network access in the sandbox | ✅ | ✅ | Keys are capped |
| Extra writable folders (`--add-dir`) | ✅ | — | Inside the workspace |
| Web search (`--search`, `web_search`) | ✅ | ✅ | Off for keys without network |
| Full bypass (`--dangerously-bypass-…`) | ✅ | ⚠️ | Full access + never ask; keys only if allowed |

## Context and files

| Codex feature | Console | API | Notes |
| --- | --- | --- | --- |
| Attach files and images (`-i`) | ✅ | ✅ | Upload, drag and drop, or paste screenshots |
| Image links | ✅ | ✅ | Keys need network |
| `@` file mentions (`/mention`) | ✅ | ✅ | |
| Skills (`/skills`), enable/disable | ✅ | ✅ | Enable/disable in Admin |
| Saved prompts (`/prompts:<name>`, `$CODEX_HOME/prompts`) | ✅ | — | Listed in the `/` menu |
| `AGENTS.md` (`/init`) | ✅ | ✅ | |
| Images Codex views or generates, videos | ✅ | ✅ | Shown inline |
| Workspace files: browse, upload, download, delete | ✅ | ✅ | Keys only in their folder |
| Change working folder (`/cd`, `/pwd`, `-C`) | ✅ | ✅ | Inside the workspace (key folder for keys) |

## Sessions and history

| Codex feature | Console | API | Notes |
| --- | --- | --- | --- |
| New session (`/new`, `/clear`) | ✅ | ✅ | |
| Resume (`codex resume`, `/resume`) | ✅ | — | Import any Codex session, then continue |
| Fork (`codex fork`, `/fork`) | ✅ | ✅ | Also from any turn |
| Undo / rewind (`/undo`) | ✅ | ✅ | From any turn |
| Rename (`/rename`) | ✅ | ✅ | Also renames the Codex thread |
| Archive / unarchive (`/archive`, `codex unarchive`) | ✅ | ✅ | Kept in sync with Codex |
| Delete (`/delete`, `codex delete`) | ✅ | ✅ | Optionally deletes the Codex thread |
| History of every turn | ✅ | ✅ | |
| Search sessions | ✅ | — | |

## Review, diffs, shell

| Codex feature | Console | API | Notes |
| --- | --- | --- | --- |
| Code review (`/review`, `codex review`): uncommitted, branch, commit, custom | ✅ | ✅ | |
| Diff (`/diff`), including untracked files | ✅ | ✅ | Runs inside Codex's read-only sandbox |
| Shell commands (`!cmd`) | ✅ | ⚠️ | `shell` scope, off by default |
| Background terminals (`/ps`, `/stop`) | ✅ | ✅ | |

## MCP, plugins, apps, hooks, memories

| Codex feature | Console | API | Notes |
| --- | --- | --- | --- |
| MCP servers: list, add, edit, enable, remove (`codex mcp`, `/mcp`) | Admin | ⚠️ | `mcp:manage` scope, off by default |
| MCP OAuth sign-in / sign-out | Admin | ⚠️ | Link shown, never opened for you |
| MCP tool calls with progress | ✅ | ✅ | |
| MCP resources | Admin | — | |
| Plugins: browse, install, uninstall (`codex plugin`, `/plugins`) | Admin | — | |
| Apps (`/apps`) | Admin | — | List |
| Hooks (`/hooks`) | Admin | — | List |
| Memories (`/memories`): per session on/off, status, reset | ✅ / Admin | ✅ | Per session in settings |
| Import setup from other agents (`/import`) | Admin | — | |

## Config, account, diagnostics

| Codex feature | Console | API | Notes |
| --- | --- | --- | --- |
| `config.toml`: effective config with layers, edit any key (`-c`, `/debug-config`) | Admin | — | |
| Feature flags (`codex features`, `--enable`, `/experimental`) | Admin | — | |
| Sign in with ChatGPT (device code) / sign out (`codex login`, `/logout`) | Admin | — | ChatGPT plan only, never API credits |
| Account, plan, usage limits, usage history (`/usage`, `/status`) | ✅ / Admin | ✅ | |
| Use a usage-limit reset | Admin | — | |
| `codex doctor` | Admin | — | |
| Warnings and notices (`/warnings`) | Admin | — | |
| Feedback to OpenAI (`/feedback`) | ✅ | — | Logs only if you tick the box |

## Not applicable to a web console

| Codex feature | Why |
| --- | --- |
| Voice (`/voice`, realtime) | Experimental WebRTC audio API; it needs a realtime-enabled account to test, and none was available for this build |
| Windows sandbox setup (`/setup-elevated-sandbox`) | The host is Linux |
| Codex Cloud tasks, `codex apply`, remote control, `exec-server`, the shared daemon (`codex agents`) | Cloud and daemon features with no local app-server API; the console is the remote control |
| IDE context (`/ide`), Desktop hand-off, worktree launcher (`--worktree`) | Need an IDE or the Desktop app; for worktrees, create one and open it as the session folder |
| Terminal-only display: themes, status line, title, pet, raw scrollback, TUI mode, key remapping | The web UI has its own theme switch (system / light / dark) and layout |
| `codex update`, `completion`, `migrate-*`, `debug`, `sandbox` | Maintenance commands; the Codex version is pinned in `package.json` |
| Other providers: API key, OSS / local models, Amazon Bedrock, gateway OAuth | This console is for a ChatGPT plan; providers can still be set in `config.toml` |
| Personality | Deprecated by Codex (no longer changes the style) |
