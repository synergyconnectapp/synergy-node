// Copied from src/api/public/webhook-events.ts (the contract, devtools.md §2.10): the server must produce exactly these.
export const SIGNATURE_EXAMPLE = {
  secret: '0123456789abcdef0123456789abcdef',
  body: '{"object":"whatsapp_business_account","entry":[{"id":"0","time":1767225600,"changes":[{"field":"synergy_ping","value":{"messaging_product":"whatsapp","ping":true,"timestamp":"1767225600"}}]}]}',
  header: 'sha256=b34c62852bf9eb4132dbac56d4b909a1e62d3df61b21807329b6c1f4d59ec77e',
} as const;

export const TIMESTAMPED_SIGNATURE_EXAMPLE = {
  secret: SIGNATURE_EXAMPLE.secret,
  body: SIGNATURE_EXAMPLE.body,
  deliveryId: 'ping-3f9a1c0b-7d2e-4a6f-8b1c-2d3e4f5a6b7c',
  t: 1767225600,
  header: 't=1767225600,v1=9baa189aceecd03d75cb0a92954f222a09db72a2a786d079af44beee79609372',
} as const;
