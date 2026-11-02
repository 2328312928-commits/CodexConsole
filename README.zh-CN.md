# Codex 控制台

一个自托管、只属于一位所有者的 Web 控制台，用来远程使用**你自己的** [Codex CLI](https://github.com/openai/codex)，登录方式是**你的 ChatGPT 套餐**（不消耗 API 额度）。每个人都运行自己的一份、只给自己用：把它部署到服务器上一次，或者用 Tailscale 在你自己的电脑上运行；之后在你任何一台设备的浏览器里打开它、粘贴你的一把 API 密钥，就能使用完整控制台，那些设备上什么都不用装。

在你自己的浏览器和手机上可以：

- 向 Codex 发送提示词，实时查看流式回复（思考过程、命令及输出、文件改动、计划、MCP 工具调用）
- 引导或停止正在进行的一轮，回答 Codex 的问题和 MCP 服务器的表单，批准或拒绝 Codex 请求运行的命令和文件修改
- 使用 Codex 自身的功能：每个会话的模型、推理强度、沙箱、审批和网络设置；`/` 斜杠命令；代码审查、压缩上下文、改动、目标、`@` 提及文件、技能、图片链接、`!` shell 命令；从任意一轮分叉会话或回退
- 向工作区上传文件、下载文件，并把文件或图片附加到提示词
- 直接查看 Codex 生成或查看的图片和视频
- 管理会话：新建、重命名、归档、删除、搜索，并可导入在终端中开始的线程
- 管理 Codex 的 **MCP 服务器**：列出、添加、编辑、启用/停用、移除、登录
- 为你的每台设备单独签发 **API 密钥**，可设置有效期、额度、速率限制和各项上限，可轮换和吊销；带 API 权限的密钥还能让你的脚本通过公网 API（`/v1`）使用
- 使用私有的**管理后台**：查看每一次请求（时间、会话、密钥、提示词大小、耗时、状态、令牌、文件），以及套餐用量限制、每个密钥的用量、当前登录、文件传输和安全日志

所有界面都有 **English 和简体中文** 两种语言（顶栏可切换），并支持浅色和深色。English docs: [README.md](README.md)。Codex 的全部功能及其在控制台中的位置：[docs/FEATURES.zh-CN.md](docs/FEATURES.zh-CN.md)。

> **这相当于一个远程终端。** Codex 会在运行控制台的机器上执行命令。拿到你任何一把密钥的人，都能在那里做 Codex 能做的事。请像对待密码一样保管密钥，并阅读 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。

> **非官方项目。**这是一个独立的开源项目，与 OpenAI 没有关联，也未获其认可。Codex 和 ChatGPT 是 OpenAI 的商标。

## 选择运行方式

| | **A. 用 Tailscale 在你自己的电脑上运行** | **B. 部署到你自己的 Linux 服务器** |
| --- | --- | --- |
| 需要 | 一台 Windows、macOS 或 Linux 电脑，以及一个免费的 [Tailscale](https://tailscale.com) 账号 | 一台能用 SSH 登录的 Linux 服务器，以及一个域名或它的公网 IPv4 地址 |
| 访问地址 | `https://<电脑名>.<tailnet>.ts.net`，每次都一样 | `https://<你的域名>` 或 `https://<服务器 IP>` |
| 谁能打开 | 任何浏览器（Funnel），或只有你自己的 Tailscale 设备 | 任何浏览器 |
| 运行时间 | 电脑开着、控制台窗口开着的时候 | 一直运行 |
| 下载 | 适合那台电脑的**控制台包** | 适合你用来部署的那台电脑的**部署程序** |

无论哪种方式，浏览器都要用你的一把 API 密钥才能登录，进入管理后台还需要你的密码和验证器动态码。

## 下载

所有文件都在项目的 **Releases** 页面：

| 你的电脑 | 控制台包（方式 A） | 部署程序（方式 B） |
| --- | --- | --- |
| Windows 10 或 11（x64） | `codex-console-windows-x64.zip` | `codex-console-deploy-windows-x64.exe` |
| Apple 芯片的 Mac（M1 或更新） | `codex-console-macos-arm64.zip` | `codex-console-deploy-macos-arm64.zip` |
| Intel 处理器的 Mac | `codex-console-macos-x64.zip` | `codex-console-deploy-macos-x64.zip` |
| Linux x64 | `codex-console-linux-x64.tar.gz` | `codex-console-deploy-linux-x64.tar.gz` |
| Linux ARM64 | `codex-console-linux-arm64.tar.gz` | `codex-console-deploy-linux-arm64.tar.gz` |

- **我的 Mac 是哪种？**点击苹果菜单 → **关于本机**：显示 “芯片：Apple M…” 的是 Apple 芯片；显示 “处理器：Intel…” 的是 Intel。
- **校验和：**`SHA256SUMS.txt` 列出了每个文件的 SHA-256。核对下载的文件：Windows PowerShell 运行 `Get-FileHash .\文件.zip`，macOS 运行 `shasum -a 256 文件.zip`，Linux 运行 `sha256sum 文件.tar.gz`。
- **没有使用付费证书签名：**第一次启动需要多点一下，下面按系统分别说明。
- **自己生成：**`npm ci && npm run package:portable`（控制台包），`cd deployer && npm ci --ignore-scripts && npm run package -- --all`（部署程序；其中 macOS 的文件需要在 Mac 上生成）。

## 方式 A 用 Tailscale 在你自己的电脑上运行

控制台运行在你的电脑上，Tailscale 为它提供一个固定的 https 地址。使用 **Funnel**（默认）时，互联网上的任何浏览器都能打开；使用**仅限 tailnet** 时，只有登录了你 Tailscale 账号的设备能打开。除了经由 Tailscale，这台电脑不会向互联网开放任何端口。

### 第 1 步：设置 Tailscale（只需一次）

1. 在要运行控制台的电脑上**安装 Tailscale 并登录**：
   - Windows 和 macOS：[tailscale.com/download](https://tailscale.com/download)（Mac 也可以用 Mac App Store 版）。打开后登录，会自动创建你的免费账号（你的 “tailnet”）。
   - Linux：运行 `curl -fsSL https://tailscale.com/install.sh | sh`，然后运行 `sudo tailscale up`，打开它输出的链接登录。
2. **开启 HTTPS。**打开 [Tailscale 管理后台的 DNS 页面](https://console.tailscale.com/admin/dns)。确认 **MagicDNS** 已开启（新的 tailnet 默认开启），然后在 **HTTPS Certificates** 中选择 **Enable HTTPS** 并确认。这会把你电脑在 Tailscale 中的名称记录到公开的证书日志里，所以请使用不介意被看到的电脑名。
3. **Funnel**（公网地址）不需要提前设置：第一次启动时会输出一个允许 Funnel 的链接，打开并确认一次即可。如果你的 tailnet 用了自定义的访问策略，需要加上 `funnel` 属性：见 [Tailscale Funnel](https://tailscale.com/kb/1223/funnel)。
4. **仅限 Linux：**允许你的用户管理 Tailscale Serve 和 Funnel：`sudo tailscale set --operator=$USER`。

访问地址是 `https://<电脑名>.<tailnet 名>.ts.net`。两个名称都可以在 [Machines 页面](https://console.tailscale.com/admin/machines) 看到，也可以在那里给电脑改名。

### 第 2 步：安装并启动

#### Windows

1. 下载 `codex-console-windows-x64.zip`。
2. 可选（可以少一次警告）：右键点击 zip → **属性** → 勾选 **解除锁定** → **确定**。
3. 右键点击 zip → **全部解压缩…** → 选择一个文件夹（例如“文档”）→ **提取**。不要在 zip 里面直接运行。
4. 打开 `Codex Console` 文件夹，双击 **Start Codex Console.cmd**。
5. 如果出现 “Windows 已保护你的电脑”，选择 **更多信息** → **仍要运行**。
6. 会打开一个命令行窗口：使用 Codex 控制台期间请保持它打开。第一次运行时，Tailscale 可能会输出一个允许 Funnel 的链接：浏览器会打开它，确认即可。
7. 窗口会显示你的访问地址；第一次运行时浏览器还会打开设置页面：接着看[首次登录与 Codex](#首次登录与-codex)。

如果想让地址只对你的 Tailscale 设备开放，请改为启动 **Start Codex Console (tailnet only).cmd**。

#### macOS（Apple 芯片或 Intel）

1. 下载适合你 Mac 的 zip：`codex-console-macos-arm64.zip`（Apple 芯片）或 `codex-console-macos-x64.zip`（Intel）。
2. 双击 zip 解压，把 `Codex Console` 文件夹移到你喜欢的位置（个人文件夹或“应用程序”）。
3. 双击 **Start Codex Console.command**，它会在终端窗口中运行。
4. 第一次运行时 macOS 会提示无法验证该文件：点击 **完成**，打开 **系统设置 → 隐私与安全性**，向下滚动，选择 **仍要打开** 并确认。（macOS 14 及更早版本：按住 Control 点按该文件 → **打开** → **打开**。）如果终端请求访问该文件夹，请允许。
5. 第一次运行时，Tailscale 可能会给出一个允许 Funnel 的链接：打开并确认。
6. 窗口会显示你的访问地址；第一次运行时浏览器还会打开设置页面：接着看[首次登录与 Codex](#首次登录与-codex)。

启动文件只会清除它自己所在文件夹的 macOS 下载隔离标记，避免 Codex 及其辅助程序被逐个拦截。**Start Codex Console (tailnet only).command** 会让地址只对你的 Tailscale 设备开放。

#### Linux（x64 或 ARM64）

```bash
tar -xzf codex-console-linux-x64.tar.gz     # 或 ...-linux-arm64.tar.gz
cd codex-console
./start.sh                                   # 通过 Funnel 公开
./start.sh --tailnet-only                    # 或：只对你的 Tailscale 设备开放
```

终端会显示你的访问地址和一次性设置链接（也会尝试在浏览器中打开它）。要在退出登录后继续运行，可以用 tmux 或 screen，或者设为 systemd 用户服务：

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

然后运行 `systemctl --user enable --now codex-console` 和 `loginctl enable-linger $USER`；用 `journalctl --user -u codex-console` 查看访问地址和设置链接。

### Funnel 还是仅限 tailnet

- **Funnel**（默认）：任何浏览器都能打开这个地址并看到登录页面。阻挡他人的是密钥（256 位，只以哈希形式保存）、按来源地址的限流，以及单独保护的管理后台。HTTPS 在你自己的电脑上结束。
- **仅限 tailnet**：只有登录了你 Tailscale 账号的设备能打开这个地址。
- 随时可以切换：启动另一个启动文件即可，它会自动修改 Tailscale 的设置。

### 停止、重启、更新、删除

- **停止：**关闭窗口或按 Ctrl+C。之后再访问这个地址会显示错误页面，直到你再次启动。
- **重启：**再次启动即可。地址不变，你的密钥和会话也都还在。
- **更新：**把新的控制台包解压到一个新文件夹，从那里启动。你的数据保存在个人文件夹中（见下表），不在包里。
- **删除：**删除这个文件夹以及下表中的数据文件夹；运行 `tailscale funnel --https=443 off`（或 `tailscale serve --https=443 off`）撤下这个地址。

| 内容 | Windows | macOS 和 Linux |
| --- | --- | --- |
| 控制台的数据（密钥、会话、日志） | `%USERPROFILE%\.codexconsole` | `~/.codexconsole` |
| Codex 的工作文件夹 | `%USERPROFILE%\codex-workspace` | `~/codex-workspace` |
| Codex 自己的登录信息和设置 | `%USERPROFILE%\.codex` | `~/.codex` |

更多内容（它会做什么、选项、故障排查）：[docs/TAILSCALE.zh-CN.md](docs/TAILSCALE.zh-CN.md)。

## 方式 B 部署到你自己的 Linux 服务器

你需要一台 Linux 服务器（Ubuntu 22.04/24.04 或 Debian 12/13，x86-64 或 ARM64，内存 1 GB 以上），能以 root 或有 sudo 权限的用户用 SSH 登录；一个指向它的域名，或者只用它的公网 IPv4 地址；并在云服务商的防火墙中开放 80 和 443 端口。部署程序运行在你自己的电脑上，通过 SSH 完成全部操作。

### 启动部署程序

- **Windows：**下载 `codex-console-deploy-windows-x64.exe` 并双击。如果出现 “Windows 已保护你的电脑”，选择 **更多信息** → **仍要运行**。
- **macOS：**下载适合你 Mac 的 zip，双击解压，再双击 `codex-console-deploy`。第一次运行时打开 **系统设置 → 隐私与安全性** → **仍要打开**（macOS 14 及更早版本：按住 Control 点按 → **打开**）。它会在终端窗口中运行。
- **Linux：**运行 `tar -xzf codex-console-deploy-linux-x64.tar.gz && ./codex-console-deploy`。

一个小窗口会显示它正在运行，同时浏览器会打开部署页面（如果没有打开，请打开窗口中显示的链接）。

### 部署

1. **你的服务器：**地址和 SSH 端口、用户名，以及密码或 SSH 密钥（会列出你 `~/.ssh` 文件夹中的密钥，也可以选择文件）。如果用户不是 root，且 sudo 密码与登录密码不同，请填写 sudo 密码。
2. **访问地址：**服务器的 IP 地址（无需域名）或你的域名（请先把域名的 DNS `A` 记录指向服务器）。接收证书通知的邮箱可以不填。
3. **检查服务器**只查看、不做任何修改；**部署**会安装 Codex 控制台（或更新它）。第一次连接时请确认服务器的 SSH 指纹（**信任并继续**）。安装需要几分钟。
4. 完成后选择 **打开设置页面**，接着看[首次登录与 Codex](#首次登录与-codex)。

再次点击 **部署** 即可更新；你的数据保留在服务器的 `/var/lib/codex-console` 中。页面上的 **其他操作** 可以获取新的设置链接或创建恢复密钥。如果你习惯用终端，在本仓库中运行 `./deploy/deploy.sh root@203.0.113.7 --ip 203.0.113.7` 效果相同。更多内容：[docs/DEPLOY.zh-CN.md](docs/DEPLOY.zh-CN.md)。

## 首次登录与 Codex

1. **设置页面。**第一次运行时它会自动打开（也可以打开窗口中显示的设置链接）。链接只能使用一次，7 天后失效。
   - **管理员密码：**至少 12 个字符，输入两次。它用于进入管理后台。
   - **验证器：**用验证器应用（Google Authenticator、Microsoft Authenticator、1Password 等）扫描二维码，输入它显示的 6 位动态码。
   - 填写 **这台设备的名称**，然后点击 **完成设置**。
2. 页面会显示 **你的第一把密钥**（“已登录”）。它只显示这一次：请复制到你的密码管理器中。这个浏览器现在已经登录。
3. **登录 Codex：**选择 **下一步：登录 Codex**（以后可以在 **管理后台 → Codex** 中操作），然后点击 **登录 ChatGPT**。页面会显示一个链接和一个代码：打开链接，登录 ChatGPT，输入代码。之后 Codex 就会使用你的 ChatGPT 套餐。
4. **开始使用：****控制台** → 新建会话 → 输入提示词。

以后进入 **管理后台** 时，需要输入管理员密码和验证器动态码（**解锁管理后台**），15 分钟不操作会自动重新锁定。顶栏的 **退出登录** 会结束这个浏览器的登录。

设置链接丢了或过期了？方式 A：重新启动控制台，它会输出一个新的链接。方式 B：部署程序的 **其他操作 → 获取新的设置链接**。

## API 密钥的创建与吊销

请给每台设备各发一把密钥，这样你可以看到每台设备的用量，也能只吊销其中一把。

**创建密钥**

1. **管理后台**（密码 + 验证器动态码）→ **密钥** → **新建密钥**。
2. 填写 **名称**，例如 “笔记本” 或 “手机”。可以再填一个 **令牌额度** 和它的 **额度周期**（每天、每月或总计）。
3. 需要的话展开 **更多选项**：有效期、控制台访问（*完整控制台*、*仅限文件夹*，或 *关闭* 即只用于 API）、公网 API 权限范围、最高沙箱级别、审批方式、网络、速率限制、IP 允许列表。
4. 点击 **创建密钥**。复制这把密钥（它只显示这一次，控制台只保存它的哈希）和 **登录地址**，然后点击 **我已保存**。

**吊销密钥**

1. **管理后台 → 密钥**，找到这把密钥，点击 **吊销**，在 **吊销密钥** 对话框中确认。
2. 它会在所有地方立即失效：用它登录的浏览器被退出登录，它正在运行的提示词被停止，它的 API 调用也会失败。**显示已吊销** 会列出已吊销的密钥。

**轮换** 会给密钥换一个新的秘密值，并让旧值退出登录（可选的宽限期能让 API 脚本暂时继续使用旧值）。同一页的 **当前登录** 列出所有已登录的浏览器，可以让其中任何一个退出登录。详细说明：[密钥详解](#密钥详解)。

## 从其他电脑和手机访问

1. 在任何浏览器中打开你的访问地址：Tailscale 地址（方式 A），或你的域名或 IP（方式 B）。
2. 粘贴你的一把 API 密钥，点击 **登录**。可以把页面加入书签，或在手机上添加到主屏幕。
3. **仅限 tailnet 时：**先在那台设备上也安装 Tailscale，并登录同一个账号。

一次登录在 12 小时不使用后失效，最长 7 天；之后再粘贴一次密钥即可。吊销那把密钥会让那台设备立即退出登录。

## 常见问题

**我该下载哪个文件？**见[下载](#下载)：要在那台电脑上运行，下载控制台包；要装到服务器上，下载部署程序。

**Windows 提示 “Windows 已保护你的电脑”。**这些文件没有用付费证书签名。选择 **更多信息 → 仍要运行**，或者先给 zip 解除锁定（属性 → **解除锁定**）。

**macOS 提示无法打开或无法验证该文件。****系统设置 → 隐私与安全性 → 仍要打开**，然后再次启动（macOS 14 及更早版本：按住 Control 点按 → **打开**）。

**Linux 提示 “Permission denied”。**请用 `tar -xzf` 解压（它会保留文件的可执行权限），或运行 `chmod +x start.sh node/node`。

**提示 “没有安装 Tailscale / Tailscale 没有运行 / 还没有登录”。**安装或打开 Tailscale 并登录，然后重新启动。

**提示 “没有开启 MagicDNS”，或者地址没有响应。**在 [DNS 页面](https://console.tailscale.com/admin/dns) 开启 MagicDNS 并选择 **Enable HTTPS**。第一次签发证书可能需要几分钟。

**提示 “还不能使用 Funnel”。**打开窗口中输出的链接并确认，或者在 tailnet 策略中加上 `funnel` 属性（[Tailscale Funnel](https://tailscale.com/kb/1223/funnel)）。

**地址和我预期的不一样。**地址取自你电脑在 Tailscale 中的名称。在 [Machines 页面](https://console.tailscale.com/admin/machines) 给电脑改名即可。

**提示 “端口 8787 已被占用”。**控制台已经在另一个窗口中运行。关闭它，或用 `CC_PORT` 换一个端口。

**我的其他设备需要安装 Tailscale 吗？**使用 Funnel 时不需要，任何浏览器都可以。仅限 tailnet 时需要。

**电脑睡眠时还能用吗？**不能。请让电脑保持唤醒、窗口保持打开（方式 A），或者使用服务器（方式 B）。

**设置链接打不开。**它只能用一次、7 天内有效，而且只有最新的链接有效。获取新链接：重新启动控制台（方式 A），或使用 **其他操作 → 获取新的设置链接**（方式 B）。

**所有密钥都丢了。**方式 B：部署程序的 **其他操作 → 创建恢复密钥**，或在服务器上运行 `sudo codex-console setup --new-key "笔记本"`。方式 A：在控制台包的文件夹中打开终端，运行 `node\node.exe app\dist\server\cli\setup.js --new-key "笔记本"`（Windows）或 `./node/node app/dist/server/cli/setup.js --new-key "笔记本"`（macOS、Linux），然后在你常用的地址登录。

**忘记了管理员密码，或者验证器丢了。**同上，改用 `--reset-password` 或 `--reset-totp`。两者都会结束所有登录。

**某把密钥可能泄露了。**在 **管理后台 → 密钥** 中 **吊销** 它（或 **轮换**，不设宽限期），然后查看它的用量和安全日志。

**Codex 提示没有登录，或者达到了用量限制。****管理后台 → Codex → 登录 ChatGPT**。用量限制来自你的 ChatGPT 套餐；控制台会显示它们，但无法解除。

**如何备份？**先停止控制台，再复制方式 A 表格中的数据文件夹（服务器上是 `/var/lib/codex-console`）。其中包含机密，请妥善保管备份。

**公开访问安全吗？**控制台就是为此设计的：256 位密钥且只保存哈希、限流、需要密码和验证器动态码的管理后台、直达你自己电脑或服务器的 HTTPS，以及每个操作的日志。但它仍然相当于那台机器的远程终端，请像保管密码一样保管密钥。更多内容：[SECURITY.zh-CN.md](SECURITY.zh-CN.md)。

## 从源码运行

需要 Node.js 22.13 或更新版本。

```bash
npm ci
npm run build
npm run setup              # 管理员密码 + 验证器 + 你的第一把 API 密钥
npm start                  # http://127.0.0.1:8787
npm run tailscale          # 或：使用 Tailscale 地址（方式 A，从源码运行）
```

打开 `http://127.0.0.1:8787`，粘贴密钥，然后在 **管理后台 → Codex** 中登录 Codex。`npm run setup -- --lang zh-CN` 以中文运行设置。也可以跳过 `npm run setup`：这时 `npm start` 会输出一个一次性的设置链接，在浏览器中完成同样的设置。

从使用设备配对的旧版本升级？配对已经取消；你的所有者账户和 API 密钥都会保留（已有的密钥仍只用于 API）。运行一次 `npm run setup -- --new-key "笔记本"`，即可得到一把能登录控制台的密钥。

Codex 默认在 `~/codex-workspace/` 中工作，每个会话一个文件夹。控制台自己的数据（数据库、密钥材料、媒体）保存在 `~/.codexconsole/`，只有所有者可访问。本仓库中不存放任何机密。

不用 Tailscale 的话，可以使用你自己的 TLS 证书（`CC_HOST=0.0.0.0`、`CC_TLS_CERT`、`CC_TLS_KEY`、`CC_PUBLIC_ORIGIN`）。除 `127.0.0.1` 外，服务器拒绝明文 HTTP。全部设置见 [`.env.example`](.env.example)。systemd 用户服务示例见 [`deploy/codex-console.service`](deploy/codex-console.service)。

## 工作原理

```
你的浏览器 ──HTTPS──▶ Caddy（Let's Encrypt，域名或 IP）──▶ Codex 控制台（127.0.0.1:8787）
                                                            ├─ 登录：API 密钥 → 会话 Cookie；管理后台：再加密码 + 验证器动态码
                                                            ├─ REST API + 服务器推送事件（实时流式输出）
                                                            ├─ SQLite（Node 内置）：会话、对话记录、请求日志、审计日志
                                                            ├─ 文件服务，限制在工作区文件夹内
                                                            └─ 子进程：`codex app-server` ──▶ 你的 ChatGPT 套餐
你的脚本 ──HTTPS──▶ Caddy ──/v1──▶ 公网 API（127.0.0.1:8788，只接受带权限的 API 密钥）
```

控制台通过 `codex app-server` 驱动 Codex。这是 Codex 官方的 JSON-RPC 接口，Codex 的 IDE 扩展和桌面应用用的也是它。

- **会话：**每个会话就是一个 Codex 线程。
- **提示词：**一条提示词开始一轮（`turn/start`），回复逐字流式返回。
- **审批：**审批请求以“允许 / 拒绝”卡片显示。超时未回答的请求会被拒绝。
- **用量限制：**来自 `account/rateLimits/read`。
- **Codex 登录：**Codex 把自己的登录信息保存在它的 `CODEX_HOME` 中。你只需在 **管理后台 → Codex** 中登录一次（设备码）；控制台从不读取或复制这些凭据。

**版本锁定。**Codex CLI 的版本锁定在 `package.json` 中（`@openai/codex` 0.164.0），随项目一起安装。`npm run codex:check` 会检查已安装的 Codex 是否仍支持控制台用到的每个协议方法。

## 密钥详解

你的每台设备都有自己的密钥，因此可以单独查看它的用量、单独吊销。

- **每把密钥的控制台登录：**“完整控制台”（所有会话和整个工作区，永远不包括管理后台）、“仅限文件夹”（它自己的会话和一个文件夹），或“关闭”（只用于 API）。
- **每把密钥的上限：**最高沙箱级别、网络访问、审批（询问你或自动拒绝）、令牌额度、每分钟提示数、同时运行的提示数、上传量、IP 允许列表和有效期。这些上限在控制台和 API 中同样生效。有上限的密钥可以查看所有会话，但只能在自己的会话中工作；`!` shell 命令需要完全访问和网络。拥有完全访问和网络的密钥没有可再限制的内容，用起来和所有者的控制台一样。
- **吊销**会让密钥立即在所有地方退出登录，包括实时流和正在运行的提示。**轮换**会签发新的密钥值，并让旧密钥值退出控制台（可选的宽限期只让它在 API 脚本中继续有效）。修改密钥的控制台登录方式也会让它退出登录。
- **管理后台 → 密钥** 还会列出当前登录的每个浏览器，包括所用的密钥、地址和浏览器信息，你可以让其中任何一个退出登录。
- 一次登录闲置 12 小时后失效，最长 7 天（`CC_SESSION_IDLE_HOURS`、`CC_SESSION_MAX_DAYS`）。

## 使用 Codex

在输入框中输入 `/` 打开命令菜单，或使用会话标题栏的 **⋯** 菜单。

| 命令 | 作用 |
| --- | --- |
| `/model`、`/approvals`、`/sandbox`、`/network` | 会话设置（滑块按钮打开同一个对话框） |
| `/review`、`/compact`、`/diff`、`/status`、`/goal` | 代码审查、压缩上下文、显示改动、会话状态、线程目标 |
| `/fork`、`/undo`、`/new` | 分叉会话、回退上一轮、新建会话。每一轮下方也有 **从这里分叉** 和 **回退** |
| `/init`、`/skills`、`/mention`、`/mcp`、`/help` | 编写 `AGENTS.md`、使用技能、提及文件、列出 MCP 服务器、列出命令 |
| `/plan`、`/permissions`、`/ps`、`/stop`、`/cd`、`/copy`、`/export`、`/feedback` | 计划模式、权限预设、后台终端、工作文件夹、复制最后的回答、导出为 Markdown、向 OpenAI 反馈 |
| `!命令` | 在会话文件夹中运行 shell 命令（总会记录到安全日志） |

输入框旁的按钮用于选择**模型、推理强度、速度以及显示多少思考过程**，选项来自 Codex 为该模型提供的内容；选择会保留在会话中。Codex 工作时，输入框可以把下一条消息**排队**，或**引导**正在进行的这一轮。其他会话中等待你处理的审批和问题会显示在会话列表顶部。

控制台的沙箱、审批和网络默认值在 **管理后台 → 设置** 中，Codex 自身的默认模型和推理强度也在那里（写入它的 `config.toml`）。

## MCP 服务器

**管理后台 → MCP 服务器** 管理 Codex 使用的 MCP 服务器。改动会写入主机上 Codex 的 `config.toml`：

- **本地服务器**在主机上运行一个命令，以控制台的用户身份运行，不受 Codex 沙箱限制。只添加你信任的命令。环境变量值只写不读：控制台不会再显示它们。
- **远程服务器**必须使用 `https://`。对于 OAuth 服务器，**登录** 会显示授权链接。控制台不会替你打开它。

MCP 工具调用会连同参数、进度和结果显示在对话记录中。

## 公网 API

带 API 权限的密钥可以为你自己的脚本调用 `/v1`：部署在服务器上时地址是 `https://<你的地址>/v1`；在自己的电脑上设置 `CC_API_ENABLED=true` 后位于 `127.0.0.1:8788`（从外部访问可用 Tailscale Funnel：[docs/FUNNEL.zh-CN.md](docs/FUNNEL.zh-CN.md)）。接口、权限范围和示例见 [docs/API.zh-CN.md](docs/API.zh-CN.md)。

## 安全概要

- **登录：**API 密钥（`cck_…`，256 位随机数，只保存 HMAC）会创建一个会话，存放在 HttpOnly、Secure、SameSite=Strict 的 Cookie 中。每次请求都会重新检查密钥，因此吊销、过期、取消控制台登录权限或不符合 IP 允许列表，都会立即结束会话。
- **管理后台：**单独保护。在用密钥登录之外，还需要所有者密码（Argon2id）和一次性的 TOTP 动态码，闲置 15 分钟后重新锁定。单凭任何密钥都打不开它。在部署好的服务器上，Codex 以自己的用户运行，接触不到控制台的数据；在你自己的电脑上，拥有完全访问的密钥等同于所有者：见 [SECURITY.zh-CN.md](SECURITY.zh-CN.md#管理后台隔离的局限)。
- **速率限制：**
  - 密钥登录：同一 IP 在 15 分钟内失败 10 次后锁定该地址（只按地址锁定，别人无法从其他地方把你锁在外面）；遭到大量尝试时，一个地址失败一次即被锁定
  - 解锁管理后台：同一 IP 在 15 分钟内最多失败 5 次，全局 20 次
  - 每把密钥的请求数、提示数，以及每小时上传字节数
- **请求检查：**Host 允许列表（防止 DNS 重绑定）、每个修改状态的请求都检查 Origin 并要求自定义请求头（防 CSRF）、严格的内容安全策略及其他安全响应头。
- **文件：**一切都限制在工作区（或密钥的文件夹）内。拒绝路径穿越和指向外部的符号链接。HTML 以纯文本显示，文件带沙箱 CSP 提供。
- **服务器：**只在本机回环地址上运行、由 Caddy 反向代理，使用独立的系统用户，数据文件夹以外全部只读；Codex 在单独的服务中以另一个用户运行，看不到控制台的数据；防火墙只开放 SSH、80 和 443；fail2ban；自动安全更新。
- **审计：**每次 API 调用、提示、文件传输、登录和安全事件都会记录，并注明所用的密钥。保留期限可配置。

完整说明，以及设备或密钥丢失时该怎么做：[SECURITY.zh-CN.md](SECURITY.zh-CN.md)。

## 恢复命令

在部署好的服务器上使用 `sudo codex-console setup …`（不用终端的话，部署程序的**其他操作**可以创建恢复密钥或获取新的设置链接）。使用控制台包时，在包的文件夹中运行 `node/node app/dist/server/cli/setup.js …`（Windows 上是 `node\node.exe app\dist\server\cli\setup.js …`）。从源码运行时使用 `npm run setup -- …`。

| 选项 | 作用 |
| --- | --- |
| `--new-key "笔记本"` | 再签发一把完整控制台密钥（例如所有密钥都丢失时） |
| `--list-keys` | 列出密钥及其状态和最近使用时间 |
| `--revoke-key ID` | 吊销密钥，并在所有地方退出登录 |
| `--sign-out-all` | 结束所有控制台登录 |
| `--reset-password` | 设置新的管理员密码；结束所有登录 |
| `--reset-totp` | 绑定新的验证器；结束所有登录 |
| `--setup-link` | 输出一个新的一次性设置链接（只在设置完成之前有效） |

## 开发

```bash
npm run dev -- --fake-codex   # 界面 + 服务器，使用模拟的 Codex：无需登录，不调用 OpenAI
npm run dev                   # 同上，使用你真实的 Codex
npm test                      # 单元测试 + 集成测试（使用模拟的 Codex）
npm run typecheck
cd deployer && npm test       # 部署程序的测试（针对模拟的 SSH 服务器）
```

`test/fake-codex/` 中的模拟 app-server 实现了与 Codex 0.164.0 相同的协议结构。提示词中的关键字会触发对应功能：`approve`、`permission`、`question`、`elicit`、`mcp`、`image`、`video`、`edit`、`slow`、`steady`、`fail`、`fail limit`。

| 路径 | 内容 |
| --- | --- |
| `server/` | Fastify API、认证、Codex 桥接（`server/codex/`）、命令行工具（`server/cli/`） |
| `web/` | React 界面（Vite） |
| `shared/` | 类型、协议子集（`shared/codex.ts`）以及 EN / 中文词典（`shared/i18n/`） |
| `deploy/` | `deploy.sh`（在你的电脑上运行）、`install.sh`（在服务器上运行）、示例 |
| `deployer/` | 部署程序：在你电脑上打开一个页面，通过 SSH 完成部署。`npm run package` 生成可执行文件 |
| `scripts/` | `dev.mjs`（开发用）、`portable.mjs`（控制台包：`npm run package:portable`）、`node-dist.mjs`（两种下载都使用的、固定版本的 Node.js） |
| `.github/` | `release.yml`：推送 `v*` 标签时，把 Windows、macOS 和 Linux 的所有下载文件生成到一个草稿版本上 |
| `test/` | Vitest 测试和模拟的 Codex |

新增界面文字时，需要同时在 `shared/i18n/en.ts` 和 `shared/i18n/zh-CN.ts` 中添加键，否则 TypeScript 和 i18n 测试会失败。

## 说明

- **仅限个人使用。**每一份都只属于一位所有者及其自己的设备。不要用它和别人共享你的 ChatGPT 套餐：这违反 OpenAI 的条款。
- 管理后台中显示的**用量限制**是 Codex 为你的套餐报告的数据。控制台不会绕过它们。
- **升级 Codex：**修改 `package.json` 中的 `@openai/codex`，运行 `npm install`，再运行 `npm run codex:check`；在服务器上则重新部署。
- **有意不包含：**语音 / 实时对话、Windows 沙箱设置、Codex 云端和远程控制功能（见 [docs/FEATURES.zh-CN.md](docs/FEATURES.zh-CN.md)）。

## 参与贡献

欢迎提交 issue 和 pull request。提交改动前请运行 `npm test` 和 `npm run typecheck`（部署程序还要运行 `cd deployer && npm test`），界面上显示的任何文字都要同时提供英文和中文。

## 报告安全问题

请不要用公开的 issue 报告漏洞：请使用本仓库在 GitHub 上的私密漏洞报告（**Security → Report a vulnerability**）。控制台保护什么、如何保护：见 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。

## 许可证

[MIT](LICENSE)。控制台安装的 Codex 本身（`@openai/codex` 软件包）属于 OpenAI，使用它自己的 Apache-2.0 许可证。
