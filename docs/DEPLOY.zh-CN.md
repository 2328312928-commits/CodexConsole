# 部署到你的服务器

[English](DEPLOY.md)

用部署程序就能把 Codex 控制台部署到一台 Linux 服务器上并启用 HTTPS：填好一个页面，点击**部署**，然后在浏览器中完成设置。无需使用终端（`deploy/deploy.sh` 可以在终端中完成同样的事）。之后你的任何浏览器都只需要一把你的 API 密钥。

## 需要准备

- **一台 Linux 服务器：**Ubuntu 22.04 / 24.04 或 Debian 12 / 13，x86-64 或 ARM64，内存 1 GB 以上（低于 1.8 GB 时安装程序会为构建添加 2 GB 交换空间），约 3 GB 可用磁盘。
- **SSH 登录权限：**以 `root` 或有 `sudo` 权限的用户登录，使用密码或 SSH 密钥均可。
- **一个地址：**DNS `A` 记录指向该服务器的域名，或者只用服务器的公网 IPv4 地址。
- **开放 80 和 443 端口：**在云服务商的防火墙或安全组中开放。80 端口用于 Let's Encrypt 的验证和跳转到 HTTPS。
- **你的电脑上：**适用于 Windows、macOS 或 Linux 的部署程序。如果改用终端方式：本仓库，以及 `bash`、`ssh` 和 `tar`（Linux、macOS，或 Windows 上的 WSL）。

Codex 在服务器上运行，并处理服务器上的文件。你用来登录的电脑只需要浏览器。

## 部署程序

| 你的电脑 | 文件 |
| --- | --- |
| Windows | `codex-console-deploy-windows-x64.exe` |
| Apple 芯片的 Mac（M1 或更新） | `codex-console-deploy-macos-arm64.zip` |
| Intel 处理器的 Mac | `codex-console-deploy-macos-x64.zip` |
| Linux | `codex-console-deploy-linux-x64.tar.gz` 或 `codex-console-deploy-linux-arm64.tar.gz` |

**获取方式。****Deploy program** 工作流（`.github/workflows/deploy-program.yml`）会在 GitHub 上生成全部五个文件：在你仓库的 **Actions** 页运行它即可下载；或者推送一个标签（例如 `deployer-v0.1.0`），把文件放到一个草稿版本（draft release）上。也可以自己生成：`cd deployer && npm ci --ignore-scripts && npm run package -- --all`（需要 Node 22.13 或更新版本；macOS 的文件需要在 Mac 上生成）。`SHA256SUMS.txt` 列出了每个文件的校验和。

**启动。**它没有用付费证书签名，所以第一次启动需要多点一下：

- **Windows：**双击 `.exe`。如果出现“Windows 已保护你的电脑”，请选择**更多信息 → 仍要运行**。
- **macOS：**打开 `.zip`，然后双击 `codex-console-deploy`。如果 macOS 提示无法检查该应用，请打开**系统设置 → 隐私与安全性**，选择**仍要打开**（较旧的 macOS：按住 Control 点击它，选择**打开**）。它会在一个终端窗口中运行。
- **Linux：**解压后运行 `codex-console-deploy`。

一个小窗口会显示它正在运行，同时浏览器会打开部署页面（如果没有打开，请打开窗口中显示的链接）。部署期间请保持该窗口打开；完成后关闭它，或在页面上点击**退出**。

**在页面上：**

1. **你的服务器：**地址和 SSH 端口、用户名，以及密码或 SSH 密钥（会列出你 `~/.ssh` 文件夹中的密钥，也可以选择文件）。如果用户不是 root，且 sudo 密码与登录密码不同，请填写 sudo 密码。
2. **访问地址：**服务器的 IP 地址（无需域名：证书直接签发给该 IP），或你自己的域名（请先把它的 DNS `A` 记录指向服务器）。接收证书通知的邮箱可以不填。
3. **检查服务器**只查看服务器，不做任何修改。**部署**会安装 Codex 控制台，或更新它。

第一次连接某台服务器时，会显示它的 SSH 指纹。如果云服务商也显示了指纹，请核对后再信任。部署程序会记住它；如果这台服务器的密钥以后变了，它会停下并发出警告，除非你确认自己重装过服务器。

