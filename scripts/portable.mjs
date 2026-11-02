// Builds the console packages: Node.js, the console with that platform's dependencies, and launchers.
// On a computer with Tailscale, unpack one and start it: "Start Codex Console" (Windows, macOS) or
// ./start.sh (Linux). Files land in release/, with SHA256SUMS.txt.
//
//   npm run package:portable                              every platform
//   npm run package:windows                               Windows only
//   node scripts/portable.mjs linux-x64 darwin-arm64      these platforms
//   ... --tailscale-name my-pc.tail1234.ts.net            the address you expect, for your own copy only (never for a public release)
//   ... --no-build                                        dist/ is already built
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tarGzToFile, zipToFile } from './archive.mjs';
import { nodeBinary, nodeLicense } from './node-dist.mjs';

const TARGETS = {
  'win-x64': { os: 'win32', cpu: 'x64', label: 'windows-x64', name: 'Windows', triple: 'x86_64-pc-windows-msvc', argon2: 'win32-x64-msvc' },
  'darwin-arm64': { os: 'darwin', cpu: 'arm64', label: 'macos-arm64', name: 'macOS (Apple silicon)', triple: 'aarch64-apple-darwin', argon2: 'darwin-arm64' },
  'darwin-x64': { os: 'darwin', cpu: 'x64', label: 'macos-x64', name: 'macOS (Intel)', triple: 'x86_64-apple-darwin', argon2: 'darwin-x64' },
  'linux-x64': { os: 'linux', cpu: 'x64', label: 'linux-x64', name: 'Linux (x64)', triple: 'x86_64-unknown-linux-musl', argon2: 'linux-x64-gnu' },
  'linux-arm64': { os: 'linux', cpu: 'arm64', label: 'linux-arm64', name: 'Linux (ARM64)', triple: 'aarch64-unknown-linux-musl', argon2: 'linux-arm64-gnu' },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(root, 'release');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const crlf = (text) => text.replace(/\r?\n/g, '\r\n');

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const nameAt = args.indexOf('--tailscale-name');
const tailscaleName = nameAt >= 0 ? (args[nameAt + 1] ?? '').toLowerCase() : '';
if (nameAt >= 0 && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(tailscaleName)) fail('--tailscale-name needs a name like my-pc.tail1234.ts.net');
const positional = args.filter((a, i) => !a.startsWith('--') && i !== nameAt + 1);
for (const a of positional) if (!TARGETS[a]) fail(`Unknown platform: ${a}. Choose from: ${Object.keys(TARGETS).join(', ')}`);
const targets = positional.length ? positional : Object.keys(TARGETS);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(from, e.name), path.join(to, e.name));
    else if (e.isFile()) fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
  }
}

/** Every regular file under `dir`, with its mode (links such as node_modules/.bin are left out). */
function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else if (e.isFile()) out.push({ name: path.relative(base, full).split(path.sep).join('/'), path: full, mode: fs.statSync(full).mode & 0o777 });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

// ---- launchers ------------------------------------------------------------------------

function windowsLauncher(extraArgs, comment) {
  return crlf(
    [
      '@echo off',
      `rem ${comment}`,
      'title Codex Console',
      'cd /d "%~dp0"',
      ...(tailscaleName ? [`set "CC_TAILSCALE_NAME=${tailscaleName}"`] : []),
      `"%~dp0node\\node.exe" "%~dp0app\\dist\\server\\cli\\tailscale.js"${extraArgs} %*`,
      'if errorlevel 1 pause',
      '',
    ].join('\n'),
  );
}

function macLauncher(extraArgs, comment) {
  return [
    '#!/bin/sh',
    `# ${comment}`,
    'cd "$(dirname "$0")" || exit 1',
    '# Unzipping a download marks every file as coming from the internet. Clear that for this folder only',
    '# (you opened this launcher yourself), so macOS does not stop Codex and its helpers one by one.',
    'xattr -dr com.apple.quarantine . 2>/dev/null',
    ...(tailscaleName ? [`export CC_TAILSCALE_NAME="${tailscaleName}"`] : []),
    `./node/node app/dist/server/cli/tailscale.js${extraArgs} "$@"`,
    'status=$?',
    `if [ "$status" -ne 0 ]; then printf '\\nPress Enter to close. / 按回车键关闭。\\n'; read -r _; fi`,
    'exit "$status"',
    '',
  ].join('\n');
}

