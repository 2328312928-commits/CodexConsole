# Security model / 安全模型

Codex Console is a remote control for a coding agent that runs commands on your machine. Treat access to the console like SSH access to the host: whoever is signed in can make Codex read files, run programs and change things. The design goal is that **only the owner, on devices the owner paired, can get in**, and that every action leaves a trace.

（中文摘要：控制台可以让 Codex 在主机上运行命令，所以登录控制台等同于拥有主机的终端权限。设计目标是：只有所有者、只在其亲自配对的设备上才能登录，并且每一个操作都会留下记录。可选的公网 API 运行在独立端口上，只提供 `/v1`、只接受 API 密钥；密钥只以 HMAC 保存，各自有权限范围、额度、速率限制和沙箱/网络/审批上限，可随时吊销。注意：Codex 的沙箱限制写入和网络，不限制读取，所以能发提示的密钥等同于能读取主机上你的用户可读的一切；MCP 工具同样在沙箱之外运行；`shell` 和 `mcp:manage` 会绕过沙箱，默认关闭。受限的密钥只能拒绝、不能批准自己的审批。下文为英文详细说明。）

## Who can get in

Every request needs all of the following:

1. **A paired device token.**
   - It is 256 random bits, issued once, through a one-time pairing code that expires in 15 minutes.
   - Browsers keep it in an `HttpOnly`, `Secure` (on HTTPS), `SameSite=Strict` cookie, with the `__Host-` prefix on HTTPS. The page's JavaScript never sees it.
   - The server stores only `HMAC-SHA256(pepper, token)`.
   - You can revoke a device from the admin dashboard. Revocation is permanent and ends that device's logins at once, including open live streams, which re-check every 30 seconds.
2. **A login** made with your password plus an authenticator (TOTP) code.
   - Passwords are hashed with Argon2id (64 MiB, 3 passes).
   - Each TOTP time step is accepted only once.
   - Logins are bound to the device that made them.
   - They expire after 7 idle days and after 30 days at most. Both are configurable.
3. **For the admin area, a fresh TOTP check.** It lapses after 15 minutes of admin inactivity, and after 12 hours at most.

The response to a failed login never says which factor was wrong. The security log records which factor failed, for the owner's eyes.

## Rate limits and lockouts

| What | Limit |
| --- | --- |
| Failed logins / admin unlocks | 5 per IP per 15 minutes, 20 overall, then locked until the window clears |
| Pairing attempts | 10 failures per IP per 15 minutes (no global cap, so nobody can lock you out of pairing; codes carry 100 bits) |
| API calls | 600 per device per minute; 120 per minute per IP before pairing |
| Prompts | 20 per device per minute |
| Uploads | 200 MB per file; 2 GB per device per hour |
| Public API, per key | 60 calls/min, 6 prompts/min, 2 prompts at once, 500 MB uploads/hour (defaults, editable per key) |
| Public API, overall | 600 requests/min for the whole listener (`CC_API_MAX_PER_MIN`) |
| Public API, bad keys | more than 20 failed keys per IP in 10 minutes → `429` (`CC_API_BAD_KEY_LIMIT`); only failures count |

All of these are configurable in `.env`. Hitting a limit is recorded in the security log; repeated identical events are collapsed to one per minute.

## Browser-side protections

