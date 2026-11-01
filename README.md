# Rokid Glasses ↔ Grok Bot (Prism open core)

Bridge **Rokid Prism** (Glasses HUD / Panel) to a local **Grok Bot** (or compatible agent gateway) using:

1. A Prism **PluginBridge v4** plugin (`prism-plugin-grokbot-sdk`)
2. An HTTP **session-bridge** (chapters, gateway job queue, optional webhook fallback)
3. A **gateway-relay** on the developer machine (long-poll → local loopback gateway → ingest)

This repository is the **public, sanitized core**. It uses only placeholder domains and fictional bot IDs. Private ops (live hosts, tokens, personal bot maps) belong in a separate private repo.

> Not an official Rokid product. Prism SDK is upstream MIT; see `NOTICE`.

## Architecture (short)

```
Glasses / Prism Panel
  → Prism Cloud
  → Prism Hub (:18790)
  → prism-plugin-grokbot-sdk (stdio PluginBridge v4)
  → session-bridge (:8787)
  → (HTTPS tunnel you provide, e.g. https://glasses.example.com)
  → gateway-relay (outbound long-poll)
  → local agent gateway 127.0.0.1:1340
  → target bot session
```

Panel and glasses share the same conversation model; the glasses HUD is a paged monochrome view, not a copy of the Panel chrome.

## Quick start (placeholders)

### 1. Hub host — session-bridge

```bash
cp .env.example .env
# set BRIDGE_TOKEN, PUBLIC_BASE_URL=https://glasses.example.com, DELIVERY_MODE=gateway
sudo bash deploy/install.sh   # or run session-bridge/server.js under your process manager
curl -s http://127.0.0.1:8787/health
```

Sideload the plugin into Prism Hub (see `deploy-hub/config.example.yaml` and `prism-plugin-grokbot-sdk/README.md`). Point Hub plugin env at `SESSION_BRIDGE_URL=http://127.0.0.1:8787` and the same `BRIDGE_TOKEN`.

### 2. Developer machine — gateway-relay

```bash
cd gateway-relay
export SESSION_BRIDGE_URL=https://glasses.example.com
export BRIDGE_TOKEN=…          # same as bridge
export DEFAULT_BOT_ID=00000000-0000-4000-8000-000000000001
node relay.js
```

Gateway auth comes from your local agent `gateway.json` (never commit it). `DEFAULT_BOT_ID` and `SESSION_BRIDGE_URL` have **no production default** in code — set them via env.

### 3. Bot list chip (optional)

Copy `deploy-hub/grokbot-bots.example.json` and replace IDs/names with your own bots. The sample only contains Example Bot A/B/C.

## Layout

| Path | Role |
|------|------|
| `prism-plugin-grokbot-sdk/` | **Preferred** Prism plugin |
| `prism-plugin-grokbot/` | Earlier plugin variant (reference) |
| `session-bridge/` | HTTP bridge + gateway queue |
| `gateway-relay/` | Local claim → sendPrompt → ingest |
| `reader-preview/` | Novel-style pagination preview |
| `deploy/` | systemd install helper for session-bridge |
| `deploy-hub/` | Hub config / service examples |
| `docs/` | Architecture, smoke checklist, SDK upgrade guide |

## Docs

- [Architecture](docs/architecture.md)
- [Source layout](docs/source-layout.md)
- [Smoke checklist](docs/smoke-checklist.md)
- [Upgrading Rokid Prism SDK / plugins](docs/upgrading-rokid-sdk.md)

## Upstream

- Prism plugin SDK: [Rokid-Prism/prism-plugin-sdk](https://github.com/Rokid-Prism/prism-plugin-sdk)
- npm: `@rokid-prism/pluginbridge-plugin-sdk`

## License

MIT — see `LICENSE`. Third-party notices in `NOTICE`.
