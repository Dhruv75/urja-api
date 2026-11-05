import { ZodError } from 'zod';
import { AppError, PortalAuthError, PortalError, PortalNotMappedError } from '../errors.js';

export function toHttpError(err) {
  if (err instanceof ZodError) {
    return { status: 400, code: 'validation_error', message: 'Invalid request parameters', details: err.issues.map((i) => ({ path: i.path.join('.') || '(query)', message: i.message })) };
  }
  if (err instanceof AppError) return { status: err.status, code: err.code, message: err.message, details: err.details };
  if (err instanceof PortalNotMappedError) return { status: 501, code: 'portal_not_mapped', message: err.message };
  if (err instanceof PortalAuthError) return { status: 502, code: 'portal_auth_failed', message: err.message };
  if (err instanceof PortalError) return { status: 502, code: 'portal_unavailable', message: err.message };
  if (err?.type === 'entity.parse.failed') return { status: 400, code: 'validation_error', message: 'Malformed JSON body' };
  return { status: 500, code: 'internal_error', message: 'Unexpected error' }; // never leak internals
}

export const errorHandler = (log) => (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const { status, code, message, details } = toHttpError(err);
  if (status >= 500 && status !== 501 && status !== 502) log.error('unhandled error', { path: req.path, error: err.stack ?? String(err) });
  else if (status >= 500) log.warn('upstream problem', { path: req.path, code, error: message });
  if (code === 'index_not_ready') res.set('Retry-After', '5');
  res.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }) } });
};
