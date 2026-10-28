# 公网 API（v1）

[English](API.md)

公网 API 让**你自己的**脚本、工具和设备不用浏览器也能使用控制台：发送提示、等待或实时接收结果、管理会话、传输文件、回答审批、管理 MCP 服务器。它只为一位所有者设计。不要把密钥交给别人：共享你的 ChatGPT 套餐违反 OpenAI 的条款。

- 它运行在**独立的监听端口**上（默认 `127.0.0.1:8788`），只提供 `/v1`。控制台页面、`/api` 和管理区永远无法通过它访问。
- 在设置 `CC_API_ENABLED=true` 之前它是**关闭**的。要从互联网访问，请放在 TLS 隧道之后：见 [FUNNEL.zh-CN.md](FUNNEL.zh-CN.md)。
- 每次调用都需要在 **管理后台 → API 密钥** 中创建的 **API 密钥**。Cookie 会被忽略。

## 目录

- [密钥与认证](#密钥与认证)
- [错误与限制](#错误与限制)
- [快速开始](#快速开始)
- [接口](#接口)
- [轮次结果](#轮次结果)
- [实时事件（SSE）](#实时事件sse)
- [斜杠命令](#斜杠命令)
- [密钥能做什么、不能做什么](#密钥能做什么不能做什么)

## 密钥与认证

以 Bearer 令牌的方式发送密钥：

```http
Authorization: Bearer cck_0123456789abcdef.<43 个字符>
```

- **格式。** `cck_` + 16 位十六进制 ID + `.` + 256 位密钥值。控制台只保存密钥值的 HMAC，所以密钥只在创建或轮换时显示一次。
- **每个密钥的设置：**
  - 标签、有效期
  - 权限范围（见下表）
  - 每天、每月或总计的令牌额度
  - 允许的最高沙箱级别、是否允许联网、Codex 需要审批时怎么处理
  - 速率限制、可选的 IP 允许列表，以及它自己的工作区文件夹
- **轮换**会生成新的密钥值。旧值可以继续有效 0、1 或 24 小时，方便你更新工具。
- **吊销**立即且永久生效。该密钥正在运行的提示会被停止，打开的事件流会在 30 秒内关闭。

### 权限范围

| 范围 | 允许 |
| --- | --- |
| `prompt` | 创建和列出会话、发送提示、引导、停止，读取历史、结果、改动、状态、技能、模型、事件、媒体；运行斜杠命令 |
| `sessions` | 分叉、回退（undo）、压缩、审查、目标、删除会话 |
| `files:read` | 列出、搜索和下载密钥文件夹中的文件 |
| `files:write` | 在密钥文件夹中上传、新建文件夹和删除文件 |
| `approvals` | 列出该密钥会话中的审批请求和问题；回答问题；拒绝审批。批准审批还需要密钥拥有完全访问和联网权限（见下文） |
| `settings` | 修改会话的模型、推理强度、沙箱、审批和网络（不会超过密钥的上限） |
| `mcp:read` | 列出 MCP 服务器及其工具 |
| `mcp:manage` ⚠ | 添加、修改、启用/停用、移除 MCP 服务器；发起/结束其登录 |
| `shell` ⚠ | 在会话文件夹中运行 `!命令`（不经过模型） |

⚠ = 危险：它们会在主机上**绕过 Codex 沙箱**运行程序，默认关闭。

## 错误与限制

错误以 JSON 返回：

```json
{ "error": { "code": "scope_missing", "detail": "shell" } }
```

| 状态码 | 常见错误码 |
| --- | --- |
| 400 | `bad_request`、`prompt_empty`、`path_invalid`、`unknown_command` |
| 401 | `invalid_api_key`、`api_key_revoked`、`api_key_expired` |
| 403 | `scope_missing`、`ip_not_allowed`、`setting_not_allowed`、`path_outside_workspace` |
| 404 | `not_found`、`session_not_found`、`turn_not_found`、`file_not_found` |
| 409 | `turn_in_progress`、`no_active_turn`、`codex_not_signed_in` |
| 413 | `prompt_too_long`、`file_too_large`、`payload_too_large` |
| 421 | `forbidden_host`（`Host` 头不是公网 API 的主机名） |
| 429 | `rate_limited`、`too_many_turns`、`quota_exceeded`、`upload_quota_exceeded`（适用时带 `Retry-After`） |
| 502 / 503 | `codex_error`、`mcp_error`、`codex_unavailable` |

限制：

- **每个密钥**（可修改）：每分钟 API 调用数（默认 60）、每分钟提示数（6）、同时运行的提示数（2）、每小时上传 MB 数（500）。
- **整个监听端口：** 每分钟 `CC_API_MAX_PER_MIN` 个请求（600）。
- **错误密钥：** 某个 IP 在 10 分钟内发送超过 `CC_API_BAD_KEY_LIMIT`（20）次错误密钥会得到 `429`。只统计失败，所以有效密钥永远不会因为别人而被锁住。
- **额度：** 该密钥所有轮次的输入 + 输出令牌，按服务器本地时间的天或月统计，或者统计总量。该密钥所有正在运行的轮次合并计算。用完后新提示会以 `quota_exceeded` 被拒绝；总量一旦越过额度，该密钥所有正在运行的轮次都会被停止（状态为 `quota_exceeded`）。Codex 在密钥会话中自行发起的轮次（例如继续某个目标）也会计入。这是软上限：用量要在每一步模型调用之后才能得知，所以每个正在运行的轮次可能多用约一步的令牌。

## 快速开始

```bash
export CODEX_CONSOLE_KEY='cck_…'          # 来自 管理后台 → API 密钥
BASE=https://<机器名>.<tailnet>.ts.net/v1   # 在主机上也可用 http://127.0.0.1:8788/v1
AUTH="Authorization: Bearer $CODEX_CONSOLE_KEY"

curl -s "$BASE/me" -H "$AUTH"

# 新建会话（位于密钥的文件夹中），然后发送一条等待结果的提示
SID=$(curl -s -X POST "$BASE/sessions" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"title":"来自笔记本"}' | jq -r .session.id)
curl -s -X POST "$BASE/sessions/$SID/turns" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"text":"列出这里的文件并做个总结","wait":true,"timeoutSec":300}'

# 上传文件，再在提示中提及它
curl -s -T ./data.csv "$BASE/files/content?path=inbox/data.csv" -H "$AUTH"
curl -s -X POST "$BASE/sessions/$SID/turns" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"text":"把 data.csv 画成图","mentions":["inbox/data.csv"],"wait":true}'

# 下载 Codex 生成的文件
curl -s -OJ "$BASE/files/content?path=plot.png" -H "$AUTH"
```

## 接口

以下路径都相对于 `/v1`。除特别说明外，请求体均为 JSON。会话 ID 形如 `ses_…`，请求 ID 形如 `req_…`。文件路径都**相对于密钥的文件夹**。

### 密钥与服务

| 方法与路径 | 范围 | 说明 |
| --- | --- | --- |
| `GET /health` | 无 | 无需密钥，返回 `{ "ok": true }` |
| `GET /me` | 任意 | 密钥的标签、范围、文件夹、上限、限制、有效期和额度（`used`、`remaining`） |
| `GET /usage?tz=<分钟>` | 任意 | 额度和 30 天的每日统计。`tz` 为你所在时区的 `Date.getTimezoneOffset()`（例如 UTC+8 为 `-480`） |
| `GET /models` | `prompt` | Codex 提供的模型及其推理强度 |

### 会话

密钥只能看到它自己创建的会话。

| 方法与路径 | 范围 | 请求体 / 参数 |
| --- | --- | --- |
| `GET /sessions?archived=1` | `prompt` | 列表 |
| `POST /sessions` | `prompt` | `{ "title"?: string }` → `{ session }` |
| `GET /sessions/:id` | `prompt` | `{ session, effective, turn }`：生效的设置，以及正在运行的轮次（如有） |
| `DELETE /sessions/:id` | `sessions` | 从控制台删除（文件保留） |
| `GET /sessions/:id/history?before=&limit=` | `prompt` | 已保存的记录条目，从旧到新，按条目 ID 分页 |
| `PATCH /sessions/:id/settings` | `settings` | `model`、`effort`、`summary`（`auto`/`concise`/`detailed`/`none`）、`serviceTier`（例如 `priority`）、`mode`（`default`/`plan`）、`sandbox`、`approvalPolicy`、`networkAccess`、`webSearch`（`disabled`/`cached`/`live`）、`memory` 任选；`null` 表示默认值。超过密钥上限会得到 `403 setting_not_allowed`（密钥不能使用自动审查、额外可写文件夹，没有联网权限时也不能使用网页搜索） |
| `POST /sessions/:id/folder` | `sessions` | `{ "path" }`：把会话移到密钥文件夹内的另一个文件夹（`/cd`） |
| `GET /sessions/:id/status` | `prompt` | 生效的设置、上下文窗口、令牌总数、目标、用量限制、待处理的审批/问题 |
| `GET /sessions/:id/diff` | `prompt` | `{ turnDiff, gitDiff, gitError }`：上一轮的改动，以及在 Codex 只读沙箱中运行的 `git diff HEAD` |
| `GET /sessions/:id/skills` | `prompt` | 会话文件夹中可用的技能 |

### 提示（轮次）

`POST /sessions/:id/turns`（范围 `prompt`）：

```json
{
  "text": "修复失败的测试",
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

- `files` 作为附件发送（图片会以图片形式发送）。`mentions` 让 Codex 关注某些文件或文件夹。`skills` 是 `/skills` 返回的技能名。`imageUrls` 必须是 `https://`，并且需要密钥允许联网：Codex 会自行下载这些图片。
- `model`、`effort`、`summary`、`serviceTier` 和 `mode` 还需要 `settings` 范围，并会保存到会话中。`GET /models` 列出每个模型的推理强度和速度档位。
- `outputSchema` 用 JSON Schema 约束最终回答（同 `codex exec --output-schema`）。
- 不带 `wait`：立即返回 `202 { requestId, turnId, status: "running" }`。
- 带 `wait`：完成时返回 `200` 和[轮次结果](#轮次结果)；`timeoutSec`（默认 120，最大 `CC_API_MAX_WAIT_SEC`）到了还没完成则返回 `202` 和目前的部分结果。
- 每个会话同一时间只能运行一个提示（`409 turn_in_progress`）。

| 方法与路径 | 范围 | 说明 |
| --- | --- | --- |
| `GET /sessions/:id/turns/:requestId?wait=<秒>` | `prompt` | 轮次结果；最多等待 `wait` 秒直到完成 |
| `POST /sessions/:id/steer` | `prompt` | `{ "text" }`：为正在运行的轮次补充指示 |
| `POST /sessions/:id/interrupt` | `prompt` | 停止正在运行的轮次 |
| `GET/POST /sessions/:id/queue` | `prompt` | 列出，或添加一条在当前轮次之后运行的提示（请求体同 `/turns`，但不含选项） |
| `DELETE /sessions/:id/queue/:itemId`、`POST /sessions/:id/queue/resume` | `prompt` | 移除排队的提示；继续因失败或停止而暂停的队列 |
| `GET /sessions/:id/terminals` | `prompt` | Codex 启动的后台终端（`/ps`） |
| `POST /sessions/:id/terminals/stop` | `sessions` | `{ "processId" }`，或 `null` 表示全部（`/stop`） |
| `POST /sessions/:id/command` | `prompt` | `{ "command": "/compact" }`：见[斜杠命令](#斜杠命令)。每个命令还会检查各自的范围 |
| `POST /sessions/:id/review` | `sessions` | `{ "target": { "type": "uncommittedChanges" } }`，或 `baseBranch` + `branch`、`commit` + `sha`、`custom` + `instructions` |
| `POST /sessions/:id/compact` | `sessions` | 总结对话以腾出上下文 |
| `POST /sessions/:id/fork` | `sessions` | `{ "turnId"?: string }`：把对话（截至该轮）复制为新会话 → `{ session }` |
| `POST /sessions/:id/undo` | `sessions` | `{ "turnId"?: string }`：移除该轮（默认上一轮）及之后的所有内容。文件不会恢复 |
| `POST /sessions/:id/shell` | `shell` ⚠ | `{ "command": "ls -la" }`：在会话文件夹中运行，不经过模型 |
| `GET/POST/DELETE /sessions/:id/goal` | `sessions` | 读取、设置（`{ "objective", "tokenBudget"? }`）或清除线程目标 |

审查、压缩和 shell 返回 `{ requestId, turnId }`，并以轮次的形式出现：像提示一样轮询即可。

### 审批与问题

设为**自动拒绝**的密钥从不等待：任何需要审批的操作都会被自动拒绝并记录。设为**询问**的密钥会等待回答，可以由你在控制台中回答，也可以通过以下接口。

批准审批可能让 Codex 越过沙箱（提权运行的命令、额外的可写目录、网络或文件权限）。所以只有当密钥的上限本来就允许一切（沙箱为*完全访问*且开启网络）时，它才能**批准**自己的审批。其他密钥只能**拒绝**（否则返回 `403 setting_not_allowed`）。你仍然可以在控制台中亲自批准。

| 方法与路径 | 范围 | 请求体 |
| --- | --- | --- |
| `GET /approvals` | `approvals` | 该密钥会话中待处理的 `{ approvals, questions }` |
| `POST /approvals/:id` | `approvals` | `{ "decision": "accept" \| "acceptForSession" \| "acceptAlways" \| "applyNetworkRule" \| "decline" \| "cancel", "ruleIndex"? }`。`acceptAlways` 保存 Codex 建议的规则（`proposedRule`）；`applyNetworkRule` 应用 `networkRules[ruleIndex]`；`cancel` 拒绝并停止本轮 |
| `POST /questions/:id` | `approvals` | Codex 自己的问题：`{ "kind": "input", "answers": { "<问题ID>": ["答案"] } }`。MCP 表单/链接：`{ "kind": "elicitation", "action": "accept" \| "decline" \| "cancel", "content"?: {…} }` |

未回答的审批会在审批超时后被拒绝（默认 10 分钟）；未回答的问题会被跳过。

### 文件

所有路径都在密钥的文件夹内。任何越界的路径（`..`、指向外部的符号链接、绝对路径）都会被拒绝。

| 方法与路径 | 范围 | 说明 |
| --- | --- | --- |
| `GET /files?path=` | `files:read` | 列出文件夹 |
| `GET /files/search?q=` | `files:read` | 模糊搜索文件名 |
| `GET /files/content?path=` | `files:read` | 下载；支持 `Range` |
| `PUT /files/content?path=&overwrite=1` | `files:write` | 上传原始请求体（`curl -T 文件`）。除非 `overwrite=1`，否则不会覆盖已有文件 |
| `POST /files/mkdir` | `files:write` | `{ "path" }` |
| `DELETE /files?path=` | `files:write` | 删除文件或文件夹 |
| `GET /media/:sessionId/:name` | `prompt` | Codex 在文件夹之外查看或生成的图片（名称来自轮次结果） |

### MCP 服务器

| 方法与路径 | 范围 | 说明 |
| --- | --- | --- |
| `GET /mcp` | `mcp:read` | 服务器及其状态、认证状态和工具。环境变量只返回名称，从不返回值 |
| `POST /mcp` | `mcp:manage` ⚠ | `{ "name", "transport": "stdio", "command", "args"?, "cwd"?, "env"? }` 或 `{ "name", "transport": "http", "url", "bearerTokenEnvVar"? }`；可选 `enabled`、`enabledTools`、`disabledTools`、`startupTimeoutSec`、`toolTimeoutSec` |
| `PUT /mcp/:name` | `mcp:manage` ⚠ | 同上但不含 `name`。`env` 中 `""` 保留已保存的值，`null` 删除它，未列出的变量名会被删除 |
| `POST /mcp/:name/enabled` | `mcp:manage` ⚠ | `{ "enabled": false }` |
| `DELETE /mcp/:name` | `mcp:manage` ⚠ | 移除 |
| `POST /mcp/:name/login` | `mcp:manage` ⚠ | OAuth 服务器返回 `{ authorizationUrl }`。请自己打开：登录在主机上完成 |
| `POST /mcp/:name/logout` | `mcp:manage` ⚠ | 删除已保存的 OAuth 令牌 |

远程 MCP 的 URL 必须是 `https://`（只有 localhost 可以用 `http://`）。

## 轮次结果

```json
{
  "requestId": "req_…",
  "sessionId": "ses_…",
  "turnId": "…",
  "status": "completed",
  "error": null,
  "text": "Codex 的最终回答（Markdown）",
  "durationMs": 8123,
  "usage": { "inputTokens": 1200, "cachedInputTokens": 400, "outputTokens": 600, "reasoningTokens": 120 },
  "files": [{ "path": "src/parser.ts", "kind": "update" }],
  "media": [{ "kind": "image", "source": "workspace", "path": "…", "name": "plot.png", "mime": "image/png", "size": 48213 }],
  "commands": [{ "command": "npm test", "exitCode": 0, "status": "completed" }],
  "diff": "该轮的统一 diff（如果 Codex 报告了）",
  "pendingApprovals": [],
  "pendingQuestions": []
}
```

`status` 为以下之一：`running`、`completed`、`interrupted`、`failed`、`usage_limited`（ChatGPT 套餐的用量限制）、`rate_limited`、`rejected`、`quota_exceeded`（密钥的额度）或 `error`。

## 实时事件（SSE）

`GET /sessions/:id/events`（范围 `prompt`）以 [Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html) 推送事件，与控制台页面使用的完全相同：

```bash
curl -N "$BASE/sessions/$SID/events" -H "$AUTH"
```

- 第一个事件是 `snapshot`（正在运行的轮次，如有）。
- 之后是：`turn_started`、`item_started`、`item_delta`（流式文本和命令输出）、`item_progress`（MCP 工具进度）、`item_completed`、`plan`、`diff`、`usage`、`status`、`approval_requested` / `approval_resolved`、`question_requested` / `question_resolved`、`goal_updated`、`transcript_changed`、`turn_completed`、`session_updated`。
- 每个事件的 `data` 是带 `type` 字段的 JSON。注释行（`: ping`）每 15 秒发送一次以保持连接。

## 斜杠命令

`POST /sessions/:id/command` 接受与控制台输入框相同的命令：

| 命令 | 范围 | 作用 |
| --- | --- | --- |
| `/help` | `prompt` | 列出命令 |
| `/new [标题]` | `prompt` | 新建会话 |
| `/fork [轮次 ID]` | `sessions` | 分叉 |
| `/undo [轮次 ID]` | `sessions` | 移除上一轮（或指定轮次）及之后的内容 |
| `/model [模型] [推理强度]` | `settings` | 查看或设置模型和推理强度（`default` 为恢复默认） |
| `/approvals untrusted\|on-request\|never` | `settings` | 审批策略 |
| `/sandbox read-only\|workspace-write\|danger-full-access` | `settings` | 沙箱（不超过密钥上限） |
| `/network on\|off` | `settings` | 沙箱内的网络访问 |
| `/review [uncommitted \| branch <分支> \| commit <sha> \| <说明>]` | `sessions` | 代码审查 |
| `/compact` | `sessions` | 压缩上下文 |
| `/diff` | `prompt` | 该轮改动和 Git 改动 |
| `/init` | `prompt` | 让 Codex 编写 `AGENTS.md` |
| `/skills` | `prompt` | 列出技能 |
| `/status` | `prompt` | 会话状态 |
| `/mcp` | `mcp:read` | MCP 服务器和工具 |
| `/goal [目的 \| clear]` | `sessions` | 查看、设置或清除目标 |
| `/plan [on \| off]` | `settings` | 计划模式 |
| `/permissions read-only\|auto\|full-access` | `settings` | 沙箱和审批预设 |
| `/rename <标题>`、`/archive`、`/unarchive` | `sessions` | |
| `/cd <文件夹>`、`/pwd` | `sessions` / `prompt` | 工作文件夹 |
| `/ps`、`/stop` | `prompt` / `sessions` | 后台终端 |
| `/summary`、`/clear` | `prompt` | 立即总结；新建会话 |
| `!<命令>` | `shell` ⚠ | 在会话文件夹中运行 shell 命令 |

返回 `{ "kind": … }`：`turn`（带 `requestId`）、`session`、`settings`、`status`、`diff`、`skills`、`models`、`mcp`、`goal`、`help` 或 `done`。

## 密钥能做什么、不能做什么

- **不能**访问控制台页面、`/api/*`、管理区、其他密钥的会话，或其文件夹以外的文件。
- **不能**提高自己的上限：沙箱、网络和审批设置都会被限制在你给密钥设定的范围内。
- **能**让 Codex *读取*其文件夹以外的文件。Codex 的沙箱限制的是写入和网络访问，不限制读取，所以拥有 `prompt` 范围的密钥，应当视同能读取你的用户在主机上可读的一切。
- **每次调用都有记录：** **管理后台 → API 密钥 → 用量**，以及请求记录、文件传输和安全日志页（可按密钥筛选）。
