import { describe, expect, it } from 'vitest';
import Synergy from '../../src/index';

// Against a real environment (staging), read-only: skipped without SYNERGY_API_KEY (E2-11).
//   SYNERGY_API_KEY=syn_… SYNERGY_BASE_URL=https://api-staging.synergyconnect.com.br npm run test:live
// SYNERGY_LIVE_TO=<wa_id> also sends one text message from the first number.
const key = process.env.SYNERGY_API_KEY;

describe.skipIf(!key)('live', () => {
  const synergy = () => new Synergy({ apiKey: key, ...(process.env.SYNERGY_BASE_URL && { baseURL: process.env.SYNERGY_BASE_URL }) });

  it('me and numbers', async () => {
    const me = await synergy().me();
    expect(me.key.id).toBeTruthy();
    const { data } = await synergy().numbers.list();
    expect(Array.isArray(data)).toBe(true);
  });

  it('reads the first number: conversations, contacts, templates', async () => {
    const { data: numbers } = await synergy().numbers.list();
    const first = numbers[0];
    if (!first) return;
    const wa = synergy().number(first.phoneNumberId);
    const page = await wa.conversations.list({ limit: 5 });
    expect(page.data.length).toBeLessThanOrEqual(5);
    await wa.conversations.changes({ since: page.rev });
    await wa.templates.list({ limit: 5 });
  });

  it('lists the webhooks and their health', async () => {
    const { data } = await synergy().webhooks.list();
    expect(Array.isArray(data)).toBe(true);
    await synergy().webhooks.health();
  });

  it.skipIf(!process.env.SYNERGY_LIVE_TO)('sends a text message', async () => {
    const { data: numbers } = await synergy().numbers.list();
    const first = numbers[0];
    if (!first) throw new Error('the key has no number');
    const sent = await synergy().number(first.phoneNumberId).messages.text({ to: process.env.SYNERGY_LIVE_TO as string, body: 'synergy-node live test' });
    expect(sent.id).toMatch(/^wamid\./);
  });
});
