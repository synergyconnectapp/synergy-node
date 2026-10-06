import type { Synergy } from './client';
import { SynergyError } from './errors';
import { ContactsResource } from './resources/contacts';
import { ConversationsResource } from './resources/conversations';
import { FlowsResource } from './resources/flows';
import { MediaResource } from './resources/media';
import { MessagesResource } from './resources/messages';
import { TemplatesResource } from './resources/templates';

// the `phone_number_id` of a path (openapi.ts PHONE_NUMBER_ID_PATTERN): digits only, so it can never reshape a URL
const PHONE_NUMBER_ID = /^\d{5,20}$/;

/** Everything that happens on ONE WhatsApp number: `synergy.number('106540352242922')`. */
export class NumberClient {
  readonly phoneNumberId: string;
  readonly messages: MessagesResource;
  readonly media: MediaResource;
  readonly flows: FlowsResource;
  readonly conversations: ConversationsResource;
  readonly contacts: ContactsResource;
  readonly templates: TemplatesResource;

  constructor(client: Synergy, phoneNumberId: string) {
    if (typeof phoneNumberId !== 'string' || !PHONE_NUMBER_ID.test(phoneNumberId)) {
      throw new SynergyError('phoneNumberId must be the number\'s `phone_number_id` (5 to 20 digits). `synergy.numbers.list()` shows them.');
    }
    this.phoneNumberId = phoneNumberId;
    this.messages = new MessagesResource(client, phoneNumberId);
    this.media = new MediaResource(client, phoneNumberId);
    this.flows = new FlowsResource(client, phoneNumberId);
    this.conversations = new ConversationsResource(client, phoneNumberId);
    this.contacts = new ContactsResource(client, phoneNumberId);
    this.templates = new TemplatesResource(client, phoneNumberId);
  }
}