function linuxLauncher() {
  return [
    '#!/bin/sh',
    '# Starts Codex Console on this computer with a public address from Tailscale Funnel.',
    '# ./start.sh --tailnet-only keeps it to your own Tailscale devices.',
    'cd "$(dirname "$0")" || exit 1',
    ...(tailscaleName ? [`export CC_TAILSCALE_NAME="${tailscaleName}"`] : []),
    'exec ./node/node app/dist/server/cli/tailscale.js "$@"',
    '',
  ].join('\n');
}

// ---- the README inside each package -------------------------------------------------------

function readme(t) {
  const addr = tailscaleName ? ` (https://${tailscaleName})` : '';
  const addrZh = tailscaleName ? `（https://${tailscaleName}）` : '';
  const before = {
    win32: [
      '  1. Install Tailscale (https://tailscale.com/download) and sign in.',
      '  2. In the Tailscale admin console (https://console.tailscale.com/admin/dns): MagicDNS on,',
      '     and under "HTTPS Certificates" choose "Enable HTTPS".',
    ],
    darwin: [
      '  1. Install Tailscale (https://tailscale.com/download or the Mac App Store) and sign in.',
      '  2. In the Tailscale admin console (https://console.tailscale.com/admin/dns): MagicDNS on,',
      '     and under "HTTPS Certificates" choose "Enable HTTPS".',
    ],
    linux: [
      '  1. Install Tailscale (https://tailscale.com/download/linux) and sign in: sudo tailscale up',
      '  2. Let your user manage Tailscale Serve and Funnel (once): sudo tailscale set --operator=$USER',
      '  3. In the Tailscale admin console (https://console.tailscale.com/admin/dns): MagicDNS on,',
      '     and under "HTTPS Certificates" choose "Enable HTTPS".',
    ],
  }[t.os];
  const beforeZh = {
    win32: [
      '  1. 安装 Tailscale（https://tailscale.com/download）并登录。',
      '  2. 在 Tailscale 管理后台（https://console.tailscale.com/admin/dns）：开启 MagicDNS，',
      '     并在 “HTTPS Certificates” 中选择 “Enable HTTPS”。',
    ],
    darwin: [
      '  1. 安装 Tailscale（https://tailscale.com/download 或 Mac App Store）并登录。',
      '  2. 在 Tailscale 管理后台（https://console.tailscale.com/admin/dns）：开启 MagicDNS，',
      '     并在 “HTTPS Certificates” 中选择 “Enable HTTPS”。',
    ],
    linux: [
      '  1. 安装 Tailscale（https://tailscale.com/download/linux）并登录：sudo tailscale up',
      '  2. 允许你的用户管理 Tailscale Serve 和 Funnel（只需一次）：sudo tailscale set --operator=$USER',
      '  3. 在 Tailscale 管理后台（https://console.tailscale.com/admin/dns）：开启 MagicDNS，',
      '     并在 “HTTPS Certificates” 中选择 “Enable HTTPS”。',
    ],
  }[t.os];
  const start = {
    win32: [
      '  Double-click "Start Codex Console.cmd". If Windows says it protected your PC, choose',
      '  "More info" > "Run anyway".',
    ],
    darwin: [
      '  Double-click "Start Codex Console.command"; it runs in a Terminal window. The first time, macOS',
      '  may say it cannot check the file: open System Settings > Privacy & Security, choose "Open Anyway"',
      '  and confirm (on macOS 14 and earlier: Control-click the file > Open > Open). The launcher clears',
      '  the download quarantine on this folder only, so Codex and its helpers are not blocked one by one.',
    ],
    linux: ['  ./start.sh                  public through Funnel', '  ./start.sh --tailnet-only   only your own Tailscale devices'],
  }[t.os];
  const startZh = {
    win32: ['  双击 “Start Codex Console.cmd”。如果 Windows 提示已保护你的电脑，请选择', '  “更多信息” > “仍要运行”。'],
    darwin: [
      '  双击 “Start Codex Console.command”，它会在终端窗口中运行。第一次运行时 macOS 可能提示无法检查',
      '  该文件：请打开 系统设置 > 隐私与安全性，选择 “仍要打开” 并确认（macOS 14 及更早版本：按住 Control',
      '  点击该文件 > 打开 > 打开）。启动文件只会清除这个文件夹的下载隔离标记，避免 Codex 及其辅助程序被逐个拦截。',
    ],
    linux: ['  ./start.sh                  通过 Funnel 公开', '  ./start.sh --tailnet-only   只对你自己的 Tailscale 设备开放'],
  }[t.os];
  const privateLine = {
    win32: ['"Start Codex Console (tailnet only).cmd" keeps the address private to your Tailscale devices.', '“Start Codex Console (tailnet only).cmd” 会让地址只对你自己的 Tailscale 设备开放。'],
    darwin: ['"Start Codex Console (tailnet only).command" keeps the address private to your Tailscale devices.', '“Start Codex Console (tailnet only).command” 会让地址只对你自己的 Tailscale 设备开放。'],
    linux: ['To keep it running after you log out, start it in tmux or screen, or as a systemd user service.', '要在退出登录后继续运行，请在 tmux 或 screen 中启动它，或把它设为 systemd 用户服务。'],
  }[t.os];
  const data = t.os === 'win32' ? ['%USERPROFILE%\\.codexconsole', '%USERPROFILE%\\codex-workspace'] : ['~/.codexconsole', '~/codex-workspace'];
  const nodeLicensePath = t.os === 'win32' ? 'node\\LICENSE.txt' : 'node/LICENSE.txt';
  const title = `Codex Console for ${t.name}`;
  const titleZh = `Codex 控制台 ${t.name.replace('Apple silicon', 'Apple 芯片')} 版`;
  const text = [
    title,
    '='.repeat(title.length),
    '',
    'Runs Codex Console on this computer and gives it a fixed public https address through',
    'Tailscale Funnel, so any browser can open it. Your API keys, rate limits and the admin',
    'password protect it.',
    '',
    'Before the first start',
    ...before,
    '',
    'Start',
    ...start,
    '  The first time, Tailscale may show a link to allow Funnel: open it and confirm. The window',
    `  then shows the address${addr} and opens the setup page: choose an admin`,
    '  password, scan the QR code with your authenticator app and save your first key.',
    '  Then: Admin > Codex > sign in with ChatGPT.',
    '',
    'Use it',
    '  On any computer or phone, open the address and sign in with an API key.',
    '  More keys: Admin > Keys > New key. Revoke a key there at any time.',
    '  Keep the window open while you use it; close it (or press Ctrl+C) to stop.',
    '',
    privateLine[0],
    `Your data stays in ${data[0]}, Codex's files in ${data[1]}.`,
    `Licenses: Codex Console is MIT (LICENSE.txt), Node.js has ${nodeLicensePath}, and Codex`,
    "(app/node_modules/@openai) is OpenAI's, under Apache-2.0.",
    '',
    '',
    titleZh,
    '='.repeat(titleZh.length + 8),
    '',
    '在这台电脑上运行 Codex 控制台，并通过 Tailscale Funnel 提供一个固定的公网 https 地址，',
    '任何浏览器都能打开。由你的 API 密钥、限流和管理员密码保护。',
    '',
    '第一次启动之前',
    ...beforeZh,
    '',
    '启动',
    ...startZh,
    '  第一次运行时，Tailscale 可能会给出一个允许 Funnel 的链接：打开并确认即可。随后窗口会',
    `  显示访问地址${addrZh}，并打开设置页面：设置管理员密码，用验证器应用`,
    '  扫描二维码，保存你的第一把密钥。然后：管理后台 > Codex > 用 ChatGPT 登录。',
    '',
    '使用',
    '  在任何电脑或手机上打开这个地址，用 API 密钥登录。',
    '  更多密钥：管理后台 > 密钥 > 新建密钥，也可以在那里随时吊销密钥。',
    '  使用期间请保持窗口打开；关闭窗口（或按 Ctrl+C）即可停止。',
    '',
    privateLine[1],
    `数据保存在 ${data[0]}，Codex 的文件在 ${data[1]}。`,
    `许可证：Codex 控制台使用 MIT 许可证（LICENSE.txt），Node.js 的许可证见 ${nodeLicensePath}，`,
    'Codex（app/node_modules/@openai）属于 OpenAI，使用 Apache-2.0 许可证。',
    '',
  ].join('\n');
  // Windows Notepad reads UTF-8 best with a byte-order mark and CRLF line ends.
  return t.os === 'win32' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(crlf(text), 'utf8')]) : Buffer.from(text, 'utf8');
}

