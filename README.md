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
    (`approve`, `approved`, `rejected`, `go ahead`, `ship it`, `lgtm`, etc.)
  - URL switched to a `/share/...` page
- Fires `conversation.complete` or `conversation.captured` events
  accordingly. Connections that subscribe to those event types receive
  the relay.

The extraction logic is intentionally heuristic + replaceable. If
claude.ai's DOM changes, the script falls back to walking `<article>`
elements. PRs improving extraction are welcome.

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
