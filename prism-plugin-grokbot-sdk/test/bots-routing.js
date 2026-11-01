#!/usr/bin/env node
/** Bot chip + routing: own bridge + mock webhooks. Checks favorites order, draft model.switch,
 *  per-conversation binding, project=bot name, direct per-bot webhook vs relay fallback, signed /reply. */
"use strict";
const { spawn } = require("child_process"); const http = require("http"); const path = require("path"); const os = require("os"); const fs = require("fs"); const assert = require("assert"); const crypto = require("crypto");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bots-test-"));
const hits = []; // {hook, body, auth}
const hook = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { hits.push({ hook: req.url, body: JSON.parse(b), auth: req.headers.authorization || "" }); res.end("{}"); }); });
const step = (s) => console.log("✔", s);
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error("timeout"); };
hook.listen(0, "127.0.0.1", async () => {
  const hp = hook.address().port, port = 19000 + Math.floor(Math.random() * 900), token = crypto.randomBytes(16).toString("hex");
  const XB = "00000000-0000-4000-8000-000000000002", FZ = "00000000-0000-4000-8000-000000000003", DJ = "00000000-0000-4000-8000-000000000004";
  fs.writeFileSync(path.join(dir, "bots.json"), JSON.stringify([
    { id: DJ, name: "Example Bot D" }, { id: FZ, name: "Example Bot C", favorite: 3 }, { id: "00000000-0000-4000-8000-000000000001", name: "Example Bot A", default: true, favorite: 2 }, { id: XB, name: "Example Bot B", favorite: 1 }]));
  fs.writeFileSync(path.join(dir, "hooks.json"), JSON.stringify({ [DJ]: { url: `http://127.0.0.1:${hp}/bot-d`, key: "kDJ" } }));
  const base = `http://127.0.0.1:${port}`;
  const br = spawn(process.execPath, [path.join(__dirname, "../../session-bridge/server.js")], { env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", DATA_DIR: path.join(dir, "data"), BRIDGE_TOKEN: token, GROKBOT_WEBHOOK_URL: `http://127.0.0.1:${hp}/default`, GROKBOT_WEBHOOK_KEY: "kDEF", BOT_WEBHOOKS_FILE: path.join(dir, "hooks.json"), PUBLIC_BASE_URL: base }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  const child = spawn(process.execPath, [path.join(__dirname, "../src/plugin.js")], { env: { ...process.env, SESSION_BRIDGE_URL: base, BRIDGE_TOKEN: token, PRISM_PLUGIN_PROTOCOL_VERSION: "4", GROKBOT_POLL_MS: "200", GROKBOT_DEBUG_LOG: "0", GROKBOT_BOTS_FILE: path.join(dir, "bots.json"), GROKBOT_STATE_FILE: path.join(dir, "turns.json"), GROKBOT_CWD: "grokbot" }, stdio: ["pipe", "pipe", "ignore"] });
  let buf = "", n = 0; const pending = new Map();
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
  const call = (method, params = {}) => new Promise((res) => { const id = `b${++n}`; pending.set(id, res); child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); });
  const okp = async (m, p) => { const r = await call(m, p); if (!r.ok) throw new Error(`${m}: ${JSON.stringify(r.error)}`); return r.payload; };
  const msg = (id, text) => ({ prism_message_id: id, text, source_device: "glasses", timestamp: "", metadata: {} });
  try {
    // chip options: favorites first in rank order, default keeps id grok-bot
    const od = await okp("adapter.openDraft", { draft_id: "dX", plugin_id: "grokbot", cwd: "", source_device: "glasses", metadata: {} });
    assert.deepStrictEqual(od.controls.model_options.slice(0, 4).map((o) => o.label), ["Example Bot B", "Example Bot A", "Example Bot C", "Example Bot D"]);
    assert.strictEqual(od.controls.current_model.id, "grok-bot"); assert.strictEqual(od.controls.model_options[0].target.option_id, XB);
    assert(!JSON.stringify(od).includes("kDJ") && !JSON.stringify(od).includes("bot-d"), "no webhook secrets in plugin output");
    step("draft chip: favorites first (Example Bot B, Example Bot A, Example Bot C), default = Example Bot A");
    // draft: switch to Example Bot D (has per-bot webhook) -> direct route
    const cd = await okp("adapter.controlDraft", { draft_id: "dX", plugin_id: "grokbot", action: "model.switch", target: { option_id: DJ } });
    assert.strictEqual(cd.controls.current_model.label, "Example Bot D");
    const bad = await call("adapter.controlDraft", { draft_id: "dX", plugin_id: "grokbot", action: "model.switch", target: { option_id: "nope" } }); assert.strictEqual(bad.error.code, "invalid_request");
    const s1 = await okp("adapter.startDraftWithMessage", { draft_id: "dX", plugin_id: "grokbot", cwd: "", source_device: "glasses", metadata: {}, message: msg("m1", "sample question") });
    assert.strictEqual(s1.session.cwd, "Example Bot D", "project = bot name");
    await until(() => hits.length >= 1); let h = hits.pop();
    assert.strictEqual(h.hook, "/bot-d"); assert.strictEqual(h.auth, "Bearer kDJ"); assert.strictEqual(h.body.route, "direct"); assert.strictEqual(h.body.target_bot_id, DJ);
    assert(h.body.reply_url.startsWith(base + "/reply/" + s1.session.native_session_id + "?exp="));
    step("model.switch on draft -> Example Bot D; command routed to its own webhook (direct) with signed reply_url");
    // follow-up in same conversation stays bound even if someone sends with another bot
    await okp("adapter.send", { session: s1.session, message: msg("m2", "继续") });
    await until(() => hits.length >= 1); h = hits.pop(); assert.strictEqual(h.hook, "/bot-d");
    const det = await okp("adapter.readDetail", { session: s1.session }); assert.strictEqual(det.current_model.label, "Example Bot D");
    assert.strictEqual(det.actions.find((a) => a.id === "model.switch").available, false);
    const cs1 = await okp("adapter.controlSession", { session: s1.session, action: "model.switch", target: { option_id: XB }, metadata: { source_device: "prism" } });
    assert.strictEqual(cs1.ok, false); assert(cs1.message.includes("新建会话")); assert.strictEqual(cs1.details.current_model.label, "Example Bot D");
    const cs2 = await okp("adapter.controlSession", { session: s1.session, action: "model.switch", target: { option_id: DJ } }); assert.strictEqual(cs2.ok, true);
    const cs3 = await okp("adapter.controlSession", { session: s1.session, action: "controls.describe" }); assert.strictEqual(cs3.ok, true); assert(cs3.details.model_options.length >= 4);
    assert((await okp("adapter.probe")).can_control_session);
    step("controlSession: switching a bound conversation -> ok:false + friendly message + unchanged detail; same bot / describe -> ok");
    step("conversation bound: follow-up -> same bot; detail chip shows Example Bot D, switch disabled");
    // signed reply endpoint (no bearer) -> chapter -> history/model name
    const rr = await fetch(h.body.reply_url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ summary: "sample reply", body: "这是Example Bot D的回复。" }) });
    assert.strictEqual(rr.status, 200);
    const forged = await fetch(h.body.reply_url.replace(/sig=[0-9a-f]+/, "sig=" + "0".repeat(64)), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{\"body\":\"x\"}" }); assert.strictEqual(forged.status, 403);
    const other = await fetch(h.body.reply_url.replace(s1.session.native_session_id, "sess_other"), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{\"body\":\"x\"}" }); assert.strictEqual(other.status, 403);
    const w = await okp("adapter.waitForRun", { session: s1.session, run_id: "m2" }); assert.strictEqual(w.payload.model, "Example Bot D"); assert.strictEqual(w.payload.text, "这是Example Bot D的回复。");
    step("signed /reply ingests without token; forged sig / other session -> 403; reply model = Example Bot D");
    // Example Bot B: no per-bot webhook -> relay through default routine with target fields
    const s2 = await okp("adapter.startSessionWithMessage", { plugin_id: "grokbot", cwd: "Example Bot B", source_device: "glasses", metadata: {}, message: msg("m3", "hello B") });
    await until(() => hits.length >= 1); h = hits.pop();
    assert.strictEqual(h.hook, "/default"); assert.strictEqual(h.auth, "Bearer kDEF"); assert.strictEqual(h.body.route, "relay"); assert.strictEqual(h.body.target_bot_id, XB); assert.strictEqual(h.body.target_bot_name, "Example Bot B");
    step("project 'Example Bot B' -> Example Bot B; no own webhook -> relay via default routine (target_bot_id/name)");
    // default conversation unchanged: no target fields
    const s3 = await okp("adapter.startSessionWithMessage", { plugin_id: "grokbot", cwd: "", source_device: "glasses", metadata: {}, message: msg("m4", "默认") });
    await until(() => hits.length >= 1); h = hits.pop();
    assert.strictEqual(h.hook, "/default"); assert(!("target_bot_id" in h.body) && !("route" in h.body)); assert.strictEqual(s3.session.cwd, "grokbot");
    const ls = await okp("adapter.listSessions"); const byId = Object.fromEntries(ls.map((x) => [x.native_session_id, x]));
    assert.strictEqual(byId[s1.session.native_session_id].cwd, "Example Bot D"); assert.strictEqual(byId[s2.session.native_session_id].metadata.model, "Example Bot B"); assert.strictEqual(byId[s3.session.native_session_id].cwd, "grokbot");
    step("default bot: payload unchanged (no target), project grokbot; listSessions groups by bot");
    console.log("\nALL BOT ROUTING CHECKS PASSED");
  } catch (e) { console.error("FAIL:", e.message); process.exitCode = 1; }
  child.kill(); br.kill(); hook.close(); fs.rmSync(dir, { recursive: true, force: true });
});
