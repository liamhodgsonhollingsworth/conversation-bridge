// Heuristic extractors for claude.ai conversation pages.
// Lives in lib/ so it can be tested + reused, but is invoked from the content script.

import { type BridgeEventPayload } from './types';

export interface ExtractedConversation {
  messages: BridgeEventPayload['messages'];
  title?: string;
  url: string;
  shareUrl?: string | null;
}

/**
 * Extract messages from a claude.ai conversation page DOM.
 *
 * The claude.ai DOM is React-rendered and changes over time. We use a conservative
 * approach: walk all elements with role-indicating attributes / class hints, falling
 * back to <article> + <div data-testid=*-message-*> selectors. Returns an empty
 * messages array if nothing matches — the caller decides what to do.
 */
export function extractClaudeConversation(doc: Document = document): ExtractedConversation {
  const url = doc.location?.href || '';
  const title = doc.title?.replace(/\s*[-—|]\s*Claude\s*$/i, '').trim() || undefined;

  const shareUrl = /\/share\//i.test(url) ? url : null;

  // Strategy 1: data-testid attributes (most stable across React refactors so far).
  const candidates = Array.from(
    doc.querySelectorAll<HTMLElement>(
      '[data-testid*="message" i], [data-testid*="conversation-turn" i]',
    ),
  );

  const messages: NonNullable<BridgeEventPayload['messages']> = [];
  if (candidates.length > 0) {
    for (const el of candidates) {
      const text = (el.innerText || el.textContent || '').trim();
      if (!text) continue;
      const role = inferRole(el);
      messages.push({ role, content: text });
    }
  } else {
    // Strategy 2: walk <article> children, which is how claude.ai's main thread renders.
    const articles = Array.from(doc.querySelectorAll<HTMLElement>('main article, article'));
    for (const el of articles) {
      const text = (el.innerText || el.textContent || '').trim();
      if (!text) continue;
      const role = inferRole(el);
      messages.push({ role, content: text });
    }
  }

  return { messages, title, url, shareUrl };
}

function inferRole(el: HTMLElement): 'user' | 'assistant' {
  const hay = (
    (el.getAttribute('data-testid') || '') +
    ' ' +
    (el.getAttribute('aria-label') || '') +
    ' ' +
    (el.className || '')
  ).toLowerCase();
  if (/(user|human|you)/.test(hay)) return 'user';
  if (/(assistant|claude|model|ai)/.test(hay)) return 'assistant';
  // Fallback: heuristic by neighbor index. Walk parent's children and pick role by parity.
  const parent = el.parentElement;
  if (parent) {
    const idx = Array.from(parent.children).indexOf(el);
    return idx % 2 === 0 ? 'user' : 'assistant';
  }
  return 'assistant';
}
