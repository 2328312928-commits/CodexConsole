# Codex Console

A private, single-owner web console for **your own** [Codex CLI](https://github.com/openai/codex), signed in with **your ChatGPT plan** (not API credits). Put it on a server once; then open it in a browser on any of your computers, paste one of your API keys, and you have the full console. Nothing to install on that computer.

From your own browsers and phone you can:

- send prompts to Codex and watch replies stream in (thinking, commands with output, file diffs, plans, MCP tool calls)
- steer a running turn, stop it, answer Codex's questions and MCP servers' forms, and approve or deny the commands and file changes Codex asks for
- use Codex's own features: per-session model, reasoning, sandbox, approval and network settings; `/` slash commands; review, compact, diffs, goals, `@` file mentions, skills, image links, `!` shell commands; fork a session from any turn or rewind it
- upload files to the workspace and download them, and attach files or images to a prompt
- see the images and videos Codex creates or looks at, inline
- manage sessions: create, rename, archive, delete, search, and import threads you started in a terminal
- manage Codex's **MCP servers**: list, add, edit, enable/disable, remove, sign in
- give each of your devices its own **API key**, with expiry, quota, rate limits, caps, rotation and revocation; keys with API scopes also work for your scripts through the public API (`/v1`)
- use a private **admin dashboard**: every request with time, session, key, prompt size, duration, status, tokens and files, plus your plan's usage limits, per-key usage, who is signed in, file transfers and a security log

Every screen is available in **English and 简体中文** (toggle in the top bar), in light and dark. Chinese docs: [README.zh-CN.md](README.zh-CN.md). What Codex offers and where each part lives: [docs/FEATURES.md](docs/FEATURES.md).

> **It is a remote shell.** Codex runs commands on the machine hosting the console. Anyone with one of your keys can do what Codex can do there. Keep keys like passwords, and read [SECURITY.md](SECURITY.md).

## How it works

```
your browsers ──HTTPS──▶ Caddy (Let's Encrypt, domain or IP) ──▶ Codex Console (127.0.0.1:8787)
                                                               ├─ sign-in: API key → session cookie; admin: + password + authenticator code
                                                               ├─ REST API + server-sent events (live streaming)
                                                               ├─ SQLite (built into Node): sessions, transcripts, request log, audit log
                                                               ├─ file service, confined to the workspace folder
                                                               └─ child process: `codex app-server` ──▶ your ChatGPT plan
your scripts ──HTTPS──▶ Caddy ──/v1──▶ public API (127.0.0.1:8788, API keys with scopes only)
```

The console drives Codex through `codex app-server`. That is Codex's official JSON-RPC interface, the one its IDE extension and desktop app use.

- **Sessions:** each session is a Codex thread.
- **Prompts:** a prompt starts a turn (`turn/start`), and replies stream token by token.
- **Approvals:** approval requests show up as Allow / Deny cards. An unanswered request is denied after a timeout.
- **Usage limits:** come from `account/rateLimits/read`.
- **Codex sign-in:** Codex keeps its own login in its `CODEX_HOME`. You sign it in once from **Admin → Codex** (device code); the console never reads or copies those credentials.

**Version pinning.** The Codex CLI version is pinned in `package.json` (`@openai/codex` 0.164.0) and installed with the project. `npm run codex:check` verifies that the installed binary still supports every protocol method the console uses.

## Deploy to your server (the main way)

You need a Linux server (Ubuntu 22.04/24.04 or Debian 12/13, x86-64 or ARM64, 1 GB RAM or more) that you can reach with SSH, and either a domain pointing at it or just its public IPv4 address. Ports 80 and 443 must be open in your provider's firewall. On your own computer, in this repository:

```bash
./deploy/deploy.sh root@203.0.113.7 --ip 203.0.113.7
```

or with a domain:

```bash
./deploy/deploy.sh me@my-server --domain console.example.com --email me@example.com
```

The script copies the app over SSH (only the files git tracks: never `.env`, data or keys), builds it on the server, installs Node.js and Caddy, gets an HTTPS certificate, and sets up a locked-down system service, a firewall, fail2ban and automatic security updates. On the first install it asks you, in that terminal, for an admin password and an authenticator, then prints **your first API key**.

Then:

1. Open the address it shows and paste the key. That is all a browser needs.
2. Open **Admin** (password + authenticator code) → **Codex** → sign in with your ChatGPT plan.
3. For each other device, issue its own key: **Admin → Keys → New key**, or on the server `sudo codex-console setup --new-key "Phone"`.

Run the same command again to update; your data stays on the server. Everything about the deployment (options, what it changes, updating, backups, troubleshooting): **[docs/DEPLOY.md](docs/DEPLOY.md)**.

## Run it on your own machine

```bash
npm ci
npm run build
npm run setup              # admin password + authenticator + your first API key
npm start
```

Open `http://127.0.0.1:8787`, paste the key, then sign Codex in from **Admin → Codex**. `npm run setup -- --lang zh-CN` runs the setup in Chinese.

Upgrading from a version that paired devices? Pairings are gone; your owner account and API keys stay (existing keys stay API-only). Run `npm run setup -- --new-key "Laptop"` once to get a key that signs in to the console.

Codex works inside `~/codex-workspace/` by default, in one folder per session. The console's own data (database, secrets, media) lives in `~/.codexconsole/` with owner-only permissions. Nothing secret goes in this repository.

To reach a home machine from elsewhere without a public server, use Tailscale (`tailscale serve --bg --https=443 http://127.0.0.1:8787`, then `CC_PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net` and `CC_TRUST_PROXY=loopback` in `.env`), or your own TLS certificate (`CC_HOST=0.0.0.0`, `CC_TLS_CERT`, `CC_TLS_KEY`, `CC_PUBLIC_ORIGIN`). The server refuses plain HTTP on anything but `127.0.0.1`. All settings: [`.env.example`](.env.example). A systemd user unit is in [`deploy/codex-console.service`](deploy/codex-console.service).

## Keys and signing in

Each of your devices gets its own key, so you can see its usage and revoke it alone.

- **Console sign-in per key:** *Full console* (every session and the whole workspace, never the admin area), *Folder only* (its own sessions and one folder), or *Off* (API only).
- **Caps per key:** the most powerful sandbox, network access, approvals (ask you, or deny automatically), token quota, prompts per minute, prompts at once, upload volume, IP allowlist and expiry. They apply in the console as well as in the API. A capped key can look at every session but works only in its own; `!` shell commands need full access and network. A key with full access and network has nothing left to cap and works like the owner's console.
- **Revoke** signs the key out everywhere at once, including live streams and running prompts. **Rotate** issues a new secret and signs the old one out of the console (an optional grace period keeps it working for API scripts). Changing a key's console access also signs it out.
- **Admin → Keys** also lists every browser signed in right now, with the key it used, its address and browser, and lets you sign any of them out.
- A sign-in lasts 12 hours without use and 7 days at most (`CC_SESSION_IDLE_HOURS`, `CC_SESSION_MAX_DAYS`).

## Working with Codex

Type `/` in the prompt box for the command menu, or use the **⋯** menu in a session's header.

| Command | Does |
| --- | --- |
| `/model`, `/approvals`, `/sandbox`, `/network` | Session settings (the sliders button opens the same dialog) |
| `/review`, `/compact`, `/diff`, `/status`, `/goal` | Code review, compact the context, show changes, session status, thread goal |
| `/fork`, `/undo`, `/new` | Fork the session, rewind the last turn, new session. Each turn also has **Fork from here** and **Rewind** |
| `/init`, `/skills`, `/mention`, `/mcp`, `/help` | Write `AGENTS.md`, use a skill, mention a file, list MCP servers, list commands |
| `/plan`, `/permissions`, `/ps`, `/stop`, `/cd`, `/copy`, `/export`, `/feedback` | Plan mode, permission presets, background terminals, working folder, copy the last answer, export as Markdown, feedback to OpenAI |
| `!command` | Run a shell command in the session folder (always recorded in the security log) |

The chip next to the prompt box picks the **model, reasoning level, speed and how much thinking is shown**, from the options Codex offers for that model; the choice stays with the session. While Codex is working, the prompt box **queues** your next message or **steers** the running turn. Approvals and questions waiting in other sessions show up at the top of the session list.

New console defaults for sandbox, approvals and network are in **Admin → Settings**, together with Codex's own default model and reasoning (written to its `config.toml`).

## MCP servers

**Admin → MCP servers** manages the MCP servers Codex uses. Changes go to Codex's `config.toml` on the host:

- **Local servers** run a command on the host, as the console's user and outside Codex's sandbox. Only add commands you trust. Environment values are write-only: the console never shows them again.
- **Remote servers** must use `https://`. For OAuth servers, **Sign in** shows the authorization link. The console never opens it for you.

MCP tool calls appear in the transcript with their arguments, progress and results.

## Public API

Keys with API scopes can call `/v1` for your own scripts: on a deployed server at `https://<your address>/v1`, on your own machine on `127.0.0.1:8788` once `CC_API_ENABLED=true` (reach it from outside with Tailscale Funnel: [docs/FUNNEL.md](docs/FUNNEL.md)). Endpoints, scopes and examples: [docs/API.md](docs/API.md).

## Security summary

- **Signing in:** an API key (`cck_…`, 256 random bits, stored only as an HMAC) creates a session in an HttpOnly, Secure, SameSite=Strict cookie. The key is checked again on every request, so revoking it, letting it expire, taking away its console access or a non-matching IP allowlist ends the session at once.
- **Admin area:** separately protected. It needs the owner password (Argon2id) and a single-use TOTP code on top of a key sign-in, and locks again after 15 minutes without use. No key alone opens it. On a deployed server Codex runs as its own user and cannot reach the console's data; on your own machine a key with full access is equivalent to the owner: see [SECURITY.md](SECURITY.md#limits-of-the-admin-separation).
- **Rate limits:**
  - key sign-in: 10 failures per IP / 15 min, then that address is locked (per address only, so nobody can lock you out from elsewhere); during a flood, one failure locks an address
  - admin unlock: 5 failures per IP / 15 min, 20 overall
  - requests per key, prompts per key, upload bytes per key per hour
- **Request checks:** a Host allowlist (blocks DNS rebinding), Origin checks plus a custom header on every state-changing request (CSRF), a strict Content-Security-Policy and other security headers.
- **Files:** everything stays inside the workspace (or the key's folder). Path traversal and symlinks pointing outside are refused. HTML is shown as text, and files are served with a sandbox CSP.
- **Server:** behind Caddy on loopback only, under its own system user, read-only outside its data folder; Codex in a separate service as another user that cannot see the console's data; firewall allows only SSH, 80 and 443; fail2ban; automatic security updates.
- **Audit:** every API call, prompt, file transfer, sign-in and security event is logged with the key that made it. Retention is configurable.

Full details, and what to do if a device or key is lost: [SECURITY.md](SECURITY.md).

## Recovery commands

On a deployed server use `sudo codex-console setup …`; on your own machine `npm run setup -- …`.

| Option | Effect |
| --- | --- |
| `--new-key "Laptop"` | Issue another full-console key (for example if you have lost all of them) |
| `--list-keys` | List keys with their status and last use |
| `--revoke-key ID` | Revoke a key and sign it out everywhere |
| `--sign-out-all` | End every console sign-in |
| `--reset-password` | New admin password; ends all sign-ins |
| `--reset-totp` | Enrol a new authenticator; ends all sign-ins |

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
| `deploy/` | `deploy.sh` (run on your computer), `install.sh` (runs on the server), examples |
| `test/` | Vitest suites and the fake Codex |

Adding UI text means adding the key to both `shared/i18n/en.ts` and `shared/i18n/zh-CN.ts`. TypeScript and the i18n test fail otherwise.

## Notes

- **Personal use only.** This is built for one owner and that owner's own devices. Sharing access to your ChatGPT plan is against OpenAI's terms.
- **Usage limits** shown in the dashboard are what Codex reports for your plan. The console does not work around them.
- **Upgrading Codex:** change `@openai/codex` in `package.json`, run `npm install`, then `npm run codex:check`; on a server, deploy again.
- **Not included on purpose:** voice / realtime, Windows sandbox setup, Codex cloud and remote-control features (see [docs/FEATURES.md](docs/FEATURES.md)).
