import type { RequestOptions, Synergy } from '../client';
import { SynergyError } from '../errors';

export type OnboardingMode = 'cloud' | 'coexistence' | 'choice';
export type OnboardingStatus = 'pending' | 'opened' | 'completed' | 'expired' | 'cancelled' | 'blocked';

export interface OnboardingResult {
  instanceId: string;
  phoneNumberId: string;
  wabaId: string;
  displayPhoneNumber: string | null;
  mode: 'cloud' | 'coexistence';
}

export interface OnboardingSession {
  id: string;
  status: OnboardingStatus;
  /** The link to hand to the customer; `null` once the session is over. */
  url: string | null;
  mode: OnboardingMode;
  return: 'redirect' | 'popup';
  redirectUrl: string;
  state: string;
  externalRef: string | null;
  displayName: string;
  createdAt: string;
  expiresAt: string;
  blocked: { reason: 'plan_limit' | 'account_paused' | 'onboarding_cap'; message: string } | null;
  lastError: { reason: string; message: string; at: string } | null;
  /** The number that was connected, once `status` is `completed`. */
  result: OnboardingResult | null;
  raw: unknown;
}

export interface CreateSessionParams {
  /** One of the return URLs verified in the app (Desenvolvedores → Cadastro). */
  redirectUrl: string;
  /** Yours: comes back on the redirect and in the webhook. A random value per session; `verifyReturn` compares it. */
  state: string;
  /** What the customer sees: "{displayName} wants to connect your WhatsApp". */
  displayName: string;
  mode?: OnboardingMode;
  return?: 'redirect' | 'popup';
  /** Your own id for the customer (a tenant id). */
  externalRef?: string;
  /** Keys that get the new number (up to 10). */
  attachToKeyIds?: string[];
  /** Seconds the link lives: 300 to 3600, default 900. */
  expiresIn?: number;
}

/** What `verifyReturn` hands back: the session as the API holds it, never as the query string claims. */
export interface VerifiedReturn {
  /** From `GET /v1/onboarding-sessions/{id}`: the only source to release anything on. */
  session: OnboardingSession;
  completed: boolean;
  /** `session.result`: the connected number when `completed`, else `null`. */
  result: OnboardingResult | null;
}

interface WireSession {
  id: string;
  status: OnboardingStatus;
  url: string | null;
  mode: OnboardingMode;
  return: 'redirect' | 'popup';
  redirect_url: string;
  state: string;
  external_ref: string | null;
  display_name: string;
  created_at: string;
  expires_at: string;
  blocked: OnboardingSession['blocked'];
  last_error: OnboardingSession['lastError'];
  result: {
    instance_id: string;
    phone_number_id: string;
    waba_id: string;
    display_phone_number: string | null;
    mode: 'cloud' | 'coexistence';
  } | null;
}

// openapi.ts SESSION_ID_PATTERN: the id is in a path, so only this shape is allowed there
const SESSION_ID = /^obs_[A-Za-z0-9]{24}$/;

const session = (w: WireSession): OnboardingSession => ({
  id: w.id,
  status: w.status,
  url: w.url,
  mode: w.mode,
  return: w.return,
  redirectUrl: w.redirect_url,
  state: w.state,
  externalRef: w.external_ref,
  displayName: w.display_name,
  createdAt: w.created_at,
  expiresAt: w.expires_at,
  blocked: w.blocked,
  lastError: w.last_error,
  result: w.result && {
    instanceId: w.result.instance_id,
    phoneNumberId: w.result.phone_number_id,
    wabaId: w.result.waba_id,
    displayPhoneNumber: w.result.display_phone_number,
    mode: w.result.mode,
  },
  raw: w,
});

export class OnboardingSessionsResource {
  constructor(private readonly client: Synergy) {}

