# Deploying to your server

[中文版](DEPLOY.zh-CN.md)

The deploy program puts Codex Console on a Linux server with HTTPS: you fill in a page, press **Deploy**, and finish setup in your browser. No terminal needed (`deploy/deploy.sh` does the same from a terminal). Afterwards any browser of yours only needs one of your API keys.

## What you need

- **A Linux server:** Ubuntu 22.04 / 24.04 or Debian 12 / 13, x86-64 or ARM64, 1 GB of memory or more (below 1.8 GB the installer adds 2 GB of swap for the build), about 3 GB of free disk.
- **SSH access** as `root` or as a user with `sudo`, with a password or an SSH key.
- **An address:** a domain whose DNS `A` record points at the server, or just the server's public IPv4 address.
- **Ports 80 and 443 open** in your provider's firewall or security group. Port 80 is needed for Let's Encrypt's checks and the redirect to HTTPS.
- **On your computer:** the deploy program for Windows, macOS or Linux. For the terminal way instead: this repository, `bash`, `ssh` and `tar` (Linux, macOS, or WSL on Windows).

Codex runs on the server and works on files there. The computer you sign in from only needs a browser.

## The deploy program

| Your computer | File |
| --- | --- |
| Windows | `codex-console-deploy-windows-x64.exe` |
| Mac with Apple silicon (M1 or newer) | `codex-console-deploy-macos-arm64.zip` |
| Mac with an Intel processor | `codex-console-deploy-macos-x64.zip` |
| Linux | `codex-console-deploy-linux-x64.tar.gz` or `codex-console-deploy-linux-arm64.tar.gz` |

**Getting it.** Download the file for your computer from the project's **Releases** page. To build them yourself: `cd deployer && npm ci --ignore-scripts && npm run package -- --all` (Node 22.13 or newer; the macOS files need a Mac). In a fork, the **Release** workflow (`.github/workflows/release.yml`) builds them on GitHub together with the console packages: push a tag such as `v0.1.0` to put them all on a draft release. `SHA256SUMS.txt` lists each file's checksum.

**Starting it.** It is not signed with a paid certificate, so the first start needs one extra click:

- **Windows:** double-click the `.exe`. If "Windows protected your PC" appears, choose **More info → Run anyway**.
- **macOS:** open the `.zip`, then double-click `codex-console-deploy`. If macOS says it cannot check the app, open **System Settings → Privacy & Security** and choose **Open Anyway** (on older macOS, Control-click it and choose **Open**). It runs in a Terminal window.
- **Linux:** extract the archive and run `codex-console-deploy`.

A small window shows that it is running and your browser opens the deploy page (if it does not, open the link shown in the window). Keep the window open while you deploy; close it, or press **Quit** on the page, when you are done.

**On the page:**

1. **Your server:** its address and SSH port, the user name, and a password or an SSH key (keys in your `~/.ssh` folder are offered, or choose the file). For a user other than root, sudo's password if it is not the login password.
2. **Web address:** the server's IP address (no domain needed: the certificate is for the IP), or your own domain (point its DNS `A` record at the server first). An email for certificate notices is optional.
3. **Check server** looks at the server without changing anything. **Deploy** installs Codex Console, or updates it.

The first connection to a server shows its SSH fingerprint. If your provider shows the fingerprint too, compare them, then trust it. The program remembers it, and if the server's key ever changes it stops with a warning, unless you confirm that you reinstalled the server.

