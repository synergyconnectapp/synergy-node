import type { RequestOptions, Synergy } from '../client';
import { SynergyError } from '../errors';
import { checkUpload, fileName, toBlob, type UploadFile } from './media';
import { query } from './conversations';

export type TemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

/** One component of a template as Meta shapes it (`HEADER`, `BODY`, `FOOTER`, `BUTTONS`…): sent and read untouched. */
export type TemplateComponent = Record<string, unknown>;

export interface Template {
  id: string;
  name: string;
  language: string;
  /** `APPROVED`, `PENDING`, `REJECTED`… as Meta says. */
  status: string;
  category: string;
  parameterFormat: 'POSITIONAL' | 'NAMED' | null;
  components: TemplateComponent[];
}

export interface TemplatesList {
  data: Template[];
  /** `true`: the cache is being refreshed from Meta; the list is what was there. */
  syncing: boolean;
  raw: unknown;
}

export interface TemplateCreated {
  id: string;
  status: string;
  category: string;
  raw: unknown;
}

interface WireTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  parameter_format: Template['parameterFormat'];
  components: TemplateComponent[];
}

// Meta's template id (openapi.ts TEMPLATE_ID_PATTERN): digits only, so it can never reshape a URL
const TEMPLATE_ID = /^\d{1,25}$/;

const template = (t: WireTemplate): Template => ({
  id: t.id,
  name: t.name,
  language: t.language,
  status: t.status,
  category: t.category,
  parameterFormat: t.parameter_format,
  components: t.components,
});

/** Message templates of the WhatsApp Business account of ONE number. Writing needs a key with the `management` scope. */
export class TemplatesResource {
  constructor(
    private readonly client: Synergy,
    private readonly phoneNumberId: string,
  ) {}

  /** `GET /v1/numbers/{id}/templates`: `status` defaults to `APPROVED`; `name` is a prefix; up to 100. */
  async list(params: { status?: string; name?: string; language?: string; limit?: number } = {}, options?: RequestOptions): Promise<TemplatesList> {
    const raw = await this.client.request<{ data: WireTemplate[]; syncing?: boolean }>({
      method: 'GET',
      path: this.#base(),
      query: query({ status: params.status, name: params.name, language: params.language, limit: params.limit }),
      retry: 'safe',
      signal: options?.signal,
    });
    return { data: raw.data.map(template), syncing: raw.syncing === true, raw };
  }

  /** `GET /v1/numbers/{id}/templates/{templateId}`. */
  async get(templateId: string, options?: RequestOptions): Promise<Template & { raw: unknown }> {
    const raw = await this.client.request<WireTemplate>({ method: 'GET', path: this.#path(templateId), retry: 'safe', signal: options?.signal });
    return { ...template(raw), raw };
  }

  /** `POST /v1/numbers/{id}/templates`: sends the template for Meta's review. `name` is lowercase letters, digits and `_`. */
  async create(
    params: { name: string; language: string; category: TemplateCategory; components: TemplateComponent[]; parameterFormat?: 'POSITIONAL' | 'NAMED' },
    options?: RequestOptions,
  ): Promise<TemplateCreated> {
    const raw = await this.client.request<{ id: string; status: string; category: string }>({
      method: 'POST',
      path: this.#base(),
      body: {
        name: params.name,
        language: params.language,
        category: params.category,
        components: params.components,
        ...(params.parameterFormat && { parameter_format: params.parameterFormat }),
      },
      retry: 'network',
      signal: options?.signal,
    });
    return { id: raw.id, status: raw.status, category: raw.category, raw };
  }

  /** `POST /v1/numbers/{id}/templates/{templateId}`: replaces the components (and, optionally, the category or the send TTL). */
  async update(
    templateId: string,
    params: { components: TemplateComponent[]; category?: TemplateCategory; messageSendTtlSeconds?: number },
    options?: RequestOptions,
  ): Promise<{ success: boolean; raw: unknown }> {
    const raw = await this.client.request<{ success?: boolean }>({
      method: 'POST',
      path: this.#path(templateId),
      body: {
        components: params.components,
        ...(params.category && { category: params.category }),
        ...(params.messageSendTtlSeconds !== undefined && { message_send_ttl_seconds: params.messageSendTtlSeconds }),
      },
      retry: 'network',
      signal: options?.signal,
    });
    return { success: raw?.success === true, raw };
  }

  /** `DELETE /v1/numbers/{id}/templates/{templateId}`. */
  async delete(templateId: string, options?: RequestOptions): Promise<{ success: boolean; raw: unknown }> {
    const raw = await this.client.request<{ success?: boolean }>({ method: 'DELETE', path: this.#path(templateId), retry: 'network', signal: options?.signal });
    return { success: raw?.success === true, raw };
  }

  /**
   * `POST /v1/numbers/{id}/templates/media`: the `handle` of an example file for a template header (up to 5 MB:
   * `image/jpeg`, `image/png`, `video/mp4`, `application/pdf`). The size must be known, so no streams.
   */
  async uploadMedia(params: { file: UploadFile; mimeType: string; filename?: string }, options?: RequestOptions): Promise<{ handle: string; raw: unknown }> {
    const { file, mimeType } = checkUpload('templates.uploadMedia', params);
    const form = new FormData();
    form.append('file', toBlob(file, mimeType), params.filename ?? fileName(file));
    const raw = await this.client.request<{ handle: string }>({ method: 'POST', path: `${this.#base()}/media`, body: form, retry: 'network', signal: options?.signal });
    return { handle: raw.handle, raw };
  }

  #base(): string {
    return `/v1/numbers/${this.phoneNumberId}/templates`;
  }

  #path(templateId: string): string {
    if (typeof templateId !== 'string' || !TEMPLATE_ID.test(templateId)) throw new SynergyError('templateId must be the id Meta gave the template (digits only).');
    return `${this.#base()}/${templateId}`;
  }
}
