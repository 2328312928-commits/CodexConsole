import type { ErrorCode } from '../../shared/errors.js';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly detail?: string,
    readonly retryAfterSec?: number,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export const badRequest = (detail?: string) => new ApiError(400, 'bad_request', detail);
export const notFound = (code: ErrorCode = 'not_found') => new ApiError(404, code);
