// Builds the deploy program: dist/deploy.cjs (one file, with ssh2, the page and install.sh inside)
// and dist/console.tgz (the console's files, exactly what deploy/deploy.sh would upload).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { tar } from './tar.mjs';

const deployer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(deployer, '..');
const dist = path.join(deployer, 'dist');

const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** What git tracks plus new files, minus everything .gitignore excludes (.env, data, keys), minus this program. */
function consoleFiles() {
  return git('ls-files', '-z', '-co', '--exclude-standard')
    .split('\0')
    .filter((f) => f && !/^(deployer|\.github)\//.test(f))
    .filter((f) => {
      try {
        return fs.lstatSync(path.join(repo, f)).isFile();
      } catch {
        return false; // deleted but still tracked
      }
    })
    .sort();
}

function consoleBundle() {
  const files = consoleFiles();
  for (const required of ['package.json', 'package-lock.json', 'deploy/install.sh']) {
    if (!files.includes(required)) throw new Error(`${required} is missing from the console's files`);
  }
  const mtime = Number(git('log', '-1', '--format=%ct').trim()) || Math.floor(Date.now() / 1000);
  const entries = files.map((name) => {
    const full = path.join(repo, name);
    return { name, data: fs.readFileSync(full), mode: fs.statSync(full).mode & 0o111 ? 0o755 : 0o644 };
  });
  return { archive: gzipSync(tar(entries, mtime), { level: 9 }), count: files.length };
}

function consoleCommit() {
  const head = git('rev-parse', '--short', 'HEAD').trim();
  // "+" when the console's files have changes that are not committed yet.
  const dirty = git('status', '--porcelain', '--', '.', ':(exclude)deployer', ':(exclude).github').trim() !== '';
  return dirty ? `${head}+` : head;
}

fs.mkdirSync(dist, { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(deployer, 'package.json'), 'utf8'));
const consolePkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));

await build({
  entryPoints: [path.join(deployer, 'src/main.ts')],
  outfile: path.join(dist, 'deploy.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  loader: { '.html': 'text', '.sh': 'text' },
  // ssh2's optional native helpers: it falls back to plain JavaScript without them.
  external: ['*.node', 'cpu-features'],
  define: {
    __DEPLOYER_VERSION__: JSON.stringify(pkg.version),
    __CONSOLE_VERSION__: JSON.stringify(consolePkg.version),
    __CONSOLE_COMMIT__: JSON.stringify(consoleCommit()),
  },
  legalComments: 'none',
  logLevel: 'warning',
});

const { archive, count } = consoleBundle();
fs.writeFileSync(path.join(dist, 'console.tgz'), archive);
console.log(`dist/deploy.cjs and dist/console.tgz (${count} files, ${Math.round(archive.length / 1024)} KB)`);
