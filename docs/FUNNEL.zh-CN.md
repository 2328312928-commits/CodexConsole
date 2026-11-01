# 用 Tailscale Funnel 对外开放 API

[English](FUNNEL.md)

> 本页只把公网 API（`/v1`）放到 Funnel 上。要在你自己的电脑上运行整个控制台并使用 Tailscale 地址，请用 `npm run tailscale`：[TAILSCALE.zh-CN.md](TAILSCALE.zh-CN.md)。

本指南适用于**在家里**运行控制台、没有公网服务器的情况：它让**公网 API**（`/v1`，只接受 API 密钥）可以从互联网访问，这样你自己的脚本在任何地方都能调用它。控制台页面和管理区**不会**对外开放：它们仍然只在 `localhost` 上，或通过 `tailscale serve` 只在你的 tailnet 内可用。如果想把整个控制台部署到公网服务器上，请看 [DEPLOY.zh-CN.md](DEPLOY.zh-CN.md)。

这里的一切都不会自动发生。每条命令都由你自己运行，并且随时可以撤销（见[关闭](#关闭)）。

## 为什么选 Tailscale Funnel

- **不开放端口：** 路由器和防火墙保持关闭，流量由 Tailscale 的中继转发。
- **自动 HTTPS：** Tailscale 为 `<机器名>.<tailnet>.ts.net` 申请并续期证书，并负责 TLS 终止。
- **只开放一个端口：** Funnel 只把一个端口转发到 `127.0.0.1:8788`。这个监听端口只提供 `/v1`：没有 Cookie，也没有 HTML。
- **真实的客户端地址：** 使用 `--proxy-protocol=2` 后，控制台能看到每个调用方的 IP。这对密钥的 IP 允许列表、错误密钥限流和日志都很重要。

```
你的脚本 ──HTTPS──▶ Tailscale Funnel (:8443) ──PROXY v2 + TCP──▶ 127.0.0.1:8788  公网 API（/v1，API 密钥）
你的设备 ──tailnet──▶ tailscale serve (:443) ──HTTP──────────────▶ 127.0.0.1:8787  控制台 + 管理区（私有）
```

## 开始之前

- 主机上已安装 Tailscale，并已登录你的 tailnet。
- 你的 tailnet 允许使用 Funnel。如果还没开启，第一次运行 `tailscale funnel` 时会打印一个链接，让你在管理控制台中开启。Funnel 需要 MagicDNS 和 HTTPS 证书。
- 注意 `<机器名>.<tailnet>.ts.net` 这个名字会公开：它会出现在公开的证书透明度日志中，任何人都可以尝试连接。没有有效密钥只会得到 `401`（多次失败后为 `429`）。
- **选择端口。** Funnel 允许 443、8443 和 10000。如果 `tailscale serve` 已经在 443 上提供控制台（README 中的方案 A），API 就用 **8443**，如下所示。同一个端口不能同时做两件事。

## 1. 开启 API 监听

在控制台的 `.env` 中：

```bash
CC_API_ENABLED=true
CC_API_HOST=127.0.0.1
CC_API_PORT=8788
CC_API_PUBLIC_ORIGIN=https://<机器名>.<tailnet>.ts.net:8443
# Funnel 总会发送 PROXY 头。"required" 会拒绝不带 PROXY 头的连接。
CC_API_PROXY_PROTOCOL=required
```

重启控制台（`npm start`，或 `systemctl --user restart codex-console`）。日志中会出现 `Public API listening`。

在主机上检查。`--haproxy-protocol` 让 curl 发送 `required` 所要求的 PROXY 头：

```bash
curl -s --haproxy-protocol http://127.0.0.1:8788/v1/health
# {"ok":true}
```

## 2. 创建密钥

在 **管理后台 → 密钥 → 新建密钥** 中：

1. 把 **控制台登录** 设为“关闭”，只授予工具需要的范围。除非确实需要，不要勾选 `shell` 和 `mcp:manage`。
2. 设置额度和有效期。
3. 审批选择 **自动拒绝**，除非你打算亲自回答。
4. 从对话框中复制密钥。它只显示一次。

## 3. 开启 Funnel

**这一步会让 API 可以从互联网访问。**

```bash
tailscale funnel --bg --proxy-protocol=2 --tls-terminated-tcp=8443 tcp://127.0.0.1:8788
tailscale funnel status
```

`--bg` 让它在重启后继续运行。如果这台机器上没有别的服务使用 443 端口，也可以改用 `--tls-terminated-tcp=443`（同时去掉 `CC_API_PUBLIC_ORIGIN` 中的 `:8443` 并重启）。

## 4. 从外部测试

请在**不在**你 tailnet 中的设备上测试，例如使用移动数据的手机。第一次 DNS 可能需要几分钟生效。

```bash
curl -s https://<机器名>.<tailnet>.ts.net:8443/v1/health
curl -s https://<机器名>.<tailnet>.ts.net:8443/v1/me -H "Authorization: Bearer $CODEX_CONSOLE_KEY"
```

这时 **管理后台 → 密钥** 的“最近使用”下应该显示手机的公网 IP。如果显示的是 `127.0.0.1`，说明 PROXY 头没有送达：检查 `--proxy-protocol=2` 参数。下一步：[API.zh-CN.md](API.zh-CN.md)。

## 关闭

```bash
tailscale funnel --tls-terminated-tcp=8443 off   # 停止对外开放 API
tailscale funnel status                          # 确认没有任何东西对外开放
```

如果还想关闭监听端口本身，设置 `CC_API_ENABLED=false` 并重启。如果只想停用某个工具，在 **管理后台 → 密钥** 中吊销它的密钥：无论是否开着 Funnel，都会立即生效。

## 故障排查

| 现象 | 可能的原因 |
| --- | --- |
| `421`，错误码 `forbidden_host` | `CC_API_PUBLIC_ORIGIN` 与你调用的 URL（主机名或端口）不一致 |
| 连接立即被关闭 | `CC_API_PROXY_PROTOCOL=required`，但调用方没有发送 PROXY 头（本地直接 curl 没加 `--haproxy-protocol`，或 Funnel 启动时没带 `--proxy-protocol=2`） |
| 所有请求都显示 `127.0.0.1` | Funnel 启动时没带 `--proxy-protocol=2`，且 `CC_API_PROXY_PROTOCOL` 为 `optional` |
| `403 ip_not_allowed` | 密钥设置了 IP 允许列表，而你从其他地址调用 |
| `401 invalid_api_key` | 密钥错误或已轮换。轮换后旧密钥只在宽限期内有效 |

## 另一种方式：用 Caddy 托管在自己的域名下

如果你有自己的域名并能开放 80/443 端口，可以让 Caddy 在单独的主机名上提供 API。这同样是公开的。在 Caddyfile 中加入（见 [`deploy/Caddyfile.example`](../deploy/Caddyfile.example)）：

```caddyfile
api.example.com {
	reverse_proxy 127.0.0.1:8788 {
		flush_interval -1
	}
}
```

并在 `.env` 中设置：

```bash
CC_API_ENABLED=true
CC_API_PUBLIC_ORIGIN=https://api.example.com
CC_API_PROXY_PROTOCOL=off
CC_API_TRUST_PROXY=loopback   # 从 Caddy 的 X-Forwarded-For 获取客户端 IP
```

除非你确实想公开控制台页面本身，否则不要把公网主机名指向控制台端口（8787）。
