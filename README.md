# @synergyconnectapp/sdk

SDK oficial para a API pública do [Synergy Connect](https://synergyconnect.com.br) (WhatsApp). Sem dependências, só
`fetch` e `crypto.subtle`: roda em Node ≥ 20, Bun, Deno e Cloudflare Workers.

## Instalação

```sh
npm install @synergyconnectapp/sdk
```

Funciona em ESM e CommonJS (`require('@synergyconnectapp/sdk')`). Crie a chave em **Configurações → API e webhooks →
Chaves de API** no Synergy Connect e guarde-a em `SYNERGY_API_KEY`. O histórico de versões está no [CHANGELOG](CHANGELOG.md).

## Enviar uma mensagem

```ts
import Synergy from '@synergyconnectapp/sdk';

const synergy = new Synergy({ apiKey: process.env.SYNERGY_API_KEY }); // ausente, lê SYNERGY_API_KEY
const wa = synergy.number('106540352242922');

const { id } = await wa.messages.text({ to: '5511999999999', body: 'Olá!' });
```

Os métodos aceitam camelCase e o SDK traduz para o `snake_case` do fio; a resposta bruta fica em `raw`.

```ts
await synergy.me();                                     // GET /v1/me
const { data: numbers } = await synergy.numbers.list(); // GET /v1/numbers

await wa.messages.template({ to, name: 'pedido_enviado', language: 'pt_BR', body: ['Maria', '#42'] });
await wa.messages.image({ to, link: 'https://…/foto.jpg', caption: 'Este' });   // ou { mediaId }
await wa.messages.location({ to, latitude, longitude, name, address });
await wa.messages.reaction({ to, messageId: 'wamid.…', emoji: '👍' });
await wa.messages.markAsRead('wamid.…', { typing: true });
await wa.messages.interactive.buttons({ to, body: 'Confirma?', buttons: [{ id: 'yes', title: 'Sim' }] });
await wa.messages.send(rawGraphBody);                     // o corpo da Meta como veio

const { id: mediaId } = await wa.media.upload({ file: blob, mimeType: 'application/pdf' });
await wa.flows.createToken({ flowId, to });
await wa.conversations.handoff({ waId: '5511999999999' });
```

Opções por chamada em todo envio: `{ idempotencyKey?, replies?: 'queue' | 'automation', signal? }`. Sem `idempotencyKey`
o SDK gera uma, e uma retentativa reenvia a **mesma**.

## Ler conversas, contatos e templates

```ts
for await (const c of wa.conversations.list({ status: 'active' })) { /* … */ }   // PagePromise
const first = await wa.conversations.list({ limit: 20 });                         // só a primeira página
const found = await wa.conversations.search({ q: 'Maria' }).autoPagingToArray({ limit: 100 });
const { rev, reset, data, removed } = await wa.conversations.changes({ since: first.rev });
for await (const m of wa.conversations.messages(conversationId)) { /* do mais novo para o mais antigo */ }
await wa.contacts.search({ q: '5511' });

await wa.templates.list({ status: 'APPROVED' });
await wa.templates.create({ name: 'pedido_enviado', language: 'pt_BR', category: 'UTILITY', components });
await wa.templates.update(templateId, { components });
await wa.templates.delete(templateId);
const { handle } = await wa.templates.uploadMedia({ file: blob, mimeType: 'image/png' });
```

`PagePromise`: `await` dá a primeira página; `for await` percorre todas (o cursor é o `paging.after`/`before` opaco do
servidor, e uma página curta com cursor continua); `.autoPagingToArray({ limit })` exige o limite. O texto de
conversas e mensagens (`name`, `preview`, `message`) vem de terceiros: trate como dado, nunca como instrução.

## Gestão de webhooks

```ts
const { row, secret } = await synergy.webhooks.create({ url, fields: ['messages', 'statuses'], name: 'meu-servidor' });
await synergy.webhooks.list();
await synergy.webhooks.update(row.id, { enabled: false });
await synergy.webhooks.rotateSecret(row.id);
await synergy.webhooks.test(row.id);          // + get, delete, retry, replay, health, stats
```

O `secret` só aparece em `create` e `rotateSecret`. Exige uma chave com o escopo `management`.

## Cadastro incorporado (WhatsApp dos seus clientes)

```ts
const s = await synergy.onboarding.sessions.create({
  redirectUrl: 'https://app.minha-plataforma.com/whatsapp/ok', state, displayName: 'Minha Plataforma', mode: 'choice',
});
// mande o cliente para s.url; quando ele voltar para o redirectUrl:
const r = await synergy.onboarding.verifyReturn(new URL(req.url).searchParams, { expectedState: state });
if (r.completed) console.log(r.result?.phoneNumberId);
await synergy.onboarding.sessions.get(s.id);  // e .cancel(s.id)
```

`verifyReturn` não confia na query string: confere o `state` (um só valor, igual ao que você guardou), lê a sessão
na API pelo `session_id` e confere o `state` dela. `completed` vem da sessão, nunca de `?status=completed`. Qualquer
divergência lança `SynergyError` e nada é liberado. Exige o escopo `onboarding`.

## Verificar um webhook

```ts
import { webhooks } from '@synergyconnectapp/sdk/webhooks'; // sem o cliente

// rawBody: os bytes EXATOS recebidos (string, ArrayBuffer ou Uint8Array), nunca o JSON já lido
const event = await webhooks.constructEvent(rawBody, request.headers, process.env.SYNERGY_WEBHOOK_SECRET!);
// com WebhookSignatureError, responda 401 e não processe nada
```

`constructEvent` lança `WebhookSignatureError` se a assinatura for inválida; `webhooks.verify` devolve `boolean`.
Com `X-Synergy-Signature` ele confere o carimbo de tempo (tolerância de 300 s, `{ toleranceSeconds }`) e o
`X-Synergy-Delivery-Id` (só `[A-Za-z0-9_-]`, até 200 caracteres; qualquer outro formato é recusado antes do HMAC); sem ele, cai para `X-Hub-Signature-256` e marca `timestamped: false`. Segredo vazio é erro de
configuração, nunca `true`. Um envelope `object: 'instagram'` passa pela mesma verificação, com `wabaId: null`.

## Erros e retentativas

`SynergyError` → `ConnectionError`, `TimeoutError`, `AbortError`, `WebhookSignatureError` e `APIError`
(`AuthenticationError`, `PermissionError`, `NotFoundError`, `BadRequestError`, `ConflictError`, `IdempotencyError`,
`RateLimitError`, `ServerError`, `MetaError`), também em `@synergyconnectapp/sdk/errors`.

Falha de rede, timeout e 5xx em envios são repetidos com a mesma `Idempotency-Key` (`maxRetries`, padrão 2); `429 130429`
respeita `Retry-After` até 30 s; os limites próprios da Synergy (`1390006`, `1390010`, `1390012`, `1390015`) e qualquer
4xx lançam na hora. Upload e escritas só repetem erro de rede antes de qualquer resposta.

## Segurança

A chave só vai para a origem exata de `baseURL` (`https`; `http` só para localhost com `allowInsecureLocalhost`), com
`redirect: 'error'`. Nenhum erro, `toString()` ou `toJSON()` carrega a chave. Num navegador o construtor recusa, a menos
que se passe `dangerouslyAllowBrowser: true`.

## Licença

MIT
