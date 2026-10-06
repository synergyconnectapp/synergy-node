import { afterEach, describe, expect, it } from 'vitest';
import Synergy, { APIError, AuthenticationError, ConnectionError, SynergyError } from '../../src/index';
import { API_KEY, PNID, SENT, client, fakeFetch, graphError, json } from '../helpers';

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } });

describe('K-06 · the key never leaves the API host (S-46)', () => {
  it('blocked: K-06 a 302 to another host → an error, and no second call carries Authorization', async () => {
    const f = fakeFetch(redirect('https://evil.example/steal'), json(SENT));
    const synergy = client(f.fetch, { maxRetries: 3 });
    await expect(synergy.number(PNID).messages.text({ to: '5511999999999', body: 'oi' })).rejects.toBeInstanceOf(SynergyError);
    expect(f.calls).toHaveLength(1);
    expect(f.calls.filter((c) => !c.url.startsWith('https://api.synergyconnect.com.br/'))).toHaveLength(0);
  });

  it('blocked: K-06 every call goes out with redirect: "error"', async () => {
    const f = fakeFetch(json({ key: {}, organization: {}, plan: {} }));
    await client(f.fetch).me();
    expect(f.calls[0]?.init.redirect).toBe('error');
  });

  it('blocked: K-06 a real fetch that refuses the redirect is an error and not retried with the key elsewhere', async () => {
    const f = fakeFetch(new TypeError('fetch failed'));
    await expect(client(f.fetch, { maxRetries: 0 }).me()).rejects.toBeInstanceOf(ConnectionError);
  });

  it('blocked: K-06 String(err), JSON.stringify(err) and the body carry no key, even when the server echoes it', async () => {
    const f = fakeFetch(json({ error: { message: `(#190) Invalid token ${API_KEY}`, code: 190, error_data: { details: `Authorization: Bearer ${API_KEY}` } } }, 401));
    const err = await client(f.fetch).me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    for (const text of [String(err), JSON.stringify(err), (err as APIError).message, JSON.stringify((err as APIError).body), (err as APIError).details ?? '']) {
      expect(text).not.toContain('syn_');
      expect(text).not.toContain(API_KEY);
    }
  });

  it('blocked: K-06 an error from a connection failure carries no request headers', async () => {
    const f = fakeFetch(new TypeError('fetch failed'));
    const err = await client(f.fetch, { maxRetries: 0 }).me().catch((e: unknown) => e);
    expect(JSON.stringify(err)).not.toContain(API_KEY);
    expect(String(err)).not.toContain(API_KEY);
  });

  it.each([['http://api.synergyconnect.com.br'], ['ftp://api.synergyconnect.com.br'], ['http://localhost:8787'], ['not a url'], ['https://user:pass@api.synergyconnect.com.br']])(
    'blocked: K-06 baseURL %s → error',
    (baseURL) => {
      expect(() => new Synergy({ apiKey: API_KEY, baseURL })).toThrow(SynergyError);
    },
  );

  it('K-06 http is only for localhost, and only with allowInsecureLocalhost', () => {
    expect(() => new Synergy({ apiKey: API_KEY, baseURL: 'http://localhost:8787', allowInsecureLocalhost: true })).not.toThrow();
    expect(() => new Synergy({ apiKey: API_KEY, baseURL: 'http://127.0.0.1:8787', allowInsecureLocalhost: true })).not.toThrow();
    expect(() => new Synergy({ apiKey: API_KEY, baseURL: 'http://evil.example', allowInsecureLocalhost: true })).toThrow(SynergyError);
  });

  it('blocked: K-06 a path that would reshape the origin is refused before any call', async () => {
    const f = fakeFetch(json({}));
    const synergy = client(f.fetch);
    await expect(synergy.request({ method: 'GET', path: '//evil.example/x', retry: 'safe' })).rejects.toThrow('origin');
    await expect(synergy.request({ method: 'GET', path: '/\\evil.example/x', retry: 'safe' })).rejects.toThrow('origin');
    expect(f.calls).toHaveLength(0);
  });

  it('blocked: K-06 ids that would reshape a path are refused before any call', async () => {
    const f = fakeFetch(json({}));
    const synergy = client(f.fetch);
    expect(() => synergy.number('../../v1/me')).toThrow(SynergyError);
    expect(() => synergy.number('1234/../5')).toThrow(SynergyError);
    const wa = synergy.number(PNID);
    await expect(wa.media.get('../me')).rejects.toThrow(SynergyError);
    await expect(wa.media.download('//evil.example')).rejects.toThrow(SynergyError);
    await expect(wa.flows.createToken({ flowId: '1/../2', to: '5511999999999' })).rejects.toThrow(SynergyError);
    expect(f.calls).toHaveLength(0);
  });

  it('blocked: K-06 Authorization goes only to the exact origin of baseURL', async () => {
    const f = fakeFetch(json({ data: [] }));
    await client(f.fetch, { baseURL: 'https://api-staging.synergyconnect.com.br/' }).numbers.list();
    const call = f.calls[0]!;
    expect(new URL(call.url).origin).toBe('https://api-staging.synergyconnect.com.br');
    expect(call.headers.Authorization).toBe(`Bearer ${API_KEY}`);
  });

  it('blocked: K-06 the key is not in the URL, the body or any header but Authorization', async () => {
    const f = fakeFetch(json(SENT));
    await client(f.fetch).number(PNID).messages.text({ to: '5511999999999', body: 'oi' });
    const call = f.calls[0]!;
    expect(call.url).not.toContain('syn_');
    expect(JSON.stringify(call.body)).not.toContain('syn_');
    for (const [name, value] of Object.entries(call.headers)) if (name !== 'Authorization') expect(value).not.toContain('syn_');
  });

  it('blocked: K-06 a missing key is an error that says where to put it, and never reads another variable', () => {
    const saved = process.env.SYNERGY_API_KEY;
    delete process.env.SYNERGY_API_KEY;
    try {
      expect(() => new Synergy()).toThrow(/SYNERGY_API_KEY/);
      expect(() => new Synergy({ apiKey: '   ' })).toThrow(SynergyError);
    } finally {
      if (saved !== undefined) process.env.SYNERGY_API_KEY = saved;
    }
  });

  it('K-06 a non-2xx answer that is HTML (a proxy) is an APIError without leaking anything', async () => {
    const f = fakeFetch(new Response('<html>Bad gateway</html>', { status: 502 }));
    const err = await client(f.fetch, { maxRetries: 0 }).me().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(JSON.stringify(err)).not.toContain(API_KEY);
  });
});

describe('E2-9 · the browser guard', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('with a `window` and without dangerouslyAllowBrowser → SynergyError with guidance', () => {
    (globalThis as { window?: unknown }).window = {};
    expect(() => new Synergy({ apiKey: API_KEY })).toThrow(/browser/);
    expect(() => new Synergy({ apiKey: API_KEY })).toThrow(SynergyError);
    expect(() => new Synergy({ apiKey: API_KEY, dangerouslyAllowBrowser: true })).not.toThrow();
  });
});
