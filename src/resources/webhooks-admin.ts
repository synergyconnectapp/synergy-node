import type { RequestOptions, Synergy } from '../client';
import { APIError, SynergyError } from '../errors';

/** A field a webhook can subscribe to: Meta's own (`messages`, `statuses`…) and ours (`synergy_conversations`, `synergy_onboarding`…). */
export type WebhookField = string;
export type WebhookStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface Webhook {
  id: string;
  url: string;
  fields: WebhookField[];
  /** `null`: every status. */
  statuses: WebhookStatus[] | null;
  /** The numbers it covers (`instance_id` of `numbers.list()`); `null`: every number of the key. */
  instanceIds: string[] | null;
  enabled: boolean;
  verification: 'ping' | 'meta';
  /** The names of its custom headers; the values are never returned. */
  headerNames: string[] | null;
  disabledReason: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  name: string | null;
}

export interface WebhookHealth {
  state: 'healthy' | 'degraded' | 'suspended';
  pending: number;
  lastError: string | null;
  lastFailureAt: number | null;
  dropped: number;
  droppedAt: number | null;
  nextAt: number | null;
}

export interface WebhookDeliveryStats {
  delivered: number;
  failed: number;
  timeouts: number;
  avgMs: number | null;
  lastSuccessAt: number | null;
}

export type WebhooksStats = { available: false } | { available: true; hours: 24 | 168; stats: Record<string, WebhookDeliveryStats> };

export interface CreateWebhookParams {
  url: string;
  fields: WebhookField[];
  statuses?: WebhookStatus[] | null;
  /** Absent or `null`: every number of the key. */
  instanceIds?: string[] | null;
  name?: string | null;
  /** `ping` (default): a signed test POST answered with 2xx. `meta`: Meta's `hub.challenge` handshake, which needs `verifyToken`. */
  verification?: 'ping' | 'meta';
  verifyToken?: string;
  /** Custom headers of every delivery (up to 10). */
  headers?: Record<string, string>;
}

export interface UpdateWebhookParams {
  url?: string;
  fields?: WebhookField[];
  statuses?: WebhookStatus[] | null;
  instanceIds?: string[] | null;
  name?: string | null;
  enabled?: boolean;
  verification?: 'ping' | 'meta';
  verifyToken?: string;
  /** A `null` value removes that header. */
  headers?: Record<string, string | null>;
}

const HOOK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `synergy.webhooks`: the webhooks of the organization (scope `management`). The `secret` comes back ONCE, from `create`
 * and `rotateSecret`: keep it, it is what `webhooks.verify` needs.
 */
export class WebhooksResource {
  constructor(private readonly client: Synergy) {}

  async list(options?: RequestOptions): Promise<{ data: Webhook[]; raw: unknown }> {
    const raw = await this.client.request<{ data: Webhook[] }>({ method: 'GET', path: '/v1/webhooks', retry: 'safe', signal: options?.signal });
    return { data: raw.data, raw };
  }

  /** There is no single-webhook route: this lists and picks, so it throws `NotFoundError` for an id that is not there. */
  async get(hookId: string, options?: RequestOptions): Promise<Webhook & { raw: unknown }> {
    const id = hookPath(hookId);
    const { data, raw } = await this.list(options);
    const hook = data.find((h) => h.id.toLowerCase() === id.toLowerCase());
    if (!hook) throw APIError.from(404, { error: 'Webhook not found' });
    return { ...hook, raw };
  }

  /** `POST /v1/webhooks`. */
  async create(params: CreateWebhookParams, options?: RequestOptions): Promise<{ row: Webhook; secret: string; pending: number; raw: unknown }> {
    const raw = await this.client.request<{ row: Webhook; secret: string; pending: number }>({
      method: 'POST',
      path: '/v1/webhooks',
      body: {
        url: params.url,
        fields: params.fields,
        // the API wants it in the body: null = every number of the key
        instanceIds: params.instanceIds ?? null,
        ...(params.statuses !== undefined && { statuses: params.statuses }),
        ...(params.name !== undefined && { name: params.name }),
        ...(params.verification && { verification: params.verification }),
        ...(params.verifyToken !== undefined && { verifyToken: params.verifyToken }),
        ...(params.headers && { headers: params.headers }),
      },
      retry: 'network',
      signal: options?.signal,
    });
    return { row: raw.row, secret: raw.secret, pending: raw.pending, raw };
  }

