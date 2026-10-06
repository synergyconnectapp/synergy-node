# @synergyconnect/sdk

SDK oficial para a API pública do [Synergy Connect](https://synergyconnect.com.br) (WhatsApp). Sem dependências, só
`fetch` e `crypto.subtle`: roda em Node ≥ 20, Bun, Deno e Cloudflare Workers.

```sh
npm install @synergyconnect/sdk
```

## Enviar uma mensagem

```ts
import Synergy from '@synergyconnect/sdk';

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

## Webhooks

```ts
import { webhooks } from '@synergyconnect/sdk/webhooks'; // sem o cliente

// rawBody: os bytes EXATOS recebidos (string, ArrayBuffer ou Uint8Array), nunca o JSON já lido
const event = await webhooks.constructEvent(rawBody, request.headers, process.env.SYNERGY_WEBHOOK_SECRET!);
```

`constructEvent` lança `WebhookSignatureError` se a assinatura for inválida; `webhooks.verify` devolve `boolean`.
Com `X-Synergy-Signature` ele confere o carimbo de tempo (tolerância de 300 s, `{ toleranceSeconds }`) e o
`X-Synergy-Delivery-Id`; sem ele, cai para `X-Hub-Signature-256` e marca `timestamped: false`. Segredo vazio é erro de
configuração, nunca `true`. Um envelope `object: 'instagram'` passa pela mesma verificação, com `wabaId: null`.

## Erros e retentativas

`SynergyError` → `ConnectionError`, `TimeoutError`, `AbortError`, `WebhookSignatureError` e `APIError`
(`AuthenticationError`, `PermissionError`, `NotFoundError`, `BadRequestError`, `ConflictError`, `IdempotencyError`,
`RateLimitError`, `ServerError`, `MetaError`), também em `@synergyconnect/sdk/errors`.

Falha de rede, timeout e 5xx em envios são repetidos com a mesma `Idempotency-Key` (`maxRetries`, padrão 2); `429 130429`
respeita `Retry-After` até 30 s; os limites próprios da Synergy (`1390006`, `1390010`, `1390012`, `1390015`) e qualquer
4xx lançam na hora. Upload e escritas só repetem erro de rede antes de qualquer resposta.

## Segurança

A chave só vai para a origem exata de `baseURL` (`https`; `http` só para localhost com `allowInsecureLocalhost`), com
`redirect: 'error'`. Nenhum erro, `toString()` ou `toJSON()` carrega a chave. Num navegador o construtor recusa, a menos
que se passe `dangerouslyAllowBrowser: true`.

## Licença

MIT
