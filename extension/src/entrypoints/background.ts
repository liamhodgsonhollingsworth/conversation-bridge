// Service worker. Handles:
//   - manual "send current page" requests from the popup
//   - CONTENT_EVENT relays from content scripts (e.g. completed conversation)
//   - health-poll alarm to flag broken connections in the UI
//   - test-connection probe (popup uses this to surface red/green status)

import {
  getConnections,
  updateConnection,
  appendLog,
  getSettings,
} from '../lib/storage';
import { postEvent, fetchHealth, urlMatchesScopes } from '../lib/protocol';
import { type BridgeEventPayload, type EventType } from '../lib/types';
import { type ExtensionMessage, type ToastData } from '../lib/messages';
import { uuid } from '../lib/uuid';

const HEALTH_POLL_PERIOD_MIN = 5;

export default defineBackground(() => {
  console.log('[ConversationBridge] background worker started', { id: browser.runtime.id });

  browser.alarms.create('health-poll', { periodInMinutes: HEALTH_POLL_PERIOD_MIN });
  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'health-poll') await pollAllHealth();
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
    return false;
  });
});

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
