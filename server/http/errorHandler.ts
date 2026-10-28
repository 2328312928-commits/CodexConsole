import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { ApiError } from '../lib/errors.js';

/** JSON error responses with stable codes (the UI translates them); internals stay in the log. */
export function handleError(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ApiError) {
    if (err.retryAfterSec) reply.header('Retry-After', String(err.retryAfterSec));
    const showDetail = err.detail && (err.status < 500 || err.code === 'codex_error' || err.code === 'mcp_error');
    return reply.status(err.status).send({
      error: { code: err.code, ...(showDetail ? { detail: err.detail } : {}), ...(err.retryAfterSec ? { retryAfterSec: err.retryAfterSec } : {}) },
    });
  }
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    return reply.status(400).send({ error: { code: 'bad_request', detail: issue ? `${issue.path.join('.')}: ${issue.message}` : undefined } });
  }
  const e = err as { statusCode?: number; code?: string; message?: string };
  if (e.statusCode === 413 || e.code === 'FST_REQ_FILE_TOO_LARGE' || e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return reply.status(413).send({ error: { code: 'payload_too_large' } });
  }
  if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
    return reply.status(e.statusCode).send({ error: { code: 'bad_request', detail: e.message } });
  }
  req.log.error({ err }, 'Unhandled error');
  return reply.status(500).send({ error: { code: 'internal' } });
}
