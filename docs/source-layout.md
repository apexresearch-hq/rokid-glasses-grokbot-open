# Source layout

## Top-level

| Path | Role |
|------|------|
| `session-bridge/` | Node HTTP bridge: chapters/sessions, gateway queue, webhook fallback |
| `prism-plugin-grokbot-sdk/` | **Current** Prism plugin (preferred) |
| `prism-plugin-grokbot/` | Earlier plugin variant (comparison / history) |
| `gateway-relay/` | Developer-machine relay → local gateway `:1340` → ingest |
| `reader-preview/` | Novel-style pagination HTML preview |
| `deploy/` | session-bridge systemd unit + `install.sh` |
| `deploy-hub/` | Prism Hub install helpers / example config (no sidecar binary) |
| `docs/` | Public architecture and operator guides |

## Secrets

Use `.env.example` as the shape reference. Never commit `.env`, secret files under `~/.secrets/`, Hub `config.yaml` with real tokens, session `data/*.json`, or relay state.

## Mental map

```
Panel/glasses → Prism Cloud → Hub :18790 → plugin → session-bridge :8787
                                                      ↓ gateway queue
                         gateway-relay → local gateway :1340 → bot
```
