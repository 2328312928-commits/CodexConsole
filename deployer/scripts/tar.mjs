// Just enough tar (ustar) for this program: regular files only, written and read.
const BLOCK = 512;

const octal = (n, width) => `${n.toString(8).padStart(width - 1, '0')}\0`;

/** ustar keeps up to 100 bytes of name, plus a 155-byte prefix split at a "/". */
function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return ['', name];
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== '/') continue;
    const prefix = name.slice(0, i);
    const base = name.slice(i + 1);
    if (base && Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(base) <= 100) return [prefix, base];
  }
  throw new Error(`Path too long for tar: ${name}`);
}

export function tarHeader(name, size, mode, mtime) {
  const h = Buffer.alloc(BLOCK);
  const [prefix, base] = splitName(name);
  h.write(base, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii'); // uid: root
  h.write(octal(0, 8), 116, 8, 'ascii'); // gid: root
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(mtime, 12), 136, 12, 'ascii');
  h.write(' '.repeat(8), 148, 8, 'ascii'); // checksum, counted as spaces
  h.write('0', 156, 1, 'ascii'); // a regular file
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write('root', 265, 32, 'ascii');
  h.write('root', 297, 32, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

/** A tar archive of `files` ({ name, data, mode? }), owned by root, all with the same time. */
export function tar(files, mtime = Math.floor(Date.now() / 1000)) {
  const parts = [];
  for (const f of files) {
    parts.push(tarHeader(f.name, f.data.length, f.mode ?? 0o644, mtime), f.data);
    const pad = (BLOCK - (f.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** The regular files in a tar archive (ustar, with GNU and pax long names). */
export function* untar(buf) {
  let off = 0;
  let longName = null;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) return;
    const field = (start, len) => {
      const s = h.subarray(start, start + len);
      const end = s.indexOf(0);
      return s.subarray(0, end === -1 ? len : end).toString('utf8');
    };
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 0x30);
    const prefix = field(257, 5) === 'ustar' ? field(345, 155) : '';
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const data = buf.subarray(off + BLOCK, off + BLOCK + size);
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === 'x') {
      longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1] ?? longName;
      continue;
    }
    if (type === 'g') continue;
    if (type === '0' || type === '\0') yield { name: longName ?? name, mode: parseInt(field(100, 8).trim() || '0', 8), data };
    longName = null;
  }
}
