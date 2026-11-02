// The official Node.js builds the downloads ship, pinned to their published checksums.
// Used by the console packages (scripts/portable.mjs) and the deploy program (deployer/scripts/package.mjs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { untar } from '../deployer/scripts/tar.mjs';

export const NODE_VERSION = '24.22.1';
// From https://nodejs.org/dist/v24.22.1/SHASUMS256.txt
const FILES = {
  'linux-x64': { file: `node-v${NODE_VERSION}-linux-x64.tar.gz`, sha256: 'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c' },
  'linux-arm64': { file: `node-v${NODE_VERSION}-linux-arm64.tar.gz`, sha256: '33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3' },
  'darwin-x64': { file: `node-v${NODE_VERSION}-darwin-x64.tar.gz`, sha256: 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035' },
  'darwin-arm64': { file: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`, sha256: '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7' },
  'win-x64': { file: 'win-x64/node.exe', sha256: 'd702daa815eabbff763c7d3808e235cf031cf2ca70211b56847bc72f51e240e5' },
};
// Node.js is shipped on its own, so its license text goes with it (github.com/nodejs/node, tag v24.22.1).
const LICENSE_SHA256 = '5888dbb9a1d2b18f2c3e6c5f6af1b39de658372b402a0577b002777f14c62ace';

export const NODE_PLATFORMS = Object.keys(FILES);

const cache = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'node');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** A file from `url`, checked against `expected`, kept in .cache/ for next time. */
async function pinned(name, url, expected) {
  const file = path.join(cache, name);
  if (fs.existsSync(file)) {
    const data = fs.readFileSync(file);
    if (sha256(data) === expected) return data;
  }
  console.log(`Downloading ${url}…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download of ${url} failed: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (sha256(data) !== expected) throw new Error(`Checksum mismatch for ${url}: not the official file`);
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(file, data);
  return data;
}

/** The official `node` (`node.exe` on Windows) for a platform such as "darwin-arm64". */
export async function nodeBinary(platform) {
  const f = FILES[platform];
  if (!f) throw new Error(`No Node.js build for ${platform}`);
  const exe = f.file.endsWith('.exe');
  const data = await pinned(exe ? `node-v${NODE_VERSION}-${platform}.exe` : f.file, `https://nodejs.org/dist/v${NODE_VERSION}/${f.file}`, f.sha256);
  if (exe) return data;
  const member = `node-v${NODE_VERSION}-${platform}/bin/node`;
  for (const entry of untar(gunzipSync(data))) if (entry.name === member) return Buffer.from(entry.data);
  throw new Error(`${member} is not in ${f.file}`);
}

/** Node.js's license text. */
export function nodeLicense() {
  return pinned(`LICENSE-v${NODE_VERSION}`, `https://raw.githubusercontent.com/nodejs/node/v${NODE_VERSION}/LICENSE`, LICENSE_SHA256);
}
