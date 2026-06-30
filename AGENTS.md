---
schema-version: 2
title: AGENTS.md — Conversation Bridge
type: agent-entry-point
worldline_tier: realized
time_position: '2026-05-28T12:00:00Z'
applies-to: every AI agent (Claude Code, Cursor, Aider, OpenAI SDK, future agents) entering this repo
---

# AGENTS.md — Conversation Bridge

This file is the vendor-neutral agent-discoverable entry point for the Conversation Bridge project. Any AI agent (Claude, GPT, open-source models, future agents) reads this file at the start of any session in this repo to orient itself in the project's conventions, capabilities, and current state.

## What this repo is

Conversation Bridge is a general-purpose Chrome / Firefox extension that captures conversations from webpages and relays them to user-configured endpoints via a transparency-based trust handshake. The protocol is open; any service can host a compatible endpoint.

Originally built to bridge claude.ai conversations into local Alethea development tools, but the protocol is project-agnostic. The extension talks **CBP v1** (Conversation Bridge Protocol); any receiving service that implements CBP can become a destination.

The repo contains:

- A **browser extension** (WXT + Svelte 5) under `extension/` — three views: Connections, Events, Settings
- An **open protocol** (CBP v1) under `docs/protocol-v1.md` — three endpoints, one event shape
- A **reference Python server** under `examples/python-server/` — writes received events to a local inbox directory

## Network map (sibling projects this agent may need to touch)

| Project | Local path (if cloned) | GitHub remote | Role |
|---------|------------------------|---------------|------|
| **conversation-bridge** (this repo) | `C:/Users/Liam/Desktop/conversation-bridge/` | github.com/liamhodgsonhollingsworth/conversation-bridge | Chrome extension + FastAPI for cross-surface comms |
| **Alethea** | `C:/Users/Liam/Desktop/Alethea/` | github.com/liamhodgsonhollingsworth/Alethea | Knowledge-graph-as-substrate; downstream consumer of bridge events |
| **Apeiron** | `C:/Users/Liam/Desktop/Apeiron/` | github.com/liamhodgsonhollingsworth/Apeiron | Node-graph engine; multi-renderer substrate |
| **Resonance Wavefront (meta-layer)** | `C:/Users/Liam/Desktop/Resonance/` | github.com/liamhodgsonhollingsworth/The-Resonance-Wavefront | Conventions + ideas graph |
| **Resonance Website** | `C:/Users/Liam/Desktop/Resonance-Website/` | github.com/liamhodgsonhollingsworth/Resonance-Website | Immersive science-fiction website |
| **Resonance Hub** | `C:/Users/Liam/Desktop/Resonance-Hub/` | github.com/liamhodgsonhollingsworth/Resonance-Hub | Open-edit collaborator entry point |

The conversation-bridge repo is the only one designed to live as a standalone protocol — receiving endpoints can be anywhere. The other repos in the network are end-to-end consumers of bridge events for the Resonance system.

## Where to find what

| Looking for... | Read... |
|----------------|---------|
| Project framing + quickstart + install instructions | `README.md` |
| The CBP v1 protocol spec (source of truth) | `docs/protocol-v1.md` |
| Browser extension source (WXT + Svelte 5) | `extension/src/` |
| Extension entrypoints (background, popup, content scripts, toast) | `extension/src/entrypoints/` |
| Extension shared lib (types, storage, protocol client, extractors) | `extension/src/lib/` |
| Reference Python endpoint | `examples/python-server/` |
| Build/install commands for the extension | `extension/README.md` + `extension/package.json` |
| Tool-versioning discipline (this file follows it) | `https://github.com/liamhodgsonhollingsworth/Alethea/blob/main/skills/versioning-discipline.md` |

## What conventions every agent inherits

