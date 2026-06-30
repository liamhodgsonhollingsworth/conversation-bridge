// Service worker. Handles:
//   - manual "send current page" requests from the popup
//   - CONTENT_EVENT relays from content scripts (e.g. completed conversation)
//   - health-poll alarm to flag broken connections in the UI
//   - test-connection probe (popup uses this to surface red/green status)

import {
  getConnections,
  addConnection,
  updateConnection,
  appendLog,
  getSettings,
} from '../lib/storage';
import { postEvent, fetchHealth, urlMatchesScopes } from '../lib/protocol';
import { type BridgeEventPayload, type EventType } from '../lib/types';
import { type ExtensionMessage, type ToastData } from '../lib/messages';
import { pollClaudeAiConversations, type PollResult } from '../lib/claude-sync';
import { uuid } from '../lib/uuid';

const HEALTH_POLL_PERIOD_MIN = 5;
const CLAUDEAI_SYNC_ALARM = 'claudeai-sync';
const CLAUDEAI_SYNC_INITIAL_ALARM = 'claudeai-sync-initial';

export default defineBackground(() => {
  console.log('[ConversationBridge] background worker started', { id: browser.runtime.id });

  // Self-hosted convenience: a build that sets VITE_SEED_LOOPBACK ships with the
  // user's own loopback receiver pre-trusted, so they don't hand-add a connection
  // to their own machine. INERT in the public default build (no flag → no seed →
  // the trust-first handshake still governs every connection). See seedLoopbackConnection.
  void seedLoopbackConnection();

  browser.alarms.create('health-poll', { periodInMinutes: HEALTH_POLL_PERIOD_MIN });

  // Schedule the recurring claude.ai sync from settings, plus a one-shot poll
  // shortly after startup so the first sync doesn't wait a full period.
  getSettings()
    .then((s) => {
      browser.alarms.create(CLAUDEAI_SYNC_ALARM, {
        periodInMinutes: Math.max(1, s.claudeAiSyncPeriodMin),
      });
    })
    .catch(() => {
      browser.alarms.create(CLAUDEAI_SYNC_ALARM, { periodInMinutes: 30 });
    });
  browser.alarms.create(CLAUDEAI_SYNC_INITIAL_ALARM, { delayInMinutes: 0.5 });

  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'health-poll') await pollAllHealth();
    else if (alarm.name === CLAUDEAI_SYNC_ALARM || alarm.name === CLAUDEAI_SYNC_INITIAL_ALARM) {
      await runClaudeAiSync();
    }
  });

  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const msg = message as ExtensionMessage;
    if (!msg || typeof msg !== 'object' || !('type' in msg)) return false;

    if (msg.type === 'CAPTURE_CURRENT_TAB') {
      handleManualPush().then(r => sendResponse(r)).catch(e =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
      return true; // async response
    }
    if (msg.type === 'CONTENT_EVENT') {
      handleContentEvent(msg.eventType, msg.sourceUrl, msg.payload)
        .then(r => sendResponse(r))
        .catch(e => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg.type === 'TEST_CONNECTION') {
      testConnection(msg.connectionId)
        .then(r => sendResponse(r))
        .catch(e => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg.type === 'SYNC_CLAUDEAI_NOW') {
      runClaudeAiSync()
        .then(r => sendResponse({ ok: !r.error, ...r }))
        .catch(e => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      return true;
    }
    return false;
  });
});

// Pre-seed a single loopback connection so a self-hosted build works on first load
// without the user hand-adding a connection to their OWN machine. Gated behind the
// build-time flag VITE_SEED_LOOPBACK (a URL, default http://127.0.0.1:8782 when set
// to a truthy non-URL): with no flag this is a no-op, so the PUBLIC extension default
// keeps the trust-first handshake for every connection. Never overrides an existing
// connection list, so it can't clobber what the user set up themselves.
async function seedLoopbackConnection(): Promise<void> {
  const flag = (import.meta.env as Record<string, string | undefined>).VITE_SEED_LOOPBACK;
  if (!flag) return;
  try {
    const existing = await getConnections();
    if (existing.length > 0) return; // never override the user's own connections
    const endpointUrl = flag.startsWith('http') ? flag : 'http://127.0.0.1:8782';
    const now = new Date().toISOString();
    await addConnection({
      id: uuid(),
      name: 'Wavelet (loopback)',
      endpointUrl,
      scopes: [{ pattern: 'claude.ai/*', description: 'Your claude.ai conversations' }],
      events: ['conversation.captured', 'conversation.complete'],
      trustAcceptance: {
        acceptedAt: now,
        dataFlowSummary:
          'Pre-seeded loopback receiver on your own machine (self-hosted build). Captures relay to ' +
          endpointUrl +
          ' over localhost only.',
        version: 1,
      },
      enabled: true,
      createdAt: now,
      totalEventsRelayed: 0,
    });
    console.log('[ConversationBridge] seeded loopback connection ->', endpointUrl);
  } catch (e) {
    console.warn('[ConversationBridge] loopback seed skipped:', e);
  }
}

async function handleManualPush(): Promise<
  { ok: true; relayed: number } | { ok: false; error: string }
