# Deploying to your server

[中文版](DEPLOY.zh-CN.md)

One command, run on your own computer, puts Codex Console on a Linux server with HTTPS. Afterwards any browser of yours only needs one of your API keys.

## What you need

- **A Linux server:** Ubuntu 22.04 / 24.04 or Debian 12 / 13, x86-64 or ARM64, 1 GB of memory or more (below 1.8 GB the installer adds 2 GB of swap for the build), about 3 GB of free disk.
- **SSH access** as `root` or as a user with `sudo`. An SSH key is recommended (`ssh-copy-id user@server`); with a password you are asked for it once.
- **An address:** a domain whose DNS `A` record points at the server, or just the server's public IPv4 address.
- **Ports 80 and 443 open** in your provider's firewall or security group. Port 80 is needed for Let's Encrypt's checks and the redirect to HTTPS.
- **On your computer:** this repository, `bash`, `ssh` and `tar` (Linux, macOS, or WSL on Windows).

Codex runs on the server and works on files there. The computer you sign in from only needs a browser.

## Deploy

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
| `--new-key NAME` | Also issue an API key for another device. |
| `--harden-ssh` | Turn off SSH password logins. Only allowed when your key login works. |
| `--no-firewall` | Leave the server's firewall as it is. |
| `--check`, `--dry-run` | Only check the server (system, memory, ports, DNS) and change nothing. |
| `--lang en\|zh-CN` | Language for messages and the setup prompts. |

Start with `--check` if you like: it shows whether the server is ready without touching it.

On the first install the server asks, in your terminal, for an **admin password** and shows a QR code for your **authenticator app**. Then it prints **your first API key**, once. Keep it in your password manager.

## First sign-in

1. Open the address the script printed and paste the key.
2. Open **Admin** with the password and an authenticator code, go to **Codex**, and sign in with your ChatGPT plan. It shows a device code: you enter it at OpenAI yourself.
3. Give every other device its own key: **Admin → Keys → New key**, or on the server `sudo codex-console setup --new-key "Phone"`. A new key is a full-console key with nothing capped and no expiry; change that in the form if you want limits.

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
- **Safety timer.** When the installer turns the firewall on (or changes SSH), it sets a 10-minute timer that undoes those changes. `deploy.sh` then logs in again over a new SSH connection; only if that works does it stop the timer. If you lose SSH access, wait 10 minutes. If you run `install.sh` by hand, confirm with `sudo codex-console confirm` from a new SSH session.
- **Codex as its own user.** Codex runs in its own service as `codexagent`, so no key can use it to read or change the console's database, keys or secrets. The installer checks that `codexagent` cannot read the console's data folder. Re-running the installer on an older install moves Codex's folder and the workspace over.
- **Codex's sandbox.** Codex isolates the commands it runs with Linux namespaces. The installer checks that this works for Codex's service. Ubuntu 23.10 and newer block those namespaces by default; the installer then adds an AppArmor profile that allows them for the Codex binary only.
- **Nothing secret leaves your computer.** `deploy.sh` uploads only files git tracks; `.env`, `data/`, databases and key files are excluded by `.gitignore`. Secrets are created on the server.

## Day to day

- **Update:** run the same `deploy.sh` command again. Your data, keys, sessions and Codex sign-in stay.
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
| Lost every key | On the server: `sudo codex-console setup --new-key "Laptop"`. |
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
