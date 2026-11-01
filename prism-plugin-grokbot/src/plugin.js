#!/usr/bin/env node
/**
 * prism-plugin-grokbot — Rokid Prism PluginBridge v4 plugin (zero dependencies).
 *
 * Speaks the same JSON-lines stdio wire as @rokid-prism/pluginbridge-plugin-sdk
 * (requests {id,method,params} snake_case; responses {id,ok,payload|error};
 * events {event:"plugin.event",payload:{subscription_id,event}} and
 * {event:"history.stream",payload}). Backend = session-bridge HTTP API.
 *
 * Env: SESSION_BRIDGE_URL (default http://127.0.0.1:8787), BRIDGE_TOKEN,
 *      GROKBOT_CHARS_PER_PAGE (default 180), GROKBOT_POLL_MS (1500),
 *      GROKBOT_RUN_TIMEOUT_MS (600000).
 * The Grok Bot webhook URL/key live only in the bridge's env (GROKBOT_WEBHOOK_URL/KEY).
 */
"use strict";
const readline = require("readline");
const { randomUUID } = require("crypto");
const fs = require("fs");
const pathMod = require("path");
const UPLOAD_MAX = 10 * 1024 * 1024;

// ---- config bootstrap: Hub launches us with only PRISM_PLUGIN_* env ----
const CONFIG_KEYS = ["SESSION_BRIDGE_URL", "BRIDGE_TOKEN", "SESSION_BRIDGE_TOKEN", "GROKBOT_CWD", "GROKBOT_DEBUG_LOG"];
const PLUGIN_ROOT = process.env.PRISM_PLUGIN_ROOT || pathMod.resolve(__dirname, "..");
const CONFIG_SOURCES = {};
const CONFIG_NOTES = [];
function parseDotenv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("#")) continue;
    const m = line.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/); if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}
