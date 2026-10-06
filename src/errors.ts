// The error hierarchy (devtools.md §5.4). Nothing here ever carries the API key or a request header (S-46, K-06):
// messages and bodies go through `redact`, and `toJSON` lists fields instead of dumping the instance.

// a key is `syn_<orgId>_<secret>_<check>`; any run of the key alphabet after the prefix is masked
const KEY_PATTERN = /syn_[A-Za-z0-9_-]+/g;

/** Masks the API key (the exact one, when known, and anything shaped like one) in a string, an array or an object. */
export function redact<T>(value: T, secret?: string): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === 'string') {
      let s = v;
      if (secret) s = s.split(secret).join('[redacted]');
      return s.replace(KEY_PATTERN, '[redacted]');
    }
    if (depth > 8 || v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, depth + 1)]));
  };
  return walk(value, 0) as T;
}

export class SynergyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(redact(message), options);
    this.name = 'SynergyError';
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, message: this.message };
  }
}

export class ConnectionError extends SynergyError {
  constructor(message = 'Could not reach the Synergy API.', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConnectionError';
  }
}

export class TimeoutError extends SynergyError {
  constructor(message = 'The request to the Synergy API timed out.', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TimeoutError';
  }
}

export class AbortError extends SynergyError {
  constructor(message = 'The request was aborted.', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AbortError';
  }
}

export class WebhookSignatureError extends SynergyError {
  constructor(message = 'Invalid webhook signature.') {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

export type ErrorCode = number;

export interface APIErrorFields {
  status: number;
  code?: ErrorCode;
  subcode?: number;
  message: string;
  details?: string;
  fbtraceId?: string;
  retryAfter?: number;
  feature?: string;
  reason?: string;
  body: unknown;
}

// Synergy codes (durable/instance/developer.ts API_ERROR) by the class they raise; Meta's own codes fall to MetaError
const PERMISSION_CODES = new Set([200, 1390004, 1390005, 1390007, 1390011, 1390013, 1390014]);
const CONFLICT_CODES = new Set([1390001, 1390002, 1390008]);
const RATE_LIMIT_CODES = new Set([130429, 1390006, 1390010, 1390012, 1390015]);

/** `retryAfter` and everything else about a failed call that is not a 2xx. */
export class APIError extends SynergyError {
  readonly status: number;
  readonly code?: ErrorCode;
  readonly subcode?: number;
  readonly details?: string;
  readonly fbtraceId?: string;
  readonly retryAfter?: number;
  readonly feature?: string;
  readonly reason?: string;
  readonly body: unknown;

  constructor(f: APIErrorFields) {
    super(f.message);
    this.name = 'APIError';
    this.status = f.status;
    this.code = f.code;
    this.subcode = f.subcode;
    this.details = f.details && redact(f.details);
    this.fbtraceId = f.fbtraceId;
    this.retryAfter = f.retryAfter;
    this.feature = f.feature;
    this.reason = f.reason;
    this.body = redact(f.body);
  }

  /** Reads the two shapes the API answers with: Graph's `{ error: { message, code… } }` and the management's `{ error: '…' }`. */
  static from(status: number, body: unknown, retryAfter?: number): APIError {
    const root = isObject(body) ? body : {};
    const graph = isObject(root.error) ? root.error : undefined;
    const data = graph && isObject(graph.error_data) ? graph.error_data : undefined;
    const fields: APIErrorFields = {
      status,
      body,
      message: (graph && str(graph.message)) ?? str(root.error) ?? str(root.message) ?? (typeof body === 'string' && body ? body.slice(0, 200) : `Request failed with status ${status}.`),
      code: graph ? int(graph.code) : undefined,
      subcode: graph ? int(graph.error_subcode) : undefined,
      details: data ? str(data.details) : undefined,
      fbtraceId: graph ? str(graph.fbtrace_id) : undefined,
      feature: str(root.feature),
      reason: str(root.reason),
      retryAfter,
    };
    const { code } = fields;
    let Class: new (f: APIErrorFields) => APIError;
    if (code === 190) Class = AuthenticationError;
    else if (code !== undefined && PERMISSION_CODES.has(code)) Class = PermissionError;
    else if (code !== undefined && CONFLICT_CODES.has(code)) Class = ConflictError;
    else if (code === 1390003) Class = IdempotencyError;
    else if (code !== undefined && RATE_LIMIT_CODES.has(code)) Class = RateLimitError;
    else if (code === 1390009) Class = BadRequestError;
    else if (code === 100 && status !== 404) Class = BadRequestError;
    else if (status === 401) Class = AuthenticationError;
    else if (status === 403) Class = PermissionError;
    else if (status === 404) Class = NotFoundError;
    else if (status === 409) Class = ConflictError;
    else if (status === 422) Class = IdempotencyError;
    else if (status === 429) Class = RateLimitError;
    else if (status >= 500) Class = ServerError;
    else if (code !== undefined) Class = MetaError; // Meta's own error (131047, 131026…), passed through
    else if (status === 400) Class = BadRequestError;
    else Class = APIError;
    return new Class(fields);
  }

  override toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      status: this.status,
      code: this.code,
      subcode: this.subcode,
      message: this.message,
      details: this.details,
      fbtraceId: this.fbtraceId,
      retryAfter: this.retryAfter,
      feature: this.feature,
      reason: this.reason,
      body: this.body,
    };
  }
}

export class AuthenticationError extends APIError {
  constructor(f: APIErrorFields) {
    super(f);
    this.name = 'AuthenticationError';
  }
}
export class PermissionError extends APIError {
  constructor(f: APIErrorFields) {
    super(f);
    this.name = 'PermissionError';
  }
}
export class NotFoundError extends APIError {
  constructor(f: APIErrorFields) {
    super(f);
    this.name = 'NotFoundError';
  }
}
export class BadRequestError extends APIError {
  constructor(f: APIErrorFields) {
    super(f);
    this.name = 'BadRequestError';
  }
}
export class ConflictError extends APIError {
  constructor(f: APIErrorFields) {
    super(f);
    this.name = 'ConflictError';
  }
}
export class IdempotencyError extends APIError {
  constructor(f: APIErrorFields) {
    super(f);
    this.name = 'IdempotencyError';
  }
}
export class RateLimitError extends APIError {
  constructor(f: APIErrorFields) {
    super(f);
    this.name = 'RateLimitError';
  }
}
export class ServerError extends APIError {
  constructor(f: APIErrorFields) {
    super(f);
    this.name = 'ServerError';
  }
}
export class MetaError extends APIError {
  constructor(f: APIErrorFields) {
    super(f);
    this.name = 'MetaError';
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);
