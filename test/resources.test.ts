import { describe, expect, it } from 'vitest';
import { NotFoundError, PermissionError, SynergyError } from '../src/index';
import { API_KEY, PNID, client, fakeFetch, graphError, json } from './helpers';

const BASE = 'https://api.synergyconnect.com.br';
const HOOK = '3f9a1c0b-7d2e-4a6f-8b1c-2d3e4f5a6b7c';
const SESSION = 'obs_4Fq9aB3cD5eF7gH9iJ1kL3mN';

const webhook = { id: HOOK, url: 'https://x.example/h', fields: ['messages'], statuses: null, instanceIds: null, enabled: true, verification: 'ping', headerNames: null, disabledReason: null, createdBy: 'key:1', createdAt: 1, updatedAt: 2, name: null };
const wireSession = {
  id: SESSION, status: 'pending', url: 'https://app.synergyconnect.com.br/connect?s=x', mode: 'choice', return: 'redirect',
  redirect_url: 'https://app.minha-plataforma.com/whatsapp/ok', state: 'st-1', external_ref: null, display_name: 'Minha Plataforma',
  created_at: '2026-10-06T00:00:00Z', expires_at: '2026-10-06T00:15:00Z', blocked: null, last_error: null, result: null,
};

describe('conversations, messages and contacts', () => {
  it('search is a POST with the body, retried like a read, and pages with after', async () => {
    const wire = (after: string | null) => json({ data: [{ id: '9', wa_id: '5511', name: 'Maria', status: 'open', unread: 1, automation: null, window_expires_at: null, last_message: null }], paging: { after }, rev: 1 });
    const f = fakeFetch(json({ error: { message: 'down' } }, 503), wire('n1'), wire(null));
    const items = await client(f.fetch).number(PNID).conversations.search({ q: 'Maria', status: 'active' }).autoPagingToArray({ limit: 10 });
    expect(items).toHaveLength(2);
    expect(f.calls.map((c) => c.method)).toEqual(['POST', 'POST', 'POST']);
    expect(f.calls[0]?.url).toBe(`${BASE}/v1/numbers/${PNID}/conversations/search`);
    expect(f.calls[0]?.body).toEqual({ q: 'Maria', status: 'active' });
    expect(f.calls[2]?.body).toEqual({ q: 'Maria', status: 'active', after: 'n1' });
  });

  it('changes sends since and camelCases the answer', async () => {
    const f = fakeFetch(json({ rev: 12, reset: true, data: [], removed: ['4'] }));
    const changes = await client(f.fetch).number(PNID).conversations.changes({ since: 9 });
    expect(changes).toMatchObject({ rev: 12, reset: true, removed: ['4'] });
    expect(f.calls[0]?.url).toBe(`${BASE}/v1/numbers/${PNID}/conversations/changes?since=9`);
  });

  it.each([-1, 1.5, Number.NaN])('changes refuses since %s before any call', async (since) => {
    const f = fakeFetch(json({}));
    await expect(client(f.fetch).number(PNID).conversations.changes({ since })).rejects.toBeInstanceOf(SynergyError);
    expect(f.calls).toHaveLength(0);
  });

  it('messages: camelCases the envelope and leaves the Meta message untouched; walks back with before', async () => {
    const wire = (before: string | null) =>
      json({ data: [{ id: 'wamid.1', direction: 'in', author: 'contact', timestamp: '1', status: null, type: 'text', message: { from: '5511', text: { body: 'oi' }, some_key: 1 }, context: { message_id: 'wamid.0' } }], paging: { before } });
    const f = fakeFetch(wire('b1'), wire(null));
    const items = await client(f.fetch).number(PNID).conversations.messages('123', { limit: 1 }).autoPagingToArray({ limit: 5 });
    expect(items[0]).toMatchObject({ id: 'wamid.1', context: { messageId: 'wamid.0' }, message: { some_key: 1, text: { body: 'oi' } } });
    expect(f.calls[0]?.url).toBe(`${BASE}/v1/numbers/${PNID}/conversations/123/messages?limit=1`);
    expect(f.calls[1]?.url).toContain('before=b1');
  });

  it.each(['', 'abc', '1/../2', '1?x=1', '1234567890123456'])('messages refuses conversationId %j', (id) => {
    expect(() => client(fakeFetch(json({})).fetch).number(PNID).conversations.messages(id)).toThrow(SynergyError);
  });

  it('contacts.search', async () => {
    const f = fakeFetch(json({ data: [{ id: '1', wa_id: '5511', name: null, phone: '+55', last_message_at: '2' }], paging: { after: null } }));
    const page = await client(f.fetch).number(PNID).contacts.search({ q: '5511', limit: 3 });
    expect(page.data).toEqual([{ id: '1', waId: '5511', name: null, phone: '+55', lastMessageAt: '2' }]);
    expect(f.calls[0]?.body).toEqual({ q: '5511', limit: 3 });
    expect(f.calls[0]?.url).toBe(`${BASE}/v1/numbers/${PNID}/contacts/search`);
  });
});

