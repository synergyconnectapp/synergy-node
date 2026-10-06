import { camelize } from './case';
import { AbortError, APIError, ConnectionError, SynergyError, TimeoutError } from './errors';
import { NumberClient } from './number';
import { OnboardingResource } from './resources/onboarding';
import { WebhooksResource } from './resources/webhooks-admin';
import { VERSION } from './version';

export const DEFAULT_BASE_URL = 'https://api.synergyconnect.com.br';
export const DEFAULT_GRAPH_VERSION = 'v25.0';
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRY_AFTER_S = 30;
const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_BACKOFF_MS = 8_000;

export interface SynergyOptions {
  /** Absent → reads `SYNERGY_API_KEY`; still absent → throws. */
  apiKey?: string;
  /** `https` only (`http` only for localhost with `allowInsecureLocalhost`). */
  baseURL?: string;
  graphVersion?: string;
  maxRetries?: number;
  /** Per attempt, in milliseconds. */
  timeout?: number;
  /** Injectable `fetch` (Workers, tests, a service binding). */
  fetch?: typeof fetch;
  /** With a `window` and without this, the constructor throws: the key must not ship to a browser. */
  dangerouslyAllowBrowser?: boolean;
  allowInsecureLocalhost?: boolean;
  /** Appended to `User-Agent: synergy-node/<version>` (the MCP uses it). */
  userAgentSuffix?: string;
  /** Longest `Retry-After` honored for a 429 `130429`, in seconds. Default 30. */
  maxRetryAfter?: number;
  /** First backoff step in milliseconds. Default 500. */
  retryDelay?: number;
}

/** Per-call options of every method that reads or writes without a message. */
export interface RequestOptions {
  signal?: AbortSignal;
}

/**
 * How a call may be retried (devtools.md §5.5):
 * - `safe`: GET and `POST …/search`: network, timeout, 5xx, 429 `130429`.
 * - `send`: `messages.*`: the same plus `409 1390002`, always with the SAME `Idempotency-Key`.
 * - `network`: upload, management and writes: only a network error BEFORE any response; never after a status.
 */
export type RetryPolicy = 'safe' | 'send' | 'network';

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  retry: RetryPolicy;
  signal?: AbortSignal;
  /** Return the `Response` (its body unread) when it is a 2xx. */
  stream?: boolean;
}

export interface Me {
  key: {
    id: string;
    name: string;
    last4: string;
    scopes: string[];
    mode: 'notify' | 'bot';
    origin: 'manual' | 'mcp';
    instanceIds: string[] | null;
    assistant: { hourly: number; daily: number; replyOnly: boolean } | null;
  };
  organization: { id: string };
  plan: { api: boolean; inbox: boolean; waFlows: boolean; mode: 'normal' | 'readonly' | 'suspended' };
  raw: unknown;
}

export interface NumberInfo {
  id: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  alias: string | null;
  wabaId: string;
  mode: 'cloud' | 'coexistence';
  status: 'active' | 'onboarding' | 'disconnected' | 'frozen';
}

export interface NumbersList {
  data: NumberInfo[];
  raw: unknown;
}

// Synergy's own codes (139xxxx) are never retried by the client, except 1390002; only Meta's 130429 is
const isOwnCode = (code: number | undefined) => code !== undefined && code >= 1_390_000;

export class Synergy {
  readonly graphVersion: string;
  readonly numbers: { list: (options?: RequestOptions) => Promise<NumbersList> };
  /** The organization's webhooks (scope `management`). */
  readonly webhooks: WebhooksResource;
  /** Hosted WhatsApp signup for your customers (scope `onboarding`). */
  readonly onboarding: OnboardingResource;

  readonly #apiKey: string;
  readonly #origin: string;
  readonly #basePath: string;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;
  readonly #timeout: number;
  readonly #maxRetryAfter: number;
  readonly #retryDelay: number;
  readonly #userAgent: string;

