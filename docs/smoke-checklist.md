# Smoke checklist

Use placeholders (`glasses.example.com`, fictional bot UUIDs). Tick only after you see the expected result.

## A. Bridge health

- [ ] `curl -sS http://127.0.0.1:8787/health` → `ok` / expected `delivery_mode`
- [ ] Public URL (tunnel) `https://glasses.example.com/health` → 200
- [ ] Unauthenticated `/v1/*` → 401 when `BRIDGE_TOKEN` is set

## B. Plugin + Hub

- [ ] Hub process active; plugin listed / enabled
- [ ] Plugin env has `SESSION_BRIDGE_URL` + `BRIDGE_TOKEN` (values not logged)
- [ ] Panel can list bots / open a new draft without “selection not accepted”

## C. Panel → App (direction A)

- [ ] Send a short message from Panel to Example Bot A (or your bot)
- [ ] Relay log shows claim → sendPrompt
- [ ] App chat receives the prompt
- [ ] Assistant reply ingests; Panel shows the reply (paged on glasses)

## D. App → Panel (direction B)

- [ ] Type in the App chat bound to the same session/bot
- [ ] Panel shows a round labeled **电脑** then **电脑续聊**
- [ ] Order matches turn journal (no merged stale cache)

## E. Labels / history

- [ ] Conversation title uses the first user sentence (or your configured rule)
- [ ] Re-opening the session in Panel does not throw native session errors
- [ ] History rounds stay separate after several turns

## F. Local unit smoke

```bash
cd prism-plugin-grokbot-sdk && npm test
cd ../gateway-relay && SMOKE_BOT_ID=00000000-0000-4000-8000-000000000001 node smoke.js
```

## Common failures (generic)

| Symptom | Check |
|---------|--------|
| `fetch failed` on relay | Tunnel URL, DNS, `BRIDGE_TOKEN` mismatch |
| Panel “Conversation temporarily unavailable” | Plugin `conversation.select` / native session acceptance |
| Health ok but no App message | Relay not running; `DEFAULT_BOT_ID` empty; wrong binding |
| 401 on bridge | Token env not loaded into Hub plugin (Hub may not inherit shell env) |
