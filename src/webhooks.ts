// Webhook verification and typed events (devtools.md §5.3, S-44, S-45). Imports nothing but the errors: the subpath
// `@synergyconnectapp/sdk/webhooks` never pulls the client. Only `crypto.subtle` and `TextEncoder` (zero `node:`).
import { SynergyError, WebhookSignatureError } from './errors';

export type RawBody = string | ArrayBuffer | Uint8Array;
export type HeadersLike = Headers | Record<string, string | string[] | undefined>;

export interface VerifyOptions {
  /** How far `t` of `X-Synergy-Signature` may be from now, in seconds. Default 300. */
  toleranceSeconds?: number;
}

const DEFAULT_TOLERANCE_SECONDS = 300;
// The two format rules of the signed contract, copied IDENTICAL from the Synergy API (src/api/public/webhook-events.ts:
// SIGNATURE_T_PATTERN, DELIVERY_ID_PATTERN) and the n8n trigger. The delivery id sits between two dots in `t.deliveryId.body`: a `.`
// (or any other separator) inside it would let bytes move from the body into the id with the same HMAC (RTF-07). The server
// normalizes every id to this charset (T-417, T-418).
const SIGNATURE_T = /^\d{1,12}$/;
const DELIVERY_ID = /^[A-Za-z0-9_-]{1,200}$/;
// the format is checked BEFORE any comparison: prefix, lowercase hex of exactly 64 characters, one signature only
const HUB_SIGNATURE = /^sha256=([0-9a-f]{64})$/;
const SYNERGY_SIGNATURE = /^t=([^,]*),v1=([0-9a-f]{64})$/;

export interface OnboardingEventValue {
  event: 'onboarding.completed' | 'onboarding.failed' | 'onboarding.expired';
  session_id: string;
  state: string;
  external_ref: string | null;
  final: boolean;
  error: { reason: string; message: string } | null;
  instance: {
    id: string;
    phone_number_id: string;
    waba_id: string;
    display_phone_number: string | null;
    mode: 'cloud' | 'coexistence';
  } | null;
  timestamp: string;
}

export interface ConversationsEventValue {
  messaging_product: 'whatsapp';
  metadata: { display_phone_number: string; phone_number_id: string };
  conversations: {
    wa_id: string;
    status: 'pending' | 'open' | 'resolved' | 'automated';
    previous_status: 'pending' | 'open' | 'resolved' | 'automated';
    automation: string | null;
    timestamp: string;
  }[];
}

/** The `value` of a Meta `messages` change: `messages[]` for what customers sent, `statuses[]` for delivery receipts. */
export interface MessagesEventValue {
  messaging_product: 'whatsapp';
  metadata: { display_phone_number: string; phone_number_id: string };
  contacts?: Record<string, unknown>[];
  messages?: Record<string, unknown>[];
  statuses?: Record<string, unknown>[];
  [key: string]: unknown;
}

export type TypedChange =
  | { field: 'messages'; value: MessagesEventValue }
  | { field: 'statuses'; value: MessagesEventValue }
  | { field: 'synergy_conversations'; value: ConversationsEventValue }
  | { field: 'synergy_onboarding'; value: OnboardingEventValue }
  | { field: 'synergy_ping'; value?: Record<string, unknown> }
  | { field: string; value: unknown };

export interface SynergyWebhookEvent {
  /** `X-Synergy-Delivery-Id`: the same on every retry; drop what you already handled. `null` when the header is absent. */
  deliveryId: string | null;
  /** `true` when `X-Synergy-Signature` (with a timestamp) was what vouched for it. */
  timestamped: boolean;
  /** `'whatsapp_business_account'`, `'instagram'` or whatever the envelope says. */
  object: 'whatsapp_business_account' | 'instagram' | (string & {});
  /** `X-Synergy-Instance-Id`, when the delivery carries it. */
  instanceId: string | null;
  /** The WABA id of `entry[0].id`; `null` for the ping (`"0"`), for an Instagram envelope and when absent. */
  wabaId: string | null;
  changes: TypedChange[];
}

const encoder = new TextEncoder();

function bodyBytes(rawBody: unknown): Uint8Array {
  if (typeof rawBody === 'string') return encoder.encode(rawBody);
  if (rawBody instanceof Uint8Array) return rawBody;
  if (rawBody instanceof ArrayBuffer) return new Uint8Array(rawBody);
  // never re-serialize: the signature covers the exact bytes that arrived
  throw new TypeError('rawBody must be the exact request body as a string, ArrayBuffer or Uint8Array (never a parsed object).');
}

function assertSecret(secret: unknown): string {
  if (typeof secret !== 'string' || secret.trim() === '') throw new SynergyError('webhook secret is empty');
  return secret;
}