> {
  const settings = await getSettings();
  if (!settings.enabled) return { ok: false, error: 'Bridge disabled in settings.' };

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.id || !tab.url) return { ok: false, error: 'No active tab.' };

  // Ask the content script for the payload. Falls back to URL-only if no content script.
  let payload: BridgeEventPayload;
  try {
    const resp = (await browser.tabs.sendMessage(tab.id, { type: 'EXTRACT' })) as
      | { payload: BridgeEventPayload }
      | undefined;
    payload = resp?.payload || { url: tab.url, title: tab.title };
  } catch {
    payload = { url: tab.url, title: tab.title };
  }

  const relayed = await relayToMatchingConnections(
    'manual.push',
    tab.url,
    payload,
    settings.privacyMode,
  );
  await showToast(tab.id, {
    id: uuid(),
    title: 'Conversation Bridge',
    message:
      relayed === 0
        ? 'No connections matched this URL.'
        : `Relayed to ${relayed} connection${relayed === 1 ? '' : 's'}.`,
    variant: relayed === 0 ? 'info' : 'success',
  });
  return { ok: true, relayed };
}

async function handleContentEvent(
  eventType: EventType,
  sourceUrl: string,
  payload: BridgeEventPayload,
): Promise<{ ok: true; relayed: number }> {
  const settings = await getSettings();
  if (!settings.enabled) return { ok: true, relayed: 0 };
  const relayed = await relayToMatchingConnections(
    eventType,
    sourceUrl,
    payload,
    settings.privacyMode,
  );
  return { ok: true, relayed };
}

/**
 * Run one claude.ai background sync cycle. Gated on both the master kill switch
 * and the per-feature claudeAiSyncEnabled flag. Relays each changed
 * conversation as a `conversation.captured` event through the existing
 * fan-out, then appends a counts-only summary to the relay log.
 */
async function runClaudeAiSync(): Promise<PollResult> {
  const settings = await getSettings();
  if (!settings.enabled || !settings.claudeAiSyncEnabled) {
    return { scanned: 0, relayed: 0, skipped: 0, error: 'disabled' };
  }

  const result = await pollClaudeAiConversations(async (sourceUrl, payload) => {
    await relayToMatchingConnections(
      'conversation.captured',
      sourceUrl,
      payload,
      settings.privacyMode,
    );
  });

  // Counts-only log entry. Never include message bodies, cookies, or tokens.
  await appendLog({
    id: uuid(),
    connectionId: 'claudeai-sync',
    connectionName: 'claude.ai auto-sync',
    eventType: 'conversation.captured',
    endpointUrl: 'internal:claude.ai',
    timestamp: new Date().toISOString(),
    status: result.error ? 'error' : 'success',
    detail: result.error
      ? `sync error: ${result.error}`
      : `scanned ${result.scanned}, relayed ${result.relayed}, skipped ${result.skipped}`,
  });

  console.log('[ConversationBridge] claude.ai sync', {
    scanned: result.scanned,
    relayed: result.relayed,
    skipped: result.skipped,
    error: result.error,
  });
  return result;
}

async function relayToMatchingConnections(
  eventType: EventType,
  sourceUrl: string,
  payload: BridgeEventPayload,
  privacyMode: boolean,
): Promise<number> {
  const conns = await getConnections();
  const matching = conns.filter(
    c =>
      c.enabled &&
      c.events.includes(eventType) &&
      urlMatchesScopes(sourceUrl, c),
  );
  if (matching.length === 0) return 0;

  const outboundPayload: BridgeEventPayload = privacyMode
    ? {
        title: payload.title,
        url: payload.url,
        shareUrl: payload.shareUrl,
        // Strip message content; keep counts only.
        messages: (payload.messages || []).map(m => ({
          role: m.role,
          content: '[redacted: privacy mode]',
          timestamp: m.timestamp,
        })),
      }
    : payload;

  let okCount = 0;
  for (const conn of matching) {
    try {
      const r = await postEvent(conn, eventType, sourceUrl, outboundPayload, {
        privacyMode,
        userAgent: navigator.userAgent,
      });
      if (r.accepted) {
        okCount += 1;
        await updateConnection(conn.id, {
          lastActiveAt: new Date().toISOString(),
          totalEventsRelayed: conn.totalEventsRelayed + 1,
        });
        await appendLog({
          id: uuid(),
          connectionId: conn.id,
          connectionName: conn.name,
          eventType,
          endpointUrl: conn.endpointUrl,
          timestamp: new Date().toISOString(),
          status: 'success',
          detail: r.eventId,
        });
      } else {
        await appendLog({
          id: uuid(),
          connectionId: conn.id,
          connectionName: conn.name,
          eventType,
          endpointUrl: conn.endpointUrl,
          timestamp: new Date().toISOString(),
          status: 'error',
          detail: r.reason || 'rejected',
        });
      }
    } catch (e) {
      await appendLog({
        id: uuid(),
        connectionId: conn.id,
        connectionName: conn.name,
        eventType,
        endpointUrl: conn.endpointUrl,
        timestamp: new Date().toISOString(),
        status: 'error',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return okCount;
}

async function pollAllHealth(): Promise<void> {
  const conns = await getConnections();
  for (const conn of conns) {
    if (!conn.enabled) continue;
    try {
      await fetchHealth(conn.endpointUrl);
    } catch {
      // Logged silently; popup will show stale lastActiveAt + status check on open.
    }
  }
}

async function testConnection(
  connectionId: string,
): Promise<{ ok: boolean; detail?: string }> {
  const conns = await getConnections();
  const conn = conns.find(c => c.id === connectionId);
  if (!conn) return { ok: false, detail: 'Connection not found.' };
  try {
    const health = await fetchHealth(conn.endpointUrl);
    return { ok: health.status === 'ready', detail: health.status };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

async function showToast(tabId: number, toast: ToastData): Promise<void> {
  try {
    await browser.tabs.sendMessage(tabId, { type: 'SHOW_TOAST', toast });
  } catch {
    // Content script may not be present on this URL; that's fine.
  }
}
