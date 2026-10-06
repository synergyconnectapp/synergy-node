import { describe, expect, it } from 'vitest';
import { NotFoundError, SynergyError } from '../../src/index';
import { API_KEY, client, fakeFetch, json } from '../helpers';

const SESSION = 'obs_4Fq9aB3cD5eF7gH9iJ1kL3mN';
const STATE = 'e7f2c0d4-9b1e-4c52-8d0a-3f6a1b2c4d5e';

const wire = (over: Record<string, unknown> = {}) => ({
  id: SESSION, status: 'completed', url: null, mode: 'choice', return: 'redirect', redirect_url: 'https://app.minha-plataforma.com/whatsapp/ok',
  state: STATE, external_ref: 'tenant_8841', display_name: 'Minha Plataforma', created_at: '2026-10-06T00:00:00Z', expires_at: '2026-10-06T00:15:00Z',
  blocked: null, last_error: null,
  result: { instance_id: 'a'.repeat(64), phone_number_id: '106540352242922', waba_id: '524126980791429', display_phone_number: '+55 11 91234-5678', mode: 'cloud' },
  ...over,
});

const returnQuery = (over: Record<string, string> = {}) => new URLSearchParams({ session_id: SESSION, state: STATE, status: 'completed', ...over });

describe('ES-14 · the return is verified against the API, never against the query string', () => {
  it('a good return: GET the session, compare the state, and answer from the session', async () => {
    const f = fakeFetch(json(wire()));
    const res = await client(f.fetch).onboarding.verifyReturn(returnQuery(), { expectedState: STATE });
    expect(res.completed).toBe(true);
    expect(res.result).toMatchObject({ phoneNumberId: '106540352242922', wabaId: '524126980791429', mode: 'cloud' });
    expect(res.session.id).toBe(SESSION);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ method: 'GET', url: `https://api.synergyconnect.com.br/v1/onboarding-sessions/${SESSION}` });
  });

  it('accepts a URL, a URLSearchParams, a query string and a plain object', async () => {
    const q = returnQuery().toString();
    for (const input of [new URL(`https://app.minha-plataforma.com/whatsapp/ok?${q}`), new URLSearchParams(q), q, `?${q}`, `https://x.example/ok?${q}`, { session_id: SESSION, state: STATE }]) {
      const f = fakeFetch(json(wire()));
      await expect(client(f.fetch).onboarding.verifyReturn(input, { expectedState: STATE })).resolves.toMatchObject({ completed: true });
    }
  });

  it('blocked: ES-14 ?status=completed on a session that is not completed → completed: false, no result', async () => {
    const f = fakeFetch(json(wire({ status: 'opened', result: null })));
    const res = await client(f.fetch).onboarding.verifyReturn(returnQuery({ status: 'completed' }), { expectedState: STATE });
    expect(res.completed).toBe(false);
    expect(res.result).toBeNull();
    expect(res.session.status).toBe('opened');
  });

  it('blocked: ES-14 a state that is not the stored one → error and no call at all', async () => {
    const f = fakeFetch(json(wire()));
    await expect(client(f.fetch).onboarding.verifyReturn(returnQuery({ state: 'other' }), { expectedState: STATE })).rejects.toBeInstanceOf(SynergyError);
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    ['a prefix of it', STATE.slice(0, -1)],
    ['it plus a suffix', `${STATE}x`],
    ['a different case', STATE.toUpperCase()],
    ['empty', ''],
    ['the injection of a second parameter', `${STATE}&status=completed`],
  ])('blocked: ES-14 state %s → error and no call', async (_name, state) => {
    const f = fakeFetch(json(wire()));
    await expect(client(f.fetch).onboarding.verifyReturn(returnQuery({ state }), { expectedState: STATE })).rejects.toBeInstanceOf(SynergyError);
    expect(f.calls).toHaveLength(0);
  });

  it('blocked: ES-14 no state in the query → error and no call', async () => {
    const f = fakeFetch(json(wire()));
    await expect(client(f.fetch).onboarding.verifyReturn(new URLSearchParams({ session_id: SESSION, status: 'completed' }), { expectedState: STATE })).rejects.toBeInstanceOf(SynergyError);
    expect(f.calls).toHaveLength(0);
  });

  it('blocked: ES-14 a repeated state or session_id (two readers, two values) → error and no call', async () => {
    const f = fakeFetch(json(wire()));
    const synergy = client(f.fetch);
    await expect(synergy.onboarding.verifyReturn(`session_id=${SESSION}&state=${STATE}&state=${STATE}`, { expectedState: STATE })).rejects.toBeInstanceOf(SynergyError);
    await expect(synergy.onboarding.verifyReturn(`session_id=${SESSION}&session_id=${SESSION}&state=${STATE}`, { expectedState: STATE })).rejects.toBeInstanceOf(SynergyError);
    await expect(synergy.onboarding.verifyReturn({ session_id: SESSION, state: [STATE, 'x'] }, { expectedState: STATE })).rejects.toBeInstanceOf(SynergyError);
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    ['missing', undefined],
    ['a path', `${SESSION}/../me`],
    ['a query', `${SESSION}?x=1`],
    ['another prefix', 'ses_4Fq9aB3cD5eF7gH9iJ1kL3mN'],
    ['too short', 'obs_abc'],
    ['an encoded slash', `${SESSION}%2F..`],
    ['empty', ''],
  ])('blocked: ES-14 session_id %s → error before any call (it never reaches a URL)', async (_name, id) => {
    const f = fakeFetch(json(wire()));
    const params = new URLSearchParams({ state: STATE });
    if (id !== undefined) params.set('session_id', id);
    await expect(client(f.fetch).onboarding.verifyReturn(params, { expectedState: STATE })).rejects.toBeInstanceOf(SynergyError);
    expect(f.calls).toHaveLength(0);
  });

  it.each([undefined, '', '   ', null, 123])('blocked: ES-14 expectedState %j → configuration error and no call (never "matches an empty state")', async (expectedState) => {
    const f = fakeFetch(json(wire()));
    const q = new URLSearchParams({ session_id: SESSION, state: '' });
    await expect(client(f.fetch).onboarding.verifyReturn(q, { expectedState } as { expectedState: string })).rejects.toBeInstanceOf(SynergyError);
    await expect(client(f.fetch).onboarding.verifyReturn(q, undefined as unknown as { expectedState: string })).rejects.toBeInstanceOf(SynergyError);
    expect(f.calls).toHaveLength(0);
  });

  it('blocked: ES-14 the API says the session carries another state (a swapped session_id) → error, the result is not handed over', async () => {
    const f = fakeFetch(json(wire({ state: 'the-state-of-another-customer' })));
    const err = await client(f.fetch).onboarding.verifyReturn(returnQuery(), { expectedState: STATE }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SynergyError);
    expect(JSON.stringify(err)).not.toContain('another-customer');
  });

  it('blocked: ES-14 the API answers a different session id than the one asked → error', async () => {
    const f = fakeFetch(json(wire({ id: 'obs_ZZZZZZZZZZZZZZZZZZZZZZZZ' })));
    await expect(client(f.fetch).onboarding.verifyReturn(returnQuery(), { expectedState: STATE })).rejects.toBeInstanceOf(SynergyError);
  });

  it('blocked: ES-14 a session the API does not know → the NotFoundError, nothing released', async () => {
    const f = fakeFetch(json({ error: 'Session not found' }, 404));
    await expect(client(f.fetch).onboarding.verifyReturn(returnQuery(), { expectedState: STATE })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('blocked: ES-14 a ?error= or ?status= forged in the query changes nothing in the answer', async () => {
    const f = fakeFetch(json(wire({ status: 'cancelled', result: null })));
    const res = await client(f.fetch).onboarding.verifyReturn(returnQuery({ status: 'completed', error: 'none' }), { expectedState: STATE });
    expect(res).toMatchObject({ completed: false, result: null });
    expect(JSON.stringify(res)).not.toContain('"error":"none"');
  });

  it('the errors never carry the key nor the stored state', async () => {
    const f = fakeFetch(json(wire({ state: 'x' })));
    const err = await client(f.fetch).onboarding.verifyReturn(returnQuery(), { expectedState: STATE }).catch((e: unknown) => e);
    for (const text of [String(err), JSON.stringify(err), (err as Error).message]) {
      expect(text).not.toContain(API_KEY);
      expect(text).not.toContain(STATE);
    }
  });
});
