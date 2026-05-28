// Content script injected on claude.ai pages. Two responsibilities:
//   1. Respond to EXTRACT requests from the background worker (used by manual push).
//   2. Observe the page for "conversation completed" heuristics and fire CONTENT_EVENT.
//
// We deliberately do NOT auto-fire on every message — that would surprise the user.
// Auto-fire triggers (initial MVP set):
//   - The user just sent a message containing approval-decision keywords
//     ("approve", "approved", "rejected", "deny", "go ahead", "ship it").
//   - The page URL changes to a /share/ pattern (Claude generated a share link).

import { extractClaudeConversation } from '../lib/extract-claude';
import { type ExtensionMessage } from '../lib/messages';

const APPROVAL_KEYWORDS = [
  'approve',
  'approved',
  'rejected',
  'reject',
  'deny',
  'go ahead',
  'ship it',
  'lgtm',
];

export default defineContentScript({
  matches: ['https://claude.ai/*'],
  runAt: 'document_idle',

  async main(_ctx) {
    console.log('[ConversationBridge] claude.ai content script loaded');

    browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
      const m = msg as { type?: string };
      if (m?.type === 'EXTRACT') {
        const payload = extractClaudeConversation(document);
        sendResponse({ payload });
        return true;
      }
      return false;
    });

    let lastUrl = location.href;
    let lastUserMsg = '';

    const tick = () => {
      // URL-change detection (SPA navigation).
      if (location.href !== lastUrl) {
        const prev = lastUrl;
        lastUrl = location.href;
        if (/\/share\//i.test(location.href) && !/\/share\//i.test(prev)) {
          const extracted = extractClaudeConversation(document);
          sendEvent('conversation.captured', extracted);
        }
      }

      // Approval-keyword detection on the latest user message.
      const conv = extractClaudeConversation(document);
      const lastUser = (conv.messages || []).slice().reverse().find(m => m.role === 'user');
      if (lastUser && lastUser.content && lastUser.content !== lastUserMsg) {
        lastUserMsg = lastUser.content;
        const lowered = lastUser.content.toLowerCase();
        if (APPROVAL_KEYWORDS.some(k => lowered.includes(k))) {
          sendEvent('conversation.complete', conv);
        }
      }
    };

    // Poll every 2s. (MutationObserver is more reactive but more brittle on claude.ai's
    // virtualized DOM; polling at 2s is plenty given conversations move on human scale.)
    const interval = setInterval(tick, 2000);
    window.addEventListener('beforeunload', () => clearInterval(interval));
  },
});

function sendEvent(
  eventType: 'conversation.complete' | 'conversation.captured',
  payload: ReturnType<typeof extractClaudeConversation>,
): void {
  const msg: ExtensionMessage = {
    type: 'CONTENT_EVENT',
    eventType,
    sourceUrl: location.href,
    payload: {
      messages: payload.messages,
      title: payload.title,
      url: payload.url,
      shareUrl: payload.shareUrl,
    },
  };
  browser.runtime.sendMessage(msg).catch((e: unknown) => {
    console.warn('[ConversationBridge] CONTENT_EVENT send failed', e);
  });
}
