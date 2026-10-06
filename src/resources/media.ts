import { camelize } from '../case';
import type { RequestOptions, Synergy } from '../client';
import { SynergyError } from '../errors';

export interface MediaUpload {
  id: string;
  raw: unknown;
}

export interface MediaInfo {
  id?: string;
  /** The download URL ON THIS API (`media.download` reads it with the same key), not Meta's. */
  url?: string;
  mimeType: string;
  sha256: string;
  fileSize?: number | string;
  raw: unknown;
}

const MEDIA_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type UploadFile = Blob | ArrayBuffer | Uint8Array;

export class MediaResource {
  constructor(
    private readonly client: Synergy,
    private readonly phoneNumberId: string,
  ) {}

  /**
   * `POST /{version}/{id}/media`. The size must be known (the API refuses an upload without `Content-Length`), so `file`
   * is a `Blob`, an `ArrayBuffer` or a `Uint8Array`, never a stream.
   */
  async upload(params: { file: UploadFile; mimeType: string; filename?: string }, options?: RequestOptions): Promise<MediaUpload> {
    const { file, mimeType } = params;
    if (typeof mimeType !== 'string' || mimeType === '') throw new SynergyError('media.upload needs the `mimeType` of the file.');
    if (!(file instanceof Blob) && !(file instanceof ArrayBuffer) && !(file instanceof Uint8Array)) {
      throw new TypeError('media.upload `file` must be a Blob, ArrayBuffer or Uint8Array (a size known up front, never a stream).');
    }
    const blob = file instanceof Blob && file.type === mimeType ? file : new Blob([file as BlobPart], { type: mimeType });
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', blob, params.filename ?? (file instanceof Blob && 'name' in file ? String(file.name) : 'file'));
    const raw = await this.client.request<{ id: string }>({
      method: 'POST',
      path: `/${this.client.graphVersion}/${this.phoneNumberId}/media`,
      body: form,
      retry: 'network',
      signal: options?.signal,
    });
    return { id: raw.id, raw };
  }

  /** `GET /{version}/{mediaId}`: the data of a media of this number. */
  async get(mediaId: string, options?: RequestOptions): Promise<MediaInfo> {
    const raw = await this.client.request({
      method: 'GET',
      path: this.#path(mediaId),
      query: { phone_number_id: this.phoneNumberId },
      retry: 'safe',
      signal: options?.signal,
    });
    return { ...camelize<Omit<MediaInfo, 'raw'>>(raw), raw };
  }

  /** `GET /{version}/{mediaId}/download`: the file, as the `Response` of the API (read `.arrayBuffer()`, `.blob()` or stream it). */
  async download(mediaId: string, options?: RequestOptions): Promise<Response> {
    return this.client.requestStream({
      method: 'GET',
      path: `${this.#path(mediaId)}/download`,
      query: { phone_number_id: this.phoneNumberId },
      retry: 'safe',
      signal: options?.signal,
    });
  }

  /** `DELETE /{version}/{mediaId}`. */
  async delete(mediaId: string, options?: RequestOptions): Promise<{ success: boolean; raw: unknown }> {
    const raw = await this.client.request<{ success?: boolean }>({
      method: 'DELETE',
      path: this.#path(mediaId),
      query: { phone_number_id: this.phoneNumberId },
      retry: 'network',
      signal: options?.signal,
    });
    return { success: raw?.success === true, raw };
  }

  #path(mediaId: string): string {
    // ids are opaque and numeric today; the pattern keeps `..` and `/` out of a path
    if (typeof mediaId !== 'string' || !MEDIA_ID.test(mediaId)) throw new SynergyError('mediaId is not a valid media id.');
    return `/${this.client.graphVersion}/${mediaId}`;
  }
}
