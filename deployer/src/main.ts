import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getAsset, isSea } from 'node:sea';
import installer from '../../deploy/install.sh';
import page from './page.html';
import { startServer, type RunningServer } from './server.js';
import { Store } from './store.js';

const USAGE = `Codex Console Deploy ${__DEPLOYER_VERSION__}
Opens a page in your browser that deploys Codex Console to your own server.

  --no-open    print the link instead of opening the browser
  --port N     use this local port (default: any free one)
  --version    print the version
`;

/** The console itself: inside the program when packaged, next to the script otherwise. */
function consoleBundle(): Buffer {
  if (isSea()) return Buffer.from(getAsset('console.tgz'));
  return readFileSync(path.join(__dirname, 'console.tgz'));
}

function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined); // the link is printed anyway
    child.unref();
  } catch {
    // the link is printed anyway
  }
}

/** Keep a double-clicked console window open long enough to read why it stopped. */
function waitForEnter(): Promise<void> {
  if (!process.stdin.isTTY) return Promise.resolve();
  process.stdout.write('\nPress Enter to close. / 按回车键关闭。\n');
  return new Promise((done) => process.stdin.once('data', () => done()));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) return void process.stdout.write(USAGE);
  if (argv.includes('--version')) return void process.stdout.write(`${__DEPLOYER_VERSION__}\n`);
  const portAt = argv.indexOf('--port');
  const port = portAt >= 0 ? Number(argv[portAt + 1]) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`Not a port number: ${argv[portAt + 1]}`);

  let running: RunningServer | null = null;
  const quit = () => {
    process.stdout.write('\nStopped. / 已停止。\n');
    void (running?.close() ?? Promise.resolve()).finally(() => process.exit(0));
  };
  running = await startServer({
    store: new Store(),
    page,
    installer,
    bundle: consoleBundle(),
    info: { version: __DEPLOYER_VERSION__, consoleVersion: __CONSOLE_VERSION__, consoleCommit: __CONSOLE_COMMIT__ },
    port,
    onQuit: quit,
  });
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);

  process.stdout.write(
    [
      `Codex Console Deploy ${__DEPLOYER_VERSION__}`,
      '',
      'Your browser opens by itself. If it does not, open this link:',
      '浏览器会自动打开。如果没有打开，请打开这个链接：',
      '',
      `  ${running.url}`,
      '',
      'Keep this window open while you deploy; close it to quit.',
      '部署时请保持此窗口打开；关闭它即可退出。',
      '',
    ].join('\n'),
  );
  if (!argv.includes('--no-open')) openBrowser(running.url);
}

main().catch(async (err: unknown) => {
  process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
  await waitForEnter();
  process.exit(1);
});
