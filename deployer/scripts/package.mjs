// Packages the deploy program as one executable file per platform, with Node.js single executable
// applications (https://nodejs.org/api/single-executable-applications.html). Files land in release/.
//
//   npm run package                          this computer's platform
//   npm run package -- linux-x64 win-x64     these platforms
//   npm run package -- --all                 every platform this computer can build
//
// macOS refuses unsigned programs, so the macOS files are built on a Mac (ad-hoc codesign).
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { inject } from 'postject';
import { nodeBinary } from '../../scripts/node-dist.mjs';
import { tar } from './tar.mjs';

// The official Node.js builds come from scripts/node-dist.mjs, pinned to their checksums.
const TARGETS = {
  'linux-x64': { label: 'linux-x64' },
  'linux-arm64': { label: 'linux-arm64' },
  'darwin-x64': { label: 'macos-x64' },
  'darwin-arm64': { label: 'macos-arm64' },
  'win-x64': { label: 'windows-x64' },
};
const SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const here = path.dirname(fileURLToPath(import.meta.url));
const deployer = path.resolve(here, '..');
const dist = path.join(deployer, 'dist');
const release = path.join(deployer, 'release');
const work = path.join(release, '.work');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const host = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const canBuild = (target) => !target.startsWith('darwin') || process.platform === 'darwin';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Drop a PE file's Authenticode signature: injecting would break it, and a broken one looks worse than none. */
function stripAuthenticode(buf) {
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('node.exe is not a PE file');
  const optional = pe + 24;
  const dirs = optional + (buf.readUInt16LE(optional) === 0x20b ? 112 : 96);
  const security = dirs + 4 * 8;
  const offset = buf.readUInt32LE(security);
  const size = buf.readUInt32LE(security + 4);
  if (!offset || !size) return buf;
  buf.writeUInt32LE(0, security);
  buf.writeUInt32LE(0, security + 4);
  // The certificate table is the last thing in the file.
  return offset + size >= buf.length - 8 ? buf.subarray(0, offset) : buf;
}

/** The program and the console's files as one blob, made by the same Node.js version the executables use. */
async function seaBlob() {
  if (!TARGETS[host]) fail(`This computer (${host}) cannot build the program: use Linux, macOS or Windows on x64 or arm64.`);
  fs.mkdirSync(work, { recursive: true });
  const node = path.join(work, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.writeFileSync(node, await nodeBinary(host), { mode: 0o755 });
  const config = {
    main: path.join(dist, 'deploy.cjs'),
    output: path.join(work, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false, // code cache and snapshots only work on the platform that made them
    assets: { 'console.tgz': path.join(dist, 'console.tgz') },
  };
  const configFile = path.join(work, 'sea-config.json');
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  execFileSync(node, ['--experimental-sea-config', configFile], { stdio: 'inherit' });
  return fs.readFileSync(config.output);
}

async function packageFor(target, blob) {
  const windows = target.startsWith('win');
  const mac = target.startsWith('darwin');
  const name = windows ? 'codex-console-deploy.exe' : 'codex-console-deploy';
  const dir = path.join(work, target);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, name);
  let bin = await nodeBinary(target);
  if (windows) bin = stripAuthenticode(bin);
  fs.writeFileSync(exe, bin, { mode: 0o755 });
  if (mac) execFileSync('codesign', ['--remove-signature', exe]);
  await inject(exe, 'NODE_SEA_BLOB', blob, { sentinelFuse: SENTINEL, ...(mac ? { machoSegmentName: 'NODE_SEA' } : {}) });
  if (mac) execFileSync('codesign', ['--sign', '-', exe]);
  fs.chmodSync(exe, 0o755);
  if (target === host) {
    const version = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim();
    console.log(`  ${target}: runs (version ${version})`);
  }

  // Windows runs the .exe as it is; a download loses the "executable" bit, so the others come in an archive.
  const base = path.join(release, `codex-console-deploy-${TARGETS[target].label}`);
  if (windows) {
    fs.copyFileSync(exe, `${base}.exe`);
    return `${base}.exe`;
  }
  if (mac) {
    fs.rmSync(`${base}.zip`, { force: true });
    execFileSync('ditto', ['-c', '-k', '--keepParent', exe, `${base}.zip`]);
    return `${base}.zip`;
  }
  fs.writeFileSync(`${base}.tar.gz`, gzipSync(tar([{ name, data: fs.readFileSync(exe), mode: 0o755 }]), { level: 9 }));
  return `${base}.tar.gz`;
}

const args = process.argv.slice(2);
const targets = args.includes('--all') ? Object.keys(TARGETS).filter(canBuild) : args.length ? args : [host];
for (const target of targets) {
  if (!TARGETS[target]) fail(`Unknown platform: ${target}. Choose from: ${Object.keys(TARGETS).join(', ')}`);
  if (!canBuild(target)) fail(`${target} has to be built on a Mac: macOS only runs signed programs.`);
}

execFileSync(process.execPath, [path.join(here, 'build.mjs')], { stdio: 'inherit' });
const blob = await seaBlob();
for (const target of targets) console.log(`Packaged ${path.relative(deployer, await packageFor(target, blob))}`);

// Checksums for every packaged file here, so a download can be checked.
const files = fs.readdirSync(release).filter((f) => f.startsWith('codex-console-deploy-')).sort();
fs.writeFileSync(path.join(release, 'SHA256SUMS.txt'), files.map((f) => `${sha256(fs.readFileSync(path.join(release, f)))}  ${f}\n`).join(''));
console.log('Wrote release/SHA256SUMS.txt');
