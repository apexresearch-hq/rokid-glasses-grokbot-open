#!/usr/bin/env node
/** Mock Prism Hub: drives src/plugin.js over v4 JSON-lines stdio against a running session-bridge.
 *  Simulates the Grok Bot reply via POST /v1/ingest (no real webhook is called unless the bridge has one). */
"use strict";
const { spawn } = require("child_process");
const path = require("path");
const assert = require("assert");
const BRIDGE = (process.env.SESSION_BRIDGE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const TOKEN = process.env.BRIDGE_TOKEN || "";

const child = spawn(process.execPath, [path.join(__dirname, "../src/plugin.js")], {
  env: { ...process.env, SESSION_BRIDGE_URL: BRIDGE, PRISM_PLUGIN_PROTOCOL_VERSION: "4", GROKBOT_POLL_MS: "300", GROKBOT_CHARS_PER_PAGE: "60", GROKBOT_STATE_FILE: require("path").join(require("os").tmpdir(), `grokbot-turns-${Date.now()}.json`) },
  stdio: ["pipe", "pipe", "inherit"],
});
let buf = "", n = 0; const pending = new Map(), events = [], history = [];
child.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    const m = JSON.parse(line);
    (function chk(v, path) { if (Array.isArray(v)) return v.forEach((x, i) => chk(x, path + "[" + i + "]")); if (v && typeof v === "object") for (const k of Object.keys(v)) { if (k !== k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()) throw new Error("non-snake_case wire key " + path + "." + k); chk(v[k], path + "." + k); } })(m, "$");
    for (const k of Object.keys(m)) assert.strictEqual(k, k.toLowerCase(), "snake_case wire");
    if (m.event === "plugin.event") events.push(m.payload.event);
    else if (m.event === "history.stream") history.push(m.payload);
    else if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
const call = (method, params = {}) => new Promise((res) => { const id = `t${++n}`; pending.set(id, res); child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); });
const okp = async (method, params) => { const r = await call(method, params); if (!r.ok) throw new Error(`${method}: ${JSON.stringify(r.error)}`); return r.payload; };
const step = (s) => console.log("✔", s);
const ingest = (body) => fetch(BRIDGE + "/v1/ingest", { method: "POST", headers: { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) }, body: JSON.stringify(body) }).then((r) => r.json());
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error("timeout"); };

