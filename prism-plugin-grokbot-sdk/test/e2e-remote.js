#!/usr/bin/env node
"use strict";
const { spawn } = require("child_process"); const path = require("path"); const fs = require("fs"); const assert = require("assert");
const BRIDGE = (process.env.SESSION_BRIDGE_URL || fs.readFileSync(process.env.BRIDGE_URL_FILE || "/path/to/.secrets/leqi-bridge-url","utf8")).trim().replace(/\/$/, "");
const TOKEN = (process.env.BRIDGE_TOKEN || fs.readFileSync(process.env.BRIDGE_TOKEN_FILE || "/path/to/.secrets/leqi-bridge-token","utf8")).trim();
const T0 = Date.now(); const ts = () => ((Date.now()-T0)/1000).toFixed(1)+"s";
const child = spawn(process.execPath, [path.join(__dirname, "../src/plugin.js")], { env: { ...process.env, SESSION_BRIDGE_URL: BRIDGE, BRIDGE_TOKEN: TOKEN, PRISM_PLUGIN_PROTOCOL_VERSION: "4", GROKBOT_POLL_MS: "3000", GROKBOT_CHARS_PER_PAGE: "60" }, stdio: ["pipe","pipe","inherit"] });
let buf = "", n = 0; const pending = new Map(), events = [];
child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0,i); buf = buf.slice(i+1); if (!line.trim()) continue; const m = JSON.parse(line);
  if (m.event === "plugin.event") { events.push(m.payload.event); console.log(`  [${ts()}] event ${m.payload.event.type}`); } else if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
const call = (method, params = {}) => new Promise((res) => { const id = `e${++n}`; pending.set(id, res); child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); });
const okp = async (m, p) => { const r = await call(m, p); if (!r.ok) throw new Error(`${m}: ${JSON.stringify(r.error)}`); return r.payload; };
const step = (s) => console.log(`✔ [${ts()}] ${s}`);
(async () => {
  const bad = await fetch(BRIDGE + "/v1/sessions", { headers: { Authorization: "Bearer wrong-token" } }); assert.strictEqual(bad.status, 401); step("wrong token -> 401");
  const none = await fetch(BRIDGE + "/v1/sessions"); assert.strictEqual(none.status, 401); step("no token -> 401");
  const disc = await okp("adapter.discover"); assert(disc.verified); step("adapter.discover");
  const ls = await okp("adapter.listSessions"); step(`listSessions -> ${ls.length}`);
  const msgId = "e2e-" + Date.now();
  const st = await okp("adapter.startSessionWithMessage", { plugin_id: "grokbot", cwd: "", source_device: "glasses", metadata: {}, message: { prism_message_id: msgId, text: "眼镜端到端测试：请用三段话介绍你自己，用于测试分页。", source_device: "glasses", timestamp: new Date().toISOString(), metadata: {} } });
  const sess = st.session; assert(st.receipt.accepted, st.receipt.detail); step(`startSessionWithMessage -> ${sess.native_session_id} (${st.receipt.detail})`);
  await okp("adapter.subscribe", { subscription_id: "s1", session: sess }); step("subscribe");
  const deadline = Date.now() + 8*60e3;
  while (!events.some(e => e.type === "completed") && Date.now() < deadline) await new Promise(r => setTimeout(r, 2000));
  if (!events.some(e => e.type === "completed")) { const r = await fetch(BRIDGE + "/v1/sessions/" + sess.native_session_id, { headers: { Authorization: `Bearer ${TOKEN}` } }); console.log("TIMEOUT; session state:", r.status, (await r.text()).slice(0, 1500)); throw new Error("routine never ingested"); }
  const types = events.map(e => e.type); step(`stream: ${types.join(" → ")}`);
  const cover = events.find(e => e.type === "message.cover"); const pages = events.filter(e => e.type === "message.page");
  assert(cover && types.indexOf("message.cover") < types.indexOf("message.page")); const ctext = cover.payload.cover || cover.payload.text;
  assert(ctext.length <= 40); step(`cover(${ctext.length}): ${ctext}`);
  assert(pages.length >= 2); assert(pages.every(p => p.payload.text.length <= 60)); step(`pages=${pages.length}, all ≤60 chars`);
  pages.forEach(p => console.log(`   [${p.payload.page}/${p.payload.total_pages}] ${p.payload.text}`));
  const att = await okp("adapter.attachSession", { prism_conversation_id: "c-e2e", plugin_id: "grokbot", native_session_id: sess.native_session_id, native_thread_id: sess.native_thread_id, cwd: "", source_device: "glasses", metadata: {} }); assert.strictEqual(att.native_session_id, sess.native_session_id); step("attachSession");
  const w = await okp("adapter.waitForRun", { session: sess, run_id: msgId }); assert.strictEqual(w.type, "completed"); assert.strictEqual(w.payload.pages.join(""), pages.map(p=>p.payload.text).join("")); step(`waitForRun re-read -> ${w.payload.page_count} pages, consistent`);
  const it = await call("adapter.interrupt", { session: sess }); assert(it.ok, JSON.stringify(it.error)); step("interrupt -> ok (bridge marked cancelled)");
  await okp("adapter.close"); console.log("\nE2E REMOTE PASSED"); child.kill(); process.exit(0);
})().catch(e => { console.error("FAIL:", e.message); child.kill(); process.exit(1); });
