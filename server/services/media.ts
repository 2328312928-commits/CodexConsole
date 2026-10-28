import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { MediaRef } from '../../shared/api.js';
import { ApiError } from '../lib/errors.js';
import { mediaKind, mimeFor, type Workspace } from './workspace.js';

const MAX_COPY_BYTES = 25 * 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9_-]{1,100}\.(png|jpg|gif|webp|bmp|avif)$/;
const SESSION_RE = /^ses_[A-Za-z0-9_-]{1,40}$/;

const MIME_BY_SNIFF: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
};

/** Identify an image by its magic bytes (never trust the file name for copies). */
export function sniffImage(buf: Buffer): { ext: string; mime: string } | null {
  const hex = buf.subarray(0, 12).toString('hex');
  let ext: string | null = null;
  if (hex.startsWith('89504e470d0a1a0a')) ext = 'png';
  else if (hex.startsWith('ffd8ff')) ext = 'jpg';
  else if (hex.startsWith('47494638')) ext = 'gif';
  else if (hex.startsWith('52494646') && buf.subarray(8, 12).toString('ascii') === 'WEBP') ext = 'webp';
  else if (hex.startsWith('424d')) ext = 'bmp';
  else if (buf.subarray(4, 12).toString('ascii').startsWith('ftypavi')) ext = 'avif';
  return ext ? { ext, mime: MIME_BY_SNIFF[ext]! } : null;
}

/**
 * Images Codex viewed or generated. Workspace files are referenced in place;
 * images elsewhere on disk (or inline base64) are copied into the private store.
 */
export class MediaStore {
  constructor(
    private readonly dir: string,
    private readonly workspace: Workspace,
  ) {}

  async fromPath(absPath: string, sessionId: string, itemId: string): Promise<MediaRef | null> {
    const real = await fsp.realpath(absPath).catch(() => null);
    if (!real) return null;
    const st = await fsp.stat(real).catch(() => null);
    if (!st?.isFile()) return null;
    const mime = mimeFor(real);
    const kind = mediaKind(mime);
    const rel = this.workspace.relOf(real);
    if (rel !== null && kind) {
      return { kind, source: 'workspace', path: rel, name: path.basename(real), mime: mime!, size: st.size };
    }
    if (st.size > MAX_COPY_BYTES) return null;
    const buf = await fsp.readFile(real);
    const sniffed = sniffImage(buf);
    return sniffed ? this.save(sessionId, itemId, buf, sniffed) : null;
  }

  async fromBase64(data: string, sessionId: string, itemId: string): Promise<MediaRef | null> {
    const m = /^data:image\/[a-z0-9.+-]+;base64,/i.exec(data);
    const b64 = m ? data.slice(m[0].length) : data;
    if (b64.length < 16 || b64.length > MAX_COPY_BYTES * 1.4 || !/^[A-Za-z0-9+/=\r\n]+$/.test(b64.slice(0, 4096))) return null;
    const buf = Buffer.from(b64, 'base64');
    const sniffed = sniffImage(buf);
    return sniffed ? this.save(sessionId, itemId, buf, sniffed) : null;
  }

  private async save(sessionId: string, itemId: string, buf: Buffer, t: { ext: string; mime: string }): Promise<MediaRef> {
    if (!SESSION_RE.test(sessionId)) throw new Error('invalid session id');
    const safeItem = itemId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'image';
    const name = `${safeItem}.${t.ext}`;
    const dir = path.join(this.dir, sessionId);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(path.join(dir, name), buf, { mode: 0o600 });
    return { kind: 'image', source: 'store', path: `${sessionId}/${name}`, name, mime: t.mime, size: buf.length };
  }

  async open(sessionId: string, name: string): Promise<{ handle: fsp.FileHandle; size: number; mime: string }> {
    if (!SESSION_RE.test(sessionId) || !NAME_RE.test(name)) throw new ApiError(400, 'path_invalid');
    const file = path.join(this.dir, sessionId, name);
    const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)).catch(() => {
      throw new ApiError(404, 'file_not_found');
    });
    const st = await handle.stat();
    const ext = path.extname(name).slice(1);
    return { handle, size: st.size, mime: MIME_BY_SNIFF[ext] ?? 'application/octet-stream' };
  }

  async removeSession(sessionId: string): Promise<void> {
    if (!SESSION_RE.test(sessionId)) return;
    await fsp.rm(path.join(this.dir, sessionId), { recursive: true, force: true });
  }
}
