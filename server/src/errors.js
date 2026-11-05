// API-facing errors carry an HTTP status and a stable machine-readable code.
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const notFound = (what) => new AppError(404, 'not_found', `${what} not found`);
export const badRequest = (code, message, details) => new AppError(400, code, message, details);
export class IndexNotReadyError extends AppError {
  constructor(message = 'The local index has not been built yet; retry shortly') {
    super(503, 'index_not_ready', message);
  }
}

// Portal-side failures. The error handler maps these to 5xx so callers can tell
// "your request is wrong" (4xx) from "the legacy portal is unhappy" (5xx).
export class PortalError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = this.constructor.name;
  }
}
export class PortalAuthError extends PortalError {}
export class PortalHttpError extends PortalError {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}
export class PortalUnavailableError extends PortalError {}
export class PortalNotMappedError extends PortalError {}