  /** `PATCH /v1/webhooks/{hookId}`: only what is passed changes. */
  async update(hookId: string, params: UpdateWebhookParams, options?: RequestOptions): Promise<{ row: Webhook; pending: number; raw: unknown }> {
    const raw = await this.client.request<{ row: Webhook; pending: number }>({
      method: 'PATCH',
      path: `/v1/webhooks/${hookPath(hookId)}`,
      body: params,
      retry: 'network',
      signal: options?.signal,
    });
    return { row: raw.row, pending: raw.pending, raw };
  }

  async delete(hookId: string, options?: RequestOptions): Promise<{ ok: true; pending: number; raw: unknown }> {
    const raw = await this.client.request<{ ok: true; pending: number }>({
      method: 'DELETE',
      path: `/v1/webhooks/${hookPath(hookId)}`,
      retry: 'network',
      signal: options?.signal,
    });
    return { ok: raw.ok, pending: raw.pending, raw };
  }

  /** The old secret stops working at once: the new one is only in this answer. */
  async rotateSecret(hookId: string, options?: RequestOptions): Promise<{ secret: string; pending: number; raw: unknown }> {
    const raw = await this.client.request<{ secret: string; pending: number }>({
      method: 'POST',
      path: `/v1/webhooks/${hookPath(hookId)}/rotate-secret`,
      retry: 'network',
      signal: options?.signal,
    });
    return { secret: raw.secret, pending: raw.pending, raw };
  }

  /** Sends one signed `synergy_ping` to the webhook. */
  async test(hookId: string, options?: RequestOptions): Promise<{ ok: true; raw: unknown }> {
    const raw = await this.client.request<{ ok: true }>({ method: 'POST', path: `/v1/webhooks/${hookPath(hookId)}/test`, retry: 'network', signal: options?.signal });
    return { ok: raw.ok, raw };
  }

  /** Retries the deliveries that are waiting, now. */
  async retry(hookId: string, options?: RequestOptions): Promise<{ ok: true; retrying: number; suspended: number; raw: unknown }> {
    const raw = await this.client.request<{ ok: true; retrying: number; suspended: number }>({
      method: 'POST',
      path: `/v1/webhooks/${hookPath(hookId)}/retry`,
      retry: 'network',
      signal: options?.signal,
    });
    return { ok: raw.ok, retrying: raw.retrying, suspended: raw.suspended, raw };
  }

  /** Sends again the events since `since` (a `Date` or milliseconds since 1970, within the last 30 days). */
  async replay(hookId: string, params: { since: Date | number }, options?: RequestOptions) {
    const since = params.since instanceof Date ? params.since.getTime() : params.since;
    if (typeof since !== 'number' || !Number.isSafeInteger(since)) throw new SynergyError('replay `since` must be a Date or an integer of milliseconds since 1970.');
    const raw = await this.client.request<{ ok: true; queued: number; truncated: boolean; suspended: number; failed: number }>({
      method: 'POST',
      path: `/v1/webhooks/${hookPath(hookId)}/replay`,
      body: { since },
      retry: 'network',
      signal: options?.signal,
    });
    return { ok: raw.ok, queued: raw.queued, truncated: raw.truncated, suspended: raw.suspended, failed: raw.failed, raw };
  }

  /** The state of the delivery queue of each webhook, by webhook id. */
  async health(options?: RequestOptions): Promise<{ data: Record<string, WebhookHealth>; raw: unknown }> {
    const raw = await this.client.request<{ data: Record<string, WebhookHealth> }>({ method: 'GET', path: '/v1/webhooks/health', retry: 'safe', signal: options?.signal });
    return { data: raw.data, raw };
  }

  /** Deliveries of the last `hours` (24 or 168), by webhook id. */
  async stats(params: { hours?: 24 | 168 } = {}, options?: RequestOptions): Promise<{ data: WebhooksStats; raw: unknown }> {
    const raw = await this.client.request<{ data: WebhooksStats }>({
      method: 'GET',
      path: '/v1/webhooks/stats',
      ...(params.hours !== undefined && { query: { hours: String(params.hours) } }),
      retry: 'safe',
      signal: options?.signal,
    });
    return { data: raw.data, raw };
  }
}

function hookPath(hookId: string): string {
  if (typeof hookId !== 'string' || !HOOK_ID.test(hookId)) throw new SynergyError('hookId must be the `id` of a webhook (a UUID).');
  return hookId;
}