  constructor(options: SynergyOptions = {}) {
    const g = globalThis as { window?: unknown };
    if (typeof g.window !== 'undefined' && !options.dangerouslyAllowBrowser) {
      throw new SynergyError(
        'This looks like a browser: an API key shipped to a browser is exposed to anyone. Call the Synergy API from your server. ' +
          'If you really mean it (a throwaway key, a local tool), pass `dangerouslyAllowBrowser: true`.',
      );
    }
    const apiKey = options.apiKey ?? readEnv('SYNERGY_API_KEY');
    if (typeof apiKey !== 'string' || apiKey.trim() === '') {
      throw new SynergyError('Missing API key: pass `apiKey` or set the SYNERGY_API_KEY environment variable.');
    }
    this.#apiKey = apiKey.trim();

    const base = parseBaseURL(options.baseURL ?? DEFAULT_BASE_URL, options.allowInsecureLocalhost === true);
    this.#origin = base.origin;
    this.#basePath = base.pathname.replace(/\/+$/, '');

    if (typeof options.fetch !== 'function' && typeof globalThis.fetch !== 'function') {
      throw new SynergyError('No `fetch` available: pass one in the options.');
    }
    // bound to globalThis: Workers throw "Illegal invocation" on a detached fetch
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.graphVersion = options.graphVersion ?? DEFAULT_GRAPH_VERSION;
    if (!/^v\d+\.\d+$/.test(this.graphVersion)) throw new SynergyError('graphVersion must look like "v25.0".');
    this.#maxRetries = nonNegative(options.maxRetries, DEFAULT_MAX_RETRIES, 'maxRetries');
    this.#timeout = nonNegative(options.timeout, DEFAULT_TIMEOUT_MS, 'timeout');
    this.#maxRetryAfter = nonNegative(options.maxRetryAfter, DEFAULT_MAX_RETRY_AFTER_S, 'maxRetryAfter');
    this.#retryDelay = nonNegative(options.retryDelay, DEFAULT_RETRY_DELAY_MS, 'retryDelay');
    this.#userAgent = `synergy-node/${VERSION}${options.userAgentSuffix ? ` ${options.userAgentSuffix}` : ''}`;

    this.webhooks = new WebhooksResource(this);
    this.onboarding = new OnboardingResource(this);
    this.numbers = {
      list: async (o) => {
        const raw = await this.request({ method: 'GET', path: '/v1/numbers', retry: 'safe', signal: o?.signal });
        return { ...camelize<{ data: NumberInfo[] }>(raw), raw };
      },
    };
  }

  /** `GET /v1/me`: who this key is, its organization and what the plan allows. */
  async me(options?: RequestOptions): Promise<Me> {
    const raw = await this.request({ method: 'GET', path: '/v1/me', retry: 'safe', signal: options?.signal });
    return { ...camelize<Omit<Me, 'raw'>>(raw), raw };
  }

  /** The client of one WhatsApp number (`phone_number_id`). */
  number(phoneNumberId: string): NumberClient {
    return new NumberClient(this, phoneNumberId);
  }

