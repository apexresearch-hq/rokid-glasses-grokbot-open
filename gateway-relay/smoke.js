#!/usr/bin/env node
"use strict";
/**
 * Local smoke: gateway reachable + optional local bridge claim round-trip.
 * Never prints secrets.
 */
const path = require("path");
const os = require("os");
const fs = require("fs");
const { loadGatewayConfig, listAgents, getTranscriptTail } = require("./gateway");

async function main() {
  const cfg = loadGatewayConfig();
  console.log(`gateway base=http://127.0.0.1:${cfg.port} token_len=${cfg.token_len}`);
  const agents = await listAgents(cfg);
  console.log(`listAgents ok count=${Array.isArray(agents) ? agents.length : "?"}`);
  const id =
    process.env.SMOKE_BOT_ID || "00000000-0000-4000-8000-000000000001" /* set SMOKE_BOT_ID in real use */;
  const tail = await getTranscriptTail(cfg, { id, limit: 3 });
  const ents = tail.entries || [];
  console.log(
    `transcriptTail ok entries=${ents.length} maxSeq=${ents.reduce((m, e) => Math.max(m, e.seq || 0), 0)}`
  );

  const token =
    process.env.BRIDGE_TOKEN ||
    (() => {
      try {
        return fs.readFileSync(
          path.join(os.homedir(), ".secrets/leqi-bridge-token"),
          "utf8"
        ).trim();
      } catch {
        return "";
      }
    })();
  const bridge = (
    process.env.SESSION_BRIDGE_URL ||
    (() => {
      try {
        return fs.readFileSync(
          path.join(os.homedir(), ".secrets/leqi-bridge-url"),
          "utf8"
        ).trim();
      } catch {
        return "";
      }
    })() ||
    ""
  ).replace(/\/$/, "");

  if (token && bridge) {
    const resp = await fetch(`${bridge}/health`);
    const h = await resp.json();
    console.log(
      `bridge health ok=${h.ok} delivery=${h.delivery_mode || "?"} pending=${(h.gateway && h.gateway.pending) || "?"}`
    );
  } else {
    console.log("bridge check skipped (no token/url)");
  }
  console.log("smoke ok");
}

main().catch((e) => {
  console.error("smoke failed:", e.message);
  process.exit(1);
});
