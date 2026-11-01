#!/usr/bin/env node
/** npm test: start a throwaway session-bridge (temp DATA_DIR, random token, spare port) and run the suites against it. */
"use strict";
const { spawn, spawnSync } = require("child_process"); const path = require("path"); const os = require("os"); const fs = require("fs"); const crypto = require("crypto");
const port = 18000 + Math.floor(Math.random() * 1000), dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-test-"));
const env = { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: dir, BRIDGE_TOKEN: crypto.randomBytes(16).toString("hex"), GROKBOT_WEBHOOK_URL: "", GROK_WEBHOOK_URL: "", SESSION_BRIDGE_URL: `http://127.0.0.1:${port}` };
const br = spawn(process.execPath, [path.join(__dirname, "../../session-bridge/server.js")], { env, stdio: "ignore" });
(async () => {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(env.SESSION_BRIDGE_URL + "/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  let code = 0;
  for (const t of ["mock-hub.js", "bridge-features.js"]) { const r = spawnSync(process.execPath, [path.join(__dirname, t)], { env, stdio: "inherit" }); if (r.status) { code = r.status; break; } }
  br.kill(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(code);
})();