(async () => {
  const probe = await okp("adapter.probe");
  assert(probe.available && probe.can_wait_run && probe.can_list_sessions); step("adapter.probe");
  const disc = await okp("adapter.discover"); assert(disc.verified, "bridge health"); step("adapter.discover (bridge /health ok)");
  const before = await okp("adapter.listSessions"); step(`adapter.listSessions -> ${before.length} sessions`);

  const msgId = "pm-" + Date.now();
  const start = await okp("adapter.startSessionWithMessage", { plugin_id: "grokbot", cwd: "", source_device: "glasses", metadata: {},
    message: { prism_message_id: msgId, text: "眼镜测试：用三句话讲讲今天的安排", source_device: "glasses", timestamp: new Date().toISOString(), metadata: {} } });
  const sess = start.session; assert(sess.native_session_id.startsWith("sess_")); assert(start.receipt.accepted, start.receipt.detail);
  step(`adapter.startSessionWithMessage -> ${sess.native_session_id} (${start.receipt.detail})`);

  const after = await okp("adapter.listSessions"); assert(after.some((s) => s.native_session_id === sess.native_session_id)); step("new session visible in listSessions");
  const att = await okp("adapter.attachSession", { prism_conversation_id: "c1", plugin_id: "grokbot", native_session_id: sess.native_session_id, native_thread_id: sess.native_thread_id, cwd: "", source_device: "glasses", metadata: {} });
  assert.strictEqual(att.native_session_id, sess.native_session_id); step("adapter.attachSession");
  const bad = await call("adapter.attachSession", { native_session_id: "sess_nope" }); assert(!bad.ok); assert.strictEqual(bad.error.code, "not_found"); step(`attach unknown -> error ${bad.error.code}`);

  const sub = await okp("adapter.subscribe", { subscription_id: "sub-1", session: sess }); assert(sub.subscribed); step("adapter.subscribe");
  const waitP = okp("adapter.waitForRun", { session: sess, run_id: msgId });

  const body = "Chapter 1: In the morning the team aligns on the glasses bridge. Confirm the Prism plugin can talk to the session bridge. Afternoon: deploy session-bridge behind HTTPS, sideload the plugin in Prism Hub, and page through results on the HUD. Evening: write down the verification notes.";
  await new Promise((r) => setTimeout(r, 700));
  const ing = await ingest({ session_id: sess.native_session_id, summary: "今日安排：对齐进度、取眼镜、部署桥与侧载插件，晚上整理记录", body });
  step(`simulated Grok Bot reply via /v1/ingest -> ${ing.chapter.id}`);

  const done = await waitP;
  assert.strictEqual(done.type, "run.completed"); assert.strictEqual(done.status, "completed"); assert.strictEqual(done.id, msgId); assert.strictEqual(done.payload.text, body);
  assert(done.payload.cover.length <= 40, "cover ≤40");
  assert(done.payload.pages.length >= 2, "multi-page");
  assert.strictEqual(done.payload.pages.join(""), body, "pages reassemble to full text");
  step(`adapter.waitForRun -> run.completed; cover="${done.payload.cover}" (${done.payload.cover.length} chars), ${done.payload.page_count} pages`);

  await until(() => events.some((e) => e.type === "run.completed"));
  const types = events.map((e) => e.type);
  const ia = types.indexOf("message.assistant"), ic = types.indexOf("message.completed"), ir = types.indexOf("run.completed");
  assert(ia >= 0 && ia < ic && ic < ir, "assistant -> message.completed -> run.completed");
  const asst = events[ia]; assert.strictEqual(asst.payload.text, body); assert.strictEqual(asst.payload.model, "Example Bot A");
  assert.strictEqual(asst.payload.pages.length, done.payload.page_count);
  assert(!types.some((t) => ["message.cover", "message.page", "completed", "status"].includes(t)), "no custom event types");
  step(`subscribe stream: ${types.join(" → ")}`);

  // follow-up in the same session via adapter.send
  const m2 = "pm2-" + Date.now();
  const rc = await okp("adapter.send", { session: sess, message: { prism_message_id: m2, text: "再简短一点", source_device: "glasses", timestamp: new Date().toISOString(), metadata: {} } });
  assert(rc.accepted); const w2 = okp("adapter.waitForRun", { session: sess, run_id: m2 });
  await ingest({ session_id: sess.native_session_id, summary: "精简版", body: "对齐、取眼镜、部署、侧载、复盘。" });
  const d2 = await w2; assert.strictEqual(d2.payload.cover, "精简版"); assert.strictEqual(d2.type, "run.completed");
  const t2 = events.map((e) => e.type); assert(t2.includes("message.user") && t2.includes("run.started"), "send-time message.user + run.started");
  { const iu = t2.lastIndexOf("message.user"), ims = t2.lastIndexOf("message.started"), irs = t2.lastIndexOf("run.started"); assert(iu < ims && ims < irs, "message.user -> message.started -> run.started"); }
  const det = await okp("adapter.readDetail", { session: sess }); assert.strictEqual(det.current_model.label, "Example Bot A"); assert.strictEqual(det.current_model.id, "grok-bot"); assert.strictEqual(det.status, "idle");
  const rs = await okp("adapter.readStatus", { session: sess }); assert.strictEqual(rs.model.display_name, "Example Bot A"); step("adapter.send + waitForRun (follow-up turn) -> completed");

  const st = await okp("adapter.readStatus", { session: sess, run_id: m2 }); step(`adapter.readStatus -> ${st.status}`);
  await okp("adapter.readHistoryStream", { session: sess, request: { stream_id: "h1", limit: 0 } });
  await until(() => history.some((h) => h.type === "end"));
  const ht = history.filter((h) => h.type === "turn" && h.stream_id === "h1");
  assert.strictEqual(ht.length, 2);
  for (const h of ht) { const ms = h.turn.messages; assert.deepStrictEqual(ms.map((m) => `${m.role}:${m.type}`), ["user:text", "assistant:progress", "assistant:text"]); assert.strictEqual(ms[1].progress.status, "completed"); assert(/^已处理 \d+m \d+s$/.test(ms[1].content)); }
  assert.strictEqual(ht[0].turn.turn_id, m2, "newest turn first"); assert.strictEqual(ht[0].turn.messages[0].content, "再简短一点"); assert.strictEqual(ht[1].turn.messages[2].content, body);
  step("adapter.readHistoryStream -> 2 turns [user, progress, assistant] newest-first + end");

  // ---- live history: send -> running turn appended -> ingest -> same turn replaced (revision++)
  await okp("adapter.readHistoryStream", { session: sess, request: { stream_id: "live1", limit: 5, live: true } });
  await until(() => history.some((h) => h.stream_id === "live1" && h.type === "turn"));
  const mL = "pmL-" + Date.now();
  await okp("adapter.send", { session: sess, message: { prism_message_id: mL, text: "live 测试", source_device: "glasses", timestamp: new Date().toISOString(), metadata: {} } });
  await until(() => history.some((h) => h.stream_id === "live1" && h.turn && h.turn.turn_id === mL));
  const runT = history.find((h) => h.stream_id === "live1" && h.turn && h.turn.turn_id === mL);
  assert.strictEqual(runT.source, "live"); assert.deepStrictEqual(runT.turn.messages.map((m) => m.type), ["text", "progress"]); assert.strictEqual(runT.turn.messages[1].progress.status, "running"); assert.strictEqual(runT.turn.messages[0].content, "live 测试");
  await ingest({ session_id: sess.native_session_id, summary: "live 回复", body: "这是 live 回复正文。" });
  await until(() => history.some((h) => h.stream_id === "live1" && h.turn && h.turn.turn_id === mL && h.turn.messages.length === 3));
  const doneT = history.filter((h) => h.stream_id === "live1" && h.turn && h.turn.turn_id === mL).pop();
  assert.strictEqual(doneT.operation, "replace"); assert(doneT.turn.revision > runT.turn.revision, "revision++"); assert.strictEqual(doneT.turn.order_key, runT.turn.order_key);
  assert.strictEqual(doneT.turn.messages[1].progress.status, "completed"); assert.strictEqual(doneT.turn.messages[2].content, "这是 live 回复正文。");
  assert(!history.some((h) => h.stream_id === "live1" && h.type === "end"), "live stream stays open");
  await okp("adapter.cancelHistoryStream", { stream_id: "live1" });
  step("live readHistoryStream: send -> running turn [user, progress(running)] -> ingest -> same turn replaced (rev++) with [user, progress(completed), assistant]");
  // ---- attachments: Hub-materialized local file -> upload -> webhook payload; events carry metadata only
  const fs = require("fs"), os = require("os");
  const png = path.join(os.tmpdir(), `mockhub-${Date.now()}.png`);
  fs.writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
  const m3 = "pm3-" + Date.now(); const evBefore = events.length;
  const rc3 = await okp("adapter.send", { session: sess, message: { prism_message_id: m3, text: "看看这张图", attachments: [{ name: "photo.png", mime_type: "image/png", local_path: png }], source_device: "phone", timestamp: new Date().toISOString(), metadata: {} } });
  assert(rc3.accepted); fs.unlinkSync(png);
  await until(() => events.slice(evBefore).some((e) => e.type === "run.progress" && e.payload.attachments));
  const stEv = events.slice(evBefore).find((e) => e.payload.attachments);
  assert.deepStrictEqual(stEv.payload.attachments, [{ name: "photo.png", mime_type: "image/png", kind: "image" }]);
  assert(!JSON.stringify(events).includes("local_path") && !JSON.stringify(events).includes("sig="), "events carry metadata only");
  step("adapter.send with Attachments -> uploaded; events carry metadata only");
  const big = path.join(os.tmpdir(), `mockhub-big-${Date.now()}.pdf`); fs.writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1));
  const rBig = await call("adapter.send", { session: sess, message: { prism_message_id: "big", text: "x", attachments: [{ name: "big.pdf", mime_type: "application/pdf", local_path: big }], source_device: "phone", timestamp: "", metadata: {} } });
  fs.unlinkSync(big); assert(!rBig.ok); assert.strictEqual(rBig.error.code, "invalid_request"); step(`>10MB attachment rejected (${rBig.error.code})`);

  // ---- approvals: "待确认：… 回复 OK/NO" in a chapter -> approval event -> resolveApproval
  await ingest({ session_id: sess.native_session_id, summary: "需要确认", body: "邮件草稿已写好。\n待确认：要把这封邮件发给张三吗？回复 OK/NO" });
  await until(() => events.some((e) => e.type === "approval.requested"));
  const apEv = events.find((e) => e.type === "approval.requested"); assert.strictEqual(apEv.payload.text, "要把这封邮件发给张三吗？");
  const st2 = await okp("adapter.readStatus", { session: sess }); assert(st2.approval_blocked);
  const lst = await okp("adapter.listApprovals", { session: sess }); assert.strictEqual(lst.length, 1);
  await okp("adapter.resolveApproval", { prism_conversation_id: "c1", plugin_id: "grokbot", session: sess, approval_request_id: apEv.payload.approval_request_id, action_id: "approve", source_device: "glasses", metadata: {} });
  assert.strictEqual((await okp("adapter.listApprovals", { session: sess })).length, 0);
  const badAp = await call("adapter.resolveApproval", { session: sess, action_id: "maybe" }); assert(!badAp.ok); assert.strictEqual(badAp.error.code, "invalid_request");
  step("approval parsed -> approval.requested event, approval_blocked, resolveApproval(approve) -> OK");

  // ---- drafts
  const od = await okp("adapter.openDraft", { draft_id: "d-1", plugin_id: "grokbot", cwd: "", source_device: "glasses", metadata: {} });
  assert.strictEqual(od.draft_id, "d-1"); assert.strictEqual(od.controls.text, "");
  await okp("adapter.controlDraft", { draft_id: "d-1", plugin_id: "grokbot", action: "text.set", target: { text: "帮我查一下" } });
  const cd = await okp("adapter.controlDraft", { draft_id: "d-1", plugin_id: "grokbot", action: "text_append", target: { text: "明天的天气" } });
  assert.strictEqual(cd.controls.text, "帮我查一下明天的天气");
  const sd = await okp("adapter.startDraftWithMessage", { draft_id: "d-1", plugin_id: "grokbot", cwd: "", source_device: "glasses", metadata: {}, message: { prism_message_id: "d1m", text: "", source_device: "glasses", timestamp: "", metadata: {} } });
  assert(sd.receipt.accepted); const od2 = await okp("adapter.openDraft", { draft_id: "d-1" }); assert.strictEqual(od2.controls.text, "");
  step("openDraft / controlDraft(text.set, text_append) / startDraftWithMessage -> draft consumed");

  // ---- interrupt
  const evI = events.length;
  const un = await okp("adapter.interrupt", { session: sess, task_id: m3 }); assert(un.ok);
  await until(() => events.slice(evI).some((e) => e.type === "run.failed" && e.payload.interrupted));
  const st3 = await okp("adapter.readStatus", { session: sess }); assert.strictEqual(st3.status, "failed");
  step("adapter.interrupt -> bridge cancelled + cancelled status event");
  await okp("adapter.unsubscribe", { subscription_id: "sub-1" }); await okp("adapter.close");
  step("adapter.unsubscribe + adapter.close");
  // ---- plugin-wide directory watcher (Hub conversation index)
  const evW = events.length;
  const w = await okp("adapter.subscribePlugin", { subscription_id: "wide-1" }); assert.strictEqual(w.subscription_id, "wide-1");
  await until(() => events.slice(evW).some((e) => e.type === "desktop.session.index.changed"));
  const wide = events.slice(evW);
  assert.strictEqual(wide[0].type, "desktop.session.directory.reconciled");
  const ix = wide.find((e) => e.type === "desktop.session.index.changed");
  assert(ix.payload.session_hint.native_session_id && ix.payload.native_session.plugin_id === "grokbot" && ix.payload.session_hint.cwd);
  await okp("adapter.unsubscribe", { subscription_id: "wide-1" });
  const pr2 = await okp("adapter.probe", {}); assert(pr2.can_plugin_wide_watch && pr2.can_list_sessions);
  const unk = await call("adapter.nope", {}); assert.strictEqual(unk.error.code, "unknown_method");
  const usage = await okp("adapter.readAgentUsage", {}); assert.deepStrictEqual(usage, {});
  step("subscribePlugin -> directory.reconciled + session.index.changed; all wire keys snake_case");
  console.log("\nALL MOCK-HUB CHECKS PASSED");
  child.kill(); process.exit(0);
})().catch((e) => { console.error("FAIL:", e.message); child.kill(); process.exit(1); });
