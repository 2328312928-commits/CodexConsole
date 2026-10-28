# Codex Console

A private, single-owner web console for **your own** [Codex CLI](https://github.com/openai/codex), signed in with **your ChatGPT plan** (not API credits). From your own browsers and phone you can:

- send prompts to Codex and watch replies stream in (thinking, commands with output, file diffs, plans, MCP tool calls)
- steer a running turn, stop it, answer Codex's questions and MCP servers' forms, and approve or deny the commands and file changes Codex asks for
- use Codex's own features: per-session model, reasoning, sandbox, approval and network settings; `/` slash commands; review, compact, diffs, goals, `@` file mentions, skills, image links, `!` shell commands; fork a session from any turn or rewind it
- upload files to the workspace and download them, and attach files or images to a prompt
- see the images and videos Codex creates or looks at, inline
- manage sessions: create, rename, archive, delete, search, and import threads you started in a terminal
- manage Codex's **MCP servers**: list, add, edit, enable/disable, remove, sign in
- create **API keys** for your own scripts and devices, with quotas, expiry, scopes, rotation and revocation, and use them over the internet through a separate public API
- use a private **admin dashboard**: every request with time, session, device or key, prompt size, duration, status, tokens and files, plus your plan's usage limits, per-key usage, device tokens, logins, file transfers and a security log

Every screen is available in **English and 简体中文** (toggle in the top bar). Chinese docs: [README.zh-CN.md](README.zh-CN.md).

> **It is a remote shell.** Codex runs commands on the machine hosting the console. Anyone who gets into the console can do what Codex can do. Read [SECURITY.md](SECURITY.md) before exposing it beyond `localhost`.

## How it works

```
your devices ──HTTPS──▶ Codex Console (Node.js, 127.0.0.1:8787 by default)
                         ├─ auth: per-device token + password + authenticator code, rate limits
                         ├─ REST API + server-sent events (live streaming)
                         ├─ SQLite (built into Node): sessions, transcripts, request log, audit log
                         ├─ file service, confined to the workspace folder
                         └─ child process: `codex app-server` ──▶ your ChatGPT plan (via `codex login`)
your scripts ──HTTPS──▶ public API (optional, 127.0.0.1:8788, /v1 only, API keys only)
```

The console drives Codex through `codex app-server`. That is Codex's official JSON-RPC interface, the one its IDE extension and desktop app use.

- **Sessions:** each session is a Codex thread.
- **Prompts:** a prompt starts a turn (`turn/start`), and replies stream token by token.
- **Approvals:** approval requests show up as Allow / Deny cards. An unanswered request is denied after a timeout.
- **Usage limits:** come from `account/rateLimits/read`.
- **Login:** Codex keeps its own login in `~/.codex`. The console never reads or copies those credentials.

**Version pinning.** The Codex CLI version is pinned in `package.json` (`@openai/codex` 0.164.0) and installed with the project. `npm run codex:check` verifies that the installed binary still supports every protocol method the console uses.

## Requirements

- **Node.js 22.13 or newer.** Node 24 LTS is recommended; Node 20 is end-of-life and not supported. The console uses Node's built-in SQLite, so nothing is compiled.
- **OS:** Linux or macOS. Windows works through WSL.
- **A ChatGPT plan** that includes Codex.
- **An authenticator app** such as Google Authenticator, 1Password, Authy or Microsoft Authenticator.

## Quick start (on the machine that will run Codex)

```bash
npm ci
npm run build
npx codex login            # sign in with ChatGPT; use `npx codex login --device-auth` on a headless server
npm run codex:check        # optional: confirms the Codex protocol and that you are signed in
npm run setup              # password + authenticator + first pairing code
npm start
```

Then:

1. Open `http://127.0.0.1:8787` on the same machine.
2. Enter the pairing code that `npm run setup` printed, or scan its QR code.
3. Sign in with your password and authenticator code.

`npm run setup -- --lang zh-CN` runs the setup in Chinese.

Codex works inside `~/codex-workspace/` by default, in one folder per session. The console's own data (database, secrets, media) lives in `~/.codexconsole/` with owner-only permissions. Nothing secret goes in this repository.

## Adding your other devices

To add a phone or laptop:

1. Go to **Admin → Devices → Add a device** and give it a name.
2. Scan the QR code on the new device, or open `/pair` there and type the code. A code works once and expires after 15 minutes.
3. Sign in on that device with your password and authenticator code.

Each device gets its own token. The admin dashboard shows usage per device. **Revoke** a device to sign it out permanently.

Other devices can only reach the console once it is served over HTTPS (next section).

## Reaching it from other devices (HTTPS)

The server listens on `127.0.0.1` only. It refuses plain HTTP on any other address. Pick one of these options:

**A. Tailscale (recommended: only your own devices can reach it, nothing is public)**

```bash
tailscale serve --bg --https=443 http://127.0.0.1:8787
```

`.env`:

```bash
CC_PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net
CC_TRUST_PROXY=loopback
```

**B. Your own domain with Caddy (automatic Let's Encrypt).** This is public: the console is reachable from the internet, protected by device token, password and authenticator code. See [`deploy/Caddyfile.example`](deploy/Caddyfile.example).

```bash
CC_PUBLIC_ORIGIN=https://console.example.com
CC_TRUST_PROXY=loopback
```

**C. Built-in TLS** (for example on your LAN with a certificate from `mkcert` or `tailscale cert`):

```bash
CC_HOST=0.0.0.0
CC_TLS_CERT=/path/to/fullchain.pem
CC_TLS_KEY=/path/to/privkey.pem
CC_PUBLIC_ORIGIN=https://mybox.lan:8787
```

Restart the console after changing `.env`. All settings are listed in [`.env.example`](.env.example).

Options A–C are for the console itself. To call the **public API** from the internet, see the next section; it can run next to option A (console on 443 through `tailscale serve`, API on 8443 through `tailscale funnel`).

To keep the console running on Linux, use the systemd user unit in [`deploy/codex-console.service`](deploy/codex-console.service). Its header explains how to install it.

## Working with Codex

Type `/` in the prompt box for the command menu, or use the **⋯** menu in a session's header.

| Command | Does |
| --- | --- |
| `/model`, `/approvals`, `/sandbox`, `/network` | Session settings (the sliders button opens the same dialog) |
| `/review`, `/compact`, `/diff`, `/status`, `/goal` | Code review, compact the context, show changes, session status, thread goal |
| `/fork`, `/undo`, `/new` | Fork the session, rewind the last turn, new session. Each turn also has **Fork from here** and **Rewind** |
| `/init`, `/skills`, `/mention`, `/mcp`, `/help` | Write `AGENTS.md`, use a skill, mention a file, list MCP servers, list commands |
| `!command` | Run a shell command in the session folder (always recorded in the security log) |

While Codex is working, the prompt box **steers** the running turn. Approvals and questions waiting in other sessions show up at the top of the session list.

New console defaults for sandbox, approvals and network are in **Admin → Settings**, together with Codex's own default model and reasoning (written to its `config.toml`).

## MCP servers

**Admin → MCP servers** manages the MCP servers Codex uses. Changes go to Codex's `config.toml` on the host:

- **Local servers** run a command on the host, as your user and outside Codex's sandbox. Only add commands you trust. Environment values are write-only: the console never shows them again.
- **Remote servers** must use `https://`. For OAuth servers, **Sign in** shows the authorization link. The console never opens it for you; the sign-in completes in a browser on the host.

MCP tool calls appear in the transcript with their arguments, progress and results.

## Public API and API keys

**Admin → API keys** creates keys for your own scripts and devices. They work only on a separate listener (`127.0.0.1:8788`, off by default) that serves `/v1`, never the console or the admin area.

- **Per key:** label, expiry, token quota (per day, month or in total), scopes, the most powerful sandbox, network, what happens on approvals (deny automatically, or ask you), rate limits, IP allowlist, and its own workspace folder.
- **Keys** are shown once and stored only as an HMAC. **Rotate** with an optional grace period, or **Revoke** instantly.
- **Usage:** each key's usage (prompts, tokens, transfers, a 30-day chart, recent prompts) is in the dashboard. Requests, transfers and the security log can be filtered by key.

Turn it on with `CC_API_ENABLED=true`. To reach it from anywhere, use Tailscale Funnel with PROXY protocol, which exposes only the API port: step-by-step guide in [docs/FUNNEL.md](docs/FUNNEL.md). Endpoints, scopes and examples are in [docs/API.md](docs/API.md).

## Security summary

- **Three factors for every login:**
  - a paired device token: 256-bit, stored only as an HMAC hash, in an HttpOnly, Secure, SameSite=Strict cookie
  - your password: Argon2id
  - a TOTP code: single-use, encrypted at rest
- **Admin step-up:** the admin area needs a fresh TOTP code after 15 minutes of inactivity.
- **Rate limits:**
  - logins: 5 failures per IP / 15 min, 20 overall
  - pairing attempts
  - API calls and prompts per device
  - upload bytes per device per hour
- **Request checks:**
  - a Host allowlist (blocks DNS rebinding)
  - Origin checks plus a custom header on every state-changing request (CSRF)
  - a strict Content-Security-Policy and other security headers
- **Files:** everything stays inside the workspace. Path traversal and symlinks pointing outside are refused. HTML is shown as text, and files are served with a sandbox CSP.
- **Audit:** every API call, prompt, file transfer and security event is logged. Retention is configurable.
- **API keys:** stored as HMACs. They work only on the separate `/v1` listener, with their own scopes, quotas, rate limits and caps on sandbox, network and approvals. Failed keys are throttled per IP. `shell` and `mcp:manage` are off unless you grant them.

Full details, and what to do if a device is lost: [SECURITY.md](SECURITY.md).

## Recovery commands (run on the host)

| Command | Effect |
| --- | --- |
| `npm run setup -- --pair "Laptop"` | New pairing code (for example if you are locked out of the admin area) |
| `npm run setup -- --revoke-all` | End every login session |
| `npm run setup -- --reset-password` | New password; ends all logins |
| `npm run setup -- --reset-totp` | Enrol a new authenticator; ends all logins |

## Development

```bash
npm run dev -- --fake-codex   # UI + server with a fake Codex: no login, no OpenAI calls
npm run dev                   # same, with your real Codex
npm test                      # unit + integration tests (use the fake Codex)
npm run typecheck
```

The fake app-server in `test/fake-codex/` implements the same protocol shapes as Codex 0.164.0. Prompt keywords make it exercise features: `approve`, `permission`, `question`, `elicit`, `mcp`, `image`, `video`, `edit`, `slow`, `steady`, `fail`, `fail limit`.

| Path | Contents |
| --- | --- |
| `server/` | Fastify API, auth, Codex bridge (`server/codex/`), CLI tools (`server/cli/`) |
| `web/` | React UI (Vite) |
| `shared/` | Types, the protocol subset (`shared/codex.ts`), and the EN / 中文 dictionaries (`shared/i18n/`) |
| `test/` | Vitest suites and the fake Codex |

Adding UI text means adding the key to both `shared/i18n/en.ts` and `shared/i18n/zh-CN.ts`. TypeScript and the i18n test fail otherwise.

## Notes

- **Personal use only.** This is built for one owner. Sharing access to your ChatGPT plan is against OpenAI's terms.
- **Usage limits** shown in the dashboard are what Codex reports for your plan. The console does not work around them.
- **Upgrading Codex:** change `@openai/codex` in `package.json`, run `npm install`, then `npm run codex:check`.
- **Not included on purpose:** signing Codex in or out (run `codex login` on the host), feedback upload, voice / realtime, Windows sandbox setup, Codex cloud and remote-control features, and plugin marketplace installs.
