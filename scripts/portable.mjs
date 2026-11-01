// Builds the Windows package: Node.js, the console with its Windows dependencies and a launcher, zipped.
// On a Windows PC with Tailscale: unzip, then double-click "Start Codex Console.cmd".
//
//   npm run package:windows
//   npm run package:windows -- --tailscale-name my-pc.tail1234.ts.net   (the address you expect; warns if it differs)
//   npm run package:windows -- --no-build                                (dist/ is already built)
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipToFile } from './zip.mjs';

const NODE_VERSION = '24.22.1';
// Pinned from https://nodejs.org/dist/v24.22.1/SHASUMS256.txt, as in deployer/scripts/package.mjs.
const NODE_EXE_SHA256 = 'd702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5';
const CODEX_EXE = 'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe';
const ARGON2_PKG = 'node_modules/@node-rs/argon2-win32-x64-msvc';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(root, 'release');
const stage = path.join(release, '.work', 'windows-x64');
const top = 'Codex Console';
const pkg = path.join(stage, top);
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

/** The official node.exe, checked against the pinned checksum (shared with the deploy program's cache). */
async function nodeExe() {
  const candidates = [path.join(root, '.cache', 'node', `node-v${NODE_VERSION}-win-x64.exe`), path.join(root, 'deployer', '.cache', 'node', `node-v${NODE_VERSION}-win-x64.exe`)];
  for (const c of candidates) {
    if (fs.existsSync(c) && sha256(fs.readFileSync(c)) === NODE_EXE_SHA256) return fs.readFileSync(c);
  }
  console.log(`Downloading Node.js ${NODE_VERSION} for Windows…`);
  const res = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/win-x64/node.exe`);
  if (!res.ok) fail(`Download of node.exe failed: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (sha256(data) !== NODE_EXE_SHA256) fail('Checksum mismatch for node.exe: not the official Node.js file');
  fs.mkdirSync(path.dirname(candidates[0]), { recursive: true });
  fs.writeFileSync(candidates[0], data);
  return data;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyDir(path.join(from, e.name), path.join(to, e.name));
    else if (e.isFile()) fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
  }
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full, base));
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

function launcher(extraArgs, comment) {
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

const README = `Codex Console for Windows
=========================

Runs Codex Console on this PC and gives it a fixed public https address through Tailscale Funnel,
so any browser can open it. Your API keys, rate limits and the admin password protect it.

Before the first start
  1. Install Tailscale (https://tailscale.com/download) and sign in.
  2. In the Tailscale admin console (https://console.tailscale.com/admin/dns): MagicDNS on,
     and under "HTTPS Certificates" choose "Enable HTTPS".

Start
  Double-click "Start Codex Console.cmd". If Windows says it protected your PC, choose
  "More info" > "Run anyway". The first time, Tailscale may show a link to allow Funnel:
  open it and confirm. The window then shows the address${tailscaleName ? ` (https://${tailscaleName})` : ''}
  and opens the setup page: choose an admin password, scan the QR code with your
  authenticator app and save your first key. Then: Admin > Codex > sign in with ChatGPT.

Use it
  On any computer or phone, open the address and sign in with an API key.
  More keys: Admin > Keys > New key. Revoke a key there at any time.
  Keep the window open while you use it; close it to stop.

"Start Codex Console (tailnet only).cmd" keeps the address private to your Tailscale devices.
Your data stays in %USERPROFILE%\\.codexconsole, Codex's files in %USERPROFILE%\\codex-workspace.


Codex 控制台 Windows 版
=======================

在这台电脑上运行 Codex 控制台，并通过 Tailscale Funnel 提供一个固定的公网 https 地址，
任何浏览器都能打开。由你的 API 密钥、限流和管理员密码保护。

第一次启动之前
  1. 安装 Tailscale（https://tailscale.com/download）并登录。
  2. 在 Tailscale 管理后台（https://console.tailscale.com/admin/dns）：开启 MagicDNS，
     并在 “HTTPS Certificates” 中选择 “Enable HTTPS”。

启动
  双击 “Start Codex Console.cmd”。如果 Windows 提示已保护你的电脑，请选择
  “更多信息” > “仍要运行”。第一次运行时，Tailscale 可能会给出一个允许 Funnel 的链接：
  打开并确认即可。随后窗口会显示访问地址${tailscaleName ? `（https://${tailscaleName}）` : ''}，
  并打开设置页面：设置管理员密码，用验证器应用扫描二维码，保存你的第一把密钥。
  然后：管理后台 > Codex > 用 ChatGPT 登录。

使用
  在任何电脑或手机上打开这个地址，用 API 密钥登录。
  更多密钥：管理后台 > 密钥 > 新建密钥，也可以在那里随时吊销密钥。
  使用期间请保持窗口打开；关闭窗口即可停止。

“Start Codex Console (tailnet only).cmd” 会让地址只对你自己的 Tailscale 设备开放。
数据保存在 %USERPROFILE%\\.codexconsole，Codex 的文件在 %USERPROFILE%\\codex-workspace。
`;

if (!args.includes('--no-build')) execFileSync(npm, ['run', 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
if (!fs.existsSync(path.join(root, 'dist', 'server', 'cli', 'tailscale.js')) || !fs.existsSync(path.join(root, 'dist', 'web', 'index.html'))) fail('Build the console first: npm run build');

fs.rmSync(stage, { recursive: true, force: true });
const app = path.join(pkg, 'app');
fs.mkdirSync(app, { recursive: true });
for (const f of ['package.json', 'package-lock.json', '.npmrc']) fs.copyFileSync(path.join(root, f), path.join(app, f));
copyDir(path.join(root, 'dist'), path.join(app, 'dist'));

console.log('Installing the console\'s Windows dependencies…');
execFileSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--os=win32', '--cpu=x64', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: app, stdio: 'inherit', shell: process.platform === 'win32' });
for (const required of [CODEX_EXE, ARGON2_PKG]) {
  if (!fs.existsSync(path.join(app, required))) fail(`Missing ${required}: the Windows dependencies did not install`);
}
fs.rmSync(path.join(app, 'package-lock.json'));

fs.mkdirSync(path.join(pkg, 'node'), { recursive: true });
fs.writeFileSync(path.join(pkg, 'node', 'node.exe'), await nodeExe());
fs.writeFileSync(path.join(pkg, 'Start Codex Console.cmd'), launcher('', 'Starts Codex Console on this PC with a public address from Tailscale Funnel.'));
fs.writeFileSync(path.join(pkg, 'Start Codex Console (tailnet only).cmd'), launcher(' --tailnet-only', 'Starts Codex Console on this PC, reachable only from your own Tailscale devices.'));
fs.writeFileSync(path.join(pkg, 'README.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(crlf(README), 'utf8')]));

const files = listFiles(stage);
const longest = files.reduce((a, b) => (b.length > a.length ? b : a), '');
if (longest.length > 180) console.warn(`Warning: a path inside is ${longest.length} characters long: ${longest}`);
fs.mkdirSync(release, { recursive: true });
const out = path.join(release, 'codex-console-windows-x64.zip');
console.log(`Zipping ${files.length} files…`);
zipToFile(
  out,
  files.map((name) => ({ name, data: fs.readFileSync(path.join(stage, name)) })),
);
const zipped = fs.readFileSync(out);
fs.writeFileSync(path.join(release, 'SHA256SUMS.txt'), `${sha256(zipped)}  codex-console-windows-x64.zip\n`);
console.log(`Packaged release/codex-console-windows-x64.zip (${Math.round(zipped.length / 1048576)} MB, ${files.length} files)`);
console.log(`SHA256 ${sha256(zipped)}`);