  // `Authorization` goes ONLY to the exact origin of `baseURL`: the URL is built with `new URL` and the result is checked
  #url(path: string, query?: Record<string, string>): URL {
    const url = new URL(`${this.#basePath}${path}`, this.#origin);
    if (url.origin !== this.#origin) throw new SynergyError('Refusing to send the API key to an origin other than baseURL.');
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    return url;
  }

  /** Runs a call with the retry rules of its policy and returns the parsed JSON. @internal */
  async request<T = unknown>(req: ApiRequest): Promise<T> {
    return (await this.#execute(req)).body as T;
  }

  /** Same, but returns the `Response` of a 2xx without reading its body. @internal */
  async requestStream(req: ApiRequest): Promise<Response> {
    const { response } = await this.#execute({ ...req, stream: true });
    return response as Response;
  }

  async #execute(req: ApiRequest): Promise<{ body: unknown; response?: Response }> {
    const url = this.#url(req.path, req.query);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#once(url, req);
      } catch (err) {
        const wait = attempt < this.#maxRetries ? this.#retryWait(err, req.retry, attempt) : null;
        if (wait === null) throw err;
        await sleep(wait, req.signal);
      }
    }
  }

  async #once(url: URL, req: ApiRequest): Promise<{ body: unknown; response?: Response }> {
    if (req.signal?.aborted) throw new AbortError();
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeout);
    const onAbort = () => controller.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });
    const failure = (cause: unknown): SynergyError => {
      if (timedOut) return new TimeoutError(undefined, { cause });
      if (req.signal?.aborted) return new AbortError(undefined, { cause });
      return new ConnectionError(undefined, { cause });
    };

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: 'application/json',
      'User-Agent': this.#userAgent,
      ...req.headers,
    };
    let body: BodyInit | undefined;
    if (req.body instanceof FormData) body = req.body;
    else if (req.body !== undefined) {
      body = JSON.stringify(req.body);
      headers['Content-Type'] = 'application/json';
    }

    try {
      let res: Response;
      try {
        res = await this.#fetch(url.toString(), { method: req.method, headers, body, redirect: 'error', signal: controller.signal });
      } catch (cause) {
        throw failure(cause);
      }
      // `redirect: 'error'` makes a real fetch reject; a fetch that hands one back is refused here too
      if ((res.status >= 300 && res.status < 400) || res.redirected || res.type === 'opaqueredirect') {
        await res.body?.cancel().catch(() => {});
        throw new SynergyError(`Refusing to follow a redirect (status ${res.status}): the API key never leaves the API host.`);
      }
      if (res.ok && req.stream) return { body: undefined, response: res };

      let text: string;
      try {
        text = await res.text();
      } catch (cause) {
        throw failure(cause);
      }
      const parsed = parseBody(text);
      if (!res.ok) throw APIError.from(res.status, parsed, retryAfterSeconds(res.headers));
      if (text !== '' && typeof parsed === 'string') throw new SynergyError(`Unexpected non-JSON answer from the API (status ${res.status}).`);
      return { body: parsed };
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  }

  // null = do not retry; otherwise the wait in milliseconds
  #retryWait(err: unknown, policy: RetryPolicy, attempt: number): number | null {
    const backoff = () => Math.min(MAX_BACKOFF_MS, this.#retryDelay * 2 ** attempt) * (0.5 + Math.random() / 2);
    if (err instanceof ConnectionError) return backoff();
    if (err instanceof TimeoutError) return policy === 'network' ? null : backoff();
    if (!(err instanceof APIError) || policy === 'network') return null;

    const afterMs = () => {
      if (err.retryAfter === undefined) return backoff();
      return err.retryAfter <= this.#maxRetryAfter ? err.retryAfter * 1000 : null;
    };
    if (err.status === 429) return isOwnCode(err.code) ? null : afterMs();
    if (err.status === 409 && err.code === 1_390_002) return policy === 'send' ? afterMs() : null;
    if (err.status >= 500) return afterMs();
    return null;
  }
}

function readEnv(name: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> }; Deno?: { env?: { get(k: string): string | undefined } } };
  try {
    return g.process?.env?.[name] ?? g.Deno?.env?.get(name);
  } catch {
    return undefined; // Deno without --allow-env
  }
}

function parseBaseURL(input: string, allowInsecureLocalhost: boolean): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new SynergyError('baseURL is not a valid URL.');
  }
  if (url.username || url.password) throw new SynergyError('baseURL must not carry credentials.');
  if (url.protocol === 'https:') return url;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol === 'http:' && local && allowInsecureLocalhost) return url;
  throw new SynergyError('baseURL must be https (http only for localhost, with `allowInsecureLocalhost: true`).');
}

function nonNegative(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new SynergyError(`${name} must be a non-negative number.`);
  return value;
}

// undefined = empty body; a string = not JSON (an HTML error page from a proxy, kept short for the message)
function parseBody(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 2_000);
  }
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