- **Host allowlist.** Only the configured hostnames are accepted, which defeats DNS-rebinding attacks against `localhost`.
- **Canonical paths only.** Request paths containing percent-escapes or backslashes are refused outright. The `/api` guards decide from both the raw path and the route that matched, so an alternative spelling of a path can't skip them.
- **CSRF.** State-changing requests must come from an allowed `Origin` and carry the `X-Codex-Console: 1` header. A cross-site page cannot add that header without a CORS preflight, and the console never answers preflights.
- **Content Security Policy.**
  - The page policy is `default-src 'self'` with no inline scripts or styles.
  - Framing is blocked: `frame-ancestors 'none'`, plus `X-Frame-Options: DENY`.
  - Other headers: `nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP, and a restrictive `Permissions-Policy`.
  - HSTS is sent when the console is served over HTTPS.
- **Untrusted output.** Codex replies are rendered from Markdown with DOMPurify. Raw HTML from the model never runs.
- **Workspace files.**
  - Files are served with `Content-Security-Policy: sandbox`.
  - HTML, JS and other text files are shown as `text/plain`.
  - Anything else is a download.

## File access

- The file browser and upload/download API cannot leave `CC_WORKSPACE_ROOT`.
- Paths are rejected if they contain `..`, backslashes or NUL bytes.
- Every path is resolved with `realpath`, so symlinks pointing outside the workspace are refused.
- Files are opened with `O_NOFOLLOW` and re-checked through `/proc/self/fd` on Linux.
- Uploads stream to a temporary file and are size-capped, so an oversized upload never reaches its final name. They never overwrite an existing file unless you ask.
- The console's data directory and the workspace cannot contain each other.

Imported Codex threads whose folder is outside the workspace can still be chatted with, but the file browser is disabled for them.

## Public API and API keys

The public API is **off by default** (`CC_API_ENABLED`). When on, it is a **second listener** (default `127.0.0.1:8788`) built for scripts, separate from the console:

- **What it serves.** Only `/v1`. Anything else is a `404`; paths with percent-escapes or backslashes are refused. `/api`, the UI and the admin area do not exist on it.
- **Auth.** Only `Authorization: Bearer cck_…` keys; cookies and device tokens are ignored. Requests must carry an allowed `Host` (`421` otherwise). Responses use `Content-Security-Policy: default-src 'none'` and never set cookies.
- **Plain HTTP only on loopback.** It refuses to bind elsewhere without TLS in front. Exposure goes through a tunnel that terminates TLS: Tailscale Funnel (recommended, [docs/FUNNEL.md](docs/FUNNEL.md)) or a reverse proxy.
- **Client addresses.** With Funnel and `--proxy-protocol=2`, the real caller IP arrives in a PROXY header. `CC_API_PROXY_PROTOCOL=required` rejects connections without one. These addresses drive IP allowlists, throttling and logs.
- **Keys at rest.** A key is `cck_<id>.<256-bit secret>`. Only `HMAC-SHA256(pepper, secret)` is stored, and the secret is shown once. Comparisons are constant-time.
- **Rotation and revocation.** Rotation issues a new secret; the old one works for 0, 1 or 24 hours if you choose. Revocation is immediate: running prompts of the key are interrupted, and its event streams close within 30 seconds. At its expiry time a key stops working and its running turns are interrupted.
- **What a key can do** is limited four ways:
  1. **Scopes** (`prompt`, `sessions`, `files:read`, `files:write`, `approvals`, `settings`, `mcp:read`, `mcp:manage`, `shell`).
  2. **Caps** on sandbox, network and approvals that no request can exceed. With approvals set to *deny*, anything needing approval is declined automatically, without waiting. With *ask*, the key can decline its own approvals but can only allow them if it already has *Full access* and network; otherwise only you can, in the console. Image links in prompts need the network cap, since Codex downloads them itself.
  3. A **token quota** per day, month or in total, counted across all of the key's running turns. When it is used up, all of them are interrupted. It is a soft limit: usage is known only after each model step, so it can be exceeded by about one step per running turn. Turns Codex starts on its own in a key's session (goal continuation) are tracked, logged and charged the same way.
  4. **Rate limits** and an optional **IP allowlist**.
- **Isolation.** A key sees only the sessions it created. Its file API is confined to its own folder in the workspace.
- **Dangerous scopes.** `shell` (runs `!command` outside the model and its sandbox) and `mcp:manage` (adds commands that Codex will start) are effectively code execution on the host. They are off by default, highlighted in the UI, and every use is in the security log.
- **Reads are not sandboxed.** Codex's sandbox limits writes and network access, not reading. A key that can send prompts can ask Codex to read any file your user can read, including outside its folder. Give keys to your own tools only, and prefer short expiries and small quotas.
- **MCP tools are not sandboxed either.** They run in their servers' processes. A key that can send prompts can make Codex use every enabled MCP server, whatever its sandbox and network caps. Keep only the servers you are happy for your keys to reach enabled.
- **Rate budget.** Unauthenticated calls and failed keys don't use up the listener-wide budget that valid keys rely on.

## MCP servers

- Managed only from the admin area (fresh TOTP), or by keys with `mcp:manage`. Every add, change, removal and sign-in is in the security log.
- **Local servers** are commands Codex starts as your user, outside its sandbox: treat adding one like installing software.
- **Environment values** are write-only. The console stores them in Codex's `config.toml` and returns only the variable names. To keep a stored value, leave it blank.
- **Remote servers** must use `https://` (plain `http://` only for localhost).
- **OAuth sign-in links** are shown, never opened automatically. The sign-in completes on the host.

