# Public access to the API with Tailscale Funnel

[中文版](FUNNEL.zh-CN.md)

This guide is for running the console **at home**, without a public server: it makes the **public API** (`/v1`, API keys only) reachable from the internet, so your own scripts can call it from anywhere. The console UI and the admin area are **not** exposed: they stay on `localhost`, or on your tailnet through `tailscale serve`. To put the whole console on a public server instead, use [DEPLOY.md](DEPLOY.md).

Nothing here happens automatically. You run each command yourself, and you can undo it at any time ([Turning it off](#turning-it-off)).

## Why Tailscale Funnel

- **No open ports:** your router and firewall stay closed. Tailscale's relays carry the traffic.
- **HTTPS handled for you:** Tailscale gets and renews the certificate for `<machine>.<tailnet>.ts.net` and terminates TLS.
- **Only one port:** Funnel forwards a single port to `127.0.0.1:8788`. That listener serves only `/v1`: no cookies, no HTML.
- **Real client addresses:** with `--proxy-protocol=2`, the console sees each caller's IP. That matters for per-key IP allowlists, the bad-key throttle and the logs.

```
your scripts ──HTTPS──▶ Tailscale Funnel (:8443) ──PROXY v2 + TCP──▶ 127.0.0.1:8788  public API (/v1, API keys)
your devices ──tailnet──▶ tailscale serve (:443) ──HTTP──────────────▶ 127.0.0.1:8787  console + admin (private)
```

## Before you start

- Tailscale is installed on the host, and the host is signed in to your tailnet.
- Funnel is allowed for your tailnet. The first `tailscale funnel` command prints a link to turn it on in the admin console if it isn't. Funnel needs MagicDNS and HTTPS certificates.
- Be aware that the name `<machine>.<tailnet>.ts.net` becomes public: it appears in public certificate-transparency logs, and anyone can try to connect. Without a valid key they only get `401` (and `429` after repeated failures).
- **Pick the port.** Funnel allows 443, 8443 and 10000. If `tailscale serve` already serves the console on 443 (README, option A), use **8443** for the API, as below. One port can't do both.

## 1. Turn on the API listener

In the console's `.env`:

```bash
CC_API_ENABLED=true
CC_API_HOST=127.0.0.1
CC_API_PORT=8788
CC_API_PUBLIC_ORIGIN=https://<machine>.<tailnet>.ts.net:8443
# Funnel always sends a PROXY header. "required" refuses connections without one.
CC_API_PROXY_PROTOCOL=required
```

Restart the console (`npm start`, or `systemctl --user restart codex-console`). The log shows `Public API listening`.

Check it on the host. `--haproxy-protocol` makes curl send the PROXY header that `required` expects:

```bash
curl -s --haproxy-protocol http://127.0.0.1:8788/v1/health
# {"ok":true}
```

## 2. Create a key

In **Admin → Keys → New key**:

1. Set **Console sign-in** to *Off* and give only the scopes the tool needs. Leave `shell` and `mcp:manage` off unless you really need them.
2. Set a quota and an expiry.
3. Choose **Deny automatically** for approvals, unless you plan to answer them.
4. Copy the key from the dialog. It is shown once.

## 3. Turn on Funnel

**This makes the API reachable from the internet.**

```bash
tailscale funnel --bg --proxy-protocol=2 --tls-terminated-tcp=8443 tcp://127.0.0.1:8788
tailscale funnel status
```

`--bg` keeps it running across reboots. Use `--tls-terminated-tcp=443` instead if nothing else on this machine uses port 443 (then drop `:8443` from `CC_API_PUBLIC_ORIGIN` and restart).

## 4. Test from outside

From a device that is **not** on your tailnet, for example a phone on mobile data. The first time, DNS can take a few minutes.

```bash
curl -s https://<machine>.<tailnet>.ts.net:8443/v1/health
curl -s https://<machine>.<tailnet>.ts.net:8443/v1/me -H "Authorization: Bearer $CODEX_CONSOLE_KEY"
```

**Admin → Keys** should now show your phone's public IP under *Last used*. If it shows `127.0.0.1`, the PROXY header isn't arriving: check the `--proxy-protocol=2` flag. Next steps: [API.md](API.md).

## Turning it off

```bash
tailscale funnel --tls-terminated-tcp=8443 off   # stop exposing the API
tailscale funnel status                          # confirm nothing is public
```

To close the listener itself too, set `CC_API_ENABLED=false` and restart. To stop a single tool, revoke its key in **Admin → Keys**: that takes effect immediately, Funnel or not.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `421` with `forbidden_host` | `CC_API_PUBLIC_ORIGIN` doesn't match the URL you call (host or port) |
| Connection closes immediately | `CC_API_PROXY_PROTOCOL=required`, but the caller sent no PROXY header (direct local curl without `--haproxy-protocol`, or Funnel started without `--proxy-protocol=2`) |
| Every request shows `127.0.0.1` | Funnel started without `--proxy-protocol=2`, and `CC_API_PROXY_PROTOCOL` is `optional` |
| `403 ip_not_allowed` | The key has an IP allowlist and you are calling from elsewhere |
| `401 invalid_api_key` | Wrong or rotated key. After rotating, the old secret works only for its grace period |

## Alternative: your own domain behind Caddy

If you have a domain and can open ports 80/443, Caddy can serve the API on its own hostname. This is also public. Add to your Caddyfile ([`deploy/Caddyfile.example`](../deploy/Caddyfile.example)):

```caddyfile
api.example.com {
	reverse_proxy 127.0.0.1:8788 {
		flush_interval -1
	}
}
```

and in `.env`:

```bash
CC_API_ENABLED=true
CC_API_PUBLIC_ORIGIN=https://api.example.com
CC_API_PROXY_PROTOCOL=off
CC_API_TRUST_PROXY=loopback   # take the client IP from Caddy's X-Forwarded-For
```

Don't point a public hostname at the console port (8787) unless you mean to expose the console UI itself.
