import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FileEntry, MediaRef } from '../../shared/api.js';
import { ApiError } from '../lib/errors.js';

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'text/plain',
  tsx: 'text/plain',
  jsx: 'text/plain',
  py: 'text/plain',
  rs: 'text/plain',
  go: 'text/plain',
  java: 'text/plain',
  c: 'text/plain',
  h: 'text/plain',
  cpp: 'text/plain',
  sh: 'text/plain',
  rb: 'text/plain',
  php: 'text/plain',
  sql: 'text/plain',
  toml: 'text/plain',
  yaml: 'text/plain',
  yml: 'text/plain',
  ini: 'text/plain',
  xml: 'text/xml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  md: 'text/markdown',
  txt: 'text/plain',
  log: 'text/plain',
};

export function mimeFor(name: string): string | null {
  const ext = path.extname(name).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? null;
}

export function mediaKind(mime: string | null): 'image' | 'video' | 'audio' | null {
  if (!mime) return null;
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return null;
}

/** Text-like files are previewed as text/plain so HTML/JS can never render. */
export function isTextLike(mime: string | null): boolean {
  return mime !== null && (mime.startsWith('text/') || mime === 'application/json');
}

export function sanitizeFilename(name: string): string | null {
  let n = name
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\]/g, '_')
    .trim();
  if (!n || n === '.' || n === '..') return null;
  while (Buffer.byteLength(n, 'utf8') > 200) {
    const ext = path.extname(n);
    const base = n.slice(0, n.length - ext.length);
    n = base.slice(0, Math.max(1, base.length - 10)) + ext;
    if (base.length <= 1) break;
  }
  return n;
}

const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'venv', 'target', 'bower_components']);
const pathInvalid = () => new ApiError(400, 'path_invalid');
const outside = () => new ApiError(403, 'path_outside_workspace');

