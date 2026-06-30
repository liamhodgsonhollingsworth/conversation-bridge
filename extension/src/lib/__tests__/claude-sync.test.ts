import { describe, it, expect } from 'vitest';
import {
  pickOrgId,
  normalizeConversation,
  selectChangedChatIds,
  type ConversationListItem,
  type SyncState,
} from '../claude-sync';

// ---------------------------------------------------------------------------
// Fixtures — realistic shapes of the claude.ai internal API responses.
// ---------------------------------------------------------------------------

const ORG_LIST_BARE = [
  {
    uuid: 'org-personal-0001',
    name: 'Personal',
    capabilities: ['chat', 'claude_pro'],
  },
  {
    uuid: 'org-raven-0002',
    name: 'Raven (no chat)',
    capabilities: ['api'],
  },
];

// First org has NO chat; the chat-capable org is second — exercises preference.
const ORG_LIST_CHAT_NOT_FIRST = [
  { uuid: 'org-api-only', name: 'API only', capabilities: ['api'] },
  { uuid: 'org-with-chat', name: 'With chat', capabilities: ['legacy', 'chat'] },
];

const ORG_LIST_WRAPPED = {
  organizations: [{ uuid: 'org-wrapped-9', name: 'Wrapped', capabilities: ['chat'] }],
};

const ORG_LIST_NO_CAPS = [
  { uuid: 'org-no-caps-1', name: 'No capabilities field' },
];

const CONVERSATION_LIST: ConversationListItem[] = [
  {
    uuid: 'chat-aaaa',
    name: 'Existing, unchanged',
    created_at: '2026-06-01T10:00:00Z',
    updated_at: '2026-06-10T10:00:00Z',
  },
  {
    uuid: 'chat-bbbb',
    name: 'Existing, updated since last sync',
    created_at: '2026-06-02T10:00:00Z',
    updated_at: '2026-06-20T12:30:00Z',
  },
  {
    uuid: 'chat-cccc',
    name: 'Brand new conversation',
    created_at: '2026-06-25T08:00:00Z',
    updated_at: '2026-06-25T08:05:00Z',
  },
];

const FULL_TREE = {
  uuid: 'chat-bbbb',
  name: 'A conversation with mixed message shapes',
  created_at: '2026-06-02T10:00:00Z',
  updated_at: '2026-06-20T12:30:00Z',
  model: 'claude-opus-4-8',
  chat_messages: [
    {
      uuid: 'msg-1',
      sender: 'human',
      text: 'Hello, can you help me?',
      created_at: '2026-06-02T10:00:01Z',
    },
    {
      uuid: 'msg-2',
      sender: 'assistant',
      // No top-level text; content blocks instead (the common rendering_mode=messages shape).
      content: [
        { type: 'text', text: 'Of course.' },
        { type: 'tool_use', name: 'search' }, // no text — must be skipped
        { type: 'text', text: 'Here is the answer.' },
      ],
      created_at: '2026-06-02T10:00:05Z',
    },
  ],
};

// ---------------------------------------------------------------------------
// pickOrgId
// ---------------------------------------------------------------------------

describe('pickOrgId', () => {
  it('picks the first chat-capable org from a bare array', () => {
    expect(pickOrgId(ORG_LIST_BARE)).toBe('org-personal-0001');
  });

  it('prefers a chat-capable org even when it is not first', () => {
    expect(pickOrgId(ORG_LIST_CHAT_NOT_FIRST)).toBe('org-with-chat');
  });

  it('unwraps a wrapped { organizations: [...] } response', () => {
    expect(pickOrgId(ORG_LIST_WRAPPED)).toBe('org-wrapped-9');
  });

  it('falls back to the first org when no capabilities are present', () => {
    expect(pickOrgId(ORG_LIST_NO_CAPS)).toBe('org-no-caps-1');
  });

  it('returns null for empty / malformed input', () => {
    expect(pickOrgId([])).toBeNull();
    expect(pickOrgId(null)).toBeNull();
    expect(pickOrgId({})).toBeNull();
    expect(pickOrgId({ organizations: [] })).toBeNull();
  });

  it('tolerates id instead of uuid', () => {
    expect(pickOrgId([{ id: 'org-by-id', capabilities: ['chat'] }])).toBe('org-by-id');
  });
});

