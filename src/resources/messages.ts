import type { Synergy } from '../client';
import { SynergyError } from '../errors';

/** Options of every send. */
export interface SendOptions {
  /** One key per intended message (an order id, say). Generated when absent; a retry reuses the SAME one. */
  idempotencyKey?: string;
  /** Where the customer's answer goes: `queue` = the agents' queue, `automation` = stays with your integration. */
  replies?: 'queue' | 'automation';
  signal?: AbortSignal;
}

/** What a send answers: the id Meta gave, who it went to and the untouched body in `raw`. */
export interface MessageResult {
  id: string;
  to: string;
  status: 'accepted';
  raw: unknown;
}

export interface ReadResult {
  success: boolean;
  raw: unknown;
}

type Common = { to: string; /** The `wamid` of a message to answer (`context.message_id`). */ replyTo?: string };

/** A media message points at an uploaded file (`mediaId`) or at a public URL (`link`), never both. */
type MediaRef = { mediaId: string; link?: never } | { link: string; mediaId?: never };

type Body = Record<string, unknown>;

// a header of an interactive message: plain text, or Meta's own object (image, video, document)
type Header = string | Body;

export interface TemplateButton {
  index: number;
  subType: 'url' | 'quick_reply' | 'copy_code';
  /** url: the variable text; quick_reply: the payload; copy_code: the code. */
  parameters: string[];
}

export interface ListSection {
  title?: string;
  rows: { id: string; title: string; description?: string }[];
}

const IDEMPOTENCY_KEY = /^[\x20-\x7e]{1,200}$/;

const text = (value: string | number) => ({ type: 'text', text: String(value) });
const header = (h: Header | undefined) => (h === undefined ? undefined : typeof h === 'string' ? text(h) : h);
const footer = (f: string | undefined) => (f === undefined ? undefined : { text: f });

export class MessagesResource {
  readonly interactive: InteractiveMessages;

  constructor(
    private readonly client: Synergy,
    private readonly phoneNumberId: string,
  ) {
    this.interactive = new InteractiveMessages(this);
  }

  /** Text, with an optional link preview. */
  async text(params: Common & { body: string; previewUrl?: boolean }, options?: SendOptions) {
    return this.#message(params, 'text', { body: params.body, ...(params.previewUrl !== undefined && { preview_url: params.previewUrl }) }, options);
  }

