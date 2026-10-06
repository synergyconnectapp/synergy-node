import { Synergy } from './client';

export { Synergy };
export default Synergy;
export { NumberClient } from './number';
export type { ApiRequest, Me, NumberInfo, NumbersList, RequestOptions, RetryPolicy, SynergyOptions } from './client';
export {
  AbortError,
  APIError,
  AuthenticationError,
  BadRequestError,
  ConflictError,
  ConnectionError,
  IdempotencyError,
  MetaError,
  NotFoundError,
  PermissionError,
  RateLimitError,
  ServerError,
  SynergyError,
  TimeoutError,
  WebhookSignatureError,
} from './errors';
export type { ErrorCode } from './errors';
export { PagePromise } from './pagination';
export type { AutoPagingOptions } from './pagination';
export type { Contact, ContactsPage } from './resources/contacts';
export type {
  Conversation,
  ConversationChanges,
  ConversationFilter,
  ConversationsPage,
  ConversationStatus,
  Handoff,
  Message,
  MessagesPage,
} from './resources/conversations';
export type {
  CreateSessionParams,
  OnboardingMode,
  OnboardingResult,
  OnboardingSession,
  OnboardingStatus,
  ReturnQuery,
  VerifiedReturn,
} from './resources/onboarding';
export type { Template, TemplateCategory, TemplateComponent, TemplateCreated, TemplatesList } from './resources/templates';
export type {
  CreateWebhookParams,
  UpdateWebhookParams,
  Webhook,
  WebhookDeliveryStats,
  WebhookField,
  WebhookHealth,
  WebhooksStats,
  WebhookStatus,
} from './resources/webhooks-admin';
export type { FlowToken } from './resources/flows';
export type { MediaInfo, MediaUpload, UploadFile } from './resources/media';
export type { ListSection, MessageResult, ReadResult, SendOptions, TemplateButton } from './resources/messages';
export { VERSION } from './version';
