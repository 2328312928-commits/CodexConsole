import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../../lib/errors.js';
import { isTextLike, mediaKind } from '../../services/workspace.js';
import type { AppDeps } from '../context.js';
import { contentDisposition, FILE_CSP } from '../headers.js';

const HOUR_MS = 3_600_000;
const sessionIdSchema = z.string().regex(/^ses_[A-Za-z0-9_-]{1,40}$/).optional();
const pathQuery = z.object({ path: z.string().max(4096).default(''), session: sessionIdSchema });

export type ByteRange = { start: number; end: number };

/** Single "bytes=" range; null means "send everything", 'invalid' means 416. */
export function parseRange(header: string | undefined, size: number): ByteRange | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'invalid';
  return { start, end };
}

export function registerFileRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { workspace, audit, config, limiter, media } = deps;

  app.get('/api/files', async (req) => {
    const q = pathQuery.parse(req.query);
    return workspace.list(q.path);
  });

  async function serve(req: FastifyRequest, reply: FastifyReply, mode: 'view' | 'download') {
    const q = pathQuery.parse(req.query);
    const f = await workspace.openForRead(q.path);
    const kind = mediaKind(f.mime);
    let type = 'application/octet-stream';
    let inline = false;
    if (mode === 'view') {
      if (kind) {
        type = f.mime!;
        inline = true;
      } else if (isTextLike(f.mime)) {
        // HTML, JS etc. are shown as plain text, never rendered.
        type = 'text/plain; charset=utf-8';
        inline = true;
      }
    }
    const range = parseRange(req.headers.range, f.size);
    if (range === 'invalid') {
      await f.handle.close();
      return reply.status(416).header('Content-Range', `bytes */${f.size}`).send({ error: { code: 'bad_request' } });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? f.size - 1;
    const length = f.size === 0 ? 0 : end - start + 1;
    reply
      .header('Content-Type', type)
      .header('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', f.name))
      .header('Content-Security-Policy', FILE_CSP)
      .header('Accept-Ranges', 'bytes')
      .header('Cache-Control', 'private, max-age=300')
      .header('Content-Length', String(length));
    if (range) reply.status(206).header('Content-Range', `bytes ${start}-${end}/${f.size}`);
    // Every response is logged, ranged reads included, so nothing leaves the workspace unrecorded.
    audit.transfer({ deviceId: req.auth.device!.id, sessionId: q.session ?? null, direction: mode, path: f.rel, bytes: length, ok: true });
    if (f.size === 0) {
      await f.handle.close();
      return reply.send('');
    }
    return reply.send(f.handle.createReadStream({ start, end, autoClose: true }));
  }

  app.get('/api/files/view', (req, reply) => serve(req, reply, 'view'));
  app.get('/api/files/download', (req, reply) => serve(req, reply, 'download'));

  app.post('/api/files/upload', async (req) => {
    const q = z
      .object({ path: z.string().max(4096).default(''), overwrite: z.enum(['0', '1']).optional(), session: sessionIdSchema })
      .parse(req.query);
    if (!req.isMultipart()) throw new ApiError(400, 'bad_request', 'multipart/form-data expected');
    const deviceId = req.auth.device!.id;
    const quotaKey = `upload:dev:${deviceId}`;
    const files: Array<{ path: string; name: string; size: number }> = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      if (limiter.usage(quotaKey, HOUR_MS) >= config.limits.uploadBytesPerHour) {
        part.file.resume();
        audit.security('rate_limited', { deviceId, ip: req.ip }, { scope: 'upload' });
        throw new ApiError(429, 'upload_quota_exceeded', undefined, Math.ceil(limiter.retryAfter(quotaKey, config.limits.uploadBytesPerHour, HOUR_MS) / 1000));
      }
      try {
        const saved = await workspace.upload(q.path, part.filename || 'upload', part.file, config.limits.maxUploadBytes, q.overwrite === '1');
        limiter.record(quotaKey, HOUR_MS, saved.size);
        audit.transfer({ deviceId, sessionId: q.session ?? null, direction: 'upload', path: saved.path, bytes: saved.size, ok: true });
        files.push(saved);
      } catch (err) {
        part.file.resume();
        audit.transfer({ deviceId, sessionId: q.session ?? null, direction: 'upload', path: `${q.path}/${part.filename}`, bytes: 0, ok: false });
        throw err;
      }
    }
    return { files };
  });

  app.post('/api/files/mkdir', async (req) => {
    const { path } = z.object({ path: z.string().min(1).max(4096) }).strict().parse(req.body);
    return { path: await workspace.mkdir(path) };
  });

  app.post('/api/files/delete', async (req) => {
    const { path } = z.object({ path: z.string().min(1).max(4096) }).strict().parse(req.body);
    await workspace.remove(path);
    return { ok: true };
  });

  // Images Codex viewed or generated outside the workspace (copied into the private store).
  app.get('/api/media/:sessionId/:name', async (req, reply) => {
    const { sessionId, name } = z.object({ sessionId: z.string().max(60), name: z.string().max(120) }).parse(req.params);
    const f = await media.open(sessionId, name);
    return reply
      .header('Content-Type', f.mime)
      .header('Content-Length', String(f.size))
      .header('Content-Security-Policy', FILE_CSP)
      .header('Content-Disposition', contentDisposition('inline', name))
      .header('Cache-Control', 'private, max-age=86400')
      .send(f.handle.createReadStream({ autoClose: true }));
  });
}