  /** An approved template: `body` and `header` are the variables in order, `buttons` the ones of its buttons. */
  async template(
    params: Common & {
      name: string;
      language: string;
      header?: (string | number)[];
      body?: (string | number)[];
      buttons?: TemplateButton[];
      /** Meta's `components`, as they are: wins over `header`, `body` and `buttons`. */
      components?: Body[];
    },
    options?: SendOptions,
  ) {
    const components =
      params.components ??
      [
        params.header?.length && { type: 'header', parameters: params.header.map(text) },
        params.body?.length && { type: 'body', parameters: params.body.map(text) },
        ...(params.buttons ?? []).map((b) => ({
          type: 'button',
          sub_type: b.subType,
          index: String(b.index),
          parameters: b.parameters.map((p) =>
            b.subType === 'quick_reply' ? { type: 'payload', payload: p } : b.subType === 'copy_code' ? { type: 'coupon_code', coupon_code: p } : text(p),
          ),
        })),
      ].filter(Boolean);
    return this.#message(
      params,
      'template',
      { name: params.name, language: { code: params.language }, ...(components.length > 0 && { components }) },
      options,
    );
  }

  async image(params: Common & MediaRef & { caption?: string }, options?: SendOptions) {
    return this.#message(params, 'image', { ...mediaRef(params), ...(params.caption !== undefined && { caption: params.caption }) }, options);
  }

  /** `voice: true` sends it as a voice message. */
  async audio(params: Common & MediaRef & { voice?: boolean }, options?: SendOptions) {
    return this.#message(params, 'audio', { ...mediaRef(params), ...(params.voice && { voice: true }) }, options);
  }

  async video(params: Common & MediaRef & { caption?: string }, options?: SendOptions) {
    return this.#message(params, 'video', { ...mediaRef(params), ...(params.caption !== undefined && { caption: params.caption }) }, options);
  }

  async document(params: Common & MediaRef & { caption?: string; filename?: string }, options?: SendOptions) {
    return this.#message(
      params,
      'document',
      { ...mediaRef(params), ...(params.caption !== undefined && { caption: params.caption }), ...(params.filename !== undefined && { filename: params.filename }) },
      options,
    );
  }

  async sticker(params: Common & MediaRef, options?: SendOptions) {
    return this.#message(params, 'sticker', mediaRef(params), options);
  }

  async location(params: Common & { latitude: number | string; longitude: number | string; name?: string; address?: string }, options?: SendOptions) {
    return this.#message(
      params,
      'location',
      {
        latitude: params.latitude,
        longitude: params.longitude,
        ...(params.name !== undefined && { name: params.name }),
        ...(params.address !== undefined && { address: params.address }),
      },
      options,
    );
  }

  /** Contact cards, in Meta's shape (`name`, `phones`, `emails`, `org`…). */
  async contacts(params: Common & { contacts: Body[] }, options?: SendOptions) {
    return this.#message(params, 'contacts', params.contacts, options);
  }

  async reaction(params: Common & { messageId: string; emoji: string }, options?: SendOptions) {
    return this.#message(params, 'reaction', { message_id: params.messageId, emoji: params.emoji }, options);
  }

  /** Marks a RECEIVED message as read; `typing: true` also shows "typing…" for up to 25 s. */
  async markAsRead(messageId: string, options: { typing?: boolean } & SendOptions = {}): Promise<ReadResult> {
    const raw = await this.#post(
      { status: 'read', message_id: messageId, ...(options.typing && { typing_indicator: { type: 'text' } }) },
      options,
    );
    return { success: (raw as { success?: unknown })?.success === true, raw };
  }

  /** Meta's send body as it is: the escape hatch for anything the helpers do not cover. */
  async send(body: Body, options: SendOptions = {}): Promise<MessageResult> {
    const raw = await this.#post(body, options);
    return toResult(raw, typeof body.to === 'string' ? body.to : '');
  }

  async #post(body: Body, options: SendOptions): Promise<unknown> {
    const headers: Record<string, string> = {};
    // generated ONCE, before the first attempt: every retry of this call carries the same key
    const key = options.idempotencyKey ?? globalThis.crypto.randomUUID();
    if (!IDEMPOTENCY_KEY.test(key)) throw new SynergyError('idempotencyKey must be 1 to 200 printable ASCII characters.');
    headers['Idempotency-Key'] = key;
    if (options.replies !== undefined) {
      if (options.replies !== 'queue' && options.replies !== 'automation') throw new SynergyError('replies must be "queue" or "automation".');
      headers['X-Synergy-Replies'] = options.replies;
    }
    return this.client.request({
      method: 'POST',
      path: `/${this.client.graphVersion}/${this.phoneNumberId}/messages`,
      body: { messaging_product: 'whatsapp', ...body },
      headers,
      retry: 'send',
      signal: options.signal,
    });
  }

  #message(params: Common, type: string, content: unknown, options?: SendOptions): Promise<MessageResult> {
    return this.send(typed(params, type, content), options);
  }
}

export class InteractiveMessages {
  constructor(private readonly messages: MessagesResource) {}

