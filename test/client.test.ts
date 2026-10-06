import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import Synergy, {
  AbortError, APIError, AuthenticationError, BadRequestError, ConflictError, IdempotencyError, MetaError, NotFoundError, PermissionError,
  RateLimitError, ServerError, SynergyError, TimeoutError, VERSION,
} from '../src/index';
import { API_KEY, PNID, SENT, client, fakeFetch, graphError, json } from './helpers';

const TO = '5511999999999';

describe('package', () => {
  it('VERSION is the version of package.json', () => {
    expect(VERSION).toBe(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
  });
});

describe('options', () => {
  it('reads SYNERGY_API_KEY when apiKey is absent', async () => {
    const saved = process.env.SYNERGY_API_KEY;
    process.env.SYNERGY_API_KEY = API_KEY;
    try {
      const f = fakeFetch(json({ key: {}, organization: {}, plan: {} }));
      await new Synergy({ fetch: f.fetch }).me();
      expect(f.calls[0]?.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    } finally {
      if (saved === undefined) delete process.env.SYNERGY_API_KEY;
      else process.env.SYNERGY_API_KEY = saved;
    }
  });

  it('sends User-Agent synergy-node/<version> plus the suffix, and Accept', async () => {
    const f = fakeFetch(json({ data: [] }));
    await client(f.fetch, { userAgentSuffix: 'synergy-mcp/1.0' }).numbers.list();
    expect(f.calls[0]?.headers['User-Agent']).toBe(`synergy-node/${VERSION} synergy-mcp/1.0`);
    expect(f.calls[0]?.headers.Accept).toBe('application/json');
  });

  it('uses graphVersion v25.0 by default and the one given', async () => {
    const f = fakeFetch(json(SENT), json(SENT));
    await client(f.fetch).number(PNID).messages.text({ to: TO, body: 'a' });
    await client(f.fetch, { graphVersion: 'v26.0' }).number(PNID).messages.text({ to: TO, body: 'a' });
    expect(f.calls[0]?.url).toBe(`https://api.synergyconnect.com.br/v25.0/${PNID}/messages`);
    expect(f.calls[1]?.url).toBe(`https://api.synergyconnect.com.br/v26.0/${PNID}/messages`);
    expect(() => client(f.fetch, { graphVersion: '25' })).toThrow(SynergyError);
  });

  it('keeps a path prefix of baseURL', async () => {
    const f = fakeFetch(json({ data: [] }));
    await client(f.fetch, { baseURL: 'https://gateway.example.com/synergy/' }).numbers.list();
    expect(f.calls[0]?.url).toBe('https://gateway.example.com/synergy/v1/numbers');
  });

  it('rejects nonsense numbers', () => {
    const f = fakeFetch(json({}));
    expect(() => client(f.fetch, { maxRetries: -1 })).toThrow(SynergyError);
    expect(() => client(f.fetch, { timeout: Number.NaN })).toThrow(SynergyError);
  });
});

describe('me and numbers', () => {
  it('me() answers camelCase and keeps the raw body', async () => {
    const raw = {
      key: { id: 'k1', name: 'n', last4: 'abcd', scopes: ['messages'], mode: 'bot', origin: 'manual', instance_ids: null, assistant: null },
      organization: { id: 'org1' },
      plan: { api: true, inbox: true, wa_flows: false, mode: 'normal' },
    };
    const f = fakeFetch(json(raw));
    const me = await client(f.fetch).me();
    expect(f.calls[0]).toMatchObject({ method: 'GET', url: 'https://api.synergyconnect.com.br/v1/me' });
    expect(me.key.instanceIds).toBeNull();
    expect(me.plan.waFlows).toBe(false);
    expect(me.raw).toEqual(raw);
  });

  it('numbers.list() answers { data } in camelCase', async () => {
    const raw = { data: [{ id: 'a'.repeat(64), phone_number_id: PNID, display_phone_number: '+55', verified_name: null, alias: null, waba_id: 'w', mode: 'cloud', status: 'active' }] };
    const f = fakeFetch(json(raw));
    const { data, raw: kept } = await client(f.fetch).numbers.list();
    expect(data[0]?.phoneNumberId).toBe(PNID);
    expect(data[0]?.wabaId).toBe('w');
    expect(kept).toEqual(raw);
  });

  it('number() refuses an id that is not a phone_number_id', () => {
    const f = fakeFetch(json({}));
    expect(() => client(f.fetch).number('abc')).toThrow(SynergyError);
  });
});

describe('messages: the bodies on the wire', () => {
  const send = async (fn: (wa: ReturnType<Synergy['number']>) => Promise<unknown>) => {
    const f = fakeFetch(json(SENT));
    await fn(client(f.fetch).number(PNID));
    return f.calls[0]!;
  };

  it('text → POST /{v}/{pnid}/messages with the Meta body, an Idempotency-Key and the result shape', async () => {
    const f = fakeFetch(json(SENT));
    const result = await client(f.fetch).number(PNID).messages.text({ to: TO, body: 'Olá!' });
    const call = f.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.body).toEqual({ messaging_product: 'whatsapp', recipient_type: 'individual', to: TO, type: 'text', text: { body: 'Olá!' } });
    expect(call.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(result).toEqual({ id: 'wamid.ABC', to: TO, status: 'accepted', raw: SENT });
  });

  it('honors idempotencyKey, replies and replyTo', async () => {
    const call = await send((wa) => wa.messages.text({ to: TO, body: 'a', previewUrl: true, replyTo: 'wamid.IN' }, { idempotencyKey: 'pedido-42', replies: 'queue' }));
    expect(call.headers['Idempotency-Key']).toBe('pedido-42');
    expect(call.headers['X-Synergy-Replies']).toBe('queue');
    expect(call.body).toMatchObject({ text: { body: 'a', preview_url: true }, context: { message_id: 'wamid.IN' } });
  });

  it('refuses a bad idempotencyKey or replies before any call', async () => {
    const f = fakeFetch(json(SENT));
    const wa = client(f.fetch).number(PNID);
    await expect(wa.messages.text({ to: TO, body: 'a' }, { idempotencyKey: 'x\r\nInjected: 1' })).rejects.toThrow(SynergyError);
    await expect(wa.messages.text({ to: TO, body: 'a' }, { idempotencyKey: 'x'.repeat(201) })).rejects.toThrow(SynergyError);
    await expect(wa.messages.text({ to: TO, body: 'a' }, { replies: 'everyone' as never })).rejects.toThrow(SynergyError);
    await expect(wa.messages.text({ to: '', body: 'a' })).rejects.toThrow(SynergyError);
    expect(f.calls).toHaveLength(0);
  });

  it('template: variables become components', async () => {
    const call = await send((wa) =>
      wa.messages.template({ to: TO, name: 'pedido_enviado', language: 'pt_BR', header: ['Loja'], body: ['Maria', 42], buttons: [{ index: 0, subType: 'url', parameters: ['abc'] }, { index: 1, subType: 'quick_reply', parameters: ['yes'] }] }),
    );
    expect(call.body).toMatchObject({
      type: 'template',
      template: {
        name: 'pedido_enviado',
        language: { code: 'pt_BR' },
        components: [
          { type: 'header', parameters: [{ type: 'text', text: 'Loja' }] },
          { type: 'body', parameters: [{ type: 'text', text: 'Maria' }, { type: 'text', text: '42' }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'abc' }] },
          { type: 'button', sub_type: 'quick_reply', index: '1', parameters: [{ type: 'payload', payload: 'yes' }] },
        ],
      },
    });
  });

  it('template without variables has no components; raw components win', async () => {
    const plain = await send((wa) => wa.messages.template({ to: TO, name: 'boas_vindas', language: 'pt_BR' }));
    expect((plain.body as { template: object }).template).toEqual({ name: 'boas_vindas', language: { code: 'pt_BR' } });
    const raw = await send((wa) => wa.messages.template({ to: TO, name: 'x', language: 'pt_BR', body: ['ignored'], components: [{ type: 'body', parameters: [] }] }));
    expect((raw.body as { template: { components: unknown } }).template.components).toEqual([{ type: 'body', parameters: [] }]);
  });

  it.each([
    ['image link', (wa: any) => wa.messages.image({ to: TO, link: 'https://x/f.jpg', caption: 'Este' }), 'image', { link: 'https://x/f.jpg', caption: 'Este' }],
    ['image id', (wa: any) => wa.messages.image({ to: TO, mediaId: '123' }), 'image', { id: '123' }],
    ['audio voice', (wa: any) => wa.messages.audio({ to: TO, mediaId: '123', voice: true }), 'audio', { id: '123', voice: true }],
    ['video', (wa: any) => wa.messages.video({ to: TO, link: 'https://x/v.mp4', caption: 'v' }), 'video', { link: 'https://x/v.mp4', caption: 'v' }],
    ['document', (wa: any) => wa.messages.document({ to: TO, mediaId: '9', filename: 'a.pdf', caption: 'c' }), 'document', { id: '9', filename: 'a.pdf', caption: 'c' }],
    ['sticker', (wa: any) => wa.messages.sticker({ to: TO, link: 'https://x/s.webp' }), 'sticker', { link: 'https://x/s.webp' }],
    ['location', (wa: any) => wa.messages.location({ to: TO, latitude: -23.5, longitude: '-46.6', name: 'Loja', address: 'Av. Paulista' }), 'location', { latitude: -23.5, longitude: '-46.6', name: 'Loja', address: 'Av. Paulista' }],
    ['contacts', (wa: any) => wa.messages.contacts({ to: TO, contacts: [{ name: { formatted_name: 'Maria' } }] }), 'contacts', [{ name: { formatted_name: 'Maria' } }]],
    ['reaction', (wa: any) => wa.messages.reaction({ to: TO, messageId: 'wamid.IN', emoji: '👍' }), 'reaction', { message_id: 'wamid.IN', emoji: '👍' }],
  ])('%s', async (_, fn, type, content) => {
    const call = await send(fn);
    expect(call.body).toMatchObject({ messaging_product: 'whatsapp', recipient_type: 'individual', to: TO, type, [type]: content });
  });

  it('media needs exactly one of mediaId and link', async () => {
    const f = fakeFetch(json(SENT));
    const wa = client(f.fetch).number(PNID);
    await expect(wa.messages.image({ to: TO } as never)).rejects.toBeInstanceOf(TypeError);
    await expect(wa.messages.image({ to: TO, mediaId: '1', link: 'https://x' } as never)).rejects.toBeInstanceOf(TypeError);
    expect(f.calls).toHaveLength(0);
  });

  it('markAsRead → status read, with the typing indicator on demand, and no `to`', async () => {
    const f = fakeFetch(json({ success: true }), json({ success: true }));
    const wa = client(f.fetch).number(PNID);
    expect(await wa.messages.markAsRead('wamid.IN')).toEqual({ success: true, raw: { success: true } });
    await wa.messages.markAsRead('wamid.IN', { typing: true });
    expect(f.calls[0]?.body).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.IN' });
    expect(f.calls[1]?.body).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.IN', typing_indicator: { type: 'text' } });
  });

  it('interactive.buttons', async () => {
    const call = await send((wa) => wa.messages.interactive.buttons({ to: TO, body: 'Confirma?', header: 'Pedido 42', footer: 'Loja', buttons: [{ id: 'yes', title: 'Sim' }, { id: 'no', title: 'Não' }] }));
    expect(call.body).toEqual({
      messaging_product: 'whatsapp', recipient_type: 'individual', to: TO, type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: 'Pedido 42' },
        body: { text: 'Confirma?' },
        footer: { text: 'Loja' },
        action: { buttons: [{ type: 'reply', reply: { id: 'yes', title: 'Sim' } }, { type: 'reply', reply: { id: 'no', title: 'Não' } }] },
      },
    });
  });

  it('interactive.list drops what is undefined', async () => {
    const sections = [{ title: 'Entrega', rows: [{ id: 'express', title: 'Expressa', description: '1 a 2 dias' }] }];
    const call = await send((wa) => wa.messages.interactive.list({ to: TO, body: 'Escolha', button: 'Escolher', sections }));
    expect((call.body as { interactive: unknown }).interactive).toEqual({ type: 'list', body: { text: 'Escolha' }, action: { button: 'Escolher', sections } });
  });

  it('interactive.flow', async () => {
    const call = await send((wa) => wa.messages.interactive.flow({ to: TO, flowId: '9876543210', cta: 'Abrir', flowToken: 'tok', screen: 'SIGN_UP', data: { a: '1' } }));
    expect((call.body as { interactive: unknown }).interactive).toEqual({
      type: 'flow',
      body: { text: 'Abrir' },
      action: {
        name: 'flow',
        parameters: { flow_message_version: '3', flow_id: '9876543210', flow_cta: 'Abrir', flow_token: 'tok', flow_action_payload: { screen: 'SIGN_UP', data: { a: '1' } } },
      },
    });
  });

  it('interactive: ctaUrl, product, productList, catalog, callPermission', async () => {
    const f = fakeFetch(json(SENT));
    const i = client(f.fetch).number(PNID).messages.interactive;
    await i.ctaUrl({ to: TO, body: 'b', displayText: 'Abrir', url: 'https://x.com' });
    await i.product({ to: TO, catalogId: 'c1', productRetailerId: 'p1', body: 'b' });
    await i.productList({ to: TO, catalogId: 'c1', header: 'H', body: 'b', sections: [{ title: 'T', productRetailerIds: ['p1', 'p2'] }] });
    await i.catalog({ to: TO, body: 'b', thumbnailProductRetailerId: 'p1' });
    await i.callPermission({ to: TO, body: 'Podemos ligar?' });
    const actions = f.calls.map((c) => (c.body as { interactive: { type: string; action: unknown } }).interactive);
    expect(actions.map((a) => a.type)).toEqual(['cta_url', 'product', 'product_list', 'catalog_message', 'call_permission_request']);
    expect(actions[0]?.action).toEqual({ name: 'cta_url', parameters: { display_text: 'Abrir', url: 'https://x.com' } });
    expect(actions[2]?.action).toEqual({ catalog_id: 'c1', sections: [{ title: 'T', product_items: [{ product_retailer_id: 'p1' }, { product_retailer_id: 'p2' }] }] });
  });

  it('send(raw) forwards the Meta body as it came (the escape hatch)', async () => {
    const body = { to: TO, type: 'text', text: { body: 'x' }, some_new_meta_field: { a: 1 } };
    const f = fakeFetch(json(SENT));
    const result = await client(f.fetch).number(PNID).messages.send(body);
    expect(f.calls[0]?.body).toEqual({ messaging_product: 'whatsapp', ...body });
    expect(result.id).toBe('wamid.ABC');
  });

  it('an answer without a message id is an error, not a fake success', async () => {
    const f = fakeFetch(json({ messaging_product: 'whatsapp' }));
    await expect(client(f.fetch).number(PNID).messages.text({ to: TO, body: 'x' })).rejects.toThrow('no message id');
  });
});

