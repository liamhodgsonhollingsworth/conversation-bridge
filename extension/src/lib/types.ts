// Core types for Conversation Bridge.
// See ../../docs/protocol-v1.md for the full Conversation Bridge Protocol (CBP) v1 spec.

export const PROTOCOL_VERSION = 1;

export type EventType =
  | 'conversation.complete'
  | 'conversation.captured'
  | 'manual.push';

export interface ConnectionScope {
  /** URL pattern, e.g. "claude.ai/share/*" or "https://example.com/*". Matched against tab URL. */
  pattern: string;
  /** Optional human-readable description shown in the transparency screen. */
  description?: string;
}

export interface TrustAcceptance {
  acceptedAt: string;
  /** Human-readable summary the user saw + approved at creation time. */
  dataFlowSummary: string;
  /** Protocol version at the time of acceptance. */
  version: number;
  /** SHA-256 of the EndpointSpec JSON at acceptance time. Re-prompt if it changes. */
  specHash?: string;
}

export interface Connection {
  id: string;
  name: string;
  endpointUrl: string;
  authToken?: string;
  /** Optional shared secret for HMAC signing. */
  hmacSecret?: string;
  scopes: ConnectionScope[];
  events: EventType[];
  trustAcceptance: TrustAcceptance;
  enabled: boolean;
  createdAt: string;
  lastActiveAt?: string;
  totalEventsRelayed: number;
}

/** Reply from the endpoint's GET /spec. */
export interface EndpointSpec {
  name: string;
  version: string;
  accepts: EventType[];
  dataFlow: string;
  contact?: string;
  repository?: string;
}

/** Reply from the endpoint's GET /health. */
export interface EndpointHealth {
  status: 'ready' | 'degraded' | 'down';
}

export interface BridgeEventPayload {
  messages?: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp?: string;
  }>;
  title?: string;
  url?: string;
  shareUrl?: string | null;
  // event-type-specific fields can extend here
  [k: string]: unknown;
}

export interface BridgeEvent {
  id: string;
  type: EventType;
  timestamp: string;
  sourceUrl: string;
  sourceName?: string;
  payload: BridgeEventPayload;
  metadata: Record<string, unknown>;
  signature?: string;
}

export interface RelayLogEntry {
  id: string;
  connectionId: string;
  connectionName: string;
  eventType: EventType;
  endpointUrl: string;
  timestamp: string;
  status: 'success' | 'error';
  detail?: string;
}

export interface ExtensionSettings {
  /** Master kill switch. When false, no events are relayed. */
  enabled: boolean;
  /** If true, redact message content (only metadata + counts relayed). */
  privacyMode: boolean;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  privacyMode: false,
};
