import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Synergy from '../../src/index';
import { OPERATIONS } from '../../src/operations';
import { constructEvent } from '../../src/webhooks';
import { API_KEY, PNID } from '../helpers';
import { SIGNATURE_EXAMPLE, TIMESTAMPED_SIGNATURE_EXAMPLE } from '../vectors';

// The contract (devtools.md §5.7): every operation of the published openapi.json is a method of the SDK. The document
// comes from OPENAPI_FILE (a local file) or OPENAPI_URL (a published one); `npm run test:contract` makes the file
// from this repo's server code when neither is set.
interface Doc {
  paths: Record<string, Record<string, { operationId?: string }>>;
  'x-webhook-delivery'?: { signature: { example: typeof SIGNATURE_EXAMPLE; timestamped: { example: typeof TIMESTAMPED_SIGNATURE_EXAMPLE } } };
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

async function load(): Promise<Doc> {
  const { OPENAPI_FILE, OPENAPI_URL } = process.env;
  if (OPENAPI_FILE) return JSON.parse(readFileSync(OPENAPI_FILE, 'utf8')) as Doc;
  if (OPENAPI_URL) {
    const res = await fetch(OPENAPI_URL);
    if (!res.ok) throw new Error(`GET ${OPENAPI_URL} → ${res.status}`);
    return (await res.json()) as Doc;
  }
  throw new Error('Set OPENAPI_FILE or OPENAPI_URL (or run `npm run test:contract`, which makes the file).');
}

const doc = await load();
const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
  Object.entries(item)
    .filter(([method]) => METHODS.includes(method))
    .map(([method, op]) => ({ id: op.operationId, label: `${method.toUpperCase()} ${path}` })),
);

const synergy = new Synergy({ apiKey: API_KEY, fetch: (() => Promise.reject(new Error('no network in the contract test'))) as typeof fetch });

function resolve(path: string): unknown {
  const keys = path.split('.');
  let owner: unknown = keys[0] === 'number' ? synergy.number(PNID) : synergy;
  if (keys[0] === 'number') keys.shift();
  let target: unknown = owner;
  for (const key of keys) {
    owner = target;
    target = (target as Record<string, unknown> | undefined)?.[key];
  }
  return target;
}

describe('openapi.json ↔ the SDK (E2-6)', () => {
  it('the document has operations', () => {
    expect(operations.length).toBeGreaterThan(0);
  });

  it.each(operations)('$label has an operationId', ({ id }) => {
    expect(id, 'an operation without operationId cannot be mapped').toBeTruthy();
  });

  it.each(operations.filter((o) => o.id))('$id ($label) is in OPERATIONS and is a method', ({ id }) => {
    const path = OPERATIONS[id as string];
    expect(path, `operationId "${id}" is new in the API: add it to src/operations.ts (and the method to the SDK)`).toBeDefined();
    expect(typeof resolve(path as string), `${path} is not a function of the SDK`).toBe('function');
  });

  it('OPERATIONS has nothing the document no longer has', () => {
    const ids = new Set(operations.map((o) => o.id));
    expect(Object.keys(OPERATIONS).filter((id) => !ids.has(id))).toEqual([]);
  });

  it('the document carries the 16 operations of the devtools slice', () => {
    const slice = [
      'listTemplates', 'createTemplate', 'uploadTemplateMedia', 'getTemplate', 'updateTemplate', 'deleteTemplate',
      'listConversations', 'searchConversations', 'listConversationChanges', 'listMessages', 'searchContacts',
      'createOnboardingSession', 'getOnboardingSession', 'cancelOnboardingSession', 'getMe', 'listNumbers',
    ];
    const ids = new Set(operations.map((o) => o.id));
    expect(slice.filter((id) => !ids.has(id))).toEqual([]);
  });
});

describe('the signature examples of the document (E2-4)', () => {
  const hub = doc['x-webhook-delivery']?.signature.example;
  const stamped = doc['x-webhook-delivery']?.signature.timestamped.example;

  it('are the vectors this repo tests with', () => {
    expect(hub).toEqual(SIGNATURE_EXAMPLE);
    expect(stamped).toEqual(TIMESTAMPED_SIGNATURE_EXAMPLE);
  });

  it('verify with the SDK', async () => {
    if (!hub || !stamped) throw new Error('the document has no x-webhook-delivery examples');
    expect(`sha256=${createHmac('sha256', hub.secret).update(hub.body).digest('hex')}`).toBe(hub.header);
    const now = Date.now;
    Date.now = () => stamped.t * 1000;
    try {
      const event = await constructEvent(stamped.body, { 'x-synergy-signature': stamped.header, 'x-synergy-delivery-id': stamped.deliveryId }, stamped.secret);
      expect(event.timestamped).toBe(true);
    } finally {
      Date.now = now;
    }
  });
});
