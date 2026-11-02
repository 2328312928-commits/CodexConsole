**Which file do I need? / 下载哪个文件？**

| | Console package: run Codex Console on this computer with a Tailscale address<br>控制台包：在这台电脑上运行，使用 Tailscale 地址 | Deploy program: install it on your own Linux server<br>部署程序：装到你自己的 Linux 服务器上 |
| --- | --- | --- |
| Windows (x64) | `codex-console-windows-x64.zip` | `codex-console-deploy-windows-x64.exe` |
| Mac with Apple silicon (M1 or newer) / Apple 芯片的 Mac | `codex-console-macos-arm64.zip` | `codex-console-deploy-macos-arm64.zip` |
| Mac with Intel / Intel 处理器的 Mac | `codex-console-macos-x64.zip` | `codex-console-deploy-macos-x64.zip` |
| Linux x64 | `codex-console-linux-x64.tar.gz` | `codex-console-deploy-linux-x64.tar.gz` |
| Linux ARM64 | `codex-console-linux-arm64.tar.gz` | `codex-console-deploy-linux-arm64.tar.gz` |

How to install, start and sign in on each system, set up Tailscale and Funnel, and create or revoke API keys: see `README.md` (English) or `README.zh-CN.md` (中文) in the repository. `SHA256SUMS.txt` lists every file's checksum.

每个系统如何安装、启动和登录，如何设置 Tailscale 和 Funnel，如何创建或吊销 API 密钥：请看仓库中的 `README.zh-CN.md`（中文）或 `README.md`（English）。`SHA256SUMS.txt` 列出了每个文件的校验和。

The programs are not signed with paid certificates, so the first start needs one extra click: on Windows "More info → Run anyway", on macOS System Settings → Privacy & Security → "Open Anyway".
程序没有使用付费证书签名，第一次启动需要多点一下：Windows 选择 “更多信息 → 仍要运行”；macOS 打开 系统设置 → 隐私与安全性 → “仍要打开”。
