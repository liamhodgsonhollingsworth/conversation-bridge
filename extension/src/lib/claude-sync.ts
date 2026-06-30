// Background internal-API poller for claude.ai.
//
// claude.ai has no official conversation API, but its logged-in web app calls
// an internal JSON API. Because this extension runs in the user's already
// authenticated browser, a background `fetch()` with `credentials: 'include'`
// rides the user's existing session cookies — no credential handling, no
// tokens entered by anyone.
//
// This module is ADDITIVE: it runs in the background worker (not the content
// script) and relays each conversation as a CBP v1 `conversation.captured`
// event. It does NOT bump the protocol — see ../../../docs/protocol-v1.md.
//
// The exported `pollClaudeAiConversations` does org -> list -> (dedup) -> tree
// -> relay and manages the `cb.claudeai.syncState` dedup map in
// browser.storage.local. The small helpers (`pickOrgId`,
// `normalizeConversation`, `selectChangedChatIds`) are PURE and unit-testable
// without a browser.

import { type BridgeEventPayload } from './types';

const CLAUDE_ORIGIN = 'https://claude.ai';
const LIST_PAGE_LIMIT = 30;
// Hard cap on list pages per cycle. 200 * 30 = 6000 conversations — far past any
// real account — so an internal API that silently IGNORES `offset` (and returns
// the same first page forever) can never spin this loop. The per-page
// "no new ids" check below is the primary guard; this is the belt-and-braces cap.
const MAX_LIST_PAGES = 200;
const FETCH_TIMEOUT_MS = 15000;
const SYNC_STATE_KEY = 'cb.claudeai.syncState';

/** chatId -> the `updated_at` ISO string we last relayed. */
export type SyncState = Record<string, string>;

