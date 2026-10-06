import { createHmac } from 'node:crypto';
import Synergy, { type SynergyOptions } from '../src/index';

export const API_KEY = 'syn_org123_abcdefSECRETvalue0123456789_1a2b';
export const PNID = '106540352242922';

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  init: RequestInit;
}

type Step = Response | Error | ((call: Call) => Response | Promise<Response>);

/** A `fetch` that answers with the given steps in order and records every call. */
export function fakeFetch(...steps: Step[]) {
  const calls: Call[] = [];
  const impl = (async (input: unknown, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    const call: Call = { url: String(input), method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body, init };
    calls.push(call);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step === undefined) throw new Error('fakeFetch: no step');
    if (step instanceof Error) throw step;
    return typeof step === 'function' ? step(call) : step.clone();
  }) as typeof fetch;
  return { fetch: impl, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export const graphError = (status: number, code: number, message = 'boom', headers: Record<string, string> = {}) =>
  json({ error: { message: `(#${code}) ${message}`, type: 'OAuthException', code, fbtrace_id: 'syn-abcd1234' } }, status, headers);

export const SENT = { messaging_product: 'whatsapp', contacts: [{ input: '5511999999999', wa_id: '5511999999999' }], messages: [{ id: 'wamid.ABC' }] };

export function client(f: typeof fetch, options: SynergyOptions = {}) {
  return new Synergy({ apiKey: API_KEY, fetch: f, retryDelay: 0, ...options });
}

export const hubSignature = (body: string | Uint8Array, secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
export const synergySignature = (body: string, secret: string, deliveryId: string, t: number) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${deliveryId}.${body}`).digest('hex')}`;
