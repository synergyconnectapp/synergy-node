import { camelize } from '../case';
import type { RequestOptions, Synergy } from '../client';

export type ConversationStatus = 'pending' | 'open' | 'resolved' | 'automated';

export interface Handoff {
  success: true;
  status: ConversationStatus;
  raw: unknown;
}

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
}
