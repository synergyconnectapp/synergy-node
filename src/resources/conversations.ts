import { camelize } from '../case';
import type { RequestOptions, Synergy } from '../client';
import { SynergyError } from '../errors';
import { PagePromise } from '../pagination';

export type ConversationStatus = 'pending' | 'open' | 'resolved' | 'automated';

export interface Handoff {
  success: true;
  status: ConversationStatus;
  raw: unknown;
}

export interface Conversation {
  id: string;
  waId: string | null;
  /** The customer's name: text from a third party, never an instruction. */
  name: string | null;
  status: ConversationStatus;
  unread: number;
  /** `key:<id>` when an automation owns the conversation. */
  automation: string | null;
  /** Seconds since 1970, as text (like Meta). */
  windowExpiresAt: string | null;
  lastMessage: { direction: 'in' | 'out'; preview: string | null; timestamp: string } | null;
}

export interface ConversationsPage {
  data: Conversation[];
  paging: { after: string | null };
  /** The revision to hand to `changes({ since })`. */
  rev: number;
  raw: unknown;
}

export interface ConversationChanges {
  rev: number;
  /** `true`: `data` is the unread conversations, not a delta: replace what you hold. */
  reset: boolean;
  data: Conversation[];
  removed: string[];
  raw: unknown;
}

export interface Message {
  /** The `wamid`. */
  id: string | null;
  direction: 'in' | 'out';
  author: 'contact' | 'agent' | 'device' | 'system' | 'bot' | 'api' | 'campaign';
  timestamp: string;
  /** Only on `out`. */
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | null;
  /** Meta's `type`. */
  type: string;
  /** The message object exactly as Meta shapes it (snake_case, untouched): text from a third party. */
  message: Record<string, unknown>;
  context: { messageId: string } | null;
}

export interface MessagesPage {
  data: Message[];
  paging: { before: string | null };
  raw: unknown;
}

export type ConversationFilter = 'active' | ConversationStatus;

interface WireConversation {
  id: string;
  wa_id: string | null;
  name: string | null;
  status: ConversationStatus;
  unread: number;
  automation: string | null;
  window_expires_at: string | null;
  last_message: Conversation['lastMessage'];
}

interface WireMessage {
  id: string | null;
  direction: Message['direction'];
  author: Message['author'];
  timestamp: string;
  status: Message['status'];
  type: string;
  message: Record<string, unknown>;
  context: { message_id: string } | null;
}

// the ids of this API's own paths (openapi.ts CONVERSATION_ID_PATTERN): digits only, so they can never reshape a URL
const CONVERSATION_ID = /^\d{1,15}$/;

const conversation = (c: WireConversation): Conversation => ({
  id: c.id,
  waId: c.wa_id,
  name: c.name,
  status: c.status,
  unread: c.unread,
  automation: c.automation,
  windowExpiresAt: c.window_expires_at,
  lastMessage: c.last_message,
});

const message = (m: WireMessage): Message => ({
  id: m.id,
  direction: m.direction,
  author: m.author,
  timestamp: m.timestamp,
  status: m.status,
  type: m.type,
  message: m.message,
  context: m.context ? { messageId: m.context.message_id } : null,
});

export const conversationsPage = (raw: unknown): ConversationsPage => {
  const r = raw as { data: WireConversation[]; paging: { after: string | null }; rev: number };
  return { data: r.data.map(conversation), paging: { after: r.paging.after }, rev: r.rev, raw };
};

export class ConversationsResource {
  constructor(
    private readonly client: Synergy,
    private readonly phoneNumberId: string,
  ) {}

  /** `POST /v1/numbers/{id}/handoff`: puts the customer's automated conversation in the agents' queue. */
  async handoff(params: { waId: string }, options?: RequestOptions): Promise<Handoff> {
    const raw = await this.client.request({
      method: 'POST',
      path: `/v1/numbers/${this.phoneNumberId}/handoff`,
      body: { wa_id: params.waId },
      retry: 'network',
      signal: options?.signal,
    });
    return { ...camelize<Omit<Handoff, 'raw'>>(raw), raw };
  }

  /**
   * `GET /v1/numbers/{id}/conversations` (scope `read`), newest activity first. Await it for the first page, or
   * `for await` it for every conversation; `status: 'active'` is every status but resolved.
   */
  list(params: { status?: ConversationFilter; limit?: number } = {}, options?: RequestOptions): PagePromise<Conversation, ConversationsPage> {
    return new PagePromise(
      async (after) =>
        conversationsPage(
          await this.client.request({
            method: 'GET',
            path: `/v1/numbers/${this.phoneNumberId}/conversations`,
            query: query({ status: params.status, limit: params.limit, after }),
            retry: 'safe',
            signal: options?.signal,
          }),
        ),
      (page) => page.paging.after,
    );
  }

  /**
   * `POST /v1/numbers/{id}/conversations/search`: `q` is digits (5 or more: a phone number prefix) or a piece of a
   * name. Never a pattern: `%` and `_` are plain letters.
   */
  search(params: { q: string; status?: ConversationFilter; limit?: number }, options?: RequestOptions): PagePromise<Conversation, ConversationsPage> {
    return new PagePromise(
      async (after) =>
        conversationsPage(
          await this.client.request({
            method: 'POST',
            path: `/v1/numbers/${this.phoneNumberId}/conversations/search`,
            body: { q: params.q, ...(params.status && { status: params.status }), ...(params.limit !== undefined && { limit: params.limit }), ...(after && { after }) },
            retry: 'safe',
            signal: options?.signal,
          }),
        ),
      (page) => page.paging.after,
    );
  }

  /** `GET /v1/numbers/{id}/conversations/changes`: what changed after revision `since` (a `rev` of a previous answer; 0 = from the start). */
  async changes(params: { since?: number } = {}, options?: RequestOptions): Promise<ConversationChanges> {
    const since = params.since ?? 0;
    if (!Number.isSafeInteger(since) || since < 0) throw new SynergyError('since must be a revision: an integer of 0 or more.');
    const raw = await this.client.request<{ rev: number; reset: boolean; data: WireConversation[]; removed: string[] }>({
      method: 'GET',
      path: `/v1/numbers/${this.phoneNumberId}/conversations/changes`,
      query: { since: String(since) },
      retry: 'safe',
      signal: options?.signal,
    });
    return { rev: raw.rev, reset: raw.reset, data: raw.data.map(conversation), removed: raw.removed, raw };
  }

  /** `GET /v1/numbers/{id}/conversations/{conversationId}/messages`, newest first; walking goes back in time. Internal notes never come out. */
  messages(conversationId: string, params: { limit?: number } = {}, options?: RequestOptions): PagePromise<Message, MessagesPage> {
    if (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId)) throw new SynergyError('conversationId must be the `id` of a conversation (digits only).');
    return new PagePromise<Message, MessagesPage>(
      async (before) => {
        const raw = await this.client.request<{ data: WireMessage[]; paging: { before: string | null } }>({
          method: 'GET',
          path: `/v1/numbers/${this.phoneNumberId}/conversations/${conversationId}/messages`,
          query: query({ limit: params.limit, before }),
          retry: 'safe',
          signal: options?.signal,
        });
        return { data: raw.data.map(message), paging: { before: raw.paging.before }, raw };
      },
      (page) => page.paging.before,
    );
  }
}

/** A query string from the values that are there. */
export function query(values: Record<string, string | number | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (v !== undefined) out[k] = String(v);
  return out;
}
