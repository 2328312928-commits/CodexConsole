# Security model

[中文版](SECURITY.zh-CN.md)

Codex Console is a remote control for a coding agent that runs commands on the server. Treat access to the console like SSH access to that server: whoever is signed in can make Codex read files, run programs and change things. The design goal is that **only the owner, with keys the owner issued to their own devices, can get in**, that the admin area needs more than a key, and that every action leaves a trace.

## Who can get in

1. **An API key with console access.**
   - A key is `cck_<id>.<secret>` with 256 random bits. The server stores only `HMAC-SHA256(pepper, secret)`, shows the key once, and compares in constant time.
   - Each key has a console setting: *Full console* (every session and the whole workspace), *Folder only* (its own sessions and its folder) or *Off* (API only).
   - Signing in with a key creates a session: a random 256-bit secret in an `HttpOnly`, `Secure` (on HTTPS), `SameSite=Strict` cookie with the `__Host-` prefix. The page's JavaScript never sees it, and the server stores only its HMAC. It expires after 12 idle hours and 7 days at most (`CC_SESSION_IDLE_HOURS`, `CC_SESSION_MAX_DAYS`).
   - The key is checked again on **every request**. Revoking it, its expiry, taking away its console access or an IP allowlist that no longer matches ends the session at once. Revoking, rotating or changing console access in the admin area also closes the key's live streams immediately and stops its running prompts; a revocation from the command line reaches open streams within 30 seconds.
   - After a rotation the old secret never signs in to the console again; an optional grace period keeps it working for API scripts only.
2. **For the admin area, the owner password and an authenticator code**, on top of a key sign-in.
   - Passwords are hashed with Argon2id (64 MiB, 3 passes). Each TOTP time step is accepted only once.
   - The unlock lapses after 15 minutes without admin use and after 12 hours at most. No key, whatever its settings, opens the admin area on its own. On a deployed server that also holds against Codex, which runs as its own user; on your own machine it does not: see [Limits of the admin separation](#limits-of-the-admin-separation).

Failed attempts never say which factor was wrong. The security log records the reason, for the owner's eyes.

## What a key may do

The same limits apply in the console and in the public API:

- **Caps** on the sandbox, network access and approvals that no request can exceed. With approvals set to *deny*, anything needing approval is declined at once. Approvals that widen access (allow, always allow, network rules) are open only to a key with *Full access* and network; other keys can only decline. The automatic reviewer is used only by keys with nothing left to cap (full access, network, approvals asked): such a key works like the owner's console.
- **Token quota** per day, month or in total, counted across the key's running turns, which stop when it is used up. It is a soft limit: usage is known after each model step, so it can run over by about one step per running turn.
- **Prompts per minute, prompts at once, upload volume per hour**, an optional **IP allowlist** and an **expiry**.
- **Folder-only keys** see only the sessions they created and their own folder, with every path relative to it. They cannot import Codex threads (those can live anywhere on the server) or add writable folders.
- **Capped keys work only in their own sessions.** A full-console key with caps can look at every session, but it can only send prompts, queue, steer, set goals or change settings in sessions it created. Elsewhere Codex would act with the session owner's rights (a running turn, a goal it continues by itself, the owner's settings). It also cannot steer or answer a turn that another key started.
- **Shell commands** (`!command`) run outside Codex's sandbox with the service's rights, so only a key with full access and network may run them.
- **Queued prompts** count against the same per-minute budget as prompts sent at once, and wait until the key has a free slot for prompts running at once.
- **Files:** a full-console key can change any file in the workspace, including files Codex reads in your other sessions (for example `AGENTS.md`). Give a key you trust less *Folder only*.

**Reads are not sandboxed.** Codex's sandbox limits writes and network access, not reading. A key that can send prompts can ask Codex to read any file the console's user can read, including outside its folder. **MCP tools** run outside the sandbox too. Give keys to your own devices only.

## Rate limits and lockouts

| What | Limit |
| --- | --- |
| Failed key sign-ins | 10 per IP per 15 minutes, then that address is locked until the window clears. There is no global lock: keys carry 256 bits, and a global lock would let anyone keep you out. During a flood (more than 100 failures overall in 15 minutes) an address is locked after its first failure; a valid key from an address that has not failed always gets in. |
| Failed admin unlocks | 5 per IP per 15 minutes, 20 overall |
| Requests | 600 per key per minute (`CC_RATE_API_PER_MIN`); 120 per minute per IP without a sign-in |
| Prompts | the key's limit, never more than 20 per minute (`CC_RATE_PROMPTS_PER_MIN`), and the key's number of prompts at once |
| Uploads | 200 MB per file; the key's hourly volume, never more than 2 GB |
| Public API, overall | 600 requests per minute for the whole listener (`CC_API_MAX_PER_MIN`) |
| Public API, bad keys | more than 20 failed keys per IP in 10 minutes → `429` (`CC_API_BAD_KEY_LIMIT`); only failures count |

