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
export type { ConversationStatus, Handoff } from './resources/conversations';
export type { FlowToken } from './resources/flows';
export type { MediaInfo, MediaUpload, UploadFile } from './resources/media';
export type { ListSection, MessageResult, ReadResult, SendOptions, TemplateButton } from './resources/messages';
export { VERSION } from './version';
