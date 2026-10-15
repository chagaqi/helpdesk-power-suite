export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'plan_limit'
  | 'rate_limited'
  | 'payload_too_large'
  | 'gone'
  | 'unresolved_reference'
  | 'internal';

const STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  plan_limit: 402,
  rate_limited: 429,
  payload_too_large: 413,
  gone: 410,
  unresolved_reference: 422,
  internal: 500,
};

/** Domain error carrying an HTTP-mappable code. Message is safe to show to admins. */
export class HpsError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HpsError';
    this.status = STATUS[code];
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}) } };
  }
}
