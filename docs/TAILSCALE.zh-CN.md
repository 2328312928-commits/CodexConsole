# 用 Tailscale 在自己的电脑上运行

[English](TAILSCALE.md)

不需要服务器，也不需要域名：Codex 控制台运行在你自己的电脑上（Windows、macOS 或 Linux），[Tailscale](https://tailscale.com) 为它提供一个固定的 https 地址：`https://<电脑名>.<tailnet>.ts.net`。只要这台电脑在 Tailscale 中的名称不变，地址就不会变。

| 模式 | 谁能打开这个地址 | 启动方式 |
| --- | --- | --- |
| **Funnel**（默认） | 互联网上的任何浏览器 | `Start Codex Console.cmd`，或 `npm run tailscale` |
| **仅限 tailnet** | 只有登录了你 Tailscale 账号的设备 | `Start Codex Console (tailnet only).cmd`，或 `npm run tailscale -- --tailnet-only` |

无论哪种模式，浏览器都需要你的一把 API 密钥才能登录，进入管理后台还需要你的密码和验证器动态码。

## 第一次启动之前

1. 在要运行控制台的电脑上**安装 Tailscale**（[下载](https://tailscale.com/download)）并登录。
2. 在[管理后台的 DNS 页面](https://console.tailscale.com/admin/dns)：开启 **MagicDNS**（新的 tailnet 默认开启），并在 **HTTPS Certificates** 中选择 **Enable HTTPS**。这会把你电脑在 Tailscale 中的名称记录到公开的证书日志里，所以请使用不介意被看到的电脑名。
3. 仅限 Funnel：第一次启动时可能会输出一个**允许 Funnel** 的链接。打开并确认即可；程序会等待，然后继续。

## Windows

1. 解压 `codex-console-windows-x64.zip`（右键 → **全部解压缩**）。里面包含 Node.js、带有 Windows 版 Codex 的控制台，以及两个启动文件。
2. 双击 **Start Codex Console.cmd**。如果出现“Windows 已保护你的电脑”，请选择**更多信息 → 仍要运行**（启动文件没有签名）。
3. 窗口会显示访问地址；第一次还会打开设置页面：设置管理员密码，用验证器应用扫描二维码，保存你的第一把密钥。然后：**管理后台 → Codex → 用 ChatGPT 登录**。
4. 使用控制台期间请保持窗口打开；关闭窗口即可停止。

数据保存在 `%USERPROFILE%\.codexconsole`，Codex 的文件在 `%USERPROFILE%\codex-workspace`，Codex 自己的登录信息在 `%USERPROFILE%\.codex`。

自己生成这个包：`npm run package:windows`（在 Linux、macOS 或 Windows 上都可以；它会下载官方的 `node.exe` 并核对校验和，再安装控制台的 Windows 依赖）。加上 `-- --tailscale-name my-pc.tail1234.ts.net` 会把你预期的地址写进启动文件；如果 Tailscale 给这台电脑的名称不同，启动时会提示。

## macOS 和 Linux

```bash
npm ci
npm run build
npm run tailscale                     # 通过 Funnel 公开
npm run tailscale -- --tailnet-only   # 只对你的 Tailscale 设备开放
```

在 Linux 上，管理 Tailscale Serve 需要先用 root 授权一次：`sudo tailscale set --operator=$USER`。

## 它会做什么

1. 向 Tailscale 查询这台电脑的名称，并检查是否已登录、版本是否足够新（1.52 或更新）。
2. 只在 `127.0.0.1:8787` 上启动控制台（可用 `CC_PORT` 换端口），并以这个名称作为访问地址。
3. 用 `tailscale funnel --bg --https=443 http://127.0.0.1:8787` 发布它（仅限 tailnet 时用 `tailscale serve`）。`--bg` 会让这项设置在重启后保留。如果 443 端口已经用于你的其他服务，它会改用 8443 或 10000，绝不改动你已有的其他设置。
4. 等到这个地址能通过 Tailscale 访问后再显示它。在所有者账户创建之前，它会输出一个一次性设置链接，并在这台电脑的浏览器中打开。

| 选项 | 含义 |
| --- | --- |
| `--tailnet-only` | 只有你的 Tailscale 设备能打开。如果控制台之前被公开过，会先撤下公开的设置。 |
| `--no-open` | 不在这台电脑的浏览器中打开设置页面。 |
| `--no-check` | 不等待地址响应。 |
| `--lang en\|zh-CN` | 提示信息的语言（默认跟随系统）。 |

启动所在文件夹中的 `.env` 设置仍然有效，但访问地址除外：它总是来自 Tailscale。

## 安全

- **Funnel 是公开的。**知道地址的人都能看到登录页面。阻挡他们的是密钥（256 位，只以哈希形式保存）、按来源地址的限流和单独保护的管理后台，和公网服务器上一样。丢失的密钥请在 **管理后台 → 密钥** 中吊销。
- **加密在你的电脑上结束。**Tailscale 为你的 `ts.net` 名称签发证书，并在你的电脑上终止 HTTPS；Funnel 的中继只转发加密后的流量。
- **真实的客户端地址。**Tailscale 用 `X-Forwarded-For` 传递每个访问者的地址（会替换访问者自己发送的值），控制台只信任来自 `127.0.0.1` 的这个头。限流和日志看到的都是真实地址。
- **它相当于你电脑的远程 shell。**Codex 以你的用户身份在运行控制台的电脑上执行命令。请像保管密码一样保管密钥，并参阅 [SECURITY.zh-CN.md](../SECURITY.zh-CN.md)。

## 关闭

关闭窗口即可停止控制台。Tailscale 中的设置会保留（此时地址会显示错误页面），下次启动时会继续使用。要删除它：`tailscale funnel --https=443 off`（或 `tailscale serve --https=443 off`），或用 `tailscale serve reset` 清除这台电脑上的所有设置。

## 故障排查

| 问题 | 处理方法 |
| --- | --- |
| “没有安装 Tailscale / Tailscale 没有运行 / 还没有登录” | 安装或打开 Tailscale 并登录，然后重新启动。 |
| “没有开启 MagicDNS” | 在 [DNS 页面](https://console.tailscale.com/admin/dns) 中开启。 |
| 地址没有响应 | 第一次签发证书可能需要几分钟。请确认 DNS 页面中已开启 **HTTPS Certificates**。 |
| “还不能使用 Funnel” | 打开程序输出的链接，或参阅 [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) 了解 tailnet 策略中的 `funnel` 属性。 |
| “端口 8787 已被占用” | 控制台已经在另一个窗口中运行，或用 `CC_PORT` 换一个端口。 |
| 电脑名和预期的不同 | 程序使用 Tailscale 报告的名称。在 Tailscale 管理后台把电脑改回原来的名称，即可恢复你常用的地址。 |
