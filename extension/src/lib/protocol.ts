// Conversation Bridge Protocol (CBP) v1 client-side helpers.
// See ../../../docs/protocol-v1.md for the wire format.

import { uuid } from './uuid';
import {
  type BridgeEvent,
  type BridgeEventPayload,
  type Connection,
  type EndpointHealth,
  type EndpointSpec,
  type EventType,
} from './types';

export async function fetchSpec(
  endpointUrl: string,
  timeoutMs = 5000,
): Promise<EndpointSpec> {
  const url = joinUrl(endpointUrl, '/spec');
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET /spec failed: HTTP ${res.status}`);
  const body = (await res.json()) as EndpointSpec;
  if (!body || typeof body.name !== 'string' || !Array.isArray(body.accepts)) {
    throw new Error('Endpoint /spec did not return a valid EndpointSpec.');
  }
  return body;
}

export async function fetchHealth(
  endpointUrl: string,
  timeoutMs = 3000,
): Promise<EndpointHealth> {
  const url = joinUrl(endpointUrl, '/health');
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET /health failed: HTTP ${res.status}`);
  return (await res.json()) as EndpointHealth;
}

export async function postEvent(
  conn: Connection,
  type: EventType,
  sourceUrl: string,
  payload: BridgeEventPayload,
  metadata: Record<string, unknown> = {},
  timeoutMs = 10000,
): Promise<{ accepted: boolean; eventId?: string; reason?: string }> {
  const event: BridgeEvent = {
    id: uuid(),
    type,
    timestamp: new Date().toISOString(),
    sourceUrl,
    payload,
    metadata,
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (conn.authToken) headers['Authorization'] = `Bearer ${conn.authToken}`;

  const body = JSON.stringify(event);

  if (conn.hmacSecret) {
    event.signature = await hmacSha256Hex(conn.hmacSecret, body);
  }

  const url = joinUrl(conn.endpointUrl, '/events');
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: conn.hmacSecret ? JSON.stringify(event) : body,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    return {
      accepted: false,
      reason: `HTTP ${res.status} ${res.statusText}`,
    };
  }
  return (await res.json()) as { accepted: boolean; eventId?: string; reason?: string };
}

export async function hashSpec(spec: EndpointSpec): Promise<string> {
  const canonical = JSON.stringify({
    name: spec.name,
    version: spec.version,
    accepts: [...spec.accepts].sort(),
    dataFlow: spec.dataFlow,
  });
  const enc = new TextEncoder().encode(canonical);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Hex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + (path.startsWith('/') ? path : '/' + path);
}

/** Return true if `url` matches any of the connection's scope patterns. */
export function urlMatchesScopes(url: string, conn: Connection): boolean {
  if (conn.scopes.length === 0) return false;
  return conn.scopes.some(s => matchPattern(url, s.pattern));
}

/** Glob-style match supporting `*` wildcards. Patterns without scheme assume any scheme. */
export function matchPattern(url: string, pattern: string): boolean {
  // If pattern has no scheme, treat as host+path glob.
  let p = pattern;
  if (!/^https?:\/\//i.test(p)) {
    p = 'https?://' + p;
  } else {
    p = p.replace(/^https?/, 'https?');
  }
  // Escape regex special chars EXCEPT `*`, then convert `*` to `.*`.
  const re = new RegExp(
    '^' +
      p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*') +
      '$',
    'i',
  );
  return re.test(url);
}