## Codex itself

- **Login.** The console starts `codex app-server` as your user. Codex keeps its login in `~/.codex/`; the console never reads, copies or logs it, and never triggers a login or logout.
- **Sandbox.** By default Codex runs with the `workspace-write` sandbox (writes limited to the session folder, no network), with approval policy `on-request`. Requests to go beyond the sandbox appear in the UI and are **denied automatically after 10 minutes**. You can change the defaults in **Admin → Settings** and per session; *Full access* removes the sandbox and is flagged in the UI. API keys can never go above their own caps.
- **Shell commands.** `!command` runs a command in the session folder directly, not through the model. It is always written to the security log.
- **Reads.** The sandbox limits writes, not reads. Codex can still read files elsewhere on the machine, including its own `~/.codex/auth.json`. This is why console access must be guarded like shell access.
- **Version.** The Codex version is pinned. The console warns when the running version differs from the tested one; `npm run codex:check` verifies protocol compatibility.

## What is stored, and where

Stored in `~/.codexconsole/` (directory `0700`, files `0600`):

| File | Contents |
| --- | --- |
| `secrets.json` | 32-byte random pepper, used for token hashes and to derive the key that encrypts the TOTP secret |
| `codexconsole.db` | Argon2id password hash, AES-256-GCM-encrypted TOTP secret, device-token, pairing-code and API-key hashes, API key settings, sessions, transcripts, request / API / transfer / security logs, usage-limit snapshots |
| `media/` | Copies of images Codex viewed or generated outside the workspace |

The repository contains no secrets: `.env`, data folders, databases, keys and certificates are all gitignored, and `.env.example` holds only non-secret settings. Logs older than the retention period (180 days by default) are deleted automatically.

## If something goes wrong

| Situation | What to do |
| --- | --- |
| A device is lost or stolen | **Admin → Devices → Revoke**. If you can't reach the admin area, run `npm run setup -- --revoke-all` on the host, then revoke the device afterwards. |
| Your password may be known | `npm run setup -- --reset-password` (ends all logins) |
| Your authenticator is lost | `npm run setup -- --reset-totp` on the host (ends all logins) |
| An API key leaked | **Admin → API keys → Revoke** (or **Rotate** with no grace period). Then check its usage and the security log, filtered by that key. |
| You want the API off the internet | `tailscale funnel --tls-terminated-tcp=8443 off` (or the port you used), and set `CC_API_ENABLED=false`. |
| Something looks odd | Check **Admin → Security log** for failed logins, lockouts, rejected hosts, origins and API keys, and use of revoked tokens. |
| You want it to stop | Stop the service. Nothing listens on the network after that, and Codex stops with it. |

## Things this does not protect against

- Someone with a shell on the host as your user. They can read the database and secrets file, and use Codex directly.
- Malicious content that Codex reads and acts on (prompt injection from files or web pages). Review approval requests before allowing them.
- Exposure without HTTPS. The server refuses plain HTTP on non-loopback addresses, but a misconfigured proxy can still leak traffic. Prefer Tailscale.
- A key that is used as intended but given to the wrong tool. Scopes, caps, quotas and folders limit the damage. They do not stop such a tool from reading what Codex can read.