完成后会显示**打开设置页面**：见[在浏览器中完成设置](#在浏览器中完成设置)。页面上的**其他操作**可以获取新的设置链接（旧链接已用过或已过期时），或创建恢复密钥（所有密钥都丢失时）。

**它会保存什么：**服务器地址、用户名、你选择的选项以及你信任过的指纹，保存在 `%APPDATA%\CodexConsoleDeploy`（Windows）、`~/Library/Application Support/CodexConsoleDeploy`（macOS）或 `~/.config/codex-console-deploy`（Linux）。从不保存密码或密钥：它们只在当前这一个任务中保存在内存里。

**谁能使用这个页面：**只有你的浏览器。部署程序只在 `127.0.0.1` 的随机端口上提供页面，并且只响应带有它所打开链接中随机令牌的请求。它拒绝其他网站的请求（检查 Host、Origin 和内容类型），并使用严格的内容安全策略（CSP）。所有操作都通过 SSH 发往你的服务器。

## 用终端部署

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
| `--new-key 名称` | 同时为另一台设备签发一把 API 密钥（设置完成之后）。 |
| `--harden-ssh` | 关闭 SSH 密码登录。只有在密钥登录可用时才允许。 |
| `--no-firewall` | 不改动服务器的防火墙。 |
| `--check`、`--dry-run` | 只检查服务器（系统、内存、端口、DNS），不做任何修改。 |
| `--lang en\|zh-CN` | 提示信息使用的语言。 |

可以先用 `--check`：它会告诉你服务器是否已准备好，而不改动任何东西。如果用密码登录，只会询问一次；用 SSH 密钥更方便（`ssh-copy-id 用户@服务器`）。最后脚本会输出控制台的地址，首次安装时还会输出一个一次性的**设置链接**。

## 在浏览器中完成设置

1. 打开设置链接。它只能使用一次，7 天后失效。设置**管理员密码**（至少 12 个字符），用**验证器应用**扫描二维码并输入动态码，再给这台设备起个名字。你会得到**你的第一把密钥**，只显示这一次：请把它保存在密码管理器中，用于在其他浏览器上登录。这个浏览器已经登录好了。
2. 用密码和验证器动态码进入 **管理后台**，打开 **Codex**，用你的 ChatGPT 套餐登录。它会显示一个设备码：由你本人在 OpenAI 页面输入。
3. 为其他每台设备各签发一把密钥：**管理后台 → 密钥 → 新建密钥**，输入名称，需要的话再填一个 token 额度（每天、每月或总计），然后点击**创建密钥**。**更多选项**中有其余设置：有效期、控制台访问、沙箱、速率限制等。新密钥默认可以登录完整控制台、不设上限、永不过期，除非你另行设置。点击**吊销**会让这把密钥在所有地方立即退出登录。

设置链接丢了或过期了？在部署程序中使用**其他操作 → 获取新的设置链接**，或在服务器上运行 `sudo codex-console setup --setup-link`。新链接会取代旧链接；设置完成后，任何设置链接都不再有效。

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
- **安全计时器。**安装程序开启防火墙（或修改 SSH）时，会设置一个 10 分钟后撤销这些修改的计时器。随后部署程序（或 `deploy.sh`）会通过新的 SSH 连接再次登录；只有登录成功才会停止计时器。如果你失去了 SSH 访问，等 10 分钟即可。如果你手动运行 `install.sh`，请在新的 SSH 会话中用 `sudo codex-console confirm` 确认。
- **Codex 以自己的用户运行。**Codex 在自己的服务中以 `codexagent` 身份运行，因此任何密钥都无法借助它读取或修改控制台的数据库、密钥或机密。安装程序会检查 `codexagent` 无法读取控制台的数据文件夹。在旧的安装上重新运行安装程序时，会把 Codex 的文件夹和工作区迁移过去。
- **Codex 的沙箱。**Codex 用 Linux 命名空间隔离它运行的命令。安装程序会检查这在 Codex 的服务中是否可用。Ubuntu 23.10 及更新版本默认禁止这类命名空间；这时安装程序会添加一个只针对 Codex 程序的 AppArmor 配置来允许它们。
- **机密不会离开你的电脑。**两种方式都只上传控制台的文件，也就是 git 跟踪的文件（部署程序自带一份在生成程序时复制的文件），因此 `.env`、`data/`、数据库和密钥文件都被 `.gitignore` 排除在外。机密在服务器上生成。

## 日常使用

- **更新：**在部署程序中再次点击**部署**（新版本的部署程序自带新版本的控制台），或再次运行同一条 `deploy.sh` 命令。数据、密钥、会话和 Codex 登录都会保留。
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
| 所有密钥都丢了 | 部署程序：**其他操作 → 创建恢复密钥**。或在服务器上运行：`sudo codex-console setup --new-key "笔记本"`。 |
| 设置链接打不开 | 它只能用一次、7 天内有效，而且只有最新的链接有效。获取新链接：部署程序 → **其他操作**，或 `sudo codex-console setup --setup-link`。 |
| 部署程序提示服务器的密钥变了 | 如果你重装过服务器，请在页面上确认。如果没有，请停止：可能有别的机器在冒充你的服务器。 |
| 部署程序无法登录服务器 | 在云服务商的控制面板中核对用户名和密码（或密钥及其口令）。有些服务商只允许 SSH 密钥登录，或需要先开启密码登录。 |
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
