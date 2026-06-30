# Conversation Bridge

A general-purpose Chrome / Firefox extension that captures conversations
from webpages and relays them to user-configured endpoints via a
transparency-based trust handshake.

Initially built to bridge claude.ai conversations into local development
tools, but the protocol is open and the extension is project-agnostic.
Any service can host a [Conversation Bridge Protocol (CBP)](docs/protocol-v1.md)
endpoint and become a destination.

## What it is

- **A browser extension** with three views: Connections, Events, Settings.
- **An open protocol** (CBP v1) that any receiving service can implement —
  three endpoints, one event shape.
- **A reference Python server** that writes received events to a local
  inbox directory.

## Status

Early MVP (extension version `0.1.0`, protocol CBP v1). What works today:

- The browser extension (background relay, popup with the three views,
  on-page toast) builds and sideloads on Chromium and Firefox.
- One built-in content-script extractor ships: **claude.ai** only. Other
  sites (ChatGPT, Gemini, …) are open contribution tasks — see
  [Adding support for other sites](#adding-support-for-other-sites).
- The reference Python endpoint implements all three CBP routes, plus
  optional bearer-token auth and optional HMAC signing.

Known rough edges: the optional HMAC signing path has not been exercised
end-to-end in production yet.

## What it is not

- Not a SaaS. There is no cloud you sign up for.
- Not tied to any one project. The protocol is published; install your
  own endpoint or use someone else's.
- Not a silent capture tool. Every connection requires explicit user
  consent after a full disclosure of what data flows where.

## Trust-first design

When you add a connection, the extension calls `GET /spec` on the endpoint
and shows you:

1. The endpoint's self-declared name and version
2. What it says it does with your data (the `dataFlow` field, verbatim)
3. Which scopes (URL patterns) this connection will capture from
4. Which event types will trigger a relay
5. Whether an auth token is attached
6. Whether content is sent (or only metadata, in privacy mode)

You click **Accept and enable** to save. You can revoke at any time from
the popup. The extension caches a hash of the endpoint's spec — if the
endpoint ever changes its declaration, you'll be re-prompted.

## Quick install (sideload)

### Chrome / Edge / Brave

1. Clone this repo: `git clone https://github.com/liamhodgsonhollingsworth/conversation-bridge.git`
2. Build the extension:
   ```bash
   cd conversation-bridge/extension
   bun install   # or pnpm / npm
   bun run build # or pnpm / npm run build
   ```
3. Open `chrome://extensions`, enable **Developer mode** (top right).
4. Click **Load unpacked**. Choose `extension/.output/chrome-mv3/`.
5. Pin the extension to your toolbar.

### Firefox

```bash
cd conversation-bridge/extension
bun run build:firefox
```

Then in Firefox: `about:debugging#/runtime/this-firefox` → **Load Temporary
Add-on** → choose `extension/.output/firefox-mv2/manifest.json`.

## Quick start: run the reference endpoint

```bash
cd conversation-bridge/examples/python-server
pip install -r requirements.txt
python server.py
```

The server starts on `http://localhost:8000` and stores received events at
`~/.bridge-inbox/<eventId>.json`.

## Adding your first connection

1. Click the Conversation Bridge icon in the toolbar.
2. Click **+ Add** in the Connections tab.
3. Endpoint URL: `http://localhost:8000`
4. Scopes: `claude.ai/*` (or any URL pattern)
5. Events: tick `manual.push` for the simplest test
6. Click **Continue**. The extension probes `/spec`.
7. Review the transparency screen. Click **Accept and enable**.

Now open any tab matching your scope, click the extension icon, click
**Push**. You should see an event file appear in `~/.bridge-inbox/`.

## How it captures claude.ai conversations

The extension ships with a content script for `claude.ai/*` that:

- Walks the page DOM and extracts messages + roles + title + URL.
- Watches for "conversation completion" heuristics:
  - User just sent a message containing an approval keyword
    (`approve`, `approved`, `reject`, `rejected`, `deny`, `go ahead`,
    `ship it`, `lgtm`)
  - URL switched to a `/share/...` page
- Fires `conversation.complete` or `conversation.captured` events
  accordingly. Connections that subscribe to those event types receive
  the relay.

The extraction logic is intentionally heuristic + replaceable. If
claude.ai's DOM changes, the script falls back to walking `<article>`
elements. PRs improving extraction are welcome.

## Automatic claude.ai sync (internal-API poller)

In addition to the on-page content script above, the extension runs a
**background poller** that automatically syncs *all* of your claude.ai
conversations with zero ongoing work.

claude.ai has no official conversation API, but its logged-in web app
calls an internal JSON API. Because the extension runs inside your
already-authenticated browser, its background `fetch()` calls ride your
**existing session cookies** (`credentials: 'include'`) — there are no
credentials, tokens, or API keys to enter, anywhere. If you are not logged
in to claude.ai, a poll cycle simply aborts quietly.

How it works:

- A `claudeai-sync` alarm fires every **30 minutes** (configurable via the
  `claudeAiSyncPeriodMin` setting), plus once shortly after the worker
  starts so the first sync doesn't wait a full period.
- Each cycle resolves your organization, lists your conversations
  (paginated), and **incrementally dedups**: a per-chat map of the last
  synced `updated_at` lives in `browser.storage.local`. Only conversations
  that are new or have a newer `updated_at` get their full message tree
  fetched and relayed. Unchanged conversations are skipped entirely, so the
  steady-state cost is ~one cheap list call.
- Each changed conversation is relayed as a CBP v1 **`conversation.captured`**
  event through the same fan-out as the content script — it flows to every
  enabled connection subscribed to `conversation.captured` whose scopes match
  `claude.ai/*`. The protocol is **not** bumped; this reuses the existing
  event type.
- Privacy mode and the master enable switch both apply. The feature has its
  own toggle (**Settings → Auto-sync claude.ai**, on by default). Logs are
  counts-only — no message bodies, cookies, or tokens are ever written.

You can also trigger an immediate sync programmatically by sending the
background worker a `{ type: 'SYNC_CLAUDEAI_NOW' }` runtime message (a
"Sync now" button is a natural addition to the popup).

### Assumed internal-API shape (and how to confirm it)

claude.ai's internal API is **undocumented**, so the poller's field mapping is
based on the observed/known response shapes below rather than a published
contract. The parser is deliberately **lenient** — it accepts both `snake_case`
and `camelCase` keys, tolerates `uuid` or `id`, and silently skips missing
fields — so a quiet rename degrades gracefully (a field drops out) instead of
breaking the sync. The three endpoints and the fields the poller reads:

| Endpoint | Reads | Tolerates |
|---|---|---|
| `GET /api/organizations` | org `uuid`, `capabilities[]` (prefers one containing `"chat"`) | `id`; wrapped `{organizations\|data\|results: [...]}` |
| `GET /api/organizations/{org}/chat_conversations?limit&offset` | per-conversation `uuid`, `updated_at` | `id`; `updatedAt`; wrapped `{conversations\|data\|results}` |
| `…/chat_conversations/{id}?tree=True&rendering_mode=messages` | `uuid`, `name`, `created_at`, `updated_at`, `model`, `chat_messages[]` (each `sender` ∈ `human`/`assistant`, `text` or `content[].text`, `created_at`) | `id`, `title`, `createdAt`/`updatedAt`, `chatMessages`/`messages`, message `role`, per-message `createdAt`/`timestamp` |

If the list endpoint ever **ignores `offset`** and returns the same page on
every request, pagination still terminates: the poller dedups by conversation id
as it collects and stops the moment a page introduces no new ids (with a hard
`MAX_LIST_PAGES` cap as a backstop).

**To confirm the field names against your real account (no credentials, no
login needed beyond your normal browser session):** while logged in to
claude.ai, open DevTools → **Network**, filter for `chat_conversations`, click
any request, and inspect the **Response** JSON. Check that conversations carry
`uuid` + `updated_at` and that a `…?tree=True` response carries `chat_messages`
with `sender`/`text`. If any of those names differ on your account, note the
real names — the parser already tolerates the common variants, but unknown names
should be added to the pickers in
[`extension/src/lib/claude-sync.ts`](extension/src/lib/claude-sync.ts).

## Adding support for other sites

The content-script pattern is the model. To add `chat.openai.com/*` or
any other source:

1. Create `extension/src/entrypoints/<site>.content.ts` mirroring
   `claude-ai.content.ts`.
2. Implement a `extract<Site>Conversation()` function in `extension/src/lib/`
   that returns `{ messages, title, url, shareUrl }`.
3. Add the host pattern to `wxt.config.ts` `host_permissions`.

The connection model and event protocol are unchanged.

## Protocol

See [`docs/protocol-v1.md`](docs/protocol-v1.md) for the full
Conversation Bridge Protocol (CBP) v1 spec. Three HTTP endpoints, one
event shape. Should fit in ~100 lines of any language.

## Layout

```
.
├── README.md              ← this file
├── LICENSE                ← MIT
├── docs/
│   └── protocol-v1.md     ← CBP v1 spec
├── examples/
│   └── python-server/     ← reference receiving endpoint
└── extension/             ← WXT + Svelte 5 browser extension
    ├── package.json
    ├── wxt.config.ts
    └── src/
        ├── entrypoints/   ← background, popup, content scripts, toast
        └── lib/           ← types, storage, protocol client, extractors
```

## Contributing

PRs are welcome. The protocol is intentionally minimal — please discuss
protocol additions in an issue before implementing. Bug fixes, additional
content-script extractors (for ChatGPT, Gemini, etc.), and additional
reference endpoint examples (Node, Go, Rust) are especially appreciated.

## License

MIT. See [LICENSE](LICENSE).