When it finishes, it shows **Open setup page**: see [Finish setup in your browser](#finish-setup-in-your-browser). **Other tasks** on the page gets a new setup link (if the old one was used or expired) or creates a recovery key (if you lost all your keys).

**What it keeps:** the server's address, user name, the options you chose and the fingerprints you trusted, in `%APPDATA%\CodexConsoleDeploy` (Windows), `~/Library/Application Support/CodexConsoleDeploy` (macOS) or `~/.config/codex-console-deploy` (Linux). Never a password or a key: those stay in memory for the one task.

**Who can use the page:** only your browser. The program serves it on `127.0.0.1` alone, on a random port, and answers only requests that carry the random token from the link it opened. It refuses other sites (Host, Origin and content-type checks) and uses a strict Content-Security-Policy. Everything goes to your server over SSH.

## Deploy from a terminal

```bash
./deploy/deploy.sh root@203.0.113.7 --ip 203.0.113.7
./deploy/deploy.sh me@my-server --domain console.example.com --email me@example.com
```

| Option | Meaning |
| --- | --- |
| `--domain NAME` | Serve on this domain. Its `A` record must point at the server. |
| `--ip ADDRESS` | Serve on the server's public IPv4 address, no domain needed. |
| `--email ADDR` | Contact address for Let's Encrypt (optional). |
| `--port N` | SSH port (default 22). It always stays open in the firewall. |
| `--identity FILE` | SSH private key to use. |
| `--new-key NAME` | Also issue an API key for another device (once setup is finished). |
| `--harden-ssh` | Turn off SSH password logins. Only allowed when your key login works. |
| `--no-firewall` | Leave the server's firewall as it is. |
| `--check`, `--dry-run` | Only check the server (system, memory, ports, DNS) and change nothing. |
| `--lang en\|zh-CN` | Language for messages. |

Start with `--check` if you like: it shows whether the server is ready without touching it. With a password login you are asked for it once; an SSH key is easier (`ssh-copy-id user@server`). At the end the script prints the console's address and, on the first install, a one-time **setup link**.

## Finish setup in your browser

1. Open the setup link. It works once and expires after 7 days. Choose an **admin password** (12 characters or more), scan the QR code with your **authenticator app** and enter its code, and name this device. You get **your first key**, shown once: keep it in your password manager to sign in from other browsers. This browser is signed in already.
2. Open **Admin** with the password and an authenticator code, go to **Codex**, and sign in with your ChatGPT plan. It shows a device code: you enter it at OpenAI yourself.
3. Give every other device its own key: **Admin → Keys → New key**, a name and, if you like, a token quota (per day, per month or in total), then **Create key**. **More options** has the rest: expiry, console access, sandbox, rate limits and more. A new key signs in to the full console, with nothing capped and no expiry unless you set it. **Revoke** signs a key out everywhere at once.

Lost the setup link, or did it expire? Use **Other tasks → Get a new setup link** in the deploy program, or `sudo codex-console setup --setup-link` on the server. A new link replaces the old one, and once setup is finished no setup link works.

## What the installer does on the server

| What | Where |
| --- | --- |
| Node.js 24 (NodeSource apt repository), only if Node 22.13+ is missing | `/usr/bin/node` |
| Caddy from Caddy's own apt repository; automatic HTTPS | `/etc/caddy/codex-console.caddy`, imported from `/etc/caddy/Caddyfile` |
| A system user that runs the console | `codexconsole` |
| A second system user that runs Codex, and a group the two share for the workspace | `codexagent`, `codexws` |
| The app, built on the server; the last three releases are kept. Owned by root, so the service cannot change its own code | `/opt/codex-console/releases/…`, `/opt/codex-console/current` |
| Database and secrets (the console only), the workspace (both), Codex's sign-in and config, Codex's home | `/var/lib/codex-console/{data,workspace,codex-home,agent}` |
| Settings: one file the installer manages, one that is yours, and Codex's | `/etc/codex-console/env`, `/etc/codex-console/local.env`, `/etc/codex-console/agent.env` |
| The console's systemd service, read-only outside `/var/lib/codex-console` | `codex-console.service` |
| Codex's service: the relay the console reaches Codex through. It cannot see the console's data | `codex-console-codex.service`, `/run/codex-console/codex.sock` |
| A management command | `sudo codex-console setup …`, `status`, `logs`, `restart` |
| Firewall (ufw): SSH, 80 and 443 only | |
| fail2ban for SSH, and automatic security updates | `/etc/fail2ban/jail.d/codex-console.local`, `/etc/apt/apt.conf.d/20auto-upgrades` |
| Only with `--harden-ssh`: no SSH passwords, root only with a key | `/etc/ssh/sshd_config.d/10-codex-console.conf` |

Details worth knowing:

- **Certificates.** With a domain, Caddy gets a normal Let's Encrypt certificate. With an IP address it gets a Let's Encrypt certificate for the IP itself; those are short-lived (about 6 days) and Caddy renews them automatically. If that fails, the installer switches to `<ip>.sslip.io`, a public DNS name that points at your IP, and prints the new address.
- **The console and the API share one address.** Caddy sends `/v1` to the public API (`127.0.0.1:8788`) and everything else to the console (`127.0.0.1:8787`). Neither listens on a public interface.
- **Your Caddyfile.** A fresh server's default Caddyfile is replaced (the original is kept as `Caddyfile.orig`). A Caddyfile you wrote yourself is kept and gets one `import` line. A configuration Caddy rejects is never applied.
- **Safety timer.** When the installer turns the firewall on (or changes SSH), it sets a 10-minute timer that undoes those changes. The deploy program (or `deploy.sh`) then logs in again over a new SSH connection; only if that works does it stop the timer. If you lose SSH access, wait 10 minutes. If you run `install.sh` by hand, confirm with `sudo codex-console confirm` from a new SSH session.
- **Codex as its own user.** Codex runs in its own service as `codexagent`, so no key can use it to read or change the console's database, keys or secrets. The installer checks that `codexagent` cannot read the console's data folder. Re-running the installer on an older install moves Codex's folder and the workspace over.
- **Codex's sandbox.** Codex isolates the commands it runs with Linux namespaces. The installer checks that this works for Codex's service. Ubuntu 23.10 and newer block those namespaces by default; the installer then adds an AppArmor profile that allows them for the Codex binary only.
- **Nothing secret leaves your computer.** Both ways upload only the console's files: what git tracks (the deploy program carries a copy made when it was built), so `.env`, `data/`, databases and key files are left out by `.gitignore`. Secrets are created on the server.

## Day to day

- **Update:** press **Deploy** again in the deploy program (a newer program carries a newer console), or run the same `deploy.sh` command. Your data, keys, sessions and Codex sign-in stay.
- **Keys:** **Admin → Keys** (create, edit caps, rotate, revoke, see who is signed in), or `sudo codex-console setup --list-keys | --new-key NAME | --revoke-key ID`.
- **Your projects:** Codex works in `/var/lib/codex-console/workspace` on the server. Upload files in the console, or clone a repository in a session with `!git clone …` (a private repository needs credentials on the server, for example a read-only deploy key).
- **Settings:** add lines to `/etc/codex-console/local.env` (see [`.env.example`](../.env.example)), then `sudo codex-console restart`.
- **Logs:** `sudo codex-console logs` for the console and Codex, `journalctl -u caddy` for HTTPS. Requests, sign-ins and security events are also in the admin dashboard.
- **Backup:** everything that matters is in `/var/lib/codex-console`. It includes secrets (the key pepper, the encrypted authenticator secret and Codex's sign-in), so keep backups private.

  ```bash
  sudo systemctl stop codex-console
  sudo tar -C /var/lib -czf codex-console-backup.tgz codex-console
  sudo systemctl start codex-console
  ```

## Troubleshooting

| Problem | What to do |
| --- | --- |
| No certificate | Check that the domain's `A` record points at the server and that ports 80 and 443 are open at your provider. `journalctl -u caddy --since -10min` shows why. Caddy keeps retrying by itself. |
| "Codex's sandbox does not work here" | Some container-based servers (OpenVZ, some LXC) do not allow user namespaces. Use a KVM server, or run sessions with full access (no sandbox; the service is still read-only outside its folder). |
| Lost every key | Deploy program: **Other tasks → Create recovery key**. Or on the server: `sudo codex-console setup --new-key "Laptop"`. |
| The setup link does not work | It works once, for 7 days, and only the newest link works. Get a new one: deploy program → **Other tasks**, or `sudo codex-console setup --setup-link`. |
| The deploy program says the server's key has changed | If you reinstalled the server, confirm that on the page. If not, stop: something may be pretending to be your server. |
| The deploy program cannot sign in | Check the user name and password (or key and passphrase) in your provider's panel. Some providers allow only SSH keys, or need password logins turned on first. |
| Lost the authenticator or password | `sudo codex-console setup --reset-totp` or `--reset-password`. Both end all sign-ins. |
| A device was lost or stolen | **Admin → Keys → Revoke** for its key, or `sudo codex-console setup --revoke-key ID`. It is signed out at once. |
| Locked out of SSH after the deploy | Wait 10 minutes for the safety timer, or use your provider's web console. |
| The page says the address is not allowed | Open the address the installer printed; other names need `CC_ALLOWED_HOSTS` in `local.env`. |

## Removing it

```bash
sudo systemctl disable --now codex-console codex-console-codex
sudo rm -rf /opt/codex-console /etc/codex-console /usr/local/bin/codex-console /etc/systemd/system/codex-console.service /etc/systemd/system/codex-console-codex.service
sudo rm -f /etc/caddy/codex-console.caddy /etc/fail2ban/jail.d/codex-console.local /etc/apparmor.d/codex-console-codex
sudo systemctl daemon-reload
# your data, workspace and Codex sign-in: sudo rm -rf /var/lib/codex-console
# the two users and their group: sudo userdel codexagent; sudo userdel codexconsole; sudo groupdel codexws
```

Then remove the `import /etc/caddy/codex-console.caddy` line from `/etc/caddy/Caddyfile` (or restore `Caddyfile.orig`) and reload Caddy.
