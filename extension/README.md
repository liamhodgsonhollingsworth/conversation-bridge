# Conversation Bridge — extension

Built with [WXT](https://wxt.dev) + Svelte 5 (runes).

## Develop

```bash
bun install        # or pnpm / npm
bun run dev        # hot-reloading Chrome
bun run dev:firefox
```

## Build

```bash
bun run build              # → .output/chrome-mv3/
bun run build:firefox      # → .output/firefox-mv2/
```

## Sideload

Chrome: `chrome://extensions` → Developer mode → Load unpacked → choose `.output/chrome-mv3/`.

Firefox: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → choose `.output/firefox-mv2/manifest.json`.

## Layout

```
src/
├── entrypoints/
│   ├── background.ts          ← service worker (event relay, health poll)
│   ├── claude-ai.content.ts   ← per-site DOM extractor + auto-fire triggers
│   ├── toast.content/         ← shadow-DOM toast on every page
│   └── popup/                 ← Svelte SPA with 3 tabs (connections, events, settings)
└── lib/
    ├── types.ts               ← Connection, BridgeEvent, EndpointSpec, ...
    ├── storage.ts              ← browser.storage.local wrappers
    ├── protocol.ts             ← CBP v1 client (fetchSpec, postEvent, urlMatchesScopes)
    ├── extract-claude.ts       ← claude.ai DOM → ExtractedConversation
    ├── messages.ts             ← typed messages between background/content/popup
    └── uuid.ts
```