  /** Up to three reply buttons. */
  async buttons(params: Common & { body: string; buttons: { id: string; title: string }[]; header?: Header; footer?: string }, options?: SendOptions) {
    return this.#send(params, {
      type: 'button',
      header: header(params.header),
      body: { text: params.body },
      footer: footer(params.footer),
      action: { buttons: params.buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
    }, options);
  }

  /** A list: `button` is the label of the button that opens it. */
  async list(params: Common & { body: string; button: string; sections: ListSection[]; header?: Header; footer?: string }, options?: SendOptions) {
    return this.#send(params, {
      type: 'list',
      header: header(params.header),
      body: { text: params.body },
      footer: footer(params.footer),
      action: { button: params.button, sections: params.sections },
    }, options);
  }

  /**
   * A WhatsApp Flow. For a flow with a Synergy endpoint, `flowToken` comes from `flows.createToken`. `body` is
   * required by Meta: absent, the `cta` text stands in.
   */
  async flow(
    params: Common & {
      flowId: string;
      cta: string;
      flowToken?: string;
      body?: string;
      header?: Header;
      footer?: string;
      flowAction?: 'navigate' | 'data_exchange';
      screen?: string;
      data?: Body;
      flowMessageVersion?: string;
    },
    options?: SendOptions,
  ) {
    return this.#send(params, {
      type: 'flow',
      header: header(params.header),
      body: { text: params.body ?? params.cta },
      footer: footer(params.footer),
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: params.flowMessageVersion ?? '3',
          flow_id: params.flowId,
          flow_cta: params.cta,
          ...(params.flowToken !== undefined && { flow_token: params.flowToken }),
          ...(params.flowAction !== undefined && { flow_action: params.flowAction }),
          ...(params.screen !== undefined && { flow_action_payload: { screen: params.screen, ...(params.data && { data: params.data }) } }),
        },
      },
    }, options);
  }

  /** A button that opens a link. */
  async ctaUrl(params: Common & { body: string; displayText: string; url: string; header?: Header; footer?: string }, options?: SendOptions) {
    return this.#send(params, {
      type: 'cta_url',
      header: header(params.header),
      body: { text: params.body },
      footer: footer(params.footer),
      action: { name: 'cta_url', parameters: { display_text: params.displayText, url: params.url } },
    }, options);
  }

  /** One product of a catalog. */
  async product(params: Common & { catalogId: string; productRetailerId: string; body?: string; footer?: string }, options?: SendOptions) {
    return this.#send(params, {
      type: 'product',
      ...(params.body !== undefined && { body: { text: params.body } }),
      footer: footer(params.footer),
      action: { catalog_id: params.catalogId, product_retailer_id: params.productRetailerId },
    }, options);
  }

  /** Several products of a catalog, in sections. */
  async productList(
    params: Common & { catalogId: string; header: Header; body: string; sections: { title: string; productRetailerIds: string[] }[]; footer?: string },
    options?: SendOptions,
  ) {
    return this.#send(params, {
      type: 'product_list',
      header: header(params.header),
      body: { text: params.body },
      footer: footer(params.footer),
      action: {
        catalog_id: params.catalogId,
        sections: params.sections.map((s) => ({ title: s.title, product_items: s.productRetailerIds.map((id) => ({ product_retailer_id: id })) })),
      },
    }, options);
  }

  /** The whole catalog. */
  async catalog(params: Common & { body: string; thumbnailProductRetailerId?: string; footer?: string }, options?: SendOptions) {
    return this.#send(params, {
      type: 'catalog_message',
      body: { text: params.body },
      footer: footer(params.footer),
      action: {
        name: 'catalog_message',
        ...(params.thumbnailProductRetailerId !== undefined && { parameters: { thumbnail_product_retailer_id: params.thumbnailProductRetailerId } }),
      },
    }, options);
  }

  /** Asks the customer's permission to call them on WhatsApp. */
  async callPermission(params: Common & { body: string }, options?: SendOptions) {
    return this.#send(params, { type: 'call_permission_request', body: { text: params.body }, action: { name: 'call_permission_request' } }, options);
  }

  #send(params: Common, content: Body, options?: SendOptions): Promise<MessageResult> {
    return this.messages.send(typed(params, 'interactive', stripUndefined(content)), options);
  }
}

function typed(params: Common, type: string, content: unknown): Body {
  if (typeof params.to !== 'string' || params.to === '') throw new SynergyError('`to` is required.');
  return {
    recipient_type: 'individual',
    to: params.to,
    type,
    [type]: content,
    ...(params.replyTo && { context: { message_id: params.replyTo } }),
  };
}

function mediaRef(p: { mediaId?: string; link?: string }): Body {
  if ((p.mediaId === undefined) === (p.link === undefined)) throw new TypeError('Pass exactly one of `mediaId` (an uploaded file) or `link` (a public URL).');
  return p.mediaId !== undefined ? { id: p.mediaId } : { link: p.link };
}

function stripUndefined(o: Body): Body {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function toResult(raw: unknown, to: string): MessageResult {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as { messages?: { id?: unknown }[]; contacts?: { wa_id?: unknown; input?: unknown }[] };
  const id = r.messages?.[0]?.id;
  if (typeof id !== 'string') throw new SynergyError('Unexpected answer to a send: no message id.');
  const wa = r.contacts?.[0]?.wa_id;
  return { id, to: typeof wa === 'string' ? wa : to, status: 'accepted', raw };
}
