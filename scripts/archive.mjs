// Archives for the console packages, written file by file so a package never sits in memory whole.
import { once } from 'node:events';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { tarHeader } from '../deployer/scripts/tar.mjs';

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * A zip of `files` ({ name, path, mode }) with UTF-8 names. With `unix`, every entry keeps its mode, so
 * macOS keeps programs executable; otherwise it is a plain zip for Windows. No zip64: under 65,535 files and 4 GB.
 */
export function zipToFile(out, files, { unix = false, when = new Date() } = {}) {
  if (files.length > 0xffff) throw new Error('Too many files for a zip without zip64');
  const { time, date } = dosDateTime(when);
  const fd = fs.openSync(out, 'w');
  const central = [];
  let offset = 0;
  try {
    for (const f of files) {
      const data = fs.readFileSync(f.path);
      const name = Buffer.from(f.name, 'utf8');
      const crc = zlib.crc32(data);
      const deflated = zlib.deflateRawSync(data, { level: 9 });
      const stored = deflated.length >= data.length;
      const body = stored ? data : deflated;
      const method = stored ? 0 : 8;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4); // version needed: 2.0
      local.writeUInt16LE(0x0800, 6); // names are UTF-8
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      fs.writeSync(fd, local);
      fs.writeSync(fd, name);
      fs.writeSync(fd, body);

      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0);
      entry.writeUInt16LE(unix ? (3 << 8) | 20 : 20, 4); // made by: Unix or MS-DOS, 2.0
      entry.writeUInt16LE(20, 6);
      entry.writeUInt16LE(0x0800, 8);
      entry.writeUInt16LE(method, 10);
      entry.writeUInt16LE(time, 12);
      entry.writeUInt16LE(date, 14);
      entry.writeUInt32LE(crc, 16);
      entry.writeUInt32LE(body.length, 20);
      entry.writeUInt32LE(data.length, 24);
      entry.writeUInt16LE(name.length, 28);
      if (unix) entry.writeUInt32LE(((0o100000 | (f.mode ?? 0o644)) << 16) >>> 0, 38); // a regular file and its mode
      entry.writeUInt32LE(offset, 42);
      central.push(entry, name);
      offset += local.length + name.length + body.length;
      if (offset > 0xffffffff) throw new Error('Zip larger than 4 GB');
    }
    const size = central.reduce((n, b) => n + b.length, 0);
    for (const b of central) fs.writeSync(fd, b);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(offset, 16);
    fs.writeSync(fd, end);
  } finally {
    fs.closeSync(fd);
  }
}

/** A gzipped tar of `files` ({ name, path, mode }), owned by root, all with the same time. */
export async function tarGzToFile(out, files, mtime = Math.floor(Date.now() / 1000)) {
  const gz = zlib.createGzip({ level: 9 });
  const sink = fs.createWriteStream(out);
  gz.pipe(sink);
  const write = async (buf) => {
    if (!gz.write(buf)) await once(gz, 'drain');
  };
  for (const f of files) {
    const data = fs.readFileSync(f.path);
    await write(tarHeader(f.name, data.length, f.mode ?? 0o644, mtime));
    await write(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) await write(Buffer.alloc(pad));
  }
  await write(Buffer.alloc(1024)); // two empty blocks end the archive
  gz.end();
  await once(sink, 'close');
}
