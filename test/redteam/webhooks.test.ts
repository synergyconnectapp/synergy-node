import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { constructEvent, verify } from '../../src/webhooks';
import { SynergyError, WebhookSignatureError } from '../../src/errors';
import { hubSignature, synergySignature } from '../helpers';
import { SIGNATURE_EXAMPLE as HUB, TIMESTAMPED_SIGNATURE_EXAMPLE as TS } from '../vectors';

const NOW = TS.t;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW * 1000));
});
afterEach(() => vi.useRealTimers());

const good = hubSignature(HUB.body, HUB.secret);
const hex = good.slice('sha256='.length);

describe('K-01 · the signature is checked fail-closed (S-45)', () => {
  const bad: [string, string][] = [
    ['short', `sha256=${hex.slice(0, 63)}`],
    ['long', `sha256=${hex}0`],
    ['not hex', `sha256=${'z'.repeat(64)}`],
    ['uppercase', `sha256=${hex.toUpperCase()}`],
    ['no prefix', hex],
    ['wrong prefix', `sha1=${hex}`],
    ['two signatures in one header', `${good}, ${good}`],
    ['whitespace around', ` ${good}`],
    ['empty', ''],
  ];

  it.each(bad)('blocked: K-01 %s X-Hub-Signature-256 → false, never an exception', async (_, value) => {
    expect(await verify(HUB.body, { 'X-Hub-Signature-256': value }, HUB.secret)).toBe(false);
    await expect(constructEvent(HUB.body, { 'X-Hub-Signature-256': value }, HUB.secret)).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('blocked: K-01 the same header twice, or two values in an array → false', async () => {
    expect(await verify(HUB.body, { 'X-Hub-Signature-256': [good, good] }, HUB.secret)).toBe(false);
    expect(await verify(HUB.body, { 'X-Hub-Signature-256': good, 'x-hub-signature-256': good }, HUB.secret)).toBe(false);
  });

  it('blocked: K-01 no signature header at all → false', async () => {
    expect(await verify(HUB.body, {}, HUB.secret)).toBe(false);
    expect(await verify(HUB.body, new Headers(), HUB.secret)).toBe(false);
  });

  it('blocked: K-01 a valid signature of ANOTHER secret or ANOTHER body → false', async () => {
    expect(await verify(HUB.body, { 'X-Hub-Signature-256': good }, 'another-secret-another-secret-00')).toBe(false);
    expect(await verify(`${HUB.body} `, { 'X-Hub-Signature-256': good }, HUB.secret)).toBe(false);
  });

  it('blocked: K-01 the malformed timestamped forms → false', async () => {
    const v1 = TS.header.split('v1=')[1] as string;
    const forms = [
      `t=${TS.t}`,
      `v1=${v1}`,
      `t=${TS.t},v1=${v1.toUpperCase()}`,
      `t=${TS.t},v1=${v1.slice(1)}`,
      `t=${TS.t}.5,v1=${v1}`,
      `t=-1,v1=${v1}`,
      `t=${TS.t}, v1=${v1}`,
      `v1=${v1},t=${TS.t}`,
      `t=${TS.t},v1=${v1},v1=${v1}`,
      `${TS.header}, ${TS.header}`,
      `t=${'9'.repeat(40)},v1=${v1}`,
    ];
    for (const header of forms) {
      expect(await verify(TS.body, { 'X-Synergy-Signature': header, 'X-Synergy-Delivery-Id': TS.deliveryId }, TS.secret), header).toBe(false);
    }
  });

  it('blocked: K-01 a bad X-Synergy-Signature never falls back to a good X-Hub-Signature-256', async () => {
    const headers = { 'X-Synergy-Signature': `t=${TS.t},v1=${'0'.repeat(64)}`, 'X-Synergy-Delivery-Id': TS.deliveryId, 'X-Hub-Signature-256': good };
    expect(await verify(HUB.body, headers, HUB.secret)).toBe(false);
  });

  it('blocked: K-01 the comparison is crypto.subtle.verify (constant time), never a string compare', async () => {
    const spy = vi.spyOn(crypto.subtle, 'verify');
    await verify(HUB.body, { 'X-Hub-Signature-256': good }, HUB.secret);
    await verify(TS.body, { 'X-Synergy-Signature': TS.header, 'X-Synergy-Delivery-Id': TS.deliveryId }, TS.secret);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('blocked: K-01 an internal failure reads as invalid, never as a pass', async () => {
    const spy = vi.spyOn(crypto.subtle, 'verify').mockRejectedValue(new Error('boom'));
    expect(await verify(HUB.body, { 'X-Hub-Signature-256': good }, HUB.secret)).toBe(false);
    spy.mockRestore();
  });
});

describe('K-02 · replay: the timestamp and the delivery id count (S-44)', () => {
  const at = (t: number, deliveryId: string = TS.deliveryId) => ({
    'X-Synergy-Signature': synergySignature(TS.body, TS.secret, deliveryId, t),
    'X-Synergy-Delivery-Id': deliveryId,
  });

  it('blocked: K-02 a t of 6 minutes ago → WebhookSignatureError', async () => {
    const headers = at(NOW - 6 * 60);
    expect(await verify(TS.body, headers, TS.secret)).toBe(false);
    await expect(constructEvent(TS.body, headers, TS.secret)).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('blocked: K-02 a t of 6 minutes IN THE FUTURE is refused too', async () => {
    expect(await verify(TS.body, at(NOW + 6 * 60), TS.secret)).toBe(false);
  });

  it('K-02 the window edge: 300 s passes, 301 s does not', async () => {
    expect(await verify(TS.body, at(NOW - 300), TS.secret)).toBe(true);
    expect(await verify(TS.body, at(NOW - 301), TS.secret)).toBe(false);
  });

  it('K-02 toleranceSeconds moves the window', async () => {
    expect(await verify(TS.body, at(NOW - 6 * 60), TS.secret, { toleranceSeconds: 600 })).toBe(true);
    expect(await verify(TS.body, at(NOW - 30), TS.secret, { toleranceSeconds: 10 })).toBe(false);
    await expect(constructEvent(TS.body, at(NOW - 6 * 60), TS.secret, { toleranceSeconds: 600 })).resolves.toMatchObject({ timestamped: true });
  });

  it('blocked: K-02 a swapped delivery id → error', async () => {
    const headers = { ...at(NOW), 'X-Synergy-Delivery-Id': 'ping-another-delivery' };
    expect(await verify(TS.body, headers, TS.secret)).toBe(false);
    await expect(constructEvent(TS.body, headers, TS.secret)).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('blocked: K-02 a missing or empty delivery id → error', async () => {
    const { 'X-Synergy-Signature': signature } = at(NOW);
    expect(await verify(TS.body, { 'X-Synergy-Signature': signature }, TS.secret)).toBe(false);
    expect(await verify(TS.body, { 'X-Synergy-Signature': signature, 'X-Synergy-Delivery-Id': '' }, TS.secret)).toBe(false);
  });

  it('blocked: K-02 a t swapped under the same v1 → error', async () => {
    const headers = { ...at(NOW), 'X-Synergy-Signature': at(NOW)['X-Synergy-Signature'].replace(`t=${NOW}`, `t=${NOW - 10}`) };
    expect(await verify(TS.body, headers, TS.secret)).toBe(false);
  });

  it('a retry has a new t and the same delivery id: both verify', async () => {
    expect(await verify(TS.body, at(NOW - 120), TS.secret)).toBe(true);
    expect(await verify(TS.body, at(NOW), TS.secret)).toBe(true);
  });

  it('rejects a nonsense tolerance as a mistake of the caller', async () => {
    await expect(verify(TS.body, at(NOW), TS.secret, { toleranceSeconds: Number.NaN })).rejects.toBeInstanceOf(TypeError);
    await expect(verify(TS.body, at(NOW), TS.secret, { toleranceSeconds: -1 })).rejects.toBeInstanceOf(TypeError);
  });
});

describe('K-03 · an empty secret is a configuration error, never a pass (S-45)', () => {
  const headers = { 'X-Hub-Signature-256': hubSignature(HUB.body, '') };

  it.each([[''], ['   '], ['\n\t'], [undefined]])('blocked: K-03 secret %j → SynergyError("webhook secret is empty")', async (secret) => {
    await expect(verify(HUB.body, headers, secret)).rejects.toThrow(SynergyError);
    await expect(verify(HUB.body, headers, secret)).rejects.toThrow('webhook secret is empty');
    await expect(constructEvent(HUB.body, headers, secret)).rejects.toThrow('webhook secret is empty');
  });

  it('blocked: K-03 a non-string secret is the same error', async () => {
    await expect(verify(HUB.body, headers, 123 as unknown as string)).rejects.toThrow('webhook secret is empty');
    await expect(verify(HUB.body, headers, null as unknown as string)).rejects.toThrow('webhook secret is empty');
  });
});

describe('K-04 · the body is the raw body, never re-serialized (S-45)', () => {
  const headers = { 'X-Hub-Signature-256': HUB.header };

  it('blocked: K-04 a parsed object → TypeError in constructEvent and in verify', async () => {
    const parsed = JSON.parse(HUB.body);
    await expect(constructEvent(parsed, headers, HUB.secret)).rejects.toBeInstanceOf(TypeError);
    await expect(verify(parsed, headers, HUB.secret)).rejects.toBeInstanceOf(TypeError);
  });

  it.each([[null], [undefined], [42], [[1, 2]], [{ toString: () => HUB.body }]])('blocked: K-04 %j is not a raw body → TypeError', async (body) => {
    await expect(constructEvent(body as never, headers, HUB.secret)).rejects.toBeInstanceOf(TypeError);
  });

  it('blocked: K-04 a re-serialized body no longer matches the signature', async () => {
    expect(await verify(JSON.stringify(JSON.parse(HUB.body), null, 2), headers, HUB.secret)).toBe(false);
  });

  it('K-04 raw bytes are signed as bytes: invalid UTF-8 verifies without a lossy decode', async () => {
    const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    expect(await verify(bytes, { 'X-Hub-Signature-256': hubSignature(bytes, 'k'.repeat(16)) }, 'k'.repeat(16))).toBe(true);
  });
});
