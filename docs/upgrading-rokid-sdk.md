# Upgrading Rokid Prism SDK / official plugins

You can follow upstream Rokid Prism SDK and official plugin releases. This project is an integration layer on PluginBridge v4 — it is **not** frozen to one SDK patch forever.

## What “follow upstream” means

1. Read the upstream changelog / release notes for [`Rokid-Prism/prism-plugin-sdk`](https://github.com/Rokid-Prism/prism-plugin-sdk) and any official plugin packages you sideload.
2. Bump `@rokid-prism/pluginbridge-plugin-sdk` in `prism-plugin-grokbot-sdk/package.json` (and lockfile).
3. Diff wire protocol expectations: request/response/event shapes, `PRISM_PLUGIN_PROTOCOL_VERSION`, snake_case fields, stdio framing.
4. Re-test Hub sideload, Panel open-session, send, subscribe, history, and controlSession.
5. Re-test gateway-relay claim → ingest → Panel labels (`电脑` / `电脑续聊`).
6. Record the bump in `CHANGELOG.md`.

## Local patches you must re-apply

This repo intentionally customizes behavior beyond a stock stub. After an upstream merge or Hub/plugin template refresh, **re-check** these areas:

| Area | Why it matters |
|------|----------------|
| `conversation.select` / native session acceptance | Panel must open existing sessions without “not accepted” errors |
| History rebuild from session-bridge chapters | Stale in-memory turns merge rounds; prefer re-read by mtime / journal |
| Chapter labels `电脑` / `电脑续聊` | App → glasses sync UX |
| Bot chip list + per-bot routing | Favorites order, default bot, webhook vs gateway relay |
| Env bootstrap (`.env` / Hub-injected `PRISM_PLUGIN_*`) | Hub often does **not** inherit your shell environment |
| Signed `/reply` and Bearer on `/v1/*` | Security; do not regress auth |

If you replace the plugin directory from an upstream tarball, your local edits can be overwritten — keep a branch or patch series.

## Breaking changes

A version bump alone is not enough when upstream changes:

- Protocol major / `PRISM_PLUGIN_PROTOCOL_VERSION`
- Method names or required params (`startSessionWithMessage`, `waitForRun`, …)
- Event payload shapes used for pagination / HUD
- Hub config schema (`plugin_dirs`, per-plugin `env`)

Treat those as **breaking**: update adapter code, then run the [smoke checklist](smoke-checklist.md).

## Suggested regression order

1. `npm test` in `prism-plugin-grokbot-sdk`
2. Hub loads plugin; Panel lists bots
3. New session Panel → App → reply visible
4. App → Panel labeled rounds
5. Re-open existing session (select path)
6. Optional: glasses HUD paging on device

## What not to mix into upgrades

- Do not paste live tokens, hostnames, or personal bot rosters into this public tree while upgrading.
- Do not “fix” a Hub upgrade by disabling auth on session-bridge.
- Unrelated host services (proxies, unrelated tunnels) should stay decoupled from the glasses bridge upgrade.
