# Running it on your own computer with Tailscale

[中文版](TAILSCALE.zh-CN.md)

No server and no domain: Codex Console runs on your own computer (Windows, macOS or Linux), and [Tailscale](https://tailscale.com) gives it a fixed https address, `https://<computer>.<tailnet>.ts.net`. The address stays the same as long as the computer keeps its name in Tailscale.

| Mode | Who can open the address | Start with |
| --- | --- | --- |
| **Funnel** (default) | Any browser on the internet | `Start Codex Console.cmd`, or `npm run tailscale` |
| **Tailnet only** | Only devices signed in to your Tailscale account | `Start Codex Console (tailnet only).cmd`, or `npm run tailscale -- --tailnet-only` |

Either way, a browser still needs one of your API keys, and the admin area your password and an authenticator code.

## Before the first start

1. **Install Tailscale** on the computer that will run the console ([download](https://tailscale.com/download)) and sign in.
2. In the [admin console's DNS page](https://console.tailscale.com/admin/dns): **MagicDNS** on (it is for new tailnets), and under **HTTPS Certificates** choose **Enable HTTPS**. This publishes your computer's Tailscale name in the public certificate logs, so pick a computer name you don't mind being seen.
3. Funnel only: the first start may print a link to **allow Funnel** for your tailnet. Open it and confirm; the program waits and then carries on.

## Windows

1. Unzip `codex-console-windows-x64.zip` from the project's Releases page (right-click → **Extract All**). It contains Node.js, the console with Codex for Windows, and two launchers.
2. Double-click **Start Codex Console.cmd**. If "Windows protected your PC" appears, choose **More info → Run anyway** (the launcher is not signed).
3. The window shows the address and, the first time, opens the setup page: choose an admin password, scan the QR code with your authenticator app, and save your first key. Then **Admin → Codex → sign in with ChatGPT**.
4. Keep the window open while you use the console; close it to stop.

Your data stays in `%USERPROFILE%\.codexconsole`, Codex's files in `%USERPROFILE%\codex-workspace`, and Codex's own sign-in in `%USERPROFILE%\.codex`.

## macOS

1. Download `codex-console-macos-arm64.zip` (Apple silicon) or `codex-console-macos-x64.zip` (Intel) and double-click it to unpack. It contains Node.js, the console with Codex for macOS, and two launchers.
2. Double-click **Start Codex Console.command**; it runs in a Terminal window. The first time, macOS can't verify it: **System Settings → Privacy & Security → Open Anyway** (macOS 14 and earlier: Control-click → **Open**). The launcher clears the download quarantine for its own folder only, so Codex and its helpers aren't blocked one by one.
3. As on Windows, the window shows the address and, the first time, opens the setup page. **Start Codex Console (tailnet only).command** keeps it private.

Your data stays in `~/.codexconsole`, Codex's files in `~/codex-workspace`, Codex's sign-in in `~/.codex`.

## Linux

```bash
tar -xzf codex-console-linux-x64.tar.gz   # or codex-console-linux-arm64.tar.gz
cd codex-console
./start.sh                                 # public through Funnel
./start.sh --tailnet-only                  # only your Tailscale devices
```

Managing Tailscale Serve and Funnel needs root once: `sudo tailscale set --operator=$USER`. To keep it running after you log out, use tmux, screen or a systemd user service (example in the [README](../README.md#linux-x64-or-arm64)).

## From source, and building the packages

```bash
npm ci
npm run build
npm run tailscale                     # public through Funnel
npm run tailscale -- --tailnet-only   # only your Tailscale devices
```

`npm run package:portable` builds all five packages into `release/` with `SHA256SUMS.txt` (on Linux, macOS or Windows: it downloads the official Node.js builds, checks their checksums, and installs each platform's own dependencies, so no Mac is needed). `npm run package:windows` builds just Windows; `node scripts/portable.mjs linux-x64` picks platforms. `-- --tailscale-name my-pc.tail1234.ts.net` writes the address you expect into the launchers, which then warn if Tailscale names the computer differently: that is for your own copy only, never for a package you publish.

## What it does

1. Asks Tailscale for this computer's name and checks that it is signed in and new enough (1.52 or later).
2. Starts the console on `127.0.0.1:8787` only (`CC_PORT` picks another port), with that name as its address.
3. Publishes it with `tailscale funnel --bg --https=443 http://127.0.0.1:8787` (or `tailscale serve` for tailnet only). `--bg` keeps the entry across restarts. If you already serve something else on port 443, it uses 8443 or 10000 instead and never touches your other entries.
4. Waits until the address answers through Tailscale, then shows it. While no owner account exists, it prints a one-time setup link and opens it in this computer's browser.

| Option | Meaning |
| --- | --- |
| `--tailnet-only` | Only your Tailscale devices can open it. A public entry for the console is taken down first. |
| `--no-open` | Don't open the setup page in this computer's browser. |
| `--no-check` | Don't wait for the address to answer. |
| `--lang en\|zh-CN` | Language for messages (default: the system's). |

Settings from a `.env` file in the folder you start it from still apply, apart from the address, which always comes from Tailscale.

## Security

- **Funnel is public.** Anyone who knows the address reaches the sign-in page. Keys (256-bit, stored only as hashes), the per-address rate limits and the separately protected admin area are what keep them out, as on a public server. Revoke a lost key in **Admin → Keys**.
- **Encryption ends on your computer.** Tailscale issues the certificate for your `ts.net` name and terminates HTTPS on your computer; Funnel's relays only pass the encrypted traffic on.
- **Real client addresses.** Tailscale passes each caller's address in `X-Forwarded-For` (replacing whatever the caller sent), and the console trusts it only from `127.0.0.1`. Rate limits and the logs see real addresses.
- **It is a remote shell for your computer.** Codex runs commands on the computer hosting the console, as your user. Keep keys like passwords, and see [SECURITY.md](../SECURITY.md).

## Turning it off

Close the window to stop the console. The Tailscale entry stays (the address then shows an error page) and is reused at the next start. To remove it: `tailscale funnel --https=443 off` (or `tailscale serve --https=443 off`), or `tailscale serve reset` to clear every entry on this computer.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| "Tailscale is not installed / not running / not signed in" | Install or open Tailscale and sign in, then start again. |
| "MagicDNS is off" | Turn it on in the [DNS page](https://console.tailscale.com/admin/dns). |
| The address does not answer | The first certificate can take a few minutes. Check that **HTTPS Certificates** are enabled in the DNS page. |
| "Funnel is not allowed" | Open the link the program printed, or see [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) for the `funnel` attribute in your tailnet policy. |
| "Port 8787 is already in use" | The console is already running in another window, or set `CC_PORT` to another port. |
| The name differs from the one you expected | The program uses the name Tailscale reports. Rename the computer in the Tailscale admin console to get your usual address back. |