  /** `POST /v1/onboarding-sessions` (scope `onboarding`): a hosted-signup link for one customer. */
  async create(params: CreateSessionParams, options?: RequestOptions): Promise<OnboardingSession> {
    const raw = await this.client.request<WireSession>({
      method: 'POST',
      path: '/v1/onboarding-sessions',
      body: {
        redirect_url: params.redirectUrl,
        state: params.state,
        display_name: params.displayName,
        ...(params.mode && { mode: params.mode }),
        ...(params.return && { return: params.return }),
        ...(params.externalRef !== undefined && { external_ref: params.externalRef }),
        ...(params.attachToKeyIds && { attach_to_key_ids: params.attachToKeyIds }),
        ...(params.expiresIn !== undefined && { expires_in: params.expiresIn }),
      },
      retry: 'network',
      signal: options?.signal,
    });
    return session(raw);
  }

  /** `GET /v1/onboarding-sessions/{id}`. */
  async get(sessionId: string, options?: RequestOptions): Promise<OnboardingSession> {
    const raw = await this.client.request<WireSession>({ method: 'GET', path: sessionPath(sessionId), retry: 'safe', signal: options?.signal });
    return session(raw);
  }

  /** `POST /v1/onboarding-sessions/{id}/cancel`: the link stops working. */
  async cancel(sessionId: string, options?: RequestOptions): Promise<OnboardingSession> {
    const raw = await this.client.request<WireSession>({ method: 'POST', path: `${sessionPath(sessionId)}/cancel`, retry: 'network', signal: options?.signal });
    return session(raw);
  }
}

export type ReturnQuery = URL | URLSearchParams | string | Record<string, string | string[] | undefined>;

export class OnboardingResource {
  readonly sessions: OnboardingSessionsResource;

  constructor(private readonly client: Synergy) {
    this.sessions = new OnboardingSessionsResource(client);
  }

  /**
   * ES-14: what to run when the customer lands on your `redirectUrl`. The query string is a hint anyone can write, so
   * this never trusts it: it checks that `state` (once, as a single value) is the one you stored for this customer,
   * then reads the session from the API by `session_id` and checks that the session carries the same `state`. Only then
   * does it answer, and `completed` comes from the session, never from `?status=completed`.
   * Anything off throws `SynergyError`, before or after the call, and nothing is released.
   */
  async verifyReturn(query: ReturnQuery, options: { expectedState: string; signal?: AbortSignal }): Promise<VerifiedReturn> {
    const expected = options?.expectedState;
    if (typeof expected !== 'string' || expected.trim() === '') throw new SynergyError('verifyReturn needs `expectedState`: the state you stored when you created the session.');
    const params = toParams(query);
    const id = single(params, 'session_id');
    const state = single(params, 'state');
    if (id === null || !SESSION_ID.test(id)) throw new SynergyError('Onboarding return rejected: the query has no valid `session_id`.');
    if (state === null || !sameText(state, expected)) throw new SynergyError('Onboarding return rejected: `state` does not match the one you stored.');
    const found = await this.sessions.get(id, { signal: options.signal });
    if (found.id !== id || !sameText(found.state, expected)) throw new SynergyError('Onboarding return rejected: the session does not carry the state you stored.');
    return { session: found, completed: found.status === 'completed', result: found.result };
  }
}

function sessionPath(sessionId: string): string {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new SynergyError('sessionId must be the `id` of an onboarding session (`obs_…`).');
  return `/v1/onboarding-sessions/${sessionId}`;
}

function toParams(query: ReturnQuery): URLSearchParams {
  if (query instanceof URL) return query.searchParams;
  if (query instanceof URLSearchParams) return query;
  if (typeof query === 'string') return new URLSearchParams(query.startsWith('?') ? query.slice(1) : query.includes('?') ? query.slice(query.indexOf('?') + 1) : query);
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) for (const item of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.append(k, item);
  return out;
}

// exactly one value: a repeated parameter (`?state=a&state=b`) is how a proxy and an app read two different things
function single(params: URLSearchParams, name: string): string | null {
  const all = params.getAll(name);
  return all.length === 1 ? (all[0] ?? null) : null;
}

// the state is a CSRF token of yours: compared over its whole length, no early exit
function sameText(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
