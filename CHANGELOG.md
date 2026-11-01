# Changelog

All notable changes to the **open core** are listed here.

## 0.1.0 — 2026-11-01

### Added

- Public-ready layout: `prism-plugin-grokbot-sdk`, `session-bridge`, `gateway-relay`, `reader-preview`, generic `deploy` / `deploy-hub` examples.
- Docs: architecture, source layout, smoke checklist, Rokid SDK upgrade notes.
- MIT `LICENSE` and `NOTICE` (SDK attribution).
- Placeholder-only `.env.example` and fictional bot list sample.

### Security

- No live domains, hostnames, personal bot rosters, or secret values in this tree.
- `gateway-relay` defaults: empty `DEFAULT_BOT_ID` and empty bridge URL (must come from env / secret files).
