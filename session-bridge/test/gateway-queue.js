"use strict";
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert");

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "sb-gw-"));
const PORT = 18788;
const TOKEN = "test-token-gateway-queue";
const env = {
  ...process.env,
  HOST: "127.0.0.1",
  PORT: String(PORT),
  DATA_DIR: DATA,
  BRIDGE_TOKEN: TOKEN,
  DELIVERY_MODE: "gateway",
  GATEWAY_FALLBACK_MS: "0",
  PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}`,
};

const child = spawn("node", [path.join(__dirname, "..", "server.js")], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});

function req(method, p, body) {
  return fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json() }));
}

(async () => {
  await new Promise((r) => setTimeout(r, 500));
  const h = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());
  assert.strictEqual(h.delivery_mode, "gateway");
  assert.strictEqual(h.gateway.pending, 0);

  const cmd = await req("POST", "/v1/command", {
    prompt: "ping",
    target_bot_id: "bot-x",
    target_bot_name: "X",
  });
  assert.strictEqual(cmd.status, 200);
  assert.ok(cmd.json.gateway_job && cmd.json.gateway_job.id);

  const claim = await req("POST", "/v1/gateway/claim", { worker_id: "t", wait_ms: 0 });
  assert.ok(claim.json.job);
  assert.strictEqual(claim.json.job.prompt, "ping");
  assert.ok(claim.json.job.reply_url);

  const claim2 = await req("POST", "/v1/gateway/claim", { worker_id: "t2" });
  assert.strictEqual(claim2.json.job, null);

  const hb = await req("POST", "/v1/gateway/heartbeat", {
    job_id: claim.json.job.id,
    worker_id: "t",
  });
  assert.strictEqual(hb.status, 200);

  const binds = await req("GET", "/v1/gateway/bindings");
  assert.ok(binds.json.bindings.some((b) => b.agent_id === "bot-x"));

  await req("POST", "/v1/gateway/complete", { job_id: claim.json.job.id, status: "done" });
  console.log("gateway-queue http ok");
  child.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => {
  console.error(e);
  child.kill();
  process.exit(1);
});