// ---------------------------------------------------------------------------
// normalizeConversation
// ---------------------------------------------------------------------------

describe('normalizeConversation', () => {
  const payload = normalizeConversation(FULL_TREE);

  it('maps sender human->user and assistant->assistant', () => {
    expect(payload.messages?.[0].role).toBe('user');
    expect(payload.messages?.[1].role).toBe('assistant');
  });

  it('uses top-level text when present', () => {
    expect(payload.messages?.[0].content).toBe('Hello, can you help me?');
  });

  it('flattens content blocks to text and skips non-text blocks', () => {
    expect(payload.messages?.[1].content).toBe('Of course.\nHere is the answer.');
  });

  it('carries per-message timestamps', () => {
    expect(payload.messages?.[0].timestamp).toBe('2026-06-02T10:00:01Z');
  });

  it('builds the canonical url, chatId, source, and title', () => {
    expect(payload.url).toBe('https://claude.ai/chat/chat-bbbb');
    expect(payload.chatId).toBe('chat-bbbb');
    expect(payload.source).toBe('claude.ai');
    expect(payload.title).toBe('A conversation with mixed message shapes');
    expect(payload.shareUrl).toBeNull();
  });

  it('carries created/updated/model metadata', () => {
    expect(payload.createdAt).toBe('2026-06-02T10:00:00Z');
    expect(payload.updatedAt).toBe('2026-06-20T12:30:00Z');
    expect(payload.model).toBe('claude-opus-4-8');
  });

  it('handles an empty / missing chat_messages gracefully', () => {
    const p = normalizeConversation({ uuid: 'x', name: 'empty' });
    expect(p.messages).toEqual([]);
    expect(p.url).toBe('https://claude.ai/chat/x');
    expect(p.model).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// selectChangedChatIds
// ---------------------------------------------------------------------------

describe('selectChangedChatIds', () => {
  it('returns only new-or-updated chat ids', () => {
    const syncState: SyncState = {
      // aaaa unchanged: stored == listed
      'chat-aaaa': '2026-06-10T10:00:00Z',
      // bbbb stored older than listed -> changed
      'chat-bbbb': '2026-06-15T00:00:00Z',
      // cccc absent -> new
    };
    const changed = selectChangedChatIds(CONVERSATION_LIST, syncState);
    expect(changed).toEqual(['chat-bbbb', 'chat-cccc']);
  });

  it('returns all ids when sync state is empty', () => {
    const changed = selectChangedChatIds(CONVERSATION_LIST, {});
    expect(changed).toEqual(['chat-aaaa', 'chat-bbbb', 'chat-cccc']);
  });

  it('returns nothing when everything is up to date', () => {
    const syncState: SyncState = {
      'chat-aaaa': '2026-06-10T10:00:00Z',
      'chat-bbbb': '2026-06-20T12:30:00Z',
      'chat-cccc': '2026-06-25T08:05:00Z',
    };
    expect(selectChangedChatIds(CONVERSATION_LIST, syncState)).toEqual([]);
  });

  it('skips items without a uuid', () => {
    const list = [
      { name: 'no uuid here' } as ConversationListItem,
      { uuid: 'chat-real', updated_at: '2026-06-01T00:00:00Z' },
    ];
    expect(selectChangedChatIds(list, {})).toEqual(['chat-real']);
  });

  it('treats a seen item with no updated_at as unchanged', () => {
    const list: ConversationListItem[] = [{ uuid: 'chat-x' }];
    expect(selectChangedChatIds(list, { 'chat-x': '2026-06-01T00:00:00Z' })).toEqual([]);
  });
});