Hitting a limit is recorded in the security log; repeated identical events are collapsed to one per minute.

## Browser-side protections

- **Host allowlist.** Only the configured hostnames are accepted, which defeats DNS-rebinding attacks.
- **Canonical paths only.** Request paths containing percent-escapes or backslashes are refused outright. The `/api` guards decide from both the raw path and the route that matched, so an alternative spelling of a path can't skip them.
- **CSRF.** State-changing requests must come from an allowed `Origin` and carry the `X-Codex-Console: 1` header. A cross-site page cannot add that header without a CORS preflight, and the console never answers preflights. The console accepts no bearer tokens: the sign-in cookie is the only credential.
- **Content Security Policy.** `default-src 'self'` with no inline scripts or styles; framing blocked (`frame-ancestors 'none'`, `X-Frame-Options: DENY`); `nosniff`, `Referrer-Policy: no-referrer`, COOP/CORP and a restrictive `Permissions-Policy`; HSTS over HTTPS.
- **Untrusted output.** Codex replies are rendered from Markdown with DOMPurify. Raw HTML from the model never runs.
- **Workspace files** are served with `Content-Security-Policy: sandbox`; HTML, JS and other text files are shown as `text/plain`; anything else is a download.

## File access

- The file browser and upload/download API cannot leave `CC_WORKSPACE_ROOT` (or a folder key's folder).
- Paths are rejected if they contain `..`, backslashes or NUL bytes. Every path is resolved with `realpath`, so symlinks pointing outside are refused. Files are opened with `O_NOFOLLOW` and re-checked through `/proc/self/fd` on Linux.
- Uploads stream to a temporary file and are size-capped, so an oversized upload never reaches its final name. They never overwrite an existing file unless you ask.
- The console's data directory and the workspace cannot contain each other.

## Public API

- A **second listener** (default `127.0.0.1:8788`) that serves only `/v1`; `/api`, the UI and the admin area do not exist on it. On a deployed server Caddy sends `/v1` there, on the same address as the console.
- **Auth:** only `Authorization: Bearer cck_…` keys with the right scopes (`prompt`, `sessions`, `files:read`, `files:write`, `approvals`, `settings`, `mcp:read`, `mcp:manage`, `shell`). Console cookies are ignored; responses never set cookies and use `Content-Security-Policy: default-src 'none'`.
- **Plain HTTP only on loopback.** It refuses to bind elsewhere without TLS in front (Caddy, or Tailscale Funnel: [docs/FUNNEL.md](docs/FUNNEL.md)).
- **Client addresses** come from Caddy's `X-Forwarded-For` (trusted from loopback only) or a PROXY protocol header (Funnel); they drive IP allowlists, throttling and logs.
- **Dangerous scopes.** `shell` (runs `!command` outside the model and its sandbox) and `mcp:manage` (adds commands that Codex will start) are effectively code execution on the server. They are off by default, highlighted in the UI, and every use is in the security log.

## A server set up with `deploy/deploy.sh`

- **Nothing secret is uploaded.** Only files git tracks are copied; `.env`, data folders, databases and key files are excluded by `.gitignore`. Secrets (the pepper, password hash, TOTP secret, first key) are created on the server; the first key is printed once in your terminal.
- **Network.** The console (`127.0.0.1:8787`) and the API (`127.0.0.1:8788`) listen on loopback only, behind Caddy with automatic HTTPS. The firewall allows only SSH, 80 and 443.
- **Service.** A dedicated system user (`codexconsole`) runs the console. The code is owned by root, so the service cannot change it. systemd makes everything outside `/var/lib/codex-console` read-only and blocks privilege escalation.
- **Codex as its own user.** Codex runs in a second service (`codex-console-codex`) as its own user (`codexagent`). It may write only to the workspace and its own folders; the console's data folder is private to the console's user, and Codex's service cannot even see it. The console reaches Codex through a small relay on a socket only their shared group may use (`/run/codex-console/codex.sock`); the relay runs nothing but the app-server, `codex doctor` and MCP sign-out. Options that cover `/proc` or `/sys` are left out because Codex mounts its own `/proc` for its sandbox.
- **Codex's sandbox.** On Ubuntu 23.10+ the installer adds an AppArmor profile that lets only the Codex binary create the user namespaces its sandbox needs.
- **Maintenance.** fail2ban watches SSH; security updates install automatically. `--harden-ssh` turns off SSH passwords, but only after `deploy.sh` has logged in with a key.
- **No lockout.** Turning the firewall on or changing SSH arms a 10-minute timer that undoes the change unless a new SSH login confirms it.

## MCP servers

- Managed only from the admin area, or by keys with `mcp:manage`. Every add, change, removal and sign-in is in the security log.
- **Local servers** are commands Codex starts as the console's user, outside its sandbox: treat adding one like installing software.
- **Environment values** are write-only. The console stores them in Codex's `config.toml` and returns only the variable names.
- **Remote servers** must use `https://` (plain `http://` only for localhost). OAuth sign-in links are shown, never opened automatically.

## Codex administration

The admin area can do everything the Codex CLI can do to Codex itself; each change goes to the security log: edit any `config.toml` key (including commands such as MCP servers, hooks and `notify`), toggle feature flags, install or remove plugins, sign Codex in with a ChatGPT device code or sign it out, reset memories, import setup from other agents, run `codex doctor`. Treat a stolen admin unlock like shell access. **Feedback to OpenAI** is sent only when you submit the form, and includes logs only if you tick the box.

## Codex itself

- **Login.** Codex keeps its login in its `CODEX_HOME` (`~/.codex` on your own machine, `/var/lib/codex-console/codex-home` on a deployed server). The console never reads, copies or logs it. It starts a sign-in or sign-out only when you do so in **Admin → Codex**.
- **Sandbox.** By default Codex runs with the `workspace-write` sandbox (writes limited to the session folder, no network) and approval policy `on-request`. Requests to go beyond the sandbox appear in the UI and are **denied automatically after 10 minutes**. *Full access* removes the sandbox and is flagged in the UI. Keys never go above their own caps.
- **Shell commands.** `!command` runs a command in the session folder directly, not through the model. It is always written to the security log.
- **Reads.** The sandbox limits writes, not reads. Codex can still read files elsewhere on the machine, including its own `auth.json`. This is why console access must be guarded like shell access.
- **Version.** The Codex version is pinned. The console warns when the running version differs from the tested one; `npm run codex:check` verifies protocol compatibility.

## What is stored, and where

In `~/.codexconsole/` on your own machine, `/var/lib/codex-console/data` on a deployed server (directory `0700`, files `0600`):

| File | Contents |
| --- | --- |
| `secrets.json` | 32-byte random pepper, used for key and sign-in hashes and to derive the key that encrypts the TOTP secret |
| `codexconsole.db` | Argon2id password hash, AES-256-GCM-encrypted TOTP secret, API-key and sign-in hashes, key settings, sessions, transcripts, request / API / transfer / security logs, usage-limit snapshots |
| `media/` | Copies of images Codex viewed or generated outside the workspace |

The repository contains no secrets: `.env`, data folders, databases, keys and certificates are all gitignored, and `.env.example` holds only non-secret settings. Logs older than the retention period (180 days by default) are deleted automatically.

## If something goes wrong

On a deployed server use `sudo codex-console setup …`; on your own machine `npm run setup -- …`.

| Situation | What to do |
| --- | --- |
| A device is lost or stolen | Revoke its key: **Admin → Keys → Revoke**, or `--revoke-key ID` (`--list-keys` shows the ids). It is signed out at once. |
| A key may have leaked | Revoke it (or **Rotate** with no grace period), then check its usage and the security log filtered by that key. |
| You lost every key | `--new-key "Laptop"` on the server. |
| Your password may be known | `--reset-password` (ends all sign-ins) |
| Your authenticator is lost | `--reset-totp` (ends all sign-ins) |
| Something looks odd | **Admin → Security log**: failed sign-ins, lockouts, rejected hosts, origins and keys. **Admin → Keys** shows every browser signed in now; sign out any you don't recognise, or use `--sign-out-all`. |
| You want it to stop | `sudo systemctl stop codex-console` (or stop `npm start`). Nothing answers on the network after that, and Codex stops with it. |

## Limits of the admin separation

Codex's sandbox limits writes and network access, not reads, so what Codex can reach depends on the system user it runs as.

- **On a server set up with `deploy/deploy.sh`** Codex runs as its own user and cannot read or change the console's data folder (the database, the pepper, keys, the encrypted authenticator secret). A key holder cannot turn Codex against the console: the admin area still needs your password and an authenticator code. A key with full access still has Codex's own reach: the workspace, Codex's ChatGPT sign-in and the network.
- **On your own machine** (`npm start`) Codex runs as your user, next to the console's data. Any key that can send prompts can have Codex read that data, so the admin area is protected by your password alone; a key with full access can also change it, which makes it equivalent to the owner. Give full access only to keys on devices you control.

## Things this does not protect against

- Someone with a shell on the server as root or as the console's user. They can read the database and secrets file, and use Codex directly. (A shell as Codex's user reaches the workspace and Codex's sign-in, not the console's data.)
- A full-console key in the wrong hands: it can do whatever Codex can do. Keep keys like passwords, give each device its own, use expiry, caps or an IP allowlist where they fit, and revoke a key as soon as a device is gone.
- Malicious content that Codex reads and acts on (prompt injection from files or web pages). Review approval requests before allowing them.
- Exposure without HTTPS. The server refuses plain HTTP on non-loopback addresses, but a misconfigured proxy in front can still leak traffic. The deploy script sets up Caddy for you.
