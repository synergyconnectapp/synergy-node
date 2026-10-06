import { camelize } from '../case';
import type { RequestOptions, Synergy } from '../client';
import { SynergyError } from '../errors';

// Meta's flow id (flows/token.ts FLOW_ID_RE)
const FLOW_ID = /^\d{5,25}$/;

export interface FlowToken {
  flowToken: string;
  /** ISO 8601. */
  expiresAt: string;
  raw: unknown;
}

export class FlowsResource {
  constructor(
    private readonly client: Synergy,
    private readonly phoneNumberId: string,
  ) {}

  /** `POST /v1/numbers/{id}/flows/{flowId}/token`: the `flow_token` a flow with a Synergy endpoint needs to be sent. */
  async createToken(params: { flowId: string; to: string; context?: Record<string, string> }, options?: RequestOptions): Promise<FlowToken> {
    if (typeof params.flowId !== 'string' || !FLOW_ID.test(params.flowId)) throw new SynergyError('flowId must be Meta\'s flow id (5 to 25 digits).');
    const raw = await this.client.request({
      method: 'POST',
      path: `/v1/numbers/${this.phoneNumberId}/flows/${params.flowId}/token`,
      body: { to: params.to, ...(params.context && { context: params.context }) },
      retry: 'network',
      signal: options?.signal,
    });
    return { ...camelize<Omit<FlowToken, 'raw'>>(raw), raw };
  }
}
