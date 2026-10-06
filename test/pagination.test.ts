import { describe, expect, it } from 'vitest';
import { PagePromise, SynergyError } from '../src/index';
import { PNID, client, fakeFetch, json } from './helpers';

const conv = (id: string) => ({ id, wa_id: `55119${id}`, name: `C${id}`, status: 'open', unread: 0, automation: null, window_expires_at: null, last_message: null });
const page = (ids: string[], after: string | null) => json({ data: ids.map(conv), paging: { after }, rev: 7 });

describe('PagePromise (§5.6)', () => {
  it('await gives the first page, camelCased, with rev and raw', async () => {
    const f = fakeFetch(page(['1', '2'], 'c1'));
    const first = await client(f.fetch).number(PNID).conversations.list({ status: 'active', limit: 2 });
    expect(first.data.map((c) => c.id)).toEqual(['1', '2']);
    expect(first.data[0]).toMatchObject({ waId: '551191', status: 'open', windowExpiresAt: null, lastMessage: null });
    expect(first.paging.after).toBe('c1');
    expect(first.rev).toBe(7);
    expect(first.raw).toMatchObject({ rev: 7 });
    expect(f.calls[0]?.url).toBe(`https://api.synergyconnect.com.br/v1/numbers/${PNID}/conversations?status=active&limit=2`);
    expect(f.calls[0]?.method).toBe('GET');
  });

  it('for await walks every page with the opaque cursor, and a short page with a cursor keeps going', async () => {
    const f = fakeFetch(page(['1', '2'], 'c1'), page([], 'c2'), page(['3'], null));
    const seen: string[] = [];
    for await (const c of client(f.fetch).number(PNID).conversations.list()) seen.push(c.id);
    expect(seen).toEqual(['1', '2', '3']);
    expect(f.calls.map((c) => new URL(c.url).searchParams.get('after'))).toEqual([null, 'c1', 'c2']);
  });

  it('await and for await on the same promise ask for the first page once', async () => {
    const f = fakeFetch(page(['1'], null));
    const list = client(f.fetch).number(PNID).conversations.list();
    await list;
    for await (const _ of list) void _;
    expect(f.calls).toHaveLength(1);
  });

  it('nothing is requested until the promise is awaited', () => {
    const f = fakeFetch(page(['1'], null));
    client(f.fetch).number(PNID).conversations.list();
    expect(f.calls).toHaveLength(0);
  });

  it('autoPagingToArray stops at the limit without fetching a page it will not use', async () => {
    const f = fakeFetch(page(['1', '2'], 'c1'), page(['3', '4'], 'c2'), page(['5'], null));
    const items = await client(f.fetch).number(PNID).conversations.list().autoPagingToArray({ limit: 3 });
    expect(items.map((c) => c.id)).toEqual(['1', '2', '3']);
    expect(f.calls).toHaveLength(2);
  });

  it.each([0, -1, 1.5, Number.NaN, undefined])('autoPagingToArray refuses limit %s', async (limit) => {
    const f = fakeFetch(page(['1'], null));
    await expect(client(f.fetch).number(PNID).conversations.list().autoPagingToArray({ limit } as { limit: number })).rejects.toBeInstanceOf(SynergyError);
    expect(f.calls).toHaveLength(0);
  });

  it('a cursor that repeats ends the walk instead of looping', async () => {
    const f = fakeFetch(page(['1'], 'same'), page(['2'], 'same'), page(['3'], 'same'));
    const items = await client(f.fetch).number(PNID).conversations.list().autoPagingToArray({ limit: 100 });
    expect(items.map((c) => c.id)).toEqual(['1', '2']);
    expect(f.calls).toHaveLength(2);
  });

  it('works on its own with any fetcher', async () => {
    const list = new PagePromise<number, { data: number[]; n: string | null }>(
      async (c) => (c === undefined ? { data: [1, 2], n: 'x' } : { data: [3], n: null }),
      (p) => p.n,
    );
    expect(await list.autoPagingToArray({ limit: 10 })).toEqual([1, 2, 3]);
  });

  it('an error in a page rejects the await and the iteration', async () => {
    const f = fakeFetch(json({ error: { message: '(#100) Invalid cursor', code: 100 } }, 400));
    const list = client(f.fetch).number(PNID).conversations.list();
    await expect(list).rejects.toMatchObject({ status: 400 });
    await expect(list.autoPagingToArray({ limit: 5 })).rejects.toMatchObject({ status: 400 });
  });
});