describe('templates', () => {
  const tpl = { id: '123', name: 'pedido', language: 'pt_BR', status: 'APPROVED', category: 'UTILITY', parameter_format: 'POSITIONAL', components: [{ type: 'BODY', text: 'Oi {{1}}', example: { body_text: [['x']] } }] };

  it('list: query, camelCase, components untouched', async () => {
    const f = fakeFetch(json({ data: [tpl], syncing: true }));
    const list = await client(f.fetch).number(PNID).templates.list({ status: 'PENDING', name: 'ped', limit: 10 });
    expect(list.syncing).toBe(true);
    expect(list.data[0]).toMatchObject({ id: '123', parameterFormat: 'POSITIONAL', components: [{ example: { body_text: [['x']] } }] });
    expect(new URL(f.calls[0]?.url ?? '').searchParams.toString()).toBe('status=PENDING&name=ped&limit=10');
  });

  it('get / update / delete / create speak the wire', async () => {
    const f = fakeFetch(json(tpl), json({ success: true }), json({ success: true }), json({ id: '9', status: 'PENDING', category: 'UTILITY' }));
    const wa = client(f.fetch).number(PNID);
    expect((await wa.templates.get('123')).name).toBe('pedido');
    expect((await wa.templates.update('123', { components: [{ type: 'BODY', text: 'x' }], messageSendTtlSeconds: 600 })).success).toBe(true);
    expect((await wa.templates.delete('123')).success).toBe(true);
    const created = await wa.templates.create({ name: 'novo', language: 'pt_BR', category: 'MARKETING', components: [{ type: 'BODY', text: 'x' }], parameterFormat: 'NAMED' });
    expect(created).toMatchObject({ id: '9', status: 'PENDING' });
    expect(f.calls.map((c) => `${c.method} ${c.url.replace(BASE, '')}`)).toEqual([
      `GET /v1/numbers/${PNID}/templates/123`,
      `POST /v1/numbers/${PNID}/templates/123`,
      `DELETE /v1/numbers/${PNID}/templates/123`,
      `POST /v1/numbers/${PNID}/templates`,
    ]);
    expect(f.calls[1]?.body).toEqual({ components: [{ type: 'BODY', text: 'x' }], message_send_ttl_seconds: 600 });
    expect(f.calls[3]?.body).toEqual({ name: 'novo', language: 'pt_BR', category: 'MARKETING', components: [{ type: 'BODY', text: 'x' }], parameter_format: 'NAMED' });
  });

  it('uploadMedia sends a multipart `file` and returns the handle', async () => {
    const f = fakeFetch(json({ handle: '4::aW1hZ2U=' }));
    const res = await client(f.fetch).number(PNID).templates.uploadMedia({ file: new Uint8Array([1, 2, 3]), mimeType: 'image/png', filename: 'a.png' });
    expect(res.handle).toBe('4::aW1hZ2U=');
    const form = f.calls[0]?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect((form.get('file') as File).type).toBe('image/png');
    expect((form.get('file') as File).name).toBe('a.png');
    expect(f.calls[0]?.url).toBe(`${BASE}/v1/numbers/${PNID}/templates/media`);
  });

  it('uploadMedia refuses a stream, and a missing mimeType', async () => {
    const wa = client(fakeFetch(json({})).fetch).number(PNID);
    await expect(wa.templates.uploadMedia({ file: new ReadableStream() as unknown as Blob, mimeType: 'image/png' })).rejects.toBeInstanceOf(TypeError);
    await expect(wa.templates.uploadMedia({ file: new Blob(['x']), mimeType: '' })).rejects.toBeInstanceOf(SynergyError);
  });

  it.each(['', 'abc', '12/../3', '1?x', '1'.repeat(26)])('refuses templateId %j before any call', async (id) => {
    const f = fakeFetch(json({}));
    await expect(client(f.fetch).number(PNID).templates.get(id)).rejects.toBeInstanceOf(SynergyError);
    expect(f.calls).toHaveLength(0);
  });

  it('writes are never retried after a status (§5.5)', async () => {
    const f = fakeFetch(json({ error: { message: 'down' } }, 503), json({ id: '1', status: 'PENDING', category: 'UTILITY' }));
    await expect(client(f.fetch).number(PNID).templates.create({ name: 'a', language: 'pt_BR', category: 'UTILITY', components: [{ type: 'BODY', text: 'x' }] })).rejects.toMatchObject({ status: 503 });
    expect(f.calls).toHaveLength(1);
  });

  it('a read of templates retries a 503', async () => {
    const f = fakeFetch(json({ error: { message: 'down' } }, 503), json({ data: [] }));
    expect((await client(f.fetch).number(PNID).templates.list()).data).toEqual([]);
    expect(f.calls).toHaveLength(2);
  });

  it('a key without the scope is a PermissionError', async () => {
    const f = fakeFetch(graphError(403, 1390013, 'scope'));
    await expect(client(f.fetch).number(PNID).templates.delete('1')).rejects.toBeInstanceOf(PermissionError);
  });
});

