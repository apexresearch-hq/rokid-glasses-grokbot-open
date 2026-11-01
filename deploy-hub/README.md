# Prism Hub deploy helpers

Example files that complement `deploy/` (session-bridge). **No binaries** are shipped.

## Typical layout on the hub host

- Prism Hub listens on `127.0.0.1:18790` (see `prism-hub.service`)
- Plugin directory: `/var/lib/prism-hub/.prism/pluginbridge-plugins/grokbot`
- Config: `/var/lib/prism-hub/.prism/config.yaml` (start from `config.example.yaml`)
- Bot chip list shape: `grokbot-bots.example.json` (fictional IDs only)

## Not packaged

- `prism-sidecar` / Hub binary (obtain from Rokid Prism distribution)
- Built `plugin.tgz` — package from `prism-plugin-grokbot-sdk/` yourself
- Real `BRIDGE_TOKEN`, login codes, or tunnel credentials

## Related ports (placeholders)

- Public bridge: `https://glasses.example.com` → `127.0.0.1:8787`
- Hub: `127.0.0.1:18790`
- Local Grok Bot gateway (developer machine): `127.0.0.1:1340` (never expose)

`fwd18790.py` is an optional SSH local-forward sketch (`HOST` / key paths are placeholders).
