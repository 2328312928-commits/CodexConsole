# Codex 控制台

一个只属于你自己的 Web 控制台，用来远程使用**你自己的** [Codex CLI](https://github.com/openai/codex)，登录方式是**你的 ChatGPT 套餐**（不消耗 API 额度）。在你自己的浏览器和手机上可以：

- 向 Codex 发送提示词，实时查看流式回复（思考过程、命令及输出、文件改动、计划、MCP 工具调用）
- 引导或停止正在进行的一轮，回答 Codex 的问题和 MCP 服务器的表单，批准或拒绝 Codex 请求运行的命令和文件修改
- 使用 Codex 自身的功能：每个会话的模型、推理强度、沙箱、审批和网络设置；`/` 斜杠命令；代码审查、压缩上下文、改动、目标、`@` 提及文件、技能、图片链接、`!` shell 命令；从任意一轮分叉会话或回退
- 向工作区上传文件、下载文件，并把文件或图片附加到提示词
- 直接查看 Codex 生成或查看的图片和视频
- 管理会话：新建、重命名、归档、删除、搜索，并可导入在终端中开始的线程
- 管理 Codex 的 **MCP 服务器**：列出、添加、编辑、启用/停用、移除、登录
- 为你自己的脚本和设备创建 **API 密钥**，可设置额度、有效期、权限范围，可轮换和吊销，并通过独立的公网 API 在互联网上使用
- 使用私有的**管理后台**：查看每一次请求（时间、会话、设备或密钥、提示词大小、耗时、状态、令牌、文件），以及套餐用量限制、每个密钥的用量、设备令牌、登录、文件传输和安全日志

所有界面都有 **English 和简体中文** 两种语言（顶栏可切换）。English docs: [README.md](README.md)。

> **这相当于一个远程终端。** Codex 会在运行控制台的机器上执行命令。能进入控制台的人就能做 Codex 能做的事。在 `localhost` 以外使用前，请先阅读 [SECURITY.md](SECURITY.md)。

## 工作原理

```
你的设备 ──HTTPS──▶ Codex 控制台（Node.js，默认监听 127.0.0.1:8787）
                    ├─ 认证：设备令牌 + 密码 + 验证器动态码，频率限制
                    ├─ REST API + 服务器推送事件（实时流式输出）
                    ├─ SQLite（Node 内置）：会话、对话记录、请求日志、审计日志
                    ├─ 文件服务，限制在工作区文件夹内
                    └─ 子进程：`codex app-server` ──▶ 你的 ChatGPT 套餐（通过 `codex login`）
你的脚本 ──HTTPS──▶ 公网 API（可选，127.0.0.1:8788，只有 /v1，只接受 API 密钥）
```

控制台通过 `codex app-server` 驱动 Codex。这是 Codex 官方的 JSON-RPC 接口，Codex 的 IDE 扩展和桌面应用也用它。

- **会话：**每个会话就是一个 Codex 线程。
- **提示词：**每条提示词启动一轮对话（`turn/start`），回复逐字流式显示。
- **审批：**审批请求显示为“允许 / 拒绝”卡片，超时未处理会自动拒绝。
- **用量限制：**来自 `account/rateLimits/read`。
- **登录：**Codex 的登录信息保存在 `~/.codex`，控制台从不读取或复制这些凭据。

**版本固定：**Codex CLI 的版本固定在 `package.json` 中（`@openai/codex` 0.164.0），随项目一起安装。`npm run codex:check` 会检查已安装的 Codex 是否仍支持控制台用到的每一个协议方法。

## 环境要求

- **Node.js 22.13 或更高版本。**推荐 Node 24 LTS；Node 20 已停止维护，不受支持。控制台使用 Node 内置的 SQLite，无需编译任何东西。
- **系统：**Linux 或 macOS；Windows 可通过 WSL 使用。
- **包含 Codex 的 ChatGPT 套餐。**
- **验证器应用**，例如 Google Authenticator、1Password、Authy、Microsoft Authenticator。

## 快速开始（在运行 Codex 的机器上）

```bash
npm ci
npm run build
npx codex login            # 用 ChatGPT 登录；无图形界面的服务器请用 `npx codex login --device-auth`
npm run codex:check        # 可选：确认 Codex 协议兼容且已登录
npm run setup              # 设置密码、绑定验证器、生成第一个配对码
npm start
```

然后：

1. 在同一台机器上打开 `http://127.0.0.1:8787`。
2. 输入 `npm run setup` 给出的配对码（或扫描它的二维码）。
3. 用密码和验证器动态码登录。

用 `npm run setup -- --lang zh-CN` 可以以中文运行设置程序。

Codex 默认在 `~/codex-workspace/` 中工作，每个会话一个文件夹。控制台自身的数据（数据库、密钥、媒体）保存在 `~/.codexconsole/`，仅所有者可读写。本仓库中不包含任何机密信息。

## 添加你的其他设备

要添加手机或笔记本：

1. 进入**管理后台 → 设备 → 添加设备**，给它起个名字。
2. 在新设备上扫描二维码，或在新设备上打开 `/pair` 并输入配对码。配对码只能使用一次，15 分钟后失效。
3. 在该设备上用密码和验证器动态码登录。

每台设备都有自己的令牌，管理后台会按设备显示用量。**吊销**某台设备后，它会被永久退出登录。

只有在通过 HTTPS 提供服务之后（见下一节），其他设备才能访问控制台。

## 从其他设备访问（HTTPS）

服务器只监听 `127.0.0.1`，并且拒绝在其他地址上使用明文 HTTP。可以选择以下任一方式：

**A. Tailscale（推荐：只有你自己的设备能访问，完全不公开）**

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

`.env`：

```bash
CC_PUBLIC_ORIGIN=https://<机器名>.<tailnet>.ts.net
CC_TRUST_PROXY=loopback
```

**B. 使用你自己的域名和 Caddy（自动申请 Let's Encrypt 证书）。**这种方式是公开的：控制台可从互联网访问，由设备令牌、密码和验证器动态码保护。见 [`deploy/Caddyfile.example`](deploy/Caddyfile.example)。

```bash
CC_PUBLIC_ORIGIN=https://console.example.com
CC_TRUST_PROXY=loopback
```

**C. 内置 TLS**（例如在局域网中，用 `mkcert` 或 `tailscale cert` 生成的证书）：

```bash
CC_HOST=0.0.0.0
CC_TLS_CERT=/path/to/fullchain.pem
CC_TLS_KEY=/path/to/privkey.pem
CC_PUBLIC_ORIGIN=https://mybox.lan:8787
```

修改 `.env` 后需重启控制台。全部配置项见 [`.env.example`](.env.example)。

方案 A–C 针对控制台本身。要从互联网调用**公网 API**，见下一节；它可以与方案 A 同时使用（控制台通过 `tailscale serve` 用 443，API 通过 `tailscale funnel` 用 8443）。

要在 Linux 上让控制台常驻运行，可使用 [`deploy/codex-console.service`](deploy/codex-console.service) 中的 systemd 用户服务，文件开头写有安装方法。

## 使用 Codex

在输入框中输入 `/` 打开命令菜单，或使用会话标题栏的 **⋯** 菜单。

| 命令 | 作用 |
| --- | --- |
| `/model`、`/approvals`、`/sandbox`、`/network` | 会话设置（滑块按钮打开同一个对话框） |
| `/review`、`/compact`、`/diff`、`/status`、`/goal` | 代码审查、压缩上下文、显示改动、会话状态、线程目标 |
| `/fork`、`/undo`、`/new` | 分叉会话、回退上一轮、新建会话。每一轮下方也有 **从这里分叉** 和 **回退** |
| `/init`、`/skills`、`/mention`、`/mcp`、`/help` | 编写 `AGENTS.md`、使用技能、提及文件、列出 MCP 服务器、列出命令 |
| `!命令` | 在会话文件夹中运行 shell 命令（总会记录到安全日志） |

Codex 工作时，输入框用于**引导**正在进行的这一轮。其他会话中等待你处理的审批和问题会显示在会话列表顶部。

控制台的沙箱、审批和网络默认值在 **管理后台 → 设置** 中，Codex 自身的默认模型和推理强度也在那里（写入它的 `config.toml`）。

## MCP 服务器

**管理后台 → MCP 服务器** 管理 Codex 使用的 MCP 服务器。改动会写入主机上 Codex 的 `config.toml`：

- **本地服务器**在主机上运行一个命令，以你的用户身份运行，不受 Codex 沙箱限制。只添加你信任的命令。环境变量值只写不读：控制台不会再显示它们。
- **远程服务器**必须使用 `https://`。对于 OAuth 服务器，**登录** 会显示授权链接。控制台不会替你打开它；登录在主机的浏览器中完成。

MCP 工具调用会连同参数、进度和结果显示在对话记录中。

## 公网 API 与 API 密钥

**管理后台 → API 密钥** 为你自己的脚本和设备创建密钥。它们只能用于独立的监听端口（`127.0.0.1:8788`，默认关闭），该端口只提供 `/v1`，永远不提供控制台或管理区。

- **每个密钥可设置：**标签、有效期、令牌额度（每天、每月或总计）、权限范围、最高沙箱级别、网络、遇到审批时的处理方式（自动拒绝或询问你）、速率限制、IP 允许列表，以及它自己的工作区文件夹。
- **密钥**只显示一次，只以 HMAC 形式保存。可以**轮换**（可选宽限期）或立即**吊销**。
- **用量：**每个密钥的用量（提示数、令牌、传输、30 天图表、最近的提示）都在管理后台中。请求记录、文件传输和安全日志都可以按密钥筛选。

用 `CC_API_ENABLED=true` 开启。要在任何地方访问，请使用带 PROXY 协议的 Tailscale Funnel，它只开放 API 端口：分步指南见 [docs/FUNNEL.zh-CN.md](docs/FUNNEL.zh-CN.md)。接口、权限范围和示例见 [docs/API.zh-CN.md](docs/API.zh-CN.md)。

## 安全概要

- **每次登录都需要三重验证：**
  - 已配对的设备令牌：256 位，只保存 HMAC 哈希，放在 HttpOnly、Secure、SameSite=Strict 的 Cookie 中
  - 密码：Argon2id
  - TOTP 动态码：每个只能用一次，静态加密保存
- **管理后台二次验证：**空闲 15 分钟后，进入管理后台需要新的动态码。
- **频率限制：**
  - 登录：每个 IP 15 分钟内最多失败 5 次，总计 20 次
  - 配对尝试
  - 每台设备的 API 调用和提示词数量
  - 每台设备每小时的上传字节数
- **请求检查：**
  - Host 白名单（防止 DNS 重绑定）
  - 所有修改类请求都会检查 Origin，并要求带自定义请求头（防止 CSRF）
  - 严格的内容安全策略（CSP）和其他安全响应头
- **文件：**所有文件访问都限制在工作区内，拒绝路径穿越和指向工作区外的符号链接。HTML 只以纯文本显示，文件响应带沙箱 CSP。
- **审计：**每一次 API 调用、提示词、文件传输和安全事件都会被记录，保留期可配置。
- **API 密钥：**以 HMAC 形式保存。只能用于独立的 `/v1` 监听端口，各自有权限范围、额度、速率限制，以及沙箱、网络和审批上限。错误密钥按 IP 限流。`shell` 和 `mcp:manage` 默认关闭，除非你明确授予。

详细说明以及设备丢失时的处理方法见 [SECURITY.md](SECURITY.md)。

## 恢复命令（在主机上运行）

| 命令 | 作用 |
| --- | --- |
| `npm run setup -- --pair "笔记本"` | 生成新的配对码（例如无法进入管理后台时） |
| `npm run setup -- --revoke-all` | 结束所有登录会话 |
| `npm run setup -- --reset-password` | 设置新密码，并结束所有登录 |
| `npm run setup -- --reset-totp` | 绑定新的验证器，并结束所有登录 |

## 开发

```bash
npm run dev -- --fake-codex   # 界面 + 服务器，使用模拟的 Codex：无需登录，不会调用 OpenAI
npm run dev                   # 同上，但使用你真实的 Codex
npm test                      # 单元测试 + 集成测试（使用模拟的 Codex）
npm run typecheck
```

`test/fake-codex/` 中的模拟服务实现了与 Codex 0.164.0 相同的协议结构。在提示词中加入以下关键字可以触发相应功能：`approve`、`permission`、`question`、`elicit`、`mcp`、`image`、`video`、`edit`、`slow`、`steady`、`fail`、`fail limit`。

| 路径 | 内容 |
| --- | --- |
| `server/` | Fastify API、认证、Codex 桥接（`server/codex/`）、命令行工具（`server/cli/`） |
| `web/` | React 界面（Vite） |
| `shared/` | 类型、协议子集（`shared/codex.ts`）以及中英文词典（`shared/i18n/`） |
| `test/` | Vitest 测试和模拟的 Codex |

新增界面文字时，必须同时在 `shared/i18n/en.ts` 和 `shared/i18n/zh-CN.ts` 中添加对应条目，否则 TypeScript 编译和 i18n 测试都会失败。

## 说明

- **仅供个人使用。**本项目只为一位所有者设计；与他人共享你的 ChatGPT 套餐违反 OpenAI 的条款。
- **用量限制：**管理后台显示的是 Codex 报告的套餐用量，控制台不会绕过这些限制。
- **升级 Codex：**修改 `package.json` 中的 `@openai/codex` 版本，运行 `npm install`，再运行 `npm run codex:check`。
- **有意不包含的功能：**Codex 的登录和退出（请在主机上运行 `codex login`）、反馈上传、语音 / 实时对话、Windows 沙箱设置、Codex 云端和远程控制功能，以及插件市场安装。
