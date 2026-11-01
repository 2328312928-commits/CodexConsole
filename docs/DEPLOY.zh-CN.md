# 部署到你的服务器

[English](DEPLOY.md)

在你自己的电脑上运行一条命令，就能把 Codex 控制台部署到一台 Linux 服务器上并启用 HTTPS。之后你的任何浏览器都只需要一把你的 API 密钥。

## 需要准备

- **一台 Linux 服务器：**Ubuntu 22.04 / 24.04 或 Debian 12 / 13，x86-64 或 ARM64，内存 1 GB 以上（低于 1.8 GB 时安装程序会为构建添加 2 GB 交换空间），约 3 GB 可用磁盘。
- **SSH 登录权限：**以 `root` 或有 `sudo` 权限的用户登录。建议使用 SSH 密钥（`ssh-copy-id 用户@服务器`）；如果用密码，只会询问一次。
- **一个地址：**DNS `A` 记录指向该服务器的域名，或者只用服务器的公网 IPv4 地址。
- **开放 80 和 443 端口：**在云服务商的防火墙或安全组中开放。80 端口用于 Let's Encrypt 的验证和跳转到 HTTPS。
- **你的电脑上：**本仓库，以及 `bash`、`ssh` 和 `tar`（Linux、macOS，或 Windows 上的 WSL）。

Codex 在服务器上运行，并处理服务器上的文件。你用来登录的电脑只需要浏览器。

## 部署

```bash
./deploy/deploy.sh root@203.0.113.7 --ip 203.0.113.7
./deploy/deploy.sh me@my-server --domain console.example.com --email me@example.com
```

| 选项 | 含义 |
| --- | --- |
| `--domain 域名` | 使用该域名提供服务。它的 `A` 记录必须指向服务器。 |
| `--ip 地址` | 使用服务器的公网 IPv4 地址提供服务，无需域名。 |
| `--email 邮箱` | Let's Encrypt 的联系邮箱（可选）。 |
| `--port N` | SSH 端口（默认 22）。防火墙中始终保持开放。 |
| `--identity 文件` | 要使用的 SSH 私钥。 |
| `--new-key 名称` | 同时为另一台设备签发一把 API 密钥。 |
| `--harden-ssh` | 关闭 SSH 密码登录。只有在密钥登录可用时才允许。 |
| `--no-firewall` | 不改动服务器的防火墙。 |
| `--check`、`--dry-run` | 只检查服务器（系统、内存、端口、DNS），不做任何修改。 |
| `--lang en\|zh-CN` | 提示信息和设置向导使用的语言。 |

可以先用 `--check`：它会告诉你服务器是否已准备好，而不改动任何东西。

首次安装时，服务器会在你的终端里要求设置**管理员密码**，并显示一个供**验证器应用**扫描的二维码。然后它会输出**你的第一把 API 密钥**，只显示这一次。请把它保存在密码管理器中。

## 首次登录

1. 打开脚本输出的地址，粘贴密钥。
2. 用密码和验证器动态码进入 **管理后台**，打开 **Codex**，用你的 ChatGPT 套餐登录。它会显示一个设备码：由你本人在 OpenAI 页面输入。
3. 为其他每台设备各签发一把密钥：**管理后台 → 密钥 → 新建密钥**，或在服务器上运行 `sudo codex-console setup --new-key "手机"`。新密钥默认是完整控制台、不设上限、永不过期；如需限制，可在表单中修改。

## 安装程序在服务器上做了什么

| 内容 | 位置 |
| --- | --- |
| Node.js 24（NodeSource apt 源），仅在缺少 Node 22.13+ 时安装 | `/usr/bin/node` |
| Caddy（Caddy 官方 apt 源），自动 HTTPS | `/etc/caddy/codex-console.caddy`，由 `/etc/caddy/Caddyfile` 引入 |
| 运行控制台的系统用户 | `codexconsole` |
| 运行 Codex 的第二个系统用户，以及两者共享工作区所用的用户组 | `codexagent`、`codexws` |
| 在服务器上构建的应用；保留最近三个版本。归 root 所有，服务无法修改自身代码 | `/opt/codex-console/releases/…`、`/opt/codex-console/current` |
| 数据库和机密（仅控制台）、工作区（两者共用）、Codex 的登录信息和配置、Codex 的主目录 | `/var/lib/codex-console/{data,workspace,codex-home,agent}` |
| 设置：一个由安装程序管理，一个归你所有，以及 Codex 的设置 | `/etc/codex-console/env`、`/etc/codex-console/local.env`、`/etc/codex-console/agent.env` |
| 控制台的 systemd 服务，`/var/lib/codex-console` 以外全部只读 | `codex-console.service` |
| Codex 的服务：控制台通过这个中继访问 Codex。它看不到控制台的数据 | `codex-console-codex.service`、`/run/codex-console/codex.sock` |
| 管理命令 | `sudo codex-console setup …`、`status`、`logs`、`restart` |
| 防火墙（ufw）：只开放 SSH、80 和 443 | |
| 针对 SSH 的 fail2ban，以及自动安全更新 | `/etc/fail2ban/jail.d/codex-console.local`、`/etc/apt/apt.conf.d/20auto-upgrades` |
| 仅在使用 `--harden-ssh` 时：禁止 SSH 密码登录，root 只能用密钥登录 | `/etc/ssh/sshd_config.d/10-codex-console.conf` |

值得了解的细节：