describe('webhooks management', () => {
  it('create sends instanceIds: null by default and gives the secret once', async () => {
    const f = fakeFetch(json({ row: webhook, secret: 'a'.repeat(32), pending: 0 }, 201));
    const res = await client(f.fetch).webhooks.create({ url: webhook.url, fields: ['messages', 'statuses'], name: 'meu-servidor' });
    expect(res.secret).toBe('a'.repeat(32));
    expect(res.row.id).toBe(HOOK);
    expect(f.calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/v1/webhooks` });
    expect(f.calls[0]?.body).toEqual({ url: webhook.url, fields: ['messages', 'statuses'], instanceIds: null, name: 'meu-servidor' });
  });

  it('the headers keep their own names (never snake_cased) and null removes one', async () => {
    const f = fakeFetch(json({ row: webhook, secret: 'b'.repeat(32), pending: 0 }, 201), json({ row: webhook, pending: 0 }));
    const hooks = client(f.fetch).webhooks;
    await hooks.create({ url: webhook.url, fields: ['messages'], headers: { 'X-Api-Key': 'k' } });
    await hooks.update(HOOK, { headers: { 'X-Api-Key': null }, enabled: false });
    expect(f.calls[0]?.body).toMatchObject({ headers: { 'X-Api-Key': 'k' } });
    expect(f.calls[1]).toMatchObject({ method: 'PATCH', url: `${BASE}/v1/webhooks/${HOOK}`, body: { headers: { 'X-Api-Key': null }, enabled: false } });
  });

  it('list, get (a list and a pick), health and stats', async () => {
    const f = fakeFetch(json({ data: [webhook] }), json({ data: [webhook] }), json({ data: [webhook] }), json({ data: { [HOOK]: { state: 'healthy', pending: 0 } } }), json({ data: { available: false } }));
    const hooks = client(f.fetch).webhooks;
    expect((await hooks.list()).data).toHaveLength(1);
    expect((await hooks.get(HOOK)).url).toBe(webhook.url);
    await expect(hooks.get('11111111-1111-4111-8111-111111111111')).rejects.toBeInstanceOf(NotFoundError);
    expect((await hooks.health()).data[HOOK]?.state).toBe('healthy');
    expect((await hooks.stats({ hours: 168 })).data).toEqual({ available: false });
    expect(f.calls[4]?.url).toBe(`${BASE}/v1/webhooks/stats?hours=168`);
  });

  it('rotateSecret, test, retry, replay, delete', async () => {
    const f = fakeFetch(
      json({ secret: 'c'.repeat(32), pending: 0 }),
      json({ ok: true }),
      json({ ok: true, retrying: 2, suspended: 0 }),
      json({ ok: true, queued: 5, truncated: false, suspended: 0, failed: 0 }),
      json({ ok: true, pending: 0 }),
    );
    const hooks = client(f.fetch).webhooks;
    expect((await hooks.rotateSecret(HOOK)).secret).toBe('c'.repeat(32));
    expect((await hooks.test(HOOK)).ok).toBe(true);
    expect((await hooks.retry(HOOK)).retrying).toBe(2);
    const since = new Date('2026-10-01T00:00:00Z');
    expect((await hooks.replay(HOOK, { since })).queued).toBe(5);
    expect((await hooks.delete(HOOK)).ok).toBe(true);
    expect(f.calls.map((c) => `${c.method} ${c.url.replace(`${BASE}/v1/webhooks/${HOOK}`, '')}`)).toEqual(['POST /rotate-secret', 'POST /test', 'POST /retry', 'POST /replay', 'DELETE ']);
    expect(f.calls[3]?.body).toEqual({ since: since.getTime() });
  });

  it.each(['', 'x', `${HOOK}/../me`, `${HOOK}?a=1`])('refuses hookId %j before any call', async (id) => {
    const f = fakeFetch(json({}));
    const hooks = client(f.fetch).webhooks;
    await expect(hooks.update(id, { enabled: true })).rejects.toBeInstanceOf(SynergyError);
    await expect(hooks.delete(id)).rejects.toBeInstanceOf(SynergyError);
    expect(f.calls).toHaveLength(0);
  });

  it('a management write is never retried after a status; a read is', async () => {
    const f = fakeFetch(json({ error: 'busy' }, 503), json({ error: 'busy' }, 503), json({ data: [] }));
    const hooks = client(f.fetch).webhooks;
    await expect(hooks.test(HOOK)).rejects.toMatchObject({ status: 503 });
    expect(f.calls).toHaveLength(1);
    await expect(hooks.list()).resolves.toMatchObject({ data: [] });
    expect(f.calls).toHaveLength(3);
  });

  it('a management error carries no key', async () => {
    const f = fakeFetch(json({ error: `Invalid or revoked key ${API_KEY}` }, 401));
    const err = await client(f.fetch).webhooks.list().catch((e: unknown) => e);
    expect(JSON.stringify(err)).not.toContain(API_KEY);
  });
});

describe('onboarding sessions', () => {
  it('create: camelCase in, snake_case on the wire, camelCase out', async () => {
    const f = fakeFetch(json(wireSession, 201));
    const s = await client(f.fetch).onboarding.sessions.create({
      redirectUrl: wireSession.redirect_url, state: 'st-1', displayName: 'Minha Plataforma', mode: 'choice', externalRef: 'tenant_1', attachToKeyIds: [HOOK], expiresIn: 600,
    });
    expect(f.calls[0]).toMatchObject({ method: 'POST', url: `${BASE}/v1/onboarding-sessions` });
    expect(f.calls[0]?.body).toEqual({
      redirect_url: wireSession.redirect_url, state: 'st-1', display_name: 'Minha Plataforma', mode: 'choice', external_ref: 'tenant_1', attach_to_key_ids: [HOOK], expires_in: 600,
    });
    expect(s).toMatchObject({ id: SESSION, status: 'pending', redirectUrl: wireSession.redirect_url, displayName: 'Minha Plataforma', expiresAt: wireSession.expires_at, result: null });
    expect(s.raw).toEqual(wireSession);
  });

  it('get and cancel, with the result of a completed session', async () => {
    const done = { ...wireSession, status: 'completed', result: { instance_id: 'a'.repeat(64), phone_number_id: PNID, waba_id: '5241', display_phone_number: '+55 11 91234-5678', mode: 'cloud' } };
    const f = fakeFetch(json(done), json({ ...wireSession, status: 'cancelled' }));
    const sessions = client(f.fetch).onboarding.sessions;
    expect((await sessions.get(SESSION)).result).toEqual({ instanceId: 'a'.repeat(64), phoneNumberId: PNID, wabaId: '5241', displayPhoneNumber: '+55 11 91234-5678', mode: 'cloud' });
    expect((await sessions.cancel(SESSION)).status).toBe('cancelled');
    expect(f.calls.map((c) => `${c.method} ${c.url.replace(BASE, '')}`)).toEqual([`GET /v1/onboarding-sessions/${SESSION}`, `POST /v1/onboarding-sessions/${SESSION}/cancel`]);
  });

  it.each(['', 'obs_short', `${SESSION}/../x`, 'xxx_4Fq9aB3cD5eF7gH9iJ1kL3mN'])('refuses sessionId %j before any call', async (id) => {
    const f = fakeFetch(json({}));
    await expect(client(f.fetch).onboarding.sessions.get(id)).rejects.toBeInstanceOf(SynergyError);
    expect(f.calls).toHaveLength(0);
  });

  it('create is not retried after a status', async () => {
    const f = fakeFetch(json({ error: 'busy' }, 503), json(wireSession, 201));
    await expect(client(f.fetch).onboarding.sessions.create({ redirectUrl: wireSession.redirect_url, state: 's', displayName: 'x' })).rejects.toMatchObject({ status: 503 });
    expect(f.calls).toHaveLength(1);
  });
});
