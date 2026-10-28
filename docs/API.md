# Public API (v1)

[中文版](API.zh-CN.md)

The public API lets **your own** scripts, tools and devices use the console without a browser: send prompts, wait for or stream the result, manage sessions, move files, answer approvals and manage MCP servers. It is meant for one owner. Don't hand keys to other people: sharing access to your ChatGPT plan is against OpenAI's terms.

- It runs on a **separate listener** (default `127.0.0.1:8788`) that serves only `/v1`. The console UI, `/api` and the admin area are never reachable through it.
- It is **off** until you set `CC_API_ENABLED=true`. To reach it from the internet, put it behind a TLS tunnel: see [FUNNEL.md](FUNNEL.md).
- Every call needs an **API key** you create in **Admin → API keys**. Cookies are ignored.

## Contents

- [Keys and authentication](#keys-and-authentication)
- [Errors and limits](#errors-and-limits)
- [Quick start](#quick-start)
- [Endpoints](#endpoints)
- [Turn results](#turn-results)
- [Live events (SSE)](#live-events-sse)
- [Slash commands](#slash-commands)
- [What a key can and cannot do](#what-a-key-can-and-cannot-do)

## Keys and authentication

Send the key as a bearer token:

```http
Authorization: Bearer cck_0123456789abcdef.<43 characters>
```

- **Format.** `cck_` + a 16-hex-digit id + `.` + a 256-bit secret. The console stores only an HMAC of the secret, so a key is shown exactly once, when you create or rotate it.
- **Settings per key.**
  - label, expiry
  - scopes (below)
  - a token quota per day, per month or in total
  - the most powerful sandbox it may use, whether network access is allowed, and what happens when Codex needs approval
  - rate limits, an optional IP allowlist, and its own workspace folder
- **Rotate** creates a new secret. The old one can keep working for 0, 1 or 24 hours so you can update your tools.
- **Revoke** is immediate and permanent. Running prompts of that key are stopped, and open event streams close within 30 seconds.

### Scopes

| Scope | Allows |
| --- | --- |
| `prompt` | Create and list sessions, send prompts, steer, stop, read history, results, diffs, status, skills, models, events, media; run slash commands |
| `sessions` | Fork, rewind (undo), compact, review, goals, delete sessions |
| `files:read` | List, search and download files in the key's folder |
| `files:write` | Upload, create folders and delete files in the key's folder |
| `approvals` | List approval requests and questions in the key's sessions; answer questions; decline approvals. Allowing an approval also needs a key with full access and network (see below) |
| `settings` | Change a session's model, reasoning, sandbox, approvals and network (never above the key's caps) |
| `mcp:read` | List MCP servers and their tools |
| `mcp:manage` ⚠ | Add, change, enable/disable, remove MCP servers; start/end their sign-in |
| `shell` ⚠ | Run `!command` shell commands in a session folder, outside the model |

⚠ = dangerous: these run programs on the host **outside Codex's sandbox**. They are off by default.

## Errors and limits

Errors are JSON:

```json
{ "error": { "code": "scope_missing", "detail": "shell" } }
```

| Status | Typical codes |
| --- | --- |
| 400 | `bad_request`, `prompt_empty`, `path_invalid`, `unknown_command` |
| 401 | `invalid_api_key`, `api_key_revoked`, `api_key_expired` |
| 403 | `scope_missing`, `ip_not_allowed`, `setting_not_allowed`, `path_outside_workspace` |
| 404 | `not_found`, `session_not_found`, `turn_not_found`, `file_not_found` |
| 409 | `turn_in_progress`, `no_active_turn`, `codex_not_signed_in` |
| 413 | `prompt_too_long`, `file_too_large`, `payload_too_large` |
| 421 | `forbidden_host` (the `Host` header is not the public API's host) |
| 429 | `rate_limited`, `too_many_turns`, `quota_exceeded`, `upload_quota_exceeded` (with `Retry-After` when it applies) |
| 502 / 503 | `codex_error`, `mcp_error`, `codex_unavailable` |

Limits:

- **Per key** (editable): API calls per minute (default 60), prompts per minute (6), prompts running at once (2), upload MB per hour (500).
- **Whole listener:** `CC_API_MAX_PER_MIN` requests per minute (600).
- **Failed keys:** an IP that sends more than `CC_API_BAD_KEY_LIMIT` (20) bad keys in 10 minutes gets `429`. Only failures count, so a valid key is never locked out by someone else.
- **Quota:** input + output tokens of the key's turns, counted per server-local day or month, or in total. All of the key's running turns count together. New prompts are refused with `quota_exceeded`, and once the total crosses the line every running turn of the key is stopped (status `quota_exceeded`). Turns Codex starts by itself in a key's session (for example to continue a goal) count too. It is a soft limit: usage is only known after each model step, so a key can go over by roughly one step per running turn.

## Quick start

```bash
export CODEX_CONSOLE_KEY='cck_…'          # from Admin → API keys
BASE=https://<machine>.<tailnet>.ts.net/v1  # or http://127.0.0.1:8788/v1 on the host
AUTH="Authorization: Bearer $CODEX_CONSOLE_KEY"

curl -s "$BASE/me" -H "$AUTH"

# New session (lives in the key's folder), then a prompt that waits for the answer
SID=$(curl -s -X POST "$BASE/sessions" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"title":"From my laptop"}' | jq -r .session.id)
curl -s -X POST "$BASE/sessions/$SID/turns" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"text":"List the files here and summarise them","wait":true,"timeoutSec":300}'

# Upload a file, then mention it in a prompt
curl -s -T ./data.csv "$BASE/files/content?path=inbox/data.csv" -H "$AUTH"
curl -s -X POST "$BASE/sessions/$SID/turns" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"text":"Plot data.csv","mentions":["inbox/data.csv"],"wait":true}'

# Download what Codex made
curl -s -OJ "$BASE/files/content?path=plot.png" -H "$AUTH"
```

## Endpoints

All paths are relative to `/v1`. Request bodies are JSON unless noted. Session ids look like `ses_…`, request ids like `req_…`. File paths are **relative to the key's folder**.

### Key and service

| Method & path | Scope | Notes |
| --- | --- | --- |
| `GET /health` | none | `{ "ok": true }` without a key |
| `GET /me` | any | The key's label, scopes, folder, caps, limits, expiry and quota (`used`, `remaining`) |
| `GET /usage?tz=<minutes>` | any | Quota plus 30 daily buckets. `tz` is `Date.getTimezoneOffset()` of your clock (e.g. `-480` for UTC+8) |
| `GET /models` | `prompt` | Models Codex offers, with their reasoning efforts |

### Sessions

A key only sees sessions it created.

| Method & path | Scope | Body / query |
| --- | --- | --- |
| `GET /sessions?archived=1` | `prompt` | List |
| `POST /sessions` | `prompt` | `{ "title"?: string }` → `{ session }` |
| `GET /sessions/:id` | `prompt` | `{ session, effective, turn }`: effective settings and the running turn, if any |
| `DELETE /sessions/:id` | `sessions` | Removes it from the console (files stay) |
| `GET /sessions/:id/history?before=&limit=` | `prompt` | Stored transcript entries, oldest first, paged by entry id |
| `PATCH /sessions/:id/settings` | `settings` | Any of `model`, `effort`, `summary` (`auto`/`concise`/`detailed`/`none`), `serviceTier` (e.g. `priority`), `mode` (`default`/`plan`), `sandbox`, `approvalPolicy`, `networkAccess`, `webSearch` (`disabled`/`cached`/`live`), `memory`; `null` = default. Above the key's caps → `403 setting_not_allowed` (keys can't use the automatic reviewer, extra writable folders, or web search without network) |
| `POST /sessions/:id/folder` | `sessions` | `{ "path" }`: move the session to another folder inside the key's folder (`/cd`) |
| `GET /sessions/:id/status` | `prompt` | Effective settings, context window, token totals, goal, usage limits, pending approvals/questions |
| `GET /sessions/:id/diff` | `prompt` | `{ turnDiff, gitDiff, gitError }`: the last turn's diff, and `git diff HEAD` run inside Codex's read-only sandbox |
| `GET /sessions/:id/skills` | `prompt` | Skills available in the session folder |

### Prompts (turns)

`POST /sessions/:id/turns` (scope `prompt`):

```json
{
  "text": "Fix the failing test",
  "files": ["inbox/log.txt"],
  "mentions": ["src/parser.ts"],
  "skills": ["my-skill"],
  "imageUrls": ["https://example.com/screenshot.png"],
  "model": "gpt-5.5",
  "effort": "high",
  "summary": "concise",
  "serviceTier": "priority",
  "mode": "plan",
  "outputSchema": { "type": "object", "properties": { "answer": { "type": "string" } }, "required": ["answer"] },
  "wait": true,
  "timeoutSec": 300
}
```

- `files` are attached (images are sent as images). `mentions` point Codex at files or folders. `skills` are skill names from `/skills`. `imageUrls` must be `https://`, and need a key with network access: Codex downloads them itself.
- `model`, `effort`, `summary`, `serviceTier` and `mode` also need the `settings` scope, and are stored on the session. `GET /models` lists each model's reasoning levels and speed tiers.
- `outputSchema` constrains the final answer to a JSON Schema (like `codex exec --output-schema`).
- Without `wait`: `202 { requestId, turnId, status: "running" }` right away.
- With `wait`: `200` and a [turn result](#turn-results) when it finishes, or `202` with the partial result when `timeoutSec` (default 120, max `CC_API_MAX_WAIT_SEC`) runs out.
- One prompt per session at a time (`409 turn_in_progress`).

| Method & path | Scope | Notes |
| --- | --- | --- |
| `GET /sessions/:id/turns/:requestId?wait=<sec>` | `prompt` | The turn result; waits up to `wait` seconds for it to finish |
| `POST /sessions/:id/steer` | `prompt` | `{ "text" }`: add guidance to the running turn |
| `POST /sessions/:id/interrupt` | `prompt` | Stop the running turn |
| `GET/POST /sessions/:id/queue` | `prompt` | List, or add a prompt (same body as `/turns`, without the options) that runs after the current turn |
| `DELETE /sessions/:id/queue/:itemId`, `POST /sessions/:id/queue/resume` | `prompt` | Remove a queued prompt; continue a queue paused by a failed or stopped turn |
| `GET /sessions/:id/terminals` | `prompt` | Background terminals Codex started (`/ps`) |
| `POST /sessions/:id/terminals/stop` | `sessions` | `{ "processId" }`, or `null` for all (`/stop`) |
| `POST /sessions/:id/command` | `prompt` | `{ "command": "/compact" }`: see [slash commands](#slash-commands). Each command also checks its own scope |
| `POST /sessions/:id/review` | `sessions` | `{ "target": { "type": "uncommittedChanges" } }`, or `baseBranch` + `branch`, `commit` + `sha`, `custom` + `instructions` |
| `POST /sessions/:id/compact` | `sessions` | Summarise the conversation to free context |
| `POST /sessions/:id/fork` | `sessions` | `{ "turnId"?: string }`: copy the conversation (up to that turn) into a new session → `{ session }` |
| `POST /sessions/:id/undo` | `sessions` | `{ "turnId"?: string }`: remove that turn (default: the last) and everything after it. Files are not restored |
| `POST /sessions/:id/shell` | `shell` ⚠ | `{ "command": "ls -la" }`: runs in the session folder, outside the model |
| `GET/POST/DELETE /sessions/:id/goal` | `sessions` | Read, set (`{ "objective", "tokenBudget"? }`) or clear the thread goal |

Review, compact and shell return `{ requestId, turnId }` and show up as turns: poll them like prompts.

### Approvals and questions

Keys set to **deny** never wait: anything that needs approval is declined automatically and logged. Keys set to **ask** wait for an answer, from you in the console or through these calls.

Allowing an approval can take Codex past the sandbox (an escalated command, an extra write root, network or file permissions). So a key may **allow** its own approvals only if its caps already allow everything: sandbox *Full access* and network on. Any other key can only **decline** (`403 setting_not_allowed` otherwise). You can still allow them yourself in the console.

| Method & path | Scope | Body |
| --- | --- | --- |
| `GET /approvals` | `approvals` | `{ approvals, questions }` pending in the key's sessions |
| `POST /approvals/:id` | `approvals` | `{ "decision": "accept" \| "acceptForSession" \| "acceptAlways" \| "applyNetworkRule" \| "decline" \| "cancel", "ruleIndex"? }`. `acceptAlways` saves Codex's proposed rule (`proposedRule`); `applyNetworkRule` applies `networkRules[ruleIndex]`; `cancel` declines and stops the turn |
| `POST /questions/:id` | `approvals` | Codex's own questions: `{ "kind": "input", "answers": { "<questionId>": ["answer"] } }`. MCP forms/links: `{ "kind": "elicitation", "action": "accept" \| "decline" \| "cancel", "content"?: {…} }` |

Unanswered approvals are declined after the approval timeout (10 minutes by default); unanswered questions are skipped.

### Files

All paths are inside the key's folder. Anything that escapes it (`..`, symlinks out, absolute paths) is refused.

| Method & path | Scope | Notes |
| --- | --- | --- |
| `GET /files?path=` | `files:read` | List a folder |
| `GET /files/search?q=` | `files:read` | Fuzzy file-name search |
| `GET /files/content?path=` | `files:read` | Download; supports `Range` |
| `PUT /files/content?path=&overwrite=1` | `files:write` | Upload the raw request body (`curl -T file`). Refuses to overwrite unless `overwrite=1` |
| `POST /files/mkdir` | `files:write` | `{ "path" }` |
| `DELETE /files?path=` | `files:write` | Delete a file or folder |
| `GET /media/:sessionId/:name` | `prompt` | Images Codex viewed or generated outside the folder (names come from turn results) |

### MCP servers

| Method & path | Scope | Notes |
| --- | --- | --- |
| `GET /mcp` | `mcp:read` | Servers with status, auth status and tools. Environment values are never returned, only their names |
| `POST /mcp` | `mcp:manage` ⚠ | `{ "name", "transport": "stdio", "command", "args"?, "cwd"?, "env"? }` or `{ "name", "transport": "http", "url", "bearerTokenEnvVar"? }`; optional `enabled`, `enabledTools`, `disabledTools`, `startupTimeoutSec`, `toolTimeoutSec` |
| `PUT /mcp/:name` | `mcp:manage` ⚠ | Same body without `name`. In `env`, `""` keeps a stored value, `null` deletes it, and names you leave out are deleted |
| `POST /mcp/:name/enabled` | `mcp:manage` ⚠ | `{ "enabled": false }` |
| `DELETE /mcp/:name` | `mcp:manage` ⚠ | Remove |
| `POST /mcp/:name/login` | `mcp:manage` ⚠ | `{ authorizationUrl }` for OAuth servers. Open it yourself: the sign-in completes on the host |
| `POST /mcp/:name/logout` | `mcp:manage` ⚠ | Forget the stored OAuth token |

Remote MCP URLs must be `https://` (plain `http://` only for localhost).

## Turn results

```json
{
  "requestId": "req_…",
  "sessionId": "ses_…",
  "turnId": "…",
  "status": "completed",
  "error": null,
  "text": "Codex's final answer (Markdown)",
  "durationMs": 8123,
  "usage": { "inputTokens": 1200, "cachedInputTokens": 400, "outputTokens": 600, "reasoningTokens": 120 },
  "files": [{ "path": "src/parser.ts", "kind": "update" }],
  "media": [{ "kind": "image", "source": "workspace", "path": "…", "name": "plot.png", "mime": "image/png", "size": 48213 }],
  "commands": [{ "command": "npm test", "exitCode": 0, "status": "completed" }],
  "diff": "unified diff of the turn, if Codex reported one",
  "pendingApprovals": [],
  "pendingQuestions": []
}
```

`status` is one of `running`, `completed`, `interrupted`, `failed`, `usage_limited` (your ChatGPT plan's limit), `rate_limited`, `rejected`, `quota_exceeded` (the key's quota) or `error`.

## Live events (SSE)

`GET /sessions/:id/events` (scope `prompt`) streams [server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html), the same ones the console UI uses:

```bash
curl -N "$BASE/sessions/$SID/events" -H "$AUTH"
```

- The first event is `snapshot` (the running turn, if any).
- Then: `turn_started`, `item_started`, `item_delta` (streamed text and command output), `item_progress` (MCP tool progress), `item_completed`, `plan`, `diff`, `usage`, `status`, `approval_requested` / `approval_resolved`, `question_requested` / `question_resolved`, `goal_updated`, `transcript_changed`, `turn_completed`, `session_updated`.
- Each event's `data` is JSON with a `type` field. Comment lines (`: ping`) keep the connection alive every 15 seconds.

## Slash commands

`POST /sessions/:id/command` accepts the same commands as the console composer:

| Command | Scope | Does |
| --- | --- | --- |
| `/help` | `prompt` | Lists the commands |
| `/new [title]` | `prompt` | New session |
| `/fork [turn id]` | `sessions` | Fork |
| `/undo [turn id]` | `sessions` | Remove the last (or given) turn and what follows |
| `/model [model] [effort]` | `settings` | Show or set model and reasoning (`default` resets) |
| `/approvals untrusted\|on-request\|never` | `settings` | Approval policy |
| `/sandbox read-only\|workspace-write\|danger-full-access` | `settings` | Sandbox (within the key's cap) |
| `/network on\|off` | `settings` | Network access in the sandbox |
| `/review [uncommitted \| branch <name> \| commit <sha> \| <instructions>]` | `sessions` | Code review |
| `/compact` | `sessions` | Compact the context |
| `/diff` | `prompt` | Turn diff and Git diff |
| `/init` | `prompt` | Ask Codex to write an `AGENTS.md` |
| `/skills` | `prompt` | List skills |
| `/status` | `prompt` | Session status |
| `/mcp` | `mcp:read` | MCP servers and tools |
| `/goal [objective \| clear]` | `sessions` | Show, set or clear the goal |
| `/plan [on \| off]` | `settings` | Plan mode |
| `/permissions read-only\|auto\|full-access` | `settings` | Sandbox and approval presets |
| `/rename <title>`, `/archive`, `/unarchive` | `sessions` | |
| `/cd <folder>`, `/pwd` | `sessions` / `prompt` | Working folder |
| `/ps`, `/stop` | `prompt` / `sessions` | Background terminals |
| `/summary`, `/clear` | `prompt` | Summarise now; new session |
| `!<command>` | `shell` ⚠ | Shell command in the session folder |

The response is `{ "kind": … }`: `turn` (with `requestId`), `session`, `settings`, `status`, `diff`, `skills`, `models`, `mcp`, `goal`, `help` or `done`.

## What a key can and cannot do

- **Can't** reach the console UI, `/api/*`, the admin area, other keys' sessions, or files outside its folder.
- **Can't** raise its own caps: sandbox, network and approval settings are clamped to what you set on the key.
- **Can** make Codex *read* files outside its folder. Codex's sandbox limits writes and network access, not reads, so treat a key with `prompt` like shell access to everything your user can read on the host.
- **Every call is logged:** **Admin → API keys → Usage**, plus the Requests, File transfers and Security log tabs (filter by key).