function loadConfig() {
  for (const k of CONFIG_KEYS) if (process.env[k]) CONFIG_SOURCES[k] = "process.env";
  const missing = () => CONFIG_KEYS.filter((k) => !process.env[k]);
  if (missing().length) {
    const file = pathMod.join(PLUGIN_ROOT, ".env");
    try {
      const vals = parseDotenv(fs.readFileSync(file, "utf8"));
      for (const k of missing()) if (vals[k]) { process.env[k] = vals[k]; CONFIG_SOURCES[k] = file; }
    } catch {}
  }
  if (missing().length && process.platform === "win32") {
    // Hub starts us with a minimal env (often no PATH/SystemRoot), so use absolute paths.
    const { execFileSync } = require("child_process");
    const win = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    const sys32 = pathMod.join(win, "System32");
    const childEnv = { SystemRoot: win, windir: win, PATH: sys32 + ";" + win, USERPROFILE: process.env.USERPROFILE || require("os").homedir() };
    const run = (exe, args) => execFileSync(exe, args, { encoding: "utf8", windowsHide: true, timeout: 8000, env: childEnv, stdio: ["ignore", "pipe", "ignore"] });
    const expand = (v) => v.replace(/%([^%]+)%/g, (x, n) => process.env[n] || x);
    for (const k of missing()) {
      let v = "", src = "";
      try {
        const out = run(pathMod.join(sys32, "reg.exe"), ["query", "HKCU\\Environment", "/v", k]);
        for (const line of out.split(/\r?\n/)) {
          const m = line.match(/^\s*(\S+)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*?)\s*$/i);
          if (m && m[1].toLowerCase() === k.toLowerCase()) { v = m[2].toUpperCase() === "REG_EXPAND_SZ" ? expand(m[3]) : m[3]; src = "HKCU\\Environment(reg)"; break; }
        }
      } catch (e) { CONFIG_NOTES.push(`reg query ${k} failed: ${e.code || e.message}`); }
      if (!v) {
        try {
          const ps = pathMod.join(sys32, "WindowsPowerShell", "v1.0", "powershell.exe");
          v = run(ps, ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetEnvironmentVariable('${k}','User')`]).trim();
          if (v) src = "HKCU\\Environment(powershell)";
        } catch (e) { CONFIG_NOTES.push(`powershell env ${k} failed: ${e.code || e.message}`); }
      }
      if (v) { process.env[k] = v; CONFIG_SOURCES[k] = src; }
    }
  }
}
loadConfig();

const PROTOCOL_VERSION = "4";
const PLUGIN_ID = "grokbot";
const BRIDGE = (process.env.SESSION_BRIDGE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const TOKEN = process.env.BRIDGE_TOKEN || process.env.SESSION_BRIDGE_TOKEN || "";
const CPP = Number(process.env.GROKBOT_CHARS_PER_PAGE || 180);
const POLL_MS = Number(process.env.GROKBOT_POLL_MS || 1500);
const RUN_TIMEOUT_MS = Number(process.env.GROKBOT_RUN_TIMEOUT_MS || 600000);
const COVER_MAX = 40;
// Panel groups threads as Agent -> project(cwd) -> thread; an empty cwd may hide sessions.
const CWD = process.env.GROKBOT_CWD || "grokbot"; // default fixed; optional override via .env
const DIR_POLL_MS = Number(process.env.GROKBOT_DIR_POLL_MS || 5000);

// ---- file debug log (every inbound request / outbound line, secrets redacted) ----
const os = require("os");
const DEBUG_LOG = process.env.GROKBOT_DEBUG_LOG === "0" ? "" : (process.env.GROKBOT_DEBUG_LOG || pathMod.join(process.env.USERPROFILE || os.homedir(), ".prism", "logs", "grokbot-plugin.log"));
const SECRET_KEY = /token|authorization|secret|password|api[_-]?key|sig$/i;
function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEY.test(k) ? "[REDACTED]" : redact(x); return o; }
  if (typeof v === "string") { let t = v.replace(/Bearer\s+[^\s"]+/gi, "Bearer [REDACTED]").replace(/([?&](sig|token)=)[^&\s"]+/gi, "$1[REDACTED]"); if (TOKEN && TOKEN.length >= 8) t = t.split(TOKEN).join("[REDACTED]"); return t; }
  return v;
}
let dbgOk = Boolean(DEBUG_LOG);
if (dbgOk) { try { fs.mkdirSync(pathMod.dirname(DEBUG_LOG), { recursive: true }); } catch { dbgOk = false; } }
function dbg(dir, obj) {
  if (!dbgOk) return;
  let body; try { body = typeof obj === "string" ? redact(obj) : JSON.stringify(redact(obj)); } catch { body = String(obj); }
  if (body.length > 8000) body = body.slice(0, 8000) + `…(+${body.length - 8000})`;
  try { fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${dir} ${body}\n`); } catch {}
}
const log = (...a) => { dbg("LOG", a.join(" ")); process.stderr.write("[grokbot] " + a.join(" ") + "\n"); };
const now = () => new Date().toISOString();
const sleep = (ms, signal) => new Promise((r) => { const onAbort = () => { clearTimeout(t); r(); }; const t = setTimeout(() => { signal && signal.removeEventListener("abort", onAbort); r(); }, ms); signal && signal.addEventListener("abort", onAbort, { once: true }); });

class AdapterError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

async function http(method, path, body) {
  const headers = { "Content-Type": "application/json" };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const r = await fetch(BRIDGE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new AdapterError(r.status === 404 ? "not_found" : "bridge_error", `${method} ${path} -> ${r.status} ${j.error || ""}`);
  return j;
}

const cover = (ch) => {
  const s = String(ch.summary || ch.title || ch.body || "").replace(/\s+/g, " ").trim();
  return s.length > COVER_MAX ? s.slice(0, COVER_MAX - 1) + "…" : s;
};

async function chapterPages(sessionId, ch) {
  const base = `/v1/sessions/${encodeURIComponent(sessionId)}/chapters/${encodeURIComponent(ch.id)}/pages?charsPerPage=${CPP}`;
  const first = await http("GET", base + "&page=1");
  const pages = [first.text];
  for (let p = 2; p <= first.totalPages; p++) pages.push((await http("GET", base + "&page=" + p)).text);
  return pages;
}

const nativeSession = (id, cwd = CWD) => ({
  plugin_id: PLUGIN_ID, native_session_id: id, native_thread_id: id,
  surface: "grokbot-session-bridge", endpoint: BRIDGE, cwd, visible: true,
});
const sid = (s) => (s && (s.native_session_id || s.native_thread_id)) || "";

// runID -> { sessionId, baseline (chapter count before the prompt) }
const runs = new Map();

/** Stream a Hub-materialized local file to the bridge; returns {id,name,mime,size,url}. */
async function uploadFile(a) {
  const local = a.local_path || a.LocalPath;
  const name = a.name || a.Name || pathMod.basename(local || "file");
  const mime = a.mime_type || a.MIMEType || "application/octet-stream";
  if (!local) throw new AdapterError("invalid_request", `attachment ${name} has no local_path`);
  let st; try { st = fs.statSync(local); } catch { throw new AdapterError("invalid_request", `attachment not readable: ${name}`); }
  if (st.size > UPLOAD_MAX) throw new AdapterError("invalid_request", `attachment ${name} exceeds 10MB`);
  const headers = { "Content-Type": mime, "Content-Length": String(st.size) };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const r = await fetch(`${BRIDGE}/v1/upload?name=${encodeURIComponent(name)}`, { method: "POST", headers, body: fs.createReadStream(local), duplex: "half" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new AdapterError("bridge_error", `upload ${name} -> ${r.status} ${j.error || ""}`);
  return j;
}
const attMeta = (list) => (list || []).map((a) => ({ name: a.name, mime_type: a.mime || a.mime_type, kind: String(a.mime || a.mime_type || "").startsWith("image/") ? "image" : "file" }));

const MODEL_NAME = "Grok Bot";
const MODEL = { id: "grok-bot", key: "grok-bot", value: "grok-bot", label: MODEL_NAME, display_name: MODEL_NAME };
// live per-session listeners (subscribe pumps) so send-time events reach the Hub immediately
const live = new Map(); // sessionId -> Set<fn(ev)>
const notify = (sessionId, ev) => { for (const fn of live.get(sessionId) || []) { try { fn(ev); } catch {} } };
const latestRun = new Map(); // sessionId -> runId
const base = (sessionId, extra = {}) => ({ native_session_id: sessionId, native_thread_id: sessionId, ...extra });

async function getSession(id) { return http("GET", `/v1/sessions/${encodeURIComponent(id)}`); }

async function submit(prompt, sessionId, msgId, rawAtts) {
  const uploaded = [];
  for (const a of rawAtts || []) uploaded.push(await uploadFile(a));
  const attachments = uploaded.map(({ name, mime, url, size }) => ({ name, mime, url, size }));
  if (!prompt && attachments.length) prompt = "请查看附件。";
  if (!prompt) throw new AdapterError("invalid_request", "message text required");
  let baseline = 0;
  if (sessionId) baseline = (await getSession(sessionId)).chapters.length;
  const r = await http("POST", "/v1/command", { prompt, session_id: sessionId || undefined, source: "prism", attachments: attachments.length ? attachments : undefined });
  const runId = msgId || randomUUID();
  runs.set(runId, { sessionId: r.session.id, baseline, startedAt: now() });
  latestRun.set(r.session.id, runId);
  const sidNew = r.session.id, attMetaList = attMeta(attachments);
  notify(sidNew, { id: `${runId}:user`, type: "message.user", status: "accepted", summary: prompt.slice(0, 160), payload: base(sidNew, { role: "user", text: prompt, prism_message_id: runId, request_id: runId, ...(attMetaList.length ? { attachments: attMetaList } : {}) }), created_at: now() });
  notify(sidNew, { id: `${runId}:msg-started`, type: "message.started", status: "running", summary: "", payload: base(sidNew, { role: "assistant", run_id: runId, turn_id: runId, model: MODEL_NAME }), created_at: now() });
  notify(sidNew, { id: `${runId}:started`, type: "run.started", status: "running", summary: "Grok Bot 已开始处理。", payload: base(sidNew, { run_id: runId, turn_id: runId, source: "prism", model: MODEL_NAME }), created_at: now() });
  const accepted = r.webhook && (r.webhook.ok || r.webhook.skipped);
  return {
    session: r.session, runId, attachments: attMeta(attachments),
    receipt: {
      native_message_id: runId, canonical_native_session_id: r.session.id, canonical_native_thread_id: r.session.id,
      accepted: Boolean(accepted), visible: true,
      detail: r.webhook.ok ? "Grok Bot routine started" : r.webhook.skipped ? "recorded (webhook not configured on bridge)" : `webhook failed: ${r.webhook.status || r.webhook.error || ""}`,
    },
  };
}

/** Standard reply events: message.assistant (full body) -> message.completed -> run.completed.
 *  cover/pages ride along as extra novel-reader metadata. Last element is the terminal run.completed. */
function replyEvents(sessionId, ch, pages, runId) {
  const c = cover(ch);
  const text = pages.join("");
  const novel = { cover: c, title: ch.title || "", page_count: pages.length, chars_per_page: CPP, pages, reader: "novel" };
  const rid = runId || latestRun.get(sessionId) || ch.id;
  return [
    { id: `${ch.id}:assistant`, type: "message.assistant", status: "completed", summary: c,
      payload: base(sessionId, { role: "assistant", message_id: ch.id, chapter_id: ch.id, run_id: rid, turn_id: rid, text, content: text, model: MODEL_NAME, ...novel }), created_at: now() },
    { id: `${ch.id}:message-completed`, type: "message.completed", status: "completed", summary: c,
      payload: base(sessionId, { role: "assistant", message_id: ch.id, run_id: rid, text, usage: null, model: MODEL_NAME }), created_at: now() },
    { id: `${rid}:terminal`, type: "run.completed", status: "completed", summary: c || text.slice(0, 240),
      payload: base(sessionId, { run_id: rid, turn_id: rid, message_id: ch.id, text, cwd: CWD, model: MODEL_NAME, ...novel }), created_at: now() },
  ];
}

function approvalEvent(sessionId, a) {
  return { id: `${a.id}:approval`, type: "approval.requested", status: "approval_blocked", summary: `待确认：${a.text}`.slice(0, COVER_MAX),
    payload: { native_session_id: sessionId, approval_request_id: a.id, chapter_id: a.chapter_id, text: a.text,
      actions: [{ action_id: "approve", label: "OK" }, { action_id: "deny", label: "NO" }] }, created_at: now() };
}
const decisionOf = (actionId) => /^(approve|ok|yes|allow|accept)/i.test(String(actionId || "")) ? "OK" : /^(deny|no|reject|decline|cancel)/i.test(String(actionId || "")) ? "NO" : null;

/** Yields: status(running) -> cover -> page 1..N -> completed, for each new chapter. */
async function* watch(sessionId, signal, baseline, once, runId) {
  let seen = baseline, lastStatus = "";
  const t0 = Date.now();
  while (!signal || !signal.aborted) {
    const { session, chapters } = await getSession(sessionId);
    if (session.status !== lastStatus) {
      lastStatus = session.status;
      const rid = latestRun.get(sessionId) || "";
      const extra = { bridge_status: session.status, run_id: rid, ...(session.last_attachments ? { attachments: attMeta(session.last_attachments) } : {}) };
      if (session.status === "error" || session.status === "cancelled") {
        const interrupted = session.status === "cancelled";
        yield { id: `${rid || randomUUID()}:terminal`, type: "run.failed", status: "failed", summary: interrupted ? "Grok Bot 已中断。" : "Grok Bot 执行失败。", payload: base(sessionId, { ...extra, interrupted }), created_at: now() };
        if (once) return;
      } else if (session.status !== "ready") {
        yield { id: randomUUID(), type: "run.progress", status: "running", summary: "Grok Bot 正在处理…", payload: base(sessionId, { ...extra, kind: "status.update" }), created_at: now() };
      }
    }
    if (chapters.length > seen) {
      for (const meta of chapters.slice(seen)) {
        const pages = await chapterPages(sessionId, meta);
        for (const ev of replyEvents(sessionId, meta, pages, runId)) yield ev;
        const appr = (session.approvals || []).find((a) => a.chapter_id === meta.id && a.status === "pending");
        if (appr) yield approvalEvent(sessionId, appr);
      }
      seen = chapters.length;
      if (once) return;
    }
    if (once && Date.now() - t0 > RUN_TIMEOUT_MS) {
      yield { id: `${runId || randomUUID()}:terminal`, type: "run.failed", status: "failed", summary: "等待 Grok Bot 回复超时。", payload: base(sessionId, { run_id: runId || "", timeout: true }), created_at: now() };
      return;
    }
    await sleep(POLL_MS, signal);
  }
}

const adapter = {
  probe: () => ({
    plugin_id: PLUGIN_ID, available: true, native_visible_input: true, native_visible_output: true,
    can_attach_session: true, can_start_session_with_message: true, can_list_sessions: true,
    can_read_history: true, can_interrupt: true, can_approval: true, can_open_draft: true, can_forward_sync: true,
    can_reverse_sync: true, can_plugin_wide_watch: true, can_wait_run: true, can_read_status: true,
    can_control_session: false, integration_mode: "protocol-native",
    visibility_surface: "grokbot-session-bridge", unavailable_reason: "",
  }),
  async discover() {
    let ok = false, detail = "";
    try { ok = (await http("GET", "/health")).ok === true; } catch (e) { detail = e.message; }
    return { plugin_id: PLUGIN_ID, surface: "grokbot-session-bridge", endpoint: BRIDGE, process_id: 0, session_hints: {}, verified: ok, detail };
  },
  async listSessions() {
    const { sessions } = await http("GET", "/v1/sessions");
    return sessions.map((s) => ({
      plugin_id: PLUGIN_ID, native_session_id: s.id, native_thread_id: s.id, surface: "grokbot-session-bridge",
      endpoint: BRIDGE, cwd: CWD, title: String(s.title || s.last_prompt || s.id).slice(0, 80), prism_conversation_id: "",
      active: ["running", "awaiting_reply"].includes(s.status), visible: true, last_activity_at: s.updated_at || s.created_at || now(),
      metadata: { status: ["running", "awaiting_reply"].includes(s.status) ? "running" : "idle", model: MODEL_NAME, sort_at: String(Date.parse(s.updated_at || s.created_at || now()) || Date.now()) },
    }));
  },
  async attachSession(p) {
    const id = p.native_session_id || p.native_thread_id;
    await getSession(id); // 404 -> not_found
    return nativeSession(id, p.cwd || CWD);
  },
  async startSessionWithMessage(p) {
    const m = p.message || {};
    const r = await submit(String(m.text || "").trim(), null, m.prism_message_id, m.attachments);
    return {
      session: nativeSession(r.session.id, p.cwd || CWD), receipt: r.receipt,
      visibility: { visible: true, marker: m.text, evidence: "session-bridge accepted", checked_at: now(), failure_reason: "" },
    };
  },
  async send(p) { const m = p.message || {}; return (await submit(String(m.text || "").trim(), sid(p.session), m.prism_message_id, m.attachments)).receipt; },
  async interrupt(p) {
    const id = sid(p.session);
    await http("POST", `/v1/sessions/${encodeURIComponent(id)}/interrupt`, { task_id: p.task_id || "" });
    return { ok: true };
  },
  // ---- drafts (SDK: openDraft / controlDraft / startDraftWithMessage). Text kept on the bridge under the DraftID. ----
  draftControls(d) { return { text: (d && d.text) || "", supported_actions: ["text.set", "text.append", "text.clear"] }; },
  async openDraft(p) {
    const id = p.draft_id; if (!id) throw new AdapterError("invalid_request", "draft_id required");
    let d; try { d = (await http("GET", `/v1/drafts/${encodeURIComponent(id)}`)).draft; } catch (e) { if (e.code !== "not_found") throw e; d = (await http("PUT", `/v1/drafts/${encodeURIComponent(id)}`, { text: "" })).draft; }
    return { draft_id: id, cwd: p.cwd || "", controls: this.draftControls(d), draft_fingerprint: `${id}:${d.updated_at}` };
  },
  async controlDraft(p) {
    const id = p.draft_id; const action = String(p.action || "").toLowerCase().replace(/_/g, ".");
    const t = p.target; const val = typeof t === "string" ? t : (t && (t.text ?? t.value)) ?? p.name ?? "";
    const path = `/v1/drafts/${encodeURIComponent(id)}`;
    let d;
    if (action === "text.set") d = (await http("PUT", path, { text: String(val) })).draft;
    else if (action === "text.append") { let cur = ""; try { cur = (await http("GET", path)).draft.text || ""; } catch {} d = (await http("PUT", path, { text: cur + String(val) })).draft; }
    else if (action === "text.clear" || action === "draft.discard") { await http("DELETE", path); d = null; }
    else throw new AdapterError("not_supported", `draft action ${p.action} not supported`);
    return { draft_id: id, cwd: "", controls: this.draftControls(d) };
  },
  async startDraftWithMessage(p) {
    const id = p.draft_id; let draft = "";
    try { draft = (await http("GET", `/v1/drafts/${encodeURIComponent(id)}`)).draft.text || ""; } catch {}
    const m = p.message || {};
    const text = [draft.trim(), String(m.text || "").trim()].filter(Boolean).join("\n");
    const r = await this.startSessionWithMessage({ ...p, message: { ...m, text } });
    await http("DELETE", `/v1/drafts/${encodeURIComponent(id)}`).catch(() => {});
    return r;
  },
  // ---- approvals ----
  async listApprovals(p) {
    const id = sid(p.session);
    const { approvals } = await http("GET", `/v1/sessions/${encodeURIComponent(id)}/approvals`);
    return approvals.map((a) => approvalEvent(id, a).payload);
  },
  async resolveApproval(p) {
    const decision = decisionOf(p.action_id);
    if (!decision) throw new AdapterError("invalid_request", `unknown approval action ${p.action_id}`);
    await http("POST", `/v1/sessions/${encodeURIComponent(sid(p.session))}/approval`, { decision, approval_id: p.approval_request_id || undefined, note: p.input || undefined });
    return { ok: true };
  },
  async waitForRun(p) {
    const run = runs.get(p.run_id);
    const sessionId = (run && run.sessionId) || sid(p.session);
    let baseline = run ? run.baseline : (await getSession(sessionId)).chapters.length - 1;
    let last;
    for await (const ev of watch(sessionId, null, Math.max(0, baseline), true, p.run_id)) if (/^run\.(completed|failed)$/.test(ev.type) || !last) last = ev;
    if (last && last.type === "run.completed" && p.run_id) last.id = p.run_id;
    if (run) runs.delete(p.run_id);
    return last;
  },
  async readStatus(p) {
    const { session, chapters } = await getSession(sid(p.session));
    const done = ["ready", "local_only"].includes(session.status) && chapters.length;
    const blocked = (session.approvals || []).some((a) => a.status === "pending");
    const status = blocked ? "waiting_approval" : ["cancelled", "error"].includes(session.status) ? "failed" : ["running", "awaiting_reply"].includes(session.status) ? "running" : chapters.length ? "completed" : "idle";
    return { status, model: MODEL,
      preview: chapters.length ? cover(chapters[chapters.length - 1]) : "", interruptible: status === "running", approval_blocked: blocked,
      primary_action: blocked ? "approval" : status === "running" ? "interrupt" : "send",
      turn_id: p.run_id || latestRun.get(session.id) || "", started_at: session.created_at, completed_at: done ? session.updated_at : undefined };
  },
  async historyTurns(id, limit) {
    const { session, chapters } = await getSession(id);
    const list = limit > 0 ? chapters.slice(-limit) : chapters;
    const turns = [];
    for (const meta of list) {
      const pages = await chapterPages(id, meta);
      turns.push({ turn_id: meta.id, order_key: meta.created_at, revision: 1, messages: [{
        id: meta.id, role: "assistant", type: "text", content: [cover(meta), "", ...pages].join("\n"),
        status: "completed", created_at: meta.created_at, updated_at: meta.created_at, metadata: { model: MODEL_NAME, cover: cover(meta), page_count: pages.length } }] });
    }
    if (session.last_prompt && !turns.length) turns.push({ turn_id: `${id}:prompt`, order_key: session.created_at, revision: 1, messages: [{ id: `${id}:prompt`, role: "user", type: "text", content: session.last_prompt, status: "completed", created_at: session.created_at, updated_at: session.created_at, ...(session.last_attachments ? { metadata: { attachments: attMeta(session.last_attachments) } } : {}) }] });
    return turns;
  },
  async readHistory(p) { return (await this.historyTurns(sid(p.session), Number(p.limit || 0))).flatMap((t) => t.messages); },
  async readDetail(p) {
    const id = sid(p.session);
    const { session, chapters } = await getSession(id);
    const st = await this.readStatus({ session: p.session });
    const blocked = st.approval_blocked; const running = st.status === "running";
    const status = blocked ? "waiting_approval" : running ? "running" : "idle";
    const pending = (session.approvals || []).find((a) => a.status === "pending");
    return {
      plugin_id: PLUGIN_ID, conversation_id: id, title: String(session.title || session.last_prompt || id).slice(0, 80),
      desktop_foreground: false, detail_stale: false, updated_at: Date.now(), status, primary_action: st.primary_action, can_queue: false,
      current_model: MODEL, current_reasoning: null, current_permission: null,
      model_options: [MODEL], reasoning_options: [], permission_options: [], interactive_controls: [], composer: null, queue: null,
      approval: pending ? { approval_request_id: pending.id, summary: pending.text, actions: [{ action_id: "approve", label: "OK" }, { action_id: "deny", label: "NO" }] } : null,
      context_window_total: "0", context_tokens_used: "0", context_window_usage_percent: "0", context_window: "",
      pinned: false,
      actions: [
        { id: "message.send", available: !running && !blocked }, { id: "interrupt", available: running },
        { id: "approval.resolve", available: Boolean(blocked) }, { id: "model.switch", available: false }, { id: "reasoning.switch", available: false },
      ],
      run: { status, active: running || Boolean(blocked), interruptible: running, approval_blocked: Boolean(blocked), approval: null, primary_action: st.primary_action, can_queue: false, summary: st.preview || "" },
      chapters: chapters.length,
    };
  },
  async verifyVisibility(p) { return { visible: true, marker: p.marker, evidence: "bridge session exists", checked_at: now(), failure_reason: "" }; },
};

// ---------------- stdio wire server ----------------
function serve(input = process.stdin, output = process.stdout) {
  const got = (process.env.PRISM_PLUGIN_PROTOCOL_VERSION || "").trim();
  if (got && got !== PROTOCOL_VERSION) { log(`protocol mismatch: hub=${got} plugin=${PROTOCOL_VERSION}`); process.exit(2); }
  const subs = new Map(), streams = new Map();
  const write = (o) => { dbg("OUT", o); output.write(JSON.stringify(o) + "\n"); };
  const ok = (id, payload) => write({ id, ok: true, payload });
  const fail = (id, code, message) => write({ id, ok: false, error: { code, message } });

  async function pump(subId, sessionId, signal) {
    try {
      const fn = (ev) => { if (!signal.aborted) write({ event: "plugin.event", payload: { subscription_id: subId, event: ev } }); };
      if (!live.has(sessionId)) live.set(sessionId, new Set()); live.get(sessionId).add(fn);
      signal.addEventListener("abort", () => live.get(sessionId) && live.get(sessionId).delete(fn), { once: true });
      const baseline = (await getSession(sessionId)).chapters.length;
      for await (const ev of watch(sessionId, signal, baseline, false)) { if (signal.aborted) break; write({ event: "plugin.event", payload: { subscription_id: subId, event: ev } }); }
    } catch (e) { log("subscribe ended:", e.message); } finally { subs.delete(subId); }
  }

  // Plugin-wide directory watcher (mirrors official openclaw plugin): Hub builds its
  // conversation index from desktop.session.directory.reconciled / desktop.session.index.changed.
  async function pumpPlugin(subId, signal) {
    const emit = (ev) => write({ event: "plugin.event", payload: { subscription_id: subId, event: ev } });
    emit({ id: "grokbot-directory-initial-" + randomUUID(), type: "desktop.session.directory.reconciled", status: "completed", summary: "Grok Bot 会话目录已连接。", payload: { source: "grokbot-session-bridge" }, created_at: now() });
    const known = new Map();
    while (!signal.aborted) {
      try {
        for (const h of await adapter.listSessions()) {
          const key = `${h.last_activity_at}|${h.metadata.status}|${h.title}`;
          if (known.get(h.native_session_id) === key) continue;
          known.set(h.native_session_id, key);
          const { active, visible, ...hint } = h;
          emit({ id: `grokbot-session-index-${h.native_session_id}-${Date.now()}`, type: "desktop.session.index.changed", status: h.metadata.status, summary: "Grok Bot 会话目录项已更新。",
            payload: { session_hint: hint, native_session: { plugin_id: h.plugin_id, native_session_id: h.native_session_id, native_thread_id: h.native_thread_id, surface: h.surface, endpoint: h.endpoint, cwd: h.cwd } }, created_at: now() });
        }
      } catch (e) { log("directory poll failed:", e.message); }
      await sleep(DIR_POLL_MS, signal);
    }
    subs.delete(subId);
  }

  const NOT_IMPL = new Set(["adapter.controlSession", "adapter.openManagedTerminal"]);

  async function handle(req) {
    const p = req.params || {};
    try {
      switch (req.method) {
        case "adapter.probe": return ok(req.id, adapter.probe());
        case "adapter.discover": return ok(req.id, await adapter.discover());
        case "adapter.listSessions": return ok(req.id, await adapter.listSessions());
        case "adapter.attachSession": return ok(req.id, await adapter.attachSession(p));
        case "adapter.startSessionWithMessage": return ok(req.id, await adapter.startSessionWithMessage(p));
        case "adapter.send": return ok(req.id, await adapter.send(p));
        case "adapter.waitForRun": return ok(req.id, await adapter.waitForRun(p));
        case "adapter.readStatus": return ok(req.id, await adapter.readStatus(p));
        case "adapter.readHistory": return ok(req.id, await adapter.readHistory(p));
        case "adapter.readDetail": return ok(req.id, await adapter.readDetail(p));
        case "adapter.verifyVisibility": return ok(req.id, await adapter.verifyVisibility(p));
        case "adapter.subscribe": {
          const subId = p.subscription_id || randomUUID();
          const ctl = new AbortController(); subs.set(subId, ctl);
          ok(req.id, { subscribed: true, subscription_id: subId });
          return void pump(subId, sid(p.session), ctl.signal);
        }
        case "adapter.subscribePlugin": {
          const subId = p.subscription_id || randomUUID();
          const ctl = new AbortController(); subs.set(subId, ctl);
          ok(req.id, { subscribed: true, subscription_id: subId });
          return void pumpPlugin(subId, ctl.signal);
        }
        case "adapter.readAgentUsage": return ok(req.id, {}); // neutral AgentUsage: all fields omitempty, no quota data
        case "adapter.ackEvent": return ok(req.id, { ok: true });
        case "adapter.unsubscribe": subs.get(p.subscription_id)?.abort(); subs.delete(p.subscription_id); return ok(req.id, { ok: true });
        case "adapter.readHistoryStream": {
          const r = p.request || {}; const streamId = String(r.stream_id || randomUUID());
          const ctl = new AbortController(); streams.set(streamId, ctl);
          ok(req.id, { stream_id: streamId });
          try {
            for (const turn of await adapter.historyTurns(sid(p.session), Number(r.limit || 0))) {
              if (ctl.signal.aborted) return;
              write({ event: "history.stream", payload: { stream_id: streamId, type: "turn", source: "initial", operation: "append", turn } });
            }
            write({ event: "history.stream", payload: { stream_id: streamId, type: "end" } });
          } catch (e) { write({ event: "history.stream", payload: { stream_id: streamId, type: "error", error: e.message } }); }
          finally { streams.delete(streamId); }
          return;
        }
        case "adapter.cancelHistoryStream": streams.get(p.stream_id)?.abort(); return ok(req.id, { ok: true });
        case "adapter.interrupt": return ok(req.id, await adapter.interrupt(p));
        case "adapter.openDraft": return ok(req.id, await adapter.openDraft(p));
        case "adapter.controlDraft": return ok(req.id, await adapter.controlDraft(p));
        case "adapter.startDraftWithMessage": return ok(req.id, await adapter.startDraftWithMessage(p));
        case "adapter.resolveApproval": return ok(req.id, await adapter.resolveApproval(p));
        case "adapter.listApprovals": return ok(req.id, await adapter.listApprovals(p)); // non-standard helper
        case "adapter.close": for (const c of subs.values()) c.abort(); subs.clear(); return ok(req.id, { ok: true });
        default:
          if (NOT_IMPL.has(req.method)) return fail(req.id, "not_implemented", `${req.method} not supported`);
          return fail(req.id, "unknown_method", `unknown adapter method ${req.method}`);
      }
    } catch (e) { fail(req.id, e.code || "adapter_error", e.message || String(e)); }
  }

  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on("line", (line) => { const t = line.trim(); if (!t) return; let req; try { req = JSON.parse(t); } catch { dbg("IN-BADJSON", t); return; } dbg("IN", req); handle(req); });
  rl.on("close", () => { for (const c of subs.values()) c.abort(); });
  log(`ready; bridge=${BRIDGE} pid=${process.pid} protocol_env=${process.env.PRISM_PLUGIN_PROTOCOL_VERSION || ""} debug_log=${DEBUG_LOG || "off"}`);
  log("config sources:", JSON.stringify(Object.fromEntries(CONFIG_KEYS.map((k) => [k, CONFIG_SOURCES[k] || "missing"]))));
  for (const n of CONFIG_NOTES) log("config note:", n);
  dbg("ENV", Object.fromEntries(Object.entries(process.env).filter(([k]) => /^PRISM|^GROKBOT|^SESSION_BRIDGE|^BRIDGE/.test(k)).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[REDACTED]" : v])));
}

process.on("uncaughtException", (e) => { log("uncaught:", e.stack || e.message); });
process.on("unhandledRejection", (e) => { log("unhandledRejection:", (e && e.stack) || String(e)); });
if (require.main === module) serve();
module.exports = { adapter, serve, cover };
