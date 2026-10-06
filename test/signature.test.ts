import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { constructEvent, verify, webhooks } from '../src/webhooks';
import { WebhookSignatureError } from '../src/errors';
import { hubSignature } from './helpers';
import { SIGNATURE_EXAMPLE as HUB, TIMESTAMPED_SIGNATURE_EXAMPLE as TS } from './vectors';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(TS.t * 1000));
});
afterEach(() => vi.useRealTimers());

describe('the test vectors of the contract (E2-4)', () => {
  it('the HMAC of X-Hub-Signature-256 matches the vector', async () => {
    expect(await verify(HUB.body, { 'X-Hub-Signature-256': HUB.header }, HUB.secret)).toBe(true);
  });

  it('the timestamped X-Synergy-Signature matches the vector', async () => {
    const headers = { 'X-Synergy-Signature': TS.header, 'X-Synergy-Delivery-Id': TS.deliveryId };
    expect(await verify(TS.body, headers, TS.secret)).toBe(true);
  });

  it('constructEvent: timestamped, with the ping as a generic change and no WABA', async () => {
    const event = await constructEvent(TS.body, { 'x-synergy-signature': TS.header, 'x-synergy-delivery-id': TS.deliveryId }, TS.secret);
    expect(event).toMatchObject({ deliveryId: TS.deliveryId, timestamped: true, object: 'whatsapp_business_account', instanceId: null, wabaId: null });
    expect(event.changes).toEqual([{ field: 'synergy_ping', value: { messaging_product: 'whatsapp', ping: true, timestamp: '1767225600' } }]);
  });

  it('constructEvent without X-Synergy-Signature falls back to X-Hub-Signature-256 and says so', async () => {
    const event = await constructEvent(HUB.body, { 'X-Hub-Signature-256': HUB.header, 'X-Synergy-Delivery-Id': 'ev-1' }, HUB.secret);
    expect(event.timestamped).toBe(false);
    expect(event.deliveryId).toBe('ev-1');
  });

  it('accepts a Headers object, Node-style array values and every raw body type', async () => {
    const headers = new Headers({ 'X-Hub-Signature-256': HUB.header });
    expect(await verify(HUB.body, headers, HUB.secret)).toBe(true);
    expect(await verify(HUB.body, { 'x-hub-signature-256': [HUB.header] }, HUB.secret)).toBe(true);
    const bytes = new TextEncoder().encode(HUB.body);
    expect(await verify(bytes, headers, HUB.secret)).toBe(true);
    expect(await verify(bytes.buffer as ArrayBuffer, headers, HUB.secret)).toBe(true);
    expect(await verify(Buffer.from(HUB.body), headers, HUB.secret)).toBe(true);
  });

  it('exposes verify and constructEvent as `webhooks`', () => {
    expect(webhooks.verify).toBe(verify);
    expect(webhooks.constructEvent).toBe(constructEvent);
  });
});

describe('the envelope', () => {
  const sign = (body: string) => ({ 'X-Hub-Signature-256': hubSignature(body, 's3cret') });

  it('types a WhatsApp envelope: WABA, instance and the changes in order', async () => {
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: '102290129340398', time: 1, changes: [
        { field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '1', phone_number_id: '2' }, messages: [] } },
        { field: 'synergy_onboarding', value: { event: 'onboarding.expired' } },
      ] }],
    });
    const event = await constructEvent(body, { ...sign(body), 'X-Synergy-Instance-Id': 'a'.repeat(64) }, 's3cret');
    expect(event.wabaId).toBe('102290129340398');
    expect(event.instanceId).toBe('a'.repeat(64));
    expect(event.changes.map((c) => c.field)).toEqual(['messages', 'synergy_onboarding']);
  });

  it('an Instagram envelope (S-10.3) passes the same check and never throws: wabaId null, generic changes', async () => {
    const body = JSON.stringify({ object: 'instagram', entry: [{ id: '17841400000000000', time: 1, changes: [{ field: 'comments', value: { id: 'c1', text: 'oi' } }] }] });
    const event = await constructEvent(body, sign(body), 's3cret');
    expect(event.object).toBe('instagram');
    expect(event.wabaId).toBeNull();
    expect(event.changes).toEqual([{ field: 'comments', value: { id: 'c1', text: 'oi' } }]);
  });

  it('an unknown object or an odd envelope still builds an event', async () => {
    const body = JSON.stringify({ object: 'page', entry: [] });
    const event = await constructEvent(body, sign(body), 's3cret');
    expect(event).toMatchObject({ object: 'page', wabaId: null, changes: [] });
  });

  it('a signed body that is not JSON is an error, not a signature error', async () => {
    const body = 'not json';
    await expect(constructEvent(body, sign(body), 's3cret')).rejects.toThrow('not valid JSON');
    await expect(constructEvent(body, sign(body), 's3cret')).rejects.not.toBeInstanceOf(WebhookSignatureError);
  });
});