/** A readable, unique folder name for a new session. */
export function defaultFolderName(title: string | undefined, now = new Date()): string {
  const slug = (title ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${slug || 'session'}-${date}-${suffix}`;
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

/** All file access for the console goes through here and stays inside the workspace root. */
export class Workspace {
  realRoot = '';

  /**
   * `shared`: Codex runs as its own user in the same group (servers set up by deploy/install.sh),
   * so folders and files the console makes must be usable by the group. Otherwise they stay private.
   */
  constructor(
    readonly root: string,
    readonly opts: { shared?: boolean } = {},
  ) {}

  async init(): Promise<void> {
    await fsp.mkdir(this.root, { recursive: true, mode: this.opts.shared ? 0o770 : 0o700 });
    this.realRoot = await fsp.realpath(this.root);
  }

  contains(realPath: string): boolean {
    return realPath === this.realRoot || realPath.startsWith(this.realRoot + path.sep);
  }

  /** Workspace-relative form of an absolute path, or null if it is outside. */
  relOf(abs: string): string | null {
    const resolved = path.resolve(abs);
    if (!this.contains(resolved)) return null;
    return path.relative(this.realRoot, resolved).split(path.sep).join('/');
  }

  /** Absolute form of a workspace-relative path (lexical: no symlink check), or null if invalid. */
  absOf(rel: string): string | null {
    try {
      return path.join(this.realRoot, ...Workspace.segments(rel));
    } catch {
      return null;
    }
  }

  /** A folder that exists inside the workspace, following symlinks only within it. */
  async folder(rel: unknown): Promise<{ abs: string; rel: string }> {
    const r = await this.resolve(rel);
    if (!r.exists) throw new ApiError(404, 'file_not_found', r.rel);
    if (!(await fsp.stat(r.abs)).isDirectory()) throw new ApiError(400, 'not_a_directory', r.rel);
    return { abs: await fsp.realpath(r.abs), rel: r.rel };
  }

  static segments(rel: unknown): string[] {
    if (typeof rel !== 'string' || rel.length > 4096 || rel.includes('\0') || rel.includes('\\')) throw pathInvalid();
    const segs = rel.split('/').filter((s) => s !== '' && s !== '.');
    if (segs.some((s) => s === '..')) throw pathInvalid();
    return segs;
  }

  /**
   * Resolve a workspace-relative path. Symlinks are allowed only when their real
   * target is inside the root; the deepest existing ancestor is checked too.
   */
  async resolve(rel: unknown): Promise<{ abs: string; rel: string; exists: boolean }> {
    const segs = Workspace.segments(rel);
    const abs = path.join(this.realRoot, ...segs);
    const lst = await fsp.lstat(abs).catch((err) => {
      if (errCode(err) === 'ENOENT' || errCode(err) === 'ENOTDIR') return null;
      throw err;
    });
    if (lst) {
      const real = await fsp.realpath(abs).catch(() => null);
      if (!real || !this.contains(real)) throw outside();
      return { abs, rel: segs.join('/'), exists: true };
    }
    let probe = path.dirname(abs);
    for (;;) {
      try {
        const real = await fsp.realpath(probe);
        if (!this.contains(real)) throw outside();
        break;
      } catch (err) {
        if (err instanceof ApiError) throw err;
        if (errCode(err) !== 'ENOENT' && errCode(err) !== 'ENOTDIR') throw err;
        const parent = path.dirname(probe);
        if (parent === probe) throw pathInvalid();
        probe = parent;
      }
    }
    return { abs, rel: segs.join('/'), exists: false };
  }

  async list(rel: string, limit = 5000): Promise<{ path: string; entries: FileEntry[]; truncated: boolean }> {
    const r = await this.resolve(rel);
    if (!r.exists) throw new ApiError(404, 'file_not_found');
    const st = await fsp.stat(r.abs);
    if (!st.isDirectory()) throw new ApiError(400, 'not_a_directory');
    const dirents = await fsp.readdir(r.abs, { withFileTypes: true });
    const entries: FileEntry[] = [];
    for (const d of dirents.slice(0, limit)) {
      const abs = path.join(r.abs, d.name);
      const childRel = r.rel ? `${r.rel}/${d.name}` : d.name;
      let type: FileEntry['type'] = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : d.isSymbolicLink() ? 'link' : 'other';
      let stat: fs.Stats | null = null;
      if (type === 'link') {
        const real = await fsp.realpath(abs).catch(() => null);
        if (real && this.contains(real)) {
          stat = await fsp.stat(real).catch(() => null);
          if (stat) type = stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other';
        }
      } else {
        stat = await fsp.lstat(abs).catch(() => null);
      }
      const mime = type === 'file' ? mimeFor(d.name) : null;
      entries.push({
        name: d.name,
        path: childRel,
        type,
        size: stat && type === 'file' ? stat.size : null,
        mtime: stat ? Math.round(stat.mtimeMs) : null,
        mime,
        media: mediaKind(mime),
      });
    }
    entries.sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
    return { path: r.rel, entries, truncated: dirents.length > limit };
  }

  /** Open a regular file for reading, refusing symlink tricks at open time. */
  async openForRead(rel: string): Promise<{ handle: fsp.FileHandle; size: number; mtimeMs: number; name: string; rel: string; mime: string | null }> {
    const r = await this.resolve(rel);
    if (!r.exists) throw new ApiError(404, 'file_not_found');
    const real = await fsp.realpath(r.abs);
    if (!this.contains(real)) throw outside();
    let handle: fsp.FileHandle;
    try {
      handle = await fsp.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    } catch (err) {
      if (errCode(err) === 'ENOENT') throw new ApiError(404, 'file_not_found');
      if (errCode(err) === 'EISDIR') throw new ApiError(400, 'not_a_file');
      throw err;
    }
    try {
      const st = await handle.stat();
      if (!st.isFile()) throw new ApiError(400, 'not_a_file');
      if (process.platform === 'linux') {
        const opened = await fsp.readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
        if (opened !== null && !this.contains(opened)) throw outside();
      }
      return { handle, size: st.size, mtimeMs: st.mtimeMs, name: path.basename(real), rel: r.rel, mime: mimeFor(real) };
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  /** Stream an upload into `relDir` without ever exceeding `maxBytes` on disk. */
  async upload(relDir: string, filename: string, stream: Readable, maxBytes: number, overwrite: boolean): Promise<{ path: string; name: string; size: number }> {
    const dir = await this.resolve(relDir);
    if (!dir.exists) await fsp.mkdir(dir.abs, { recursive: true });
    const dirStat = await fsp.stat(dir.abs);
    if (!dirStat.isDirectory()) throw new ApiError(400, 'not_a_directory');
    const name = sanitizeFilename(filename) ?? 'upload';
    const tmp = path.join(dir.abs, `.${name.slice(0, 60)}.${crypto.randomBytes(6).toString('hex')}.part`);
    let bytes = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > maxBytes) cb(new ApiError(413, 'file_too_large'));
        else cb(null, chunk);
      },
    });
    const handle = await fsp.open(tmp, 'wx', this.opts.shared ? 0o660 : 0o644);
    try {
      await pipeline(stream, counter, handle.createWriteStream());
      const target = await this.placeFile(tmp, dir.abs, name, overwrite);
      return { path: this.relOf(target)!, name: path.basename(target), size: bytes };
    } catch (err) {
      await handle.close().catch(() => undefined);
      await fsp.rm(tmp, { force: true });
      throw err;
    }
  }

  private async placeFile(tmp: string, dirAbs: string, name: string, overwrite: boolean): Promise<string> {
    const target = path.join(dirAbs, name);
    if (overwrite) {
      const lst = await fsp.lstat(target).catch(() => null);
      if (lst?.isDirectory()) throw new ApiError(409, 'file_exists');
      await fsp.rename(tmp, target);
      return target;
    }
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    for (let i = 0; i < 1000; i++) {
      const candidate = path.join(dirAbs, i === 0 ? name : `${base} (${i})${ext}`);
      try {
        await fsp.link(tmp, candidate); // fails if the name is taken: no silent overwrite
        await fsp.rm(tmp, { force: true });
        return candidate;
      } catch (err) {
        if (errCode(err) === 'EEXIST') continue;
        if (errCode(err) === 'EPERM' || errCode(err) === 'ENOTSUP' || errCode(err) === 'EXDEV') {
          if (await fsp.lstat(candidate).catch(() => null)) continue;
          await fsp.rename(tmp, candidate);
          return candidate;
        }
        throw err;
      }
    }
    throw new ApiError(409, 'file_exists');
  }

  async mkdir(rel: string): Promise<string> {
    const r = await this.resolve(rel);
    if (r.rel === '') throw pathInvalid();
    if (r.exists) throw new ApiError(409, 'file_exists');
    await fsp.mkdir(r.abs, { recursive: true });
    return r.rel;
  }

  async remove(rel: string): Promise<void> {
    const r = await this.resolve(rel);
    if (r.rel === '') throw pathInvalid();
    if (!r.exists) throw new ApiError(404, 'file_not_found');
    const lst = await fsp.lstat(r.abs);
    await fsp.rm(r.abs, { recursive: lst.isDirectory(), force: false });
  }

  /** Media files created or modified under `absDir` since `sinceMs` (bounded walk, no symlinks). */
  async scanMedia(absDir: string, sinceMs: number, exclude: Set<string> = new Set(), maxResults = 50): Promise<MediaRef[]> {
    if (!this.contains(path.resolve(absDir))) return [];
    const found: Array<MediaRef & { mtime: number }> = [];
    let visited = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 6 || found.length >= maxResults) return;
      const dirents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const d of dirents) {
        if (++visited > 20_000 || found.length >= maxResults) return;
        const abs = path.join(dir, d.name);
        if (d.isDirectory()) {
          if (d.name.startsWith('.') || SKIP_DIRS.has(d.name)) continue;
          await walk(abs, depth + 1);
        } else if (d.isFile()) {
          const mime = mimeFor(d.name);
          const kind = mediaKind(mime);
          if (!kind) continue;
          const rel = this.relOf(abs);
          if (rel === null || exclude.has(rel)) continue;
          const st = await fsp.stat(abs).catch(() => null);
          if (!st || st.mtimeMs < sinceMs) continue;
          found.push({ kind, source: 'workspace', path: rel, name: d.name, mime: mime!, size: st.size, mtime: st.mtimeMs });
        }
      }
    };
    await walk(path.resolve(absDir), 0);
    return found.sort((a, b) => a.mtime - b.mtime).map(({ mtime: _m, ...ref }) => ref);
  }
}
