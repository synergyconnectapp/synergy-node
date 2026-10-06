/**
 * Every `operationId` of the API's `openapi.json` and the SDK method that makes the call, from a `Synergy` client
 * (`number.…` = from `synergy.number(phoneNumberId)`). The contract test (`npm run test:contract`) fails when the
 * document has an operation that is not here, or when a path here is not a function: a new route cannot ship unnoticed.
 */
export const OPERATIONS: Record<string, string> = {
  getMe: 'me',
  listNumbers: 'numbers.list',

  sendMessage: 'number.messages.send',
  uploadMedia: 'number.media.upload',
  getMedia: 'number.media.get',
  deleteMedia: 'number.media.delete',
  downloadMedia: 'number.media.download',
  handoffConversation: 'number.conversations.handoff',
  createFlowToken: 'number.flows.createToken',

  listConversations: 'number.conversations.list',
  searchConversations: 'number.conversations.search',
  listConversationChanges: 'number.conversations.changes',
  listMessages: 'number.conversations.messages',
  searchContacts: 'number.contacts.search',

  listTemplates: 'number.templates.list',
  createTemplate: 'number.templates.create',
  uploadTemplateMedia: 'number.templates.uploadMedia',
  getTemplate: 'number.templates.get',
  updateTemplate: 'number.templates.update',
  deleteTemplate: 'number.templates.delete',

  listWebhooks: 'webhooks.list',
  createWebhook: 'webhooks.create',
  getWebhooksHealth: 'webhooks.health',
  getWebhooksStats: 'webhooks.stats',
  updateWebhook: 'webhooks.update',
  deleteWebhook: 'webhooks.delete',
  rotateWebhookSecret: 'webhooks.rotateSecret',
  retryWebhook: 'webhooks.retry',
  replayWebhook: 'webhooks.replay',
  testWebhook: 'webhooks.test',

  createOnboardingSession: 'onboarding.sessions.create',
  getOnboardingSession: 'onboarding.sessions.get',
  cancelOnboardingSession: 'onboarding.sessions.cancel',
};