/** A single item from the chat_conversations list endpoint (only fields we use). */
export interface ConversationListItem {
  uuid: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  summary?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Pure helpers (no browser.* — unit-testable with plain fixtures)
// ---------------------------------------------------------------------------

/**
 * Pick the org uuid to sync. Accepts the raw JSON from GET /api/organizations,
 * which may be a bare array or wrapped (e.g. `{ organizations: [...] }` /
 * `{ data: [...] }`). Prefers the first org whose `capabilities` array contains
 * "chat"; otherwise falls back to the first org. Returns null if none found.
 */
export function pickOrgId(orgsJson: unknown): string | null {
  const orgs = asArray(orgsJson, ['organizations', 'data', 'results']);
  if (orgs.length === 0) return null;

  const hasChat = (o: unknown): boolean => {
    const caps = (o as { capabilities?: unknown })?.capabilities;
    return Array.isArray(caps) && caps.some((c) => String(c).toLowerCase() === 'chat');
  };

  const chatOrg = orgs.find((o) => hasChat(o) && typeof orgUuid(o) === 'string');
  if (chatOrg) {
    const id = orgUuid(chatOrg);
    if (id) return id;
  }

  for (const o of orgs) {
    const id = orgUuid(o);
    if (id) return id;
  }
  return null;
}

/**
 * Normalize the full conversation tree JSON (from
 * GET /api/organizations/{orgId}/chat_conversations/{chatId}?tree=True&rendering_mode=messages)
 * into a CBP v1 BridgeEventPayload. Maps sender 'human'->'user',
 * 'assistant'->'assistant'; flattens each message's `content` blocks (or `text`)
 * to a single string; builds the canonical url/chatId/source fields.
 */
export function normalizeConversation(treeJson: unknown): BridgeEventPayload {
  const tree = (treeJson ?? {}) as Record<string, unknown>;
  const chatId = pickStr(tree, 'uuid', 'id') ?? '';
  const rawMessages = pickArray(tree, 'chat_messages', 'chatMessages', 'messages');

  const messages = rawMessages.map((m) => {
    const msg = (m ?? {}) as Record<string, unknown>;
    // claude.ai labels the author `sender` ('human'|'assistant'); tolerate a
    // `role` field too in case the shape drifts toward the public-API naming.
    const role = mapSenderToRole(msg.sender ?? msg.role);
    return {
      role,
      content: extractMessageText(msg),
      timestamp: pickStr(msg, 'created_at', 'createdAt', 'timestamp'),
    };
  });

  const model = pickStr(tree, 'model');

  const payload: BridgeEventPayload = {
    messages,
    title: pickStr(tree, 'name', 'title'),
    url: `${CLAUDE_ORIGIN}/chat/${chatId}`,
    shareUrl: null,
    chatId,
    source: 'claude.ai',
    createdAt: pickStr(tree, 'created_at', 'createdAt'),
    updatedAt: pickStr(tree, 'updated_at', 'updatedAt'),
    model,
  };
  return payload;
}

/**
 * Given the listed conversation summaries and the stored dedup map, return the
 * chatIds that need a full tree fetch — i.e. we have no record for them OR the
 * listed `updated_at` is strictly newer than the stored value. Items with no
 * uuid are skipped. Items with no `updated_at` are treated as "always fetch if
 * unseen" (and re-fetched when we have no stored marker).
 */
export function selectChangedChatIds(
  listItems: ConversationListItem[],
  syncState: SyncState,
): string[] {
  const out: string[] = [];
  for (const item of listItems) {
    const chatId = convId(item);
    if (!chatId) continue;
    const stored = syncState[chatId];
    const listed = pickStr(item as unknown as Record<string, unknown>, 'updated_at', 'updatedAt');
    if (stored === undefined) {
      out.push(chatId);
      continue;
    }
    if (listed !== undefined && isNewer(listed, stored)) {
      out.push(chatId);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The poller (uses browser.storage.local + fetch)
// ---------------------------------------------------------------------------

export interface PollResult {
  scanned: number;
  relayed: number;
  skipped: number;
  error?: string;
}

/**
 * One full poll cycle: pick org -> paginate the conversation list -> select
 * changed/new conversations via the dedup map -> fetch each full tree ->
 * relay it via the supplied callback -> persist the new `updated_at` markers.
 *
 * The `relay` callback is injected so this is testable and decoupled from the
 * background worker. It is called once per changed conversation with the
 * canonical sourceUrl and the normalized payload.
 *
 * On any network/auth failure the cycle aborts QUIETLY and returns a
 * structured error (never throws out of the alarm handler). 401/403 means the
 * user is not logged in.
 */
export async function pollClaudeAiConversations(
  relay: (sourceUrl: string, payload: BridgeEventPayload) => Promise<void>,
): Promise<PollResult> {
  let scanned = 0;
  let relayed = 0;
  let skipped = 0;

  // 1. Resolve the org id.
  const orgsRes = await apiGet('/api/organizations');
  if (!orgsRes.ok) {
    return { scanned, relayed, skipped, error: orgsRes.error };
  }
  const orgId = pickOrgId(orgsRes.json);
  if (!orgId) {
    return { scanned, relayed, skipped, error: 'no_org' };
  }

  // 2. Paginate the conversation list. Dedup by id as we collect, and stop as
  //    soon as a page introduces no NEW ids — this is what makes the loop safe
  //    against an internal API that silently ignores `offset` and returns the
  //    same first page on every request (which would otherwise loop forever).
  //    MAX_LIST_PAGES is the belt-and-braces hard cap.
  const listItems: ConversationListItem[] = [];
  const seenIds = new Set<string>();
  for (let offset = 0, pages = 0; pages < MAX_LIST_PAGES; offset += LIST_PAGE_LIMIT, pages++) {
    const path = `/api/organizations/${orgId}/chat_conversations?limit=${LIST_PAGE_LIMIT}&offset=${offset}`;
    const pageRes = await apiGet(path);
    if (!pageRes.ok) {
      // Partial failure: keep what we have but report the error.
      return { scanned, relayed, skipped, error: pageRes.error };
    }
    const page = asArray(pageRes.json, ['conversations', 'data', 'results']) as ConversationListItem[];
    const beforeUnique = seenIds.size;
    for (const it of page) {
      const id = convId(it);
      if (id === undefined) continue; // id-less rows can't be deduped or synced
      if (seenIds.has(id)) continue; // already collected (offset ignored / overlap)
      seenIds.add(id);
      listItems.push(it);
    }
    scanned = listItems.length;
    if (page.length < LIST_PAGE_LIMIT) break; // short/empty page = last page
    if (seenIds.size === beforeUnique) break; // no new ids this page -> stop
  }

  // 3. Diff against the dedup map. (listItems now holds only id-bearing rows.)
  const syncState = await loadSyncState();
  const changed = selectChangedChatIds(listItems, syncState);
  skipped = listItems.length - changed.length;
  if (skipped < 0) skipped = 0;

  // Index list items by id so we have a fallback `updated_at` to persist.
  const listedById = new Map<string, ConversationListItem>();
  for (const i of listItems) {
    const id = convId(i);
    if (id !== undefined) listedById.set(id, i);
  }

  // 4. Fetch each changed tree and relay it.
  for (const chatId of changed) {
    const treeRes = await apiGet(
      `/api/organizations/${orgId}/chat_conversations/${chatId}?tree=True&rendering_mode=messages`,
    );
    if (!treeRes.ok) {
      // Don't update the marker for a failed fetch; we'll retry next cycle.
      continue;
    }
    const payload = normalizeConversation(treeRes.json);
    const sourceUrl = `${CLAUDE_ORIGIN}/chat/${chatId}`;
    try {
      await relay(sourceUrl, payload);
      relayed += 1;
    } catch {
      // Relay failure: skip the marker update so we retry next cycle.
      continue;
    }
    // Persist the freshest `updated_at` we know about for this chat.
    const listed = listedById.get(chatId);
    const marker =
      payload.updatedAt ||
      (listed && pickStr(listed as unknown as Record<string, unknown>, 'updated_at', 'updatedAt')) ||
      new Date().toISOString();
    syncState[chatId] = marker;
  }

  await saveSyncState(syncState);
  return { scanned, relayed, skipped };
}

// ---------------------------------------------------------------------------
// Network + storage internals
// ---------------------------------------------------------------------------

type ApiResult =
  | { ok: true; json: unknown }
  | { ok: false; error: string };

/**
 * GET a claude.ai internal-API path with the user's session cookies. Never
 * logs cookies/tokens/bodies. Returns a structured result rather than throwing.
 */
async function apiGet(path: string): Promise<ApiResult> {
  const url = `${CLAUDE_ORIGIN}${path}`;
  try {
    const res = await fetch(url, {
      credentials: 'include',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: 'not_logged_in' };
    }
    if (!res.ok) {
      return { ok: false, error: `http_${res.status}` };
    }
    const json = (await res.json()) as unknown;
    return { ok: true, json };
  } catch (e) {
    const name = e instanceof Error ? e.name : 'Error';
    return { ok: false, error: name === 'TimeoutError' ? 'timeout' : 'network_error' };
  }
}

async function loadSyncState(): Promise<SyncState> {
  try {
    const r = await browser.storage.local.get(SYNC_STATE_KEY);
    const v = r[SYNC_STATE_KEY];
    if (v && typeof v === 'object') return v as SyncState;
  } catch {
    // fall through to empty
  }
  return {};
}

async function saveSyncState(state: SyncState): Promise<void> {
  try {
    await browser.storage.local.set({ [SYNC_STATE_KEY]: state });
  } catch {
    // best-effort; next cycle will re-diff
  }
}

// ---------------------------------------------------------------------------
// Small shared pure utilities
// ---------------------------------------------------------------------------

/**
 * First present non-empty string among the given keys. Tolerates the API
 * returning snake_case OR camelCase (e.g. `updated_at` vs `updatedAt`) and
 * simply skips keys that are missing or non-string.
 */
function pickStr(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/** First present array among the given keys (snake_case/camelCase tolerant). */
function pickArray(obj: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const k of keys) {
    const v = obj[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

/** The conversation id from a list item, tolerating `uuid` or `id`. */
function convId(item: ConversationListItem): string | undefined {
  return pickStr(item as unknown as Record<string, unknown>, 'uuid', 'id');
}

/** Coerce a possibly-wrapped JSON value into an array of items. */
function asArray(json: unknown, wrapperKeys: string[]): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    for (const k of wrapperKeys) {
      if (Array.isArray(obj[k])) return obj[k] as unknown[];
    }
  }
  return [];
}

/** Extract the org uuid from an org object, tolerating `uuid` or `id`. */
function orgUuid(o: unknown): string | null {
  const obj = (o ?? {}) as Record<string, unknown>;
  if (typeof obj.uuid === 'string' && obj.uuid.length > 0) return obj.uuid;
  if (typeof obj.id === 'string' && obj.id.length > 0) return obj.id;
  return null;
}

/** Map claude.ai message sender to a CBP role. */
function mapSenderToRole(sender: unknown): 'user' | 'assistant' | 'system' {
  const s = String(sender ?? '').toLowerCase();
  if (s === 'human' || s === 'user') return 'user';
  if (s === 'assistant') return 'assistant';
  return 'system';
}

/**
 * Flatten a message into a single text string. Prefers a non-empty top-level
 * `text`; otherwise concatenates `.text` from each block in the `content`
 * array (skipping blocks without text, e.g. tool_use). Falls back to ''.
 */
function extractMessageText(msg: Record<string, unknown>): string {
  if (typeof msg.text === 'string' && msg.text.length > 0) return msg.text;
  const content = msg.content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = (block ?? {}) as Record<string, unknown>;
      if (typeof b.text === 'string' && b.text.length > 0) parts.push(b.text);
    }
    if (parts.length > 0) return parts.join('\n');
  }
  // Some payloads put plain text on `text` even when empty above; final fallback.
  if (typeof msg.text === 'string') return msg.text;
  return '';
}

/** True if ISO timestamp `a` is strictly newer than ISO timestamp `b`. */
function isNewer(a: string, b: string): boolean {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) {
    // Fall back to lexical comparison for non-parseable values (ISO sorts lexically).
    return a > b;
  }
  return ta > tb;
}