- **证书。**使用域名时，Caddy 申请普通的 Let's Encrypt 证书。使用 IP 地址时，它为 IP 本身申请 Let's Encrypt 证书；这类证书有效期很短（约 6 天），Caddy 会自动续期。如果申请失败，安装程序会改用 `<ip>.sslip.io`（一个指向你 IP 的公共 DNS 名称），并输出新地址。
- **控制台和 API 共用一个地址。**Caddy 把 `/v1` 转发给公网 API（`127.0.0.1:8788`），其他请求转发给控制台（`127.0.0.1:8787`）。两者都不监听公网网卡。
- **你的 Caddyfile。**新服务器上的默认 Caddyfile 会被替换（原文件保存为 `Caddyfile.orig`）。你自己写的 Caddyfile 会保留，只添加一行 `import`。Caddy 拒绝的配置永远不会被应用。
- **安全计时器。**安装程序开启防火墙（或修改 SSH）时，会设置一个 10 分钟后撤销这些修改的计时器。随后 `deploy.sh` 会通过新的 SSH 连接再次登录；只有登录成功才会停止计时器。如果你失去了 SSH 访问，等 10 分钟即可。如果你手动运行 `install.sh`，请在新的 SSH 会话中用 `sudo codex-console confirm` 确认。
- **Codex 以自己的用户运行。**Codex 在自己的服务中以 `codexagent` 身份运行，因此任何密钥都无法借助它读取或修改控制台的数据库、密钥或机密。安装程序会检查 `codexagent` 无法读取控制台的数据文件夹。在旧的安装上重新运行安装程序时，会把 Codex 的文件夹和工作区迁移过去。
- **Codex 的沙箱。**Codex 用 Linux 命名空间隔离它运行的命令。安装程序会检查这在 Codex 的服务中是否可用。Ubuntu 23.10 及更新版本默认禁止这类命名空间；这时安装程序会添加一个只针对 Codex 程序的 AppArmor 配置来允许它们。
- **机密不会离开你的电脑。**`deploy.sh` 只上传 git 跟踪的文件；`.env`、`data/`、数据库和密钥文件都被 `.gitignore` 排除。机密在服务器上生成。

## 日常使用

- **更新：**再次运行同一条 `deploy.sh` 命令。数据、密钥、会话和 Codex 登录都会保留。
- **密钥：****管理后台 → 密钥**（新建、修改上限、轮换、吊销、查看当前登录），或 `sudo codex-console setup --list-keys | --new-key 名称 | --revoke-key ID`。
- **你的项目：**Codex 在服务器的 `/var/lib/codex-console/workspace` 中工作。可以在控制台中上传文件，或在会话中用 `!git clone …` 克隆仓库（私有仓库需要在服务器上配置凭据，例如只读的部署密钥）。
- **设置：**在 `/etc/codex-console/local.env` 中添加配置行（见 [`.env.example`](../.env.example)），然后运行 `sudo codex-console restart`。
- **日志：**`sudo codex-console logs` 查看控制台和 Codex 的日志，`journalctl -u caddy` 查看 HTTPS 相关日志。请求、登录和安全事件也在管理后台中。
- **备份：**所有重要内容都在 `/var/lib/codex-console` 中。其中包含机密（用于密钥哈希的服务器密钥 pepper、加密的验证器密钥和 Codex 的登录信息），请妥善保管备份。

  ```bash
  sudo systemctl stop codex-console
  sudo tar -C /var/lib -czf codex-console-backup.tgz codex-console
  sudo systemctl start codex-console
  ```

## 故障排查

| 问题 | 处理方法 |
| --- | --- |
| 没有拿到证书 | 确认域名的 `A` 记录指向服务器，并在云服务商处开放了 80 和 443 端口。`journalctl -u caddy --since -10min` 会显示原因。Caddy 会自动重试。 |
| “Codex 沙箱在本机无法工作” | 一些基于容器的服务器（OpenVZ、部分 LXC）不允许用户命名空间。请换用 KVM 服务器，或以完全访问模式运行会话（没有沙箱；但服务在其文件夹以外仍是只读的）。 |
| 所有密钥都丢了 | 在服务器上运行：`sudo codex-console setup --new-key "笔记本"`。 |
| 验证器或密码丢了 | `sudo codex-console setup --reset-totp` 或 `--reset-password`。两者都会结束所有登录。 |
| 设备丢失或被盗 | 在 **管理后台 → 密钥** 中吊销它的密钥，或运行 `sudo codex-console setup --revoke-key ID`。它会立即被退出登录。 |
| 部署后 SSH 无法登录 | 等待 10 分钟让安全计时器生效，或使用云服务商的网页控制台。 |
| 页面提示该地址不被允许 | 请打开安装程序输出的地址；其他名称需要在 `local.env` 中设置 `CC_ALLOWED_HOSTS`。 |

## 卸载

```bash
sudo systemctl disable --now codex-console codex-console-codex
sudo rm -rf /opt/codex-console /etc/codex-console /usr/local/bin/codex-console /etc/systemd/system/codex-console.service /etc/systemd/system/codex-console-codex.service
sudo rm -f /etc/caddy/codex-console.caddy /etc/fail2ban/jail.d/codex-console.local /etc/apparmor.d/codex-console-codex
sudo systemctl daemon-reload
# 你的数据、工作区和 Codex 登录信息：sudo rm -rf /var/lib/codex-console
# 两个用户及其用户组：sudo userdel codexagent; sudo userdel codexconsole; sudo groupdel codexws
```

然后从 `/etc/caddy/Caddyfile` 中删除 `import /etc/caddy/codex-console.caddy` 这一行（或恢复 `Caddyfile.orig`），并重新加载 Caddy。