// ---- one package --------------------------------------------------------------------------

async function build(target) {
  const t = TARGETS[target];
  const top = t.os === 'linux' ? 'codex-console' : 'Codex Console';
  const stage = path.join(release, '.work', target);
  const pkg = path.join(stage, top);
  const app = path.join(pkg, 'app');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(app, { recursive: true });
  for (const f of ['package.json', 'package-lock.json', '.npmrc']) fs.copyFileSync(path.join(root, f), path.join(app, f));
  copyDir(path.join(root, 'dist'), path.join(app, 'dist'));

  console.log(`${t.name}: installing the console's dependencies…`);
  const platformFlags = [`--os=${t.os}`, `--cpu=${t.cpu}`, ...(t.os === 'linux' ? ['--libc=glibc'] : [])];
  execFileSync(npm, ['ci', '--omit=dev', '--ignore-scripts', ...platformFlags, '--no-audit', '--no-fund', '--loglevel=error'], { cwd: app, stdio: 'inherit', shell: process.platform === 'win32' });
  const codex = `node_modules/@openai/codex-${t.os}-${t.cpu}/vendor/${t.triple}/bin/codex${t.os === 'win32' ? '.exe' : ''}`;
  for (const required of [codex, `node_modules/@node-rs/argon2-${t.argon2}`]) {
    if (!fs.existsSync(path.join(app, required))) fail(`${t.name}: missing ${required}`);
  }
  fs.rmSync(path.join(app, 'package-lock.json'));

  fs.mkdirSync(path.join(pkg, 'node'));
  fs.writeFileSync(path.join(pkg, 'node', t.os === 'win32' ? 'node.exe' : 'node'), await nodeBinary(target), { mode: 0o755 });
  const licenseText = (await nodeLicense()).toString('utf8');
  const projectLicense = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
  fs.writeFileSync(path.join(pkg, 'node', 'LICENSE.txt'), t.os === 'win32' ? crlf(licenseText) : licenseText);
  fs.writeFileSync(path.join(pkg, 'LICENSE.txt'), t.os === 'win32' ? crlf(projectLicense) : projectLicense);
  fs.writeFileSync(path.join(pkg, 'README.txt'), readme(t));
  const publicComment = 'Starts Codex Console on this computer with a public address from Tailscale Funnel.';
  const privateComment = 'Starts Codex Console on this computer, reachable only from your own Tailscale devices.';
  if (t.os === 'win32') {
    fs.writeFileSync(path.join(pkg, 'Start Codex Console.cmd'), windowsLauncher('', publicComment));
    fs.writeFileSync(path.join(pkg, 'Start Codex Console (tailnet only).cmd'), windowsLauncher(' --tailnet-only', privateComment));
  } else if (t.os === 'darwin') {
    fs.writeFileSync(path.join(pkg, 'Start Codex Console.command'), macLauncher('', publicComment), { mode: 0o755 });
    fs.writeFileSync(path.join(pkg, 'Start Codex Console (tailnet only).command'), macLauncher(' --tailnet-only', privateComment), { mode: 0o755 });
  } else {
    fs.writeFileSync(path.join(pkg, 'start.sh'), linuxLauncher(), { mode: 0o755 });
  }

  const files = listFiles(stage);
  const longest = files.reduce((a, b) => (b.name.length > a.length ? b.name : a), '');
  if (longest.length > 180) console.warn(`Warning: a path inside is ${longest.length} characters long: ${longest}`);
  const out = path.join(release, `codex-console-${t.label}.${t.os === 'linux' ? 'tar.gz' : 'zip'}`);
  console.log(`${t.name}: packing ${files.length} files…`);
  if (t.os === 'linux') await tarGzToFile(out, files);
  else zipToFile(out, files, { unix: t.os === 'darwin' });
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(`Packaged ${path.relative(root, out)} (${Math.round(fs.statSync(out).size / 1048576)} MB)`);
}

if (!args.includes('--no-build')) execFileSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
if (!fs.existsSync(path.join(root, 'dist', 'server', 'cli', 'tailscale.js')) || !fs.existsSync(path.join(root, 'dist', 'web', 'index.html'))) fail('Build the console first: npm run build');
fs.mkdirSync(release, { recursive: true });
for (const target of targets) await build(target);
fs.rmSync(path.join(release, '.work'), { recursive: true, force: true });

// Checksums for every console package here, so a download can be checked.
const packages = fs.readdirSync(release).filter((f) => /^codex-console-.+\.(zip|tar\.gz)$/.test(f)).sort();
fs.writeFileSync(path.join(release, 'SHA256SUMS.txt'), packages.map((f) => `${sha256(fs.readFileSync(path.join(release, f)))}  ${f}\n`).join(''));
console.log('Wrote release/SHA256SUMS.txt');