/** One header, case-insensitive. `undefined` = absent; `null` = present but not a single value (so never valid). */
function header(headers: HeadersLike, name: string): string | undefined | null {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const wanted = name.toLowerCase();
  let found: string | string[] | undefined;
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() !== wanted || v === undefined) continue;
    if (found !== undefined) return null; // the same header twice
    found = v;
  }
  if (Array.isArray(found)) return found.length === 1 ? (found[0] as string) : found.length === 0 ? undefined : null;
  return found;
}

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// HMAC-SHA256 through `crypto.subtle.verify`: constant-time compare inside the platform, never `===` on hex
async function hmacMatches(secret: string, signatureHex: string, parts: Uint8Array[]): Promise<boolean> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const message = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    message.set(p, at);
    at += p.length;
  }
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, hexToBytes(signatureHex), message);
}

interface Check {
  ok: boolean;
  timestamped: boolean;
  deliveryId: string | null;
  reason: string;
}

async function check(rawBody: RawBody, headers: HeadersLike, secret: string, options: VerifyOptions): Promise<Check> {
  const body = bodyBytes(rawBody);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance < 0) {
    throw new TypeError('toleranceSeconds must be a non-negative number.');
  }
  const bad = (reason: string, timestamped: boolean): Check => ({ ok: false, timestamped, deliveryId: null, reason });
  try {
    const synergy = header(headers, 'x-synergy-signature');
    const delivery = header(headers, 'x-synergy-delivery-id');
    const deliveryId = typeof delivery === 'string' && DELIVERY_ID.test(delivery) ? delivery : null;

    if (synergy !== undefined) {
      // with the timestamped header present it is the ONLY one that counts: a bad one never falls back to X-Hub-Signature-256
      if (synergy === null) return bad('malformed signature header', true);
      const m = SYNERGY_SIGNATURE.exec(synergy);
      if (!m || !SIGNATURE_T.test(m[1] as string)) return bad('malformed signature header', true);
      const t = Number(m[1]);
      if (!Number.isSafeInteger(t)) return bad('malformed signature header', true);
      if (deliveryId === null) return bad('missing or invalid delivery id', true);
      const now = Math.floor(Date.now() / 1000);
      if (Math.abs(now - t) > tolerance) return bad('timestamp outside the tolerance window', true);
      const ok = await hmacMatches(secret, m[2] as string, [encoder.encode(`${t}.${deliveryId}.`), body]);
      return ok ? { ok, timestamped: true, deliveryId, reason: '' } : bad('signature mismatch', true);
    }

    const hub = header(headers, 'x-hub-signature-256');
    if (hub === undefined) return bad('missing signature header', false);
    if (hub === null) return bad('malformed signature header', false);
    const m = HUB_SIGNATURE.exec(hub);
    if (!m) return bad('malformed signature header', false);
    const ok = await hmacMatches(secret, m[1] as string, [body]);
    return ok ? { ok, timestamped: false, deliveryId, reason: '' } : bad('signature mismatch', false);
  } catch {
    // any internal failure reads as "invalid", never as a pass
    return bad('signature could not be checked', false);
  }
}

/**
 * Checks the signature of a delivery. `true` only when it is valid; every bad signature (short, long, uppercase, no
 * prefix, two of them, a stale `t`, another delivery id) is `false`, never an exception. Throws only for a mistake
 * in the caller's code: an empty `secret` (`SynergyError`) or a `rawBody` that is not the raw body (`TypeError`).
 */
export async function verify(rawBody: RawBody, headers: HeadersLike, secret: string | undefined, options: VerifyOptions = {}): Promise<boolean> {
  const key = assertSecret(secret);
  return (await check(rawBody, headers, key, options)).ok;
}

/** `verify`, then the typed event. Throws `WebhookSignatureError` when the signature is not valid. */
export async function constructEvent(
  rawBody: RawBody,
  headers: HeadersLike,
  secret: string | undefined,
  options: VerifyOptions = {},
): Promise<SynergyWebhookEvent> {
  const key = assertSecret(secret);
  const result = await check(rawBody, headers, key, options);
  if (!result.ok) throw new WebhookSignatureError(`Invalid webhook signature (${result.reason}).`);

  let envelope: unknown;
  try {
    envelope = JSON.parse(typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody));
  } catch (cause) {
    throw new SynergyError('The webhook body is not valid JSON.', { cause });
  }
  const root = isObject(envelope) ? envelope : {};
  const entry = Array.isArray(root.entry) ? root.entry : [];
  const first = isObject(entry[0]) ? entry[0] : {};
  const object = typeof root.object === 'string' ? root.object : '';
  const instance = header(headers, 'x-synergy-instance-id');
  const waba = typeof first.id === 'string' && first.id !== '' && first.id !== '0' ? first.id : null;

  // an unknown or Instagram envelope keeps its changes as `{ field, value: unknown }` and never throws
  const changes: TypedChange[] = [];
  for (const e of entry) {
    if (!isObject(e) || !Array.isArray(e.changes)) continue;
    for (const c of e.changes) {
      if (isObject(c) && typeof c.field === 'string') changes.push({ field: c.field, value: c.value } as TypedChange);
    }
  }

  return {
    deliveryId: result.deliveryId,
    timestamped: result.timestamped,
    object,
    instanceId: typeof instance === 'string' && instance !== '' ? instance : null,
    wabaId: object === 'whatsapp_business_account' ? waba : null,
    changes,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const webhooks = { verify, constructEvent };