- **CBP v1 protocol versioning**: the `schema-version: 1` stamp in `docs/protocol-v1.md` frontmatter is load-bearing. Per the network-wide [tool-versioning discipline](https://github.com/liamhodgsonhollingsworth/Alethea/blob/main/skills/versioning-discipline.md), protocol changes carry a changelog at the foot of the doc + a schema-version bump in frontmatter. Backward compatibility means a client that could parse the previous version can parse the new one — self-enforcing by construction.
- **Transparency-first trust handshake**: every endpoint connection requires explicit user consent after full disclosure (`GET /spec` enumerates the endpoint's `dataFlow`, scopes, event types, auth posture, content visibility). Agents authoring new endpoints MUST populate the `/spec` response truthfully — the trust model relies on it.
- **Three-endpoint contract**: any CBP-compatible endpoint exposes `GET /spec`, `GET /health`, `POST /events`. Implementations should fit in one file in any language (~100 lines). Adding endpoints beyond these three breaks the minimal-surface goal.
- **Optional auth + optional signing**: localhost endpoints can skip both. Public endpoints layer on a bearer token and optionally HMAC signatures. The protocol does not mandate either.
- **Project-agnostic protocol**: nothing in CBP v1 is specific to claude.ai, Alethea, WeaveMind, or any other downstream. Any project can host a compatible endpoint. Agents adding content-script extractors for new sites (ChatGPT, Gemini, etc.) follow the model in `extension/src/entrypoints/claude-ai.content.ts` and add the host pattern to `wxt.config.ts` `host_permissions`.
- **Heuristic + replaceable extraction**: the claude.ai content script walks DOM + watches for completion heuristics. If the DOM changes, the script falls back to walking `<article>` elements. Future agents improving extraction submit PRs against the entrypoint files.
- **GitHub operations are session-handled**: agents do their own `gh` operations (PR creation, merge, branch delete).
- **AGENTS.md follows the tool-versioning discipline**: this file carries `schema-version` frontmatter + a `## Changelog` section at the foot, exemplifying the same discipline the CBP protocol spec follows.

## How to contribute as an agent

1. **Read `README.md`** for the quickstart + project shape
2. **Read `docs/protocol-v1.md`** for the protocol contract
3. **For protocol changes**: discuss in an issue first; protocol additions raise the schema-version + changelog
4. **For new content-script extractors** (e.g., ChatGPT, Gemini): mirror `extension/src/entrypoints/claude-ai.content.ts` + add the host pattern to `wxt.config.ts`
5. **For new reference endpoints** (Node, Go, Rust): mirror `examples/python-server/` shape + verify against the three-endpoint contract
6. **Commit + push + PR** via `gh` (sessions are full github actors)

## Build + run for testing

```bash
# Build the extension (Chrome / Edge / Brave)
cd extension && bun install && bun run build

# Build for Firefox
cd extension && bun run build:firefox

# Run the reference Python endpoint
cd examples/python-server && pip install -r requirements.txt && python server.py
```

## When you can't tell whether to act or ask

- **Bug fix in extractor + bounded scope**: act directly
- **New content-script entrypoint for a new site**: act directly; the extractor pattern is documented
- **Protocol change (new field, new endpoint, breaking change)**: discuss in an issue first; protocol additions are intentionally conservative
- **New reference endpoint in a new language**: act directly under `examples/<lang>-server/`
- **Anything touching the trust handshake or transparency model**: open a discussion first; this is the security-load-bearing surface

## License

MIT. See [LICENSE](LICENSE). Differs from sibling repos in the Resonance network (which use O'Saasy) because conversation-bridge is intentionally project-agnostic and the protocol exists to be implemented anywhere.

## Open questions agents may need to surface

- The HMAC round-trip on the optional signing path has not been exercised in production
- The federation protocol extension on CBP v1 is designed (in the Alethea ideas graph) but not implemented
- Content-script extractors for ChatGPT, Gemini, and other LLM webapps are open implementation tasks
- The trust-tier-extended endpoint discovery (auto-publishing endpoints to a directory) is sketched in the network's ideas graph

## Changelog

- v1, 2026-05-28, initial vendor-neutral agent-discoverability surface; cross-vendor mirror of `CLAUDE.md` for any AI agent stack entering this repo. Filed during foundation arc F5.
- v2, 2026-05-28, added `schema-version: 2` frontmatter (file already referenced the discipline in convention bullet 1 but did not itself carry the field) + this Changelog section per the [tool-versioning discipline](https://github.com/liamhodgsonhollingsworth/Alethea/blob/main/skills/versioning-discipline.md); added tool-versioning row to "Where to find what"; added a bullet to "What conventions every agent inherits" naming that AGENTS.md itself follows the discipline. Backward-compatible per Line 4 (additive). Filed during the cross-repo AGENTS.md sync audit (SPEC-471).
- v3, 2026-06-30, documented the additive **claude.ai internal-API background poller** (`extension/src/lib/claude-sync.ts` + a `claudeai-sync` alarm in `background.ts`). The poller rides the user's existing logged-in claude.ai session (`credentials: 'include'`, no tokens), incrementally dedups via a `cb.claudeai.syncState` map in `browser.storage.local`, and relays new/updated conversations as the **existing** CBP v1 `conversation.captured` event — the protocol is NOT bumped (`docs/protocol-v1.md` stays schema-version 1). Pure helpers (`pickOrgId`, `normalizeConversation`, `selectChangedChatIds`) are unit-tested with `vitest` under `extension/src/lib/__tests__/`. Additive only (no structural change to this file). Filed during the internal-API-poller arc.

This file is an evolving idea; agents that find gaps should propose extensions via PRs.
