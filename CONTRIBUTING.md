# Contributing

Thanks for helping improve the open core.

## Before you open a PR

1. Do **not** commit secrets, real bot UUIDs, personal display names, live domains, SSH keys, tunnel credentials, or session journals.
2. Prefer placeholders: `glasses.example.com`, `00000000-0000-4000-8000-…`, `Example Bot A/B`.
3. Keep production ops (hosts, tokens, runbooks with live facts) out of this repo — use a private ops companion if you need them.
4. Run local tests where practical:
   - `cd prism-plugin-grokbot-sdk && npm test`
   - `cd gateway-relay && node smoke.js` (needs a local gateway + env)
5. Document breaking wire / SDK changes in `docs/upgrading-rokid-sdk.md` and `CHANGELOG.md`.

## Code style

- Node ≥ 18, no build step for the bridge/relay.
- Snake_case on the Prism PluginBridge wire; keep Hub compatibility.
- Never log Bearer tokens, `reply_url` query signatures, or gateway tokens.

## Upstream

Plugin wire protocol tracks [`Rokid-Prism/prism-plugin-sdk`](https://github.com/Rokid-Prism/prism-plugin-sdk). When bumping `@rokid-prism/pluginbridge-plugin-sdk`, follow the upgrading guide.
