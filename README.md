# Codex Console

A self-hosted, single-owner web console for **your own** [Codex CLI](https://github.com/openai/codex), signed in with **your ChatGPT plan** (not API credits). Everyone runs their own copy, for themselves: put it on a server once, or run it on your own computer with Tailscale; then open it in a browser on any of your devices, paste one of your API keys, and you have the full console. Nothing to install on those devices.

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

> **Unofficial.** An independent open-source project, not affiliated with or endorsed by OpenAI. Codex and ChatGPT are trademarks of OpenAI.

## Which way to run it

| | **A. Your own computer, with Tailscale** | **B. Your own Linux server** |
| --- | --- | --- |
| You need | A Windows, macOS or Linux computer and a free [Tailscale](https://tailscale.com) account | A Linux server you can reach with SSH, and a domain or its public IPv4 address |
| Address | `https://<computer>.<tailnet>.ts.net`, the same every time | `https://<your domain>` or `https://<the server's IP>` |
| Who can open it | Any browser (Funnel), or only your own Tailscale devices | Any browser |
| Runs while | the computer is on and the console window is open | always |
| Download | the **console package** for that computer | the **deploy program** for the computer you deploy from |

Either way, a browser needs one of your API keys to sign in, and the admin area also needs your password and an authenticator code.

## Downloads

Everything is on the project's **Releases** page:

| Your computer | Console package (option A) | Deploy program (option B) |
| --- | --- | --- |
| Windows 10 or 11 (x64) | `codex-console-windows-x64.zip` | `codex-console-deploy-windows-x64.exe` |
| Mac with Apple silicon (M1 or newer) | `codex-console-macos-arm64.zip` | `codex-console-deploy-macos-arm64.zip` |
| Mac with an Intel processor | `codex-console-macos-x64.zip` | `codex-console-deploy-macos-x64.zip` |
| Linux x64 | `codex-console-linux-x64.tar.gz` | `codex-console-deploy-linux-x64.tar.gz` |
| Linux ARM64 | `codex-console-linux-arm64.tar.gz` | `codex-console-deploy-linux-arm64.tar.gz` |

- **Which Mac?** Apple menu → **About This Mac**: "Chip: Apple M…" means Apple silicon; "Processor: Intel…" means Intel.
- **Checksums:** `SHA256SUMS.txt` lists every file's SHA-256. To check a download: Windows PowerShell `Get-FileHash .\file.zip`, macOS `shasum -a 256 file.zip`, Linux `sha256sum file.tar.gz`.
- **Not signed with paid certificates:** the first start needs one extra click, described below for each system.
- **Build them yourself:** `npm ci && npm run package:portable` (console packages) and `cd deployer && npm ci --ignore-scripts && npm run package -- --all` (deploy program; its macOS files need a Mac).

## Option A: your own computer, with Tailscale

The console runs on your computer and Tailscale gives it a fixed https address. With **Funnel** (the default) any browser on the internet can open it; with **tailnet only** just the devices signed in to your Tailscale account can. Nothing on the computer is opened to the internet except through Tailscale.

### Step 1: set up Tailscale (once)

1. **Install Tailscale and sign in** on the computer that will run the console:
   - Windows and macOS: [tailscale.com/download](https://tailscale.com/download) (on a Mac, the Mac App Store version works too). Open it and sign in; it creates your free account (your "tailnet").
   - Linux: `curl -fsSL https://tailscale.com/install.sh | sh`, then `sudo tailscale up` and open the link it prints to sign in.
2. **Turn on HTTPS.** Open the [DNS page of the Tailscale admin console](https://console.tailscale.com/admin/dns). Check that **MagicDNS** is on (it is for new tailnets), then under **HTTPS Certificates** choose **Enable HTTPS** and confirm. This publishes your computer's Tailscale name in public certificate logs, so use a computer name you don't mind being seen.
3. **Funnel** (for a public address) needs nothing in advance: the first start prints a link to allow it, which you open and confirm once. If your tailnet has a custom access policy, it needs the `funnel` attribute: see [Tailscale Funnel](https://tailscale.com/kb/1223/funnel).
4. **Linux only:** let your user manage Tailscale Serve and Funnel: `sudo tailscale set --operator=$USER`.

The address is `https://<computer name>.<tailnet name>.ts.net`. You can see both on the [Machines page](https://console.tailscale.com/admin/machines), and rename the computer there.

### Step 2: install and start

#### Windows

1. Download `codex-console-windows-x64.zip`.
2. Optional, saves a warning later: right-click the zip → **Properties** → tick **Unblock** → **OK**.
3. Right-click the zip → **Extract All…** → choose a folder (for example your Documents) → **Extract**. Don't run it from inside the zip.
4. Open the `Codex Console` folder and double-click **Start Codex Console.cmd**.
5. If "Windows protected your PC" appears, choose **More info** → **Run anyway**.
6. A console window opens: keep it open while you use Codex Console. The first time, Tailscale may print a link to allow Funnel: your browser opens it; confirm.
7. The window shows your address, and the first time your browser opens the setup page: go on with [First sign-in and Codex](#first-sign-in-and-codex).

To keep the address private to your Tailscale devices, start **Start Codex Console (tailnet only).cmd** instead.

#### macOS (Apple silicon or Intel)

1. Download the zip for your Mac: `codex-console-macos-arm64.zip` (Apple silicon) or `codex-console-macos-x64.zip` (Intel).
2. Double-click the zip to unpack it, and move the `Codex Console` folder where you like (your home folder or Applications).
3. Double-click **Start Codex Console.command**. It runs in a Terminal window.
4. The first time, macOS says it can't verify the file: click **Done**, open **System Settings → Privacy & Security**, scroll down, choose **Open Anyway** and confirm. (macOS 14 and earlier: Control-click the file → **Open** → **Open**.) If Terminal asks for access to the folder, allow it.
5. The first time, Tailscale may show a link to allow Funnel: open it and confirm.
6. The window shows your address, and the first time your browser opens the setup page: go on with [First sign-in and Codex](#first-sign-in-and-codex).

The launcher clears macOS's download quarantine for its own folder only, so Codex and its helpers aren't blocked one by one. **Start Codex Console (tailnet only).command** keeps the address private to your Tailscale devices.

#### Linux (x64 or ARM64)

```bash
tar -xzf codex-console-linux-x64.tar.gz     # or ...-linux-arm64.tar.gz
cd codex-console
./start.sh                                   # public through Funnel
./start.sh --tailnet-only                    # or: only your Tailscale devices
```

The terminal shows your address and the one-time setup link (it also tries to open it in your browser). To keep it running after you log out, use tmux or screen, or a systemd user service:

```ini
# ~/.config/systemd/user/codex-console.service
[Unit]
Description=Codex Console

[Service]
ExecStart=%h/codex-console/start.sh --no-open
Restart=on-failure

[Install]
WantedBy=default.target
```

Then `systemctl --user enable --now codex-console` and `loginctl enable-linger $USER`; `journalctl --user -u codex-console` shows the address and the setup link.

### Funnel or tailnet only

- **Funnel** (default): any browser can open the address and see the sign-in page. Keys (256-bit, stored only as hashes), per-address rate limits and the separately protected admin area keep others out. HTTPS ends on your own computer.
- **Tailnet only**: the address works only on devices signed in to your Tailscale account.
- Switch any time by starting the other launcher; it changes the Tailscale setting for you.

### Stop, restart, update, remove

- **Stop:** close the window or press Ctrl+C. The address then shows an error page until you start again.
- **Restart:** start it again. The address stays the same, and so do your keys and sessions.
- **Update:** unpack the new package into a new folder and start that one. Your data lives in your home folder (below), not in the package.
- **Remove:** delete the folder and the data folders below; `tailscale funnel --https=443 off` (or `tailscale serve --https=443 off`) removes the address.

| What | Windows | macOS and Linux |
| --- | --- | --- |
| The console's data (keys, sessions, logs) | `%USERPROFILE%\.codexconsole` | `~/.codexconsole` |
| Codex's working folder | `%USERPROFILE%\codex-workspace` | `~/codex-workspace` |
| Codex's own sign-in and settings | `%USERPROFILE%\.codex` | `~/.codex` |

More (what it does, options, troubleshooting): [docs/TAILSCALE.md](docs/TAILSCALE.md).

## Option B: your own Linux server

You need a Linux server (Ubuntu 22.04/24.04 or Debian 12/13, x86-64 or ARM64, 1 GB RAM or more) that you can sign in to with SSH as root or a sudo user, a domain pointing at it or just its public IPv4 address, and ports 80 and 443 open in your provider's firewall. The deploy program runs on your own computer and does everything over SSH.

### Start the deploy program

- **Windows:** download `codex-console-deploy-windows-x64.exe` and double-click it. If "Windows protected your PC" appears, choose **More info** → **Run anyway**.
- **macOS:** download the zip for your Mac, double-click it, then double-click `codex-console-deploy`. The first time, open **System Settings → Privacy & Security** → **Open Anyway** (macOS 14 and earlier: Control-click → **Open**). It runs in a Terminal window.
- **Linux:** `tar -xzf codex-console-deploy-linux-x64.tar.gz && ./codex-console-deploy`.

A small window shows that it is running, and your browser opens the deploy page (if it doesn't, open the link shown in the window).

### Deploy

1. **Your server:** its address and SSH port, the user name, and the password or SSH key (keys in your `~/.ssh` folder are listed; or choose the file). For a user other than root, sudo's password if it isn't the login password.
2. **Web address:** the server's IP address (no domain needed) or your domain (point its DNS `A` record at the server first). An email for certificate notices is optional.
3. **Check server** looks without changing anything; **Deploy** installs Codex Console (or updates it). The first time, confirm the server's SSH fingerprint (**Trust and continue**). Installing takes a few minutes.
4. When it finishes, choose **Open setup page** and go on with [First sign-in and Codex](#first-sign-in-and-codex).

Press **Deploy** again to update; your data stays on the server, in `/var/lib/codex-console`. **Other tasks** on the page gets a new setup link or creates a recovery key. From a terminal, `./deploy/deploy.sh root@203.0.113.7 --ip 203.0.113.7` in this repository does the same. More: [docs/DEPLOY.md](docs/DEPLOY.md).

## First sign-in and Codex

1. **Setup page.** It opens by itself the first time (or open the setup link shown in the window). The link works once and expires after 7 days.
   - **Admin password:** at least 12 characters, typed twice. It opens the admin area.
   - **Authenticator:** scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, …) and type its 6-digit code.
   - **Name of this device**, then **Finish setup**.
2. **Your first key** appears ("You're signed in"). It is shown only once: copy it into your password manager. This browser is now signed in.
3. **Sign Codex in:** choose **Next: sign Codex in** (later: **Admin → Codex**), then **Sign in to ChatGPT**. It shows a link and a code: open the link, sign in to ChatGPT, enter the code. Codex now uses your ChatGPT plan.
4. **Work:** **Console** → new session → type a prompt.

Later, **Admin** asks for the admin password and an authenticator code (**Unlock admin**) and locks again after 15 minutes without use. **Sign out** in the top bar ends this browser's sign-in.

Lost the setup link, or it expired? Option A: start the console again, which prints a new one. Option B: the deploy program's **Other tasks → Get a new setup link**.

## API keys: create and revoke

Give each device its own key, so you can see its usage and revoke just that one.

**Create a key**

1. **Admin** (password + authenticator code) → **Keys** → **New key**.
2. **Name**, for example "Laptop" or "Phone". Optionally a **Token quota** with its **Quota period** (per day, per month or in total).
3. Optionally **More options**: expiry, console access (*Full console*, *Folder only*, or *Off* for API only), public API scopes, the most powerful sandbox, approvals, network, rate limits, IP allowlist.
4. **Create key**. Copy the key (it is shown only once; the console keeps only a hash) and the **Sign in at** address, then **I've saved it**.

**Revoke a key**

1. **Admin → Keys**, find the key, choose **Revoke** and confirm in **Revoke key**.
2. It stops working everywhere at once: browsers signed in with it are signed out, its running prompts stop and its API calls fail. **Show revoked** lists revoked keys.

**Rotate** gives a key a new secret and signs the old one out (an optional grace period keeps it working for API scripts). **Signed in now**, on the same page, lists every browser signed in and lets you sign any of them out. Details: [Keys in detail](#keys-in-detail).

## Using it from other computers and phones

1. Open your address in any browser: the Tailscale address (option A) or your domain or IP (option B).
2. Paste one of your API keys and choose **Sign in**. Bookmark the page, or add it to the phone's home screen.
3. **Tailnet only:** install Tailscale on that device too and sign in to the same account first.

A sign-in lasts 12 hours without use and 7 days at most; then paste the key again. Revoking the key signs that device out at once.

## FAQ

**Which file do I download?** See [Downloads](#downloads): the console package to run it on that computer, the deploy program to put it on a server.

**Windows says "Windows protected your PC".** The files aren't signed with a paid certificate. Choose **More info → Run anyway**, or unblock the zip first (Properties → **Unblock**).

**macOS says it can't open or verify the file.** **System Settings → Privacy & Security → Open Anyway**, then start it again (macOS 14 and earlier: Control-click → **Open**).

**Linux says "Permission denied".** Unpack with `tar -xzf` (it keeps the files executable), or run `chmod +x start.sh node/node`.

**"Tailscale is not installed / not running / not signed in".** Install or open Tailscale, sign in, and start again.

**"MagicDNS is off", or the address doesn't answer.** On the [DNS page](https://console.tailscale.com/admin/dns), turn on MagicDNS and **Enable HTTPS**. The first certificate can take a few minutes.

**"Funnel is not allowed".** Open the link the window printed and confirm, or add the `funnel` attribute to your tailnet policy ([Tailscale Funnel](https://tailscale.com/kb/1223/funnel)).

**The address isn't the one I expected.** It is your computer's name in Tailscale. Rename the computer on the [Machines page](https://console.tailscale.com/admin/machines).

**"Port 8787 is already in use".** The console is already running in another window. Close it, or set `CC_PORT` to another port.

**Do my other devices need Tailscale?** With Funnel, no: any browser works. With tailnet only, yes.

**Does it work while my computer sleeps?** No. Keep the computer awake and the window open (option A), or use a server (option B).

**The setup link doesn't work.** It works once, for 7 days, and only the newest link works. Get a new one: restart the console (option A) or **Other tasks → Get a new setup link** (option B).

**I lost every key.** Option B: the deploy program's **Other tasks → Create recovery key**, or `sudo codex-console setup --new-key "Laptop"` on the server. Option A: open a terminal in the package folder and run `node\node.exe app\dist\server\cli\setup.js --new-key "Laptop"` (Windows) or `./node/node app/dist/server/cli/setup.js --new-key "Laptop"` (macOS, Linux), then sign in at your usual address.

**I forgot the admin password or lost the authenticator.** Same as above with `--reset-password` or `--reset-totp`. Both end every sign-in.

**A key may have leaked.** **Revoke** it (or **Rotate** without a grace period) in **Admin → Keys**, then check its usage and the security log.

**Codex says it isn't signed in, or it hit a usage limit.** **Admin → Codex → Sign in to ChatGPT**. Usage limits are your ChatGPT plan's; the console shows them but can't lift them.

**How do I back up?** Stop the console and copy the data folders in the table under option A (`/var/lib/codex-console` on a server). They contain secrets, so keep backups private.

**Is it safe to make it public?** The console was built for that: 256-bit keys stored only as hashes, rate limits, an admin area that needs a password and an authenticator code, HTTPS to your own computer or server, and a log of every action. It is still a remote shell for that machine, so treat keys like passwords. More: [SECURITY.md](SECURITY.md).

## Run it from source

You need Node.js 22.13 or newer.

```bash
npm ci
npm run build
npm run setup              # admin password + authenticator + your first API key
npm start                  # http://127.0.0.1:8787
npm run tailscale          # or: with a Tailscale address (option A, from source)
```

Open `http://127.0.0.1:8787`, paste the key, then sign Codex in from **Admin → Codex**. `npm run setup -- --lang zh-CN` runs the setup in Chinese. Or skip `npm run setup`: `npm start` then prints a one-time setup link that does the same in your browser.

Upgrading from a version that paired devices? Pairings are gone; your owner account and API keys stay (existing keys stay API-only). Run `npm run setup -- --new-key "Laptop"` once to get a key that signs in to the console.

Codex works inside `~/codex-workspace/` by default, in one folder per session. The console's own data (database, secrets, media) lives in `~/.codexconsole/` with owner-only permissions. Nothing secret goes in this repository.

Without Tailscale, use your own TLS certificate (`CC_HOST=0.0.0.0`, `CC_TLS_CERT`, `CC_TLS_KEY`, `CC_PUBLIC_ORIGIN`). The server refuses plain HTTP on anything but `127.0.0.1`. All settings: [`.env.example`](.env.example). A systemd user unit is in [`deploy/codex-console.service`](deploy/codex-console.service).

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

## Keys in detail

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

On a deployed server use `sudo codex-console setup …` (or, without a terminal, the deploy program's **Other tasks** for a recovery key or a new setup link). With a console package, run `node/node app/dist/server/cli/setup.js …` in its folder (`node\node.exe app\dist\server\cli\setup.js …` on Windows). From source, `npm run setup -- …`.

| Option | Effect |
| --- | --- |
| `--new-key "Laptop"` | Issue another full-console key (for example if you have lost all of them) |
| `--list-keys` | List keys with their status and last use |
| `--revoke-key ID` | Revoke a key and sign it out everywhere |
| `--sign-out-all` | End every console sign-in |
| `--reset-password` | New admin password; ends all sign-ins |
| `--reset-totp` | Enrol a new authenticator; ends all sign-ins |
| `--setup-link` | Print a new one-time setup link (only until setup is finished) |

## Development

```bash
npm run dev -- --fake-codex   # UI + server with a fake Codex: no login, no OpenAI calls
npm run dev                   # same, with your real Codex
npm test                      # unit + integration tests (use the fake Codex)
npm run typecheck
cd deployer && npm test       # the deploy program's tests (against a fake SSH server)
```

The fake app-server in `test/fake-codex/` implements the same protocol shapes as Codex 0.164.0. Prompt keywords make it exercise features: `approve`, `permission`, `question`, `elicit`, `mcp`, `image`, `video`, `edit`, `slow`, `steady`, `fail`, `fail limit`.

| Path | Contents |
| --- | --- |
| `server/` | Fastify API, auth, Codex bridge (`server/codex/`), CLI tools (`server/cli/`) |
| `web/` | React UI (Vite) |
| `shared/` | Types, the protocol subset (`shared/codex.ts`), and the EN / 中文 dictionaries (`shared/i18n/`) |
| `deploy/` | `deploy.sh` (run on your computer), `install.sh` (runs on the server), examples |
| `deployer/` | The deploy program: a page on your computer that deploys over SSH. `npm run package` builds the executables |
| `scripts/` | `dev.mjs` (development), `portable.mjs` (the console packages: `npm run package:portable`), `node-dist.mjs` (the pinned Node.js builds both downloads ship) |
| `.github/` | `release.yml`: on a `v*` tag, builds every download for Windows, macOS and Linux onto a draft release |
| `test/` | Vitest suites and the fake Codex |

Adding UI text means adding the key to both `shared/i18n/en.ts` and `shared/i18n/zh-CN.ts`. TypeScript and the i18n test fail otherwise.

## Notes

- **Personal use only.** Each copy is for one owner and that owner's own devices. Don't use it to share your ChatGPT plan with other people: that is against OpenAI's terms.
- **Usage limits** shown in the dashboard are what Codex reports for your plan. The console does not work around them.
- **Upgrading Codex:** change `@openai/codex` in `package.json`, run `npm install`, then `npm run codex:check`; on a server, deploy again.
- **Not included on purpose:** voice / realtime, Windows sandbox setup, Codex cloud and remote-control features (see [docs/FEATURES.md](docs/FEATURES.md)).

## Contributing

Issues and pull requests are welcome. Before sending a change, run `npm test` and `npm run typecheck` (and `cd deployer && npm test` for the deploy program), and give anything the UI shows both English and Chinese text.

## Reporting security issues

Please don't open a public issue for a vulnerability: use this repository's private vulnerability reporting on GitHub (**Security → Report a vulnerability**). What the console protects and how: [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Codex itself (the `@openai/codex` package the console installs) is OpenAI's, under its own Apache-2.0 license.
