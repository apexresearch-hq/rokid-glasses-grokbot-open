#!/usr/bin/env node
/**
 * Stub only — does NOT implement full PluginBridge v4 serve().
 * Purpose: document the probe shape and HTTP mapping to session-bridge.
 *
 * Next step (real plugin):
 *   npm install @prism-rokid/pluginbridge-plugin-sdk@0.1.1
 *   implement list_sessions / attach_session / subscribe / wait_for_run
 *   pointing at SESSION_BRIDGE_URL (default http://127.0.0.1:8787)
 *
 * Env:
 *   SESSION_BRIDGE_URL   e.g. http://127.0.0.1:8787
 *   BRIDGE_TOKEN         optional Bearer for bridge /v1/*
 */
"use strict";

const BRIDGE = process.env.SESSION_BRIDGE_URL || "http://127.0.0.1:8787";

/** Shape probe() should return (SDK Capability). */
const PROBE = {
  PluginID: "grokbot",
  Available: true,
  NativeVisibleInput: true,
  CanForwardSync: true,
  CanReverseSync: false,
  CanWaitRun: true,
  IntegrationMode: "protocol-native",
  VisibilitySurface: "grokbot",
};

const HTTP_MAP = {
  list_sessions: "GET  /v1/sessions",
  attach_session: "GET  /v1/sessions/:id",
  start_with_message: "POST /v1/command  { prompt, session_id? }",
  wait_for_run: "poll GET /v1/sessions/:id until status ready|error",
  read_history_as_chapters: "GET  /v1/sessions/:id  → chapters[]",
  open_current_page:
    "GET  /v1/sessions/:id/chapters/:cid/pages?page=&charsPerPage=180",
};

function log(line) {
  // PluginBridge uses stdout for protocol; logs must go to stderr.
  process.stderr.write(`[prism-plugin-grokbot stub] ${line}\n`);
}

async function health() {
  try {
    const r = await fetch(`${BRIDGE}/health`);
    const j = await r.json();
    return j;
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

(async () => {
  log(`bridge=${BRIDGE}`);
  log(`probe=${JSON.stringify(PROBE)}`);
  log(`http_map=${JSON.stringify(HTTP_MAP)}`);
  const h = await health();
  log(`health=${JSON.stringify(h)}`);
  log(
    "This stub exits after probe dump. Wire @prism-rokid/pluginbridge-plugin-sdk serve() for Hub."
  );
  // Exit 0 so side-load smoke checks that node can run the entrypoint.
  process.exit(0);
})();