describe('media, flows and handoff', () => {
  it('upload → multipart with the file, type and messaging_product; { id, raw }', async () => {
    const f = fakeFetch(json({ id: '1166846181421424' }));
    const wa = client(f.fetch).number(PNID);
    const result = await wa.media.upload({ file: new Blob(['%PDF-1.4'], { type: 'application/pdf' }), mimeType: 'application/pdf', filename: 'a.pdf' });
    expect(result).toEqual({ id: '1166846181421424', raw: { id: '1166846181421424' } });
    const call = f.calls[0]!;
    expect(call.url).toBe(`https://api.synergyconnect.com.br/v25.0/${PNID}/media`);
    const form = call.init.body as FormData;
    expect(form.get('messaging_product')).toBe('whatsapp');
    expect(form.get('type')).toBe('application/pdf');
    expect((form.get('file') as File).name).toBe('a.pdf');
    expect(call.headers['Content-Type']).toBeUndefined();
  });

  it('upload takes bytes too and refuses a stream (the size must be known)', async () => {
    const f = fakeFetch(json({ id: '1' }));
    const wa = client(f.fetch).number(PNID);
    await wa.media.upload({ file: new Uint8Array([1, 2, 3]), mimeType: 'image/png' });
    await wa.media.upload({ file: new ArrayBuffer(4), mimeType: 'image/png' });
    await expect(wa.media.upload({ file: new ReadableStream() as never, mimeType: 'image/png' })).rejects.toBeInstanceOf(TypeError);
    await expect(wa.media.upload({ file: new Blob(['x']), mimeType: '' })).rejects.toThrow(SynergyError);
    expect(f.calls).toHaveLength(2);
  });

  it('get / download / delete use the media path with phone_number_id', async () => {
    const f = fakeFetch(
      json({ id: '77', url: 'https://api.synergyconnect.com.br/v25.0/77/download?phone_number_id=1', mime_type: 'image/jpeg', sha256: 'abc', file_size: 10 }),
      new Response('FILEBYTES', { status: 200, headers: { 'content-type': 'image/jpeg' } }),
      json({ success: true }),
    );
    const wa = client(f.fetch).number(PNID);
    const info = await wa.media.get('77');
    expect(info).toMatchObject({ mimeType: 'image/jpeg', sha256: 'abc', fileSize: 10 });
    const res = await wa.media.download('77');
    expect(await res.text()).toBe('FILEBYTES');
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    expect(await wa.media.delete('77')).toMatchObject({ success: true });
    expect(f.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET https://api.synergyconnect.com.br/v25.0/77?phone_number_id=${PNID}`,
      `GET https://api.synergyconnect.com.br/v25.0/77/download?phone_number_id=${PNID}`,
      `DELETE https://api.synergyconnect.com.br/v25.0/77?phone_number_id=${PNID}`,
    ]);
  });

  it('download of a missing media is a NotFoundError', async () => {
    const f = fakeFetch(graphError(404, 100));
    await expect(client(f.fetch).number(PNID).media.download('77')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('flows.createToken and conversations.handoff', async () => {
    const f = fakeFetch(json({ flow_token: 'v1.x.y', expires_at: '2026-01-04T00:00:00.000Z' }), json({ success: true, status: 'pending' }));
    const wa = client(f.fetch).number(PNID);
    expect(await wa.flows.createToken({ flowId: '1234567890', to: TO, context: { plan: 'pro' } })).toMatchObject({ flowToken: 'v1.x.y', expiresAt: '2026-01-04T00:00:00.000Z' });
    expect(await wa.conversations.handoff({ waId: TO })).toMatchObject({ success: true, status: 'pending' });
    expect(f.calls[0]).toMatchObject({ method: 'POST', url: `https://api.synergyconnect.com.br/v1/numbers/${PNID}/flows/1234567890/token`, body: { to: TO, context: { plan: 'pro' } } });
    expect(f.calls[1]).toMatchObject({ method: 'POST', url: `https://api.synergyconnect.com.br/v1/numbers/${PNID}/handoff`, body: { wa_id: TO } });
  });
});

describe('E2-5 · errors', () => {
  const cases: [string, number, number | undefined, new (...a: never[]) => APIError][] = [
    ['190', 401, 190, AuthenticationError],
    ['401 without code', 401, undefined, AuthenticationError],
    ['200', 403, 200, PermissionError],
    ['1390004 (plan)', 403, 1390004, PermissionError],
    ['1390005', 403, 1390005, PermissionError],
    ['1390007', 403, 1390007, PermissionError],
    ['1390011', 403, 1390011, PermissionError],
    ['1390013', 403, 1390013, PermissionError],
    ['1390014', 403, 1390014, PermissionError],
    ['404 (100)', 404, 100, NotFoundError],
    ['400 (100)', 400, 100, BadRequestError],
    ['1390009', 400, 1390009, BadRequestError],
    ['1390001', 409, 1390001, ConflictError],
    ['1390002', 409, 1390002, ConflictError],
    ['1390008', 409, 1390008, ConflictError],
    ['1390003', 422, 1390003, IdempotencyError],
    ['130429', 429, 130429, RateLimitError],
    ['1390006', 429, 1390006, RateLimitError],
    ['1390010', 429, 1390010, RateLimitError],
    ['1390012', 429, 1390012, RateLimitError],
    ['1390015', 429, 1390015, RateLimitError],
    ['503 (2)', 503, 2, ServerError],
    ['Meta 131047', 400, 131047, MetaError],
    ['Meta 131026', 400, 131026, MetaError],
  ];

  it.each(cases)('%s → the right class, with status, code and fbtraceId', async (_, status, code, Class) => {
    const f = fakeFetch(code === undefined ? json({ error: 'Unauthorized' }, status) : graphError(status, code, 'msg'));
    const err = (await client(f.fetch, { maxRetries: 0 }).me().catch((e: unknown) => e)) as APIError;
    expect(err).toBeInstanceOf(Class);
    expect(err).toBeInstanceOf(APIError);
    expect(err).toBeInstanceOf(SynergyError);
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    if (code !== undefined) expect(err.fbtraceId).toBe('syn-abcd1234');
  });

  it('the management error shape: { error, feature, reason }', async () => {
    const f = fakeFetch(json({ error: 'O plano não inclui a API.', feature: 'api', reason: 'plan' }, 403));
    const err = (await client(f.fetch).me().catch((e: unknown) => e)) as PermissionError;
    expect(err).toBeInstanceOf(PermissionError);
    expect(err).toMatchObject({ status: 403, message: 'O plano não inclui a API.', feature: 'api', reason: 'plan', code: undefined });
  });

  it('keeps error_data.details, retryAfter and the body', async () => {
    const body = { error: { message: '(#1390006) volume', code: 1390006, error_data: { details: 'Buy a recharge' } } };
    const f = fakeFetch(json(body, 429, { 'retry-after': '3600' }));
    const err = (await client(f.fetch).me().catch((e: unknown) => e)) as RateLimitError;
    expect(err).toMatchObject({ details: 'Buy a recharge', retryAfter: 3600, body });
  });

  it('toJSON lists the fields; no instance dump', async () => {
    const f = fakeFetch(graphError(400, 131047, 'window'));
    const err = (await client(f.fetch).me().catch((e: unknown) => e)) as MetaError;
    expect(Object.keys(JSON.parse(JSON.stringify(err)))).toEqual(expect.arrayContaining(['name', 'status', 'code', 'message', 'fbtraceId', 'body']));
    expect(JSON.parse(JSON.stringify(err)).name).toBe('MetaError');
  });
});

describe('E2-2 / E2-3 · retries (§5.5)', () => {
  const text = (synergy: Synergy) => synergy.number(PNID).messages.text({ to: TO, body: 'x' });

  it('E2-2 503 then 200 on a send: the SAME Idempotency-Key', async () => {
    const f = fakeFetch(graphError(503, 2), json(SENT));
    const result = await text(client(f.fetch));
    expect(result.id).toBe('wamid.ABC');
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]?.headers['Idempotency-Key']).toBeTruthy();
    expect(f.calls[1]?.headers['Idempotency-Key']).toBe(f.calls[0]?.headers['Idempotency-Key']);
  });

  it('a network error on a send is retried with the same key', async () => {
    const f = fakeFetch(new TypeError('fetch failed'), json(SENT));
    await text(client(f.fetch));
    expect(f.calls.map((c) => c.headers['Idempotency-Key'])).toHaveLength(2);
    expect(f.calls[1]?.headers['Idempotency-Key']).toBe(f.calls[0]?.headers['Idempotency-Key']);
  });

  it('a caller idempotencyKey is reused across retries', async () => {
    const f = fakeFetch(graphError(500, 1), graphError(502, 1), json(SENT));
    await client(f.fetch).number(PNID).messages.text({ to: TO, body: 'x' }, { idempotencyKey: 'order-7' });
    expect(f.calls.map((c) => c.headers['Idempotency-Key'])).toEqual(['order-7', 'order-7', 'order-7']);
  });

  it('gives up after maxRetries and throws the last error', async () => {
    const f = fakeFetch(graphError(503, 2));
    await expect(text(client(f.fetch, { maxRetries: 2 }))).rejects.toBeInstanceOf(ServerError);
    expect(f.calls).toHaveLength(3);
    const g = fakeFetch(graphError(503, 2));
    await expect(text(client(g.fetch, { maxRetries: 0 }))).rejects.toBeInstanceOf(ServerError);
    expect(g.calls).toHaveLength(1);
  });

  it('409 1390002 waits and repeats the same key', async () => {
    const f = fakeFetch(graphError(409, 1390002, 'in progress', { 'retry-after': '0' }), json(SENT));
    await text(client(f.fetch));
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]?.headers['Idempotency-Key']).toBe(f.calls[0]?.headers['Idempotency-Key']);
  });

  it('429 130429 respects Retry-After up to maxRetryAfter', async () => {
    const f = fakeFetch(graphError(429, 130429, 'slow down', { 'retry-after': '0' }), json(SENT));
    await text(client(f.fetch));
    expect(f.calls).toHaveLength(2);
    const g = fakeFetch(graphError(429, 130429, 'slow down', { 'retry-after': '120' }), json(SENT));
    const err = await text(client(g.fetch)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter).toBe(120);
    expect(g.calls).toHaveLength(1);
  });

  it.each([1390006, 1390010, 1390012, 1390015])('E2-3 429 %i → RateLimitError with retryAfter and NO second call', async (code) => {
    const f = fakeFetch(graphError(429, code, 'limit', { 'retry-after': '0' }), json(SENT));
    const err = await text(client(f.fetch)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter).toBe(0);
    expect(f.calls).toHaveLength(1);
  });

  it.each([
    [400, 100], [401, 190], [403, 200], [404, 100], [409, 1390001], [422, 1390003], [400, 131047],
  ])('%i/%i is never retried', async (status, code) => {
    const f = fakeFetch(graphError(status, code), json(SENT));
    await expect(text(client(f.fetch))).rejects.toBeInstanceOf(APIError);
    expect(f.calls).toHaveLength(1);
  });

  it('GET is retried on 5xx and on a network error', async () => {
    const f = fakeFetch(new TypeError('fetch failed'), graphError(502, 1), json({ data: [] }));
    expect(await client(f.fetch).numbers.list()).toMatchObject({ data: [] });
    expect(f.calls).toHaveLength(3);
  });

  it('uploads, writes and deletes: only a network error BEFORE a response, never after a status', async () => {
    const up = fakeFetch(graphError(503, 2), json({ id: '1' }));
    await expect(client(up.fetch).number(PNID).media.upload({ file: new Blob(['x']), mimeType: 'image/png' })).rejects.toBeInstanceOf(ServerError);
    expect(up.calls).toHaveLength(1);

    const del = fakeFetch(graphError(500, 1), json({ success: true }));
    await expect(client(del.fetch).number(PNID).media.delete('77')).rejects.toBeInstanceOf(ServerError);
    expect(del.calls).toHaveLength(1);

    const handoff = fakeFetch(graphError(429, 130429, 'x', { 'retry-after': '0' }), json({ success: true, status: 'pending' }));
    await expect(client(handoff.fetch).number(PNID).conversations.handoff({ waId: TO })).rejects.toBeInstanceOf(RateLimitError);
    expect(handoff.calls).toHaveLength(1);

    const net = fakeFetch(new TypeError('fetch failed'), json({ id: '1' }));
    await client(net.fetch).number(PNID).media.upload({ file: new Blob(['x']), mimeType: 'image/png' });
    expect(net.calls).toHaveLength(2);
  });

  it('a timeout is a TimeoutError, retried on a send, never on an upload', async () => {
    const hang = (call: { init: RequestInit }) =>
      new Promise<Response>((_, reject) => call.init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const f = fakeFetch(hang as never, json(SENT));
    expect((await text(client(f.fetch, { timeout: 20 }))).id).toBe('wamid.ABC');
    expect(f.calls).toHaveLength(2);

    const g = fakeFetch(hang as never, json({ id: '1' }));
    await expect(client(g.fetch, { timeout: 20 }).number(PNID).media.upload({ file: new Blob(['x']), mimeType: 'image/png' })).rejects.toBeInstanceOf(TimeoutError);
    expect(g.calls).toHaveLength(1);
  });

  it('an aborted signal is an AbortError and nothing is retried', async () => {
    const controller = new AbortController();
    const hang = (call: { init: RequestInit }) =>
      new Promise<Response>((_, reject) => call.init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const f = fakeFetch(hang as never, json(SENT));
    const pending = client(f.fetch).number(PNID).messages.text({ to: TO, body: 'x' }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toBeInstanceOf(AbortError);
    expect(f.calls).toHaveLength(1);
    // already aborted: no call at all
    await expect(client(f.fetch).me({ signal: controller.signal })).rejects.toBeInstanceOf(AbortError);
    expect(f.calls).toHaveLength(1);
  });

  it('a 2xx that is not JSON is an error', async () => {
    const f = fakeFetch(new Response('<html>hi</html>', { status: 200 }));
    await expect(client(f.fetch).me()).rejects.toThrow('non-JSON');
  });
});
