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
const draftBots = new Map(); // draftId -> bot option id (chosen on the chip before the first message)

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

// ---- bot list (model chip): GROKBOT_BOTS_FILE (default ~/.prism/grokbot-bots.json) =
//   [{ "id": "<agent id>", "name": "...", "favorite": 1|2|..|true|false, "default": true? }]
// No secrets here: per-bot webhook URL/key live only in the bridge's BOT_WEBHOOKS_FILE.
// The default bot keeps option id "grok-bot" (sessions created before the bot list have no target).
const DEFAULT_ID = "grok-bot";
const BOTS_FILE = process.env.GROKBOT_BOTS_FILE || pathMod.join(process.env.USERPROFILE || os.homedir(), ".prism", "grokbot-bots.json");
let botsCache = { mtime: -1, list: null };
function loadBots() {
  let mtime = 0; try { mtime = fs.statSync(BOTS_FILE).mtimeMs; } catch {}
  if (botsCache.list && botsCache.mtime === mtime) return botsCache.list;
  let raw = []; try { raw = JSON.parse(fs.readFileSync(BOTS_FILE, "utf8")); if (!Array.isArray(raw)) raw = raw.bots || []; } catch {}
  const seen = new Set(); const list = [];
  for (const b of raw) {
    if (!b || !b.name) continue;
    const id = b.default ? DEFAULT_ID : String(b.id || "").trim(); if (!id || seen.has(id)) continue; seen.add(id);
    list.push({ id, agent_id: b.id || "", name: String(b.name), favorite: b.favorite === true ? 999 : Number(b.favorite) || 0, isDefault: Boolean(b.default) });
  }
  if (!seen.has(DEFAULT_ID)) list.unshift({ id: DEFAULT_ID, agent_id: "", name: "Example Bot A", favorite: 0, isDefault: true });
  // favorites first (rank ascending), then the rest in file order
  const fav = list.filter((b) => b.favorite).sort((a, b) => a.favorite - b.favorite), rest = list.filter((b) => !b.favorite);
  botsCache = { mtime, list: [...fav, ...rest] };
  return botsCache.list;
}
const defaultBot = () => loadBots().find((b) => b.isDefault);
const botById = (id) => id ? loadBots().find((b) => b.id === id || b.agent_id === id) : null;
const botByName = (n) => n ? loadBots().find((b) => b.name === n) : null;
const botOption = (b) => ({ id: b.id, key: b.id, value: b.id, label: b.name, display_name: b.name, target: { option_id: b.id } });
const botOptions = () => loadBots().map(botOption);
const sessionBot = (session) => (session && session.target_bot_id && (botById(session.target_bot_id) || { id: session.target_bot_id, agent_id: session.target_bot_id, name: session.target_bot_name || session.target_bot_id })) || defaultBot();
const sessionBotName = new Map(); // sessionId -> bot name (filled from bridge reads)
const botNameOf = (sessionId) => sessionBotName.get(sessionId) || defaultBot().name;
const cwdForBot = (b) => (b && !b.isDefault ? b.name : CWD);
/** Resolve the bot for a new conversation: explicit draft choice > project (cwd = bot name) > default. */
const pickBot = (botId, cwd) => botById(botId) || botByName(cwd) || defaultBot();
const MODEL_NAME = "Grok Bot"; // legacy constant (fallback only)
const MODEL = botOption({ id: DEFAULT_ID, name: "Grok Bot" });
// live per-session listeners (subscribe pumps) so send-time events reach the Hub immediately
const live = new Map(); // sessionId -> Set<fn(ev)>
const notify = (sessionId, ev) => { for (const fn of live.get(sessionId) || []) { try { fn(ev); } catch {} } };
const latestRun = new Map(); // sessionId -> runId
const base = (sessionId, extra = {}) => ({ native_session_id: sessionId, native_thread_id: sessionId, ...extra });

async function getSession(id) { const r = await http("GET", `/v1/sessions/${encodeURIComponent(id)}`); if (r && r.session) sessionBotName.set(id, sessionBot(r.session).name); return r; }

async function submit(prompt, sessionId, msgId, rawAtts, bot) {
  const uploaded = [];
  for (const a of rawAtts || []) uploaded.push(await uploadFile(a));
  const attachments = uploaded.map(({ name, mime, url, size }) => ({ name, mime, url, size }));
  if (!prompt && attachments.length) prompt = "请查看附件。";
  if (!prompt) throw new AdapterError("invalid_request", "message text required");
  let baseline = 0;
  if (sessionId) baseline = (await getSession(sessionId)).chapters.length;
  const r = await http("POST", "/v1/command", { prompt, session_id: sessionId || undefined, source: "prism", attachments: attachments.length ? attachments : undefined,
    ...(!sessionId && bot && !bot.isDefault ? { target_bot_id: bot.agent_id || bot.id, target_bot_name: bot.name } : {}) });
  const runId = msgId || randomUUID();
  runs.set(runId, { sessionId: r.session.id, baseline, startedAt: now() });
  journalAdd({ run_id: runId, session_id: r.session.id, prompt, baseline, created_at: now(), attachments: attMeta(attachments) });
  latestRun.set(r.session.id, runId);
  sessionBotName.set(r.session.id, sessionBot(r.session).name);
  const sidNew = r.session.id, attMetaList = attMeta(attachments);
  notify(sidNew, { id: `${runId}:user`, type: "message.user", status: "accepted", summary: prompt.slice(0, 160), payload: base(sidNew, { role: "user", text: prompt, prism_message_id: runId, request_id: runId, ...(attMetaList.length ? { attachments: attMetaList } : {}) }), created_at: now() });
  notify(sidNew, { id: `${runId}:msg-started`, type: "message.started", status: "running", summary: "", payload: base(sidNew, { role: "assistant", run_id: runId, turn_id: runId, model: botNameOf(sidNew) }), created_at: now() });
  notify(sidNew, { id: `${runId}:started`, type: "run.started", status: "running", summary: `${botNameOf(sidNew)} 已开始处理。`, payload: base(sidNew, { run_id: runId, turn_id: runId, source: "prism", model: botNameOf(sidNew) }), created_at: now() });
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
      payload: base(sessionId, { role: "assistant", message_id: ch.id, chapter_id: ch.id, run_id: rid, turn_id: rid, text, content: text, model: botNameOf(sessionId), ...novel }), created_at: now() },
    { id: `${ch.id}:message-completed`, type: "message.completed", status: "completed", summary: c,
      payload: base(sessionId, { role: "assistant", message_id: ch.id, run_id: rid, text, usage: null, model: botNameOf(sessionId) }), created_at: now() },
    { id: `${rid}:terminal`, type: "run.completed", status: "completed", summary: c || text.slice(0, 240),
      payload: base(sessionId, { run_id: rid, turn_id: rid, message_id: ch.id, text, cwd: CWD, model: botNameOf(sessionId), ...novel }), created_at: now() },
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
        if (meta.title === "运行中") continue;
        const pages = await chapterPages(sessionId, meta);
        if (meta.title === APP_USER) {
          const text = `「${APP_USER}」${pages.join("")}`;
          latestRun.set(sessionId, meta.id);
          yield { id: `${meta.id}:user`, type: "message.user", status: "accepted", summary: text.slice(0, 160), payload: base(sessionId, { role: "user", text, prism_message_id: meta.id, request_id: meta.id, source: "app" }), created_at: now() };
          continue;
        }
        if (meta.title === APP_REPLY && pages.length && !pages[0].startsWith(`「${APP_REPLY}」`)) pages[0] = `「${APP_REPLY}」` + pages[0];
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

// ---- prompt journal: the bridge only keeps last_prompt, so the plugin remembers every prompt it
// submitted (run_id, session, chapter-count baseline) to pair user text with its reply chapters.
const JOURNAL_FILE = process.env.GROKBOT_STATE_FILE || pathMod.join(process.env.USERPROFILE || os.homedir(), ".prism", "grokbot-turns.json");
let journal = null;
let journalMtime = -1;
function journalLoad() {
  // reload when another process (or a Hub restart) changed the file; a stale cache misgroups turns
  let m = 0; try { m = fs.statSync(JOURNAL_FILE).mtimeMs; } catch {}
  if (journal && m === journalMtime) return journal;
  journalMtime = m; journal = null;
  try { journal = JSON.parse(fs.readFileSync(JOURNAL_FILE, "utf8")); if (!Array.isArray(journal)) journal = []; } catch { journal = []; }
  return journal;
}
function journalAdd(e) {
  const j = journalLoad(); j.push(e);
  if (j.length > 2000) j.splice(0, j.length - 2000);
  try { fs.mkdirSync(pathMod.dirname(JOURNAL_FILE), { recursive: true }); fs.writeFileSync(JOURNAL_FILE + ".tmp", JSON.stringify(j)); fs.renameSync(JOURNAL_FILE + ".tmp", JOURNAL_FILE); journalMtime = fs.statSync(JOURNAL_FILE).mtimeMs; } catch (err) { log("journal write failed:", err.message); }
}
const EARLY = "（早期消息，原文未记录）";
const APP_USER = "电脑", APP_REPLY = "电脑续聊";
const labelText = (ch, text) => ch.title === APP_REPLY && !text.startsWith(`「${APP_REPLY}」`) ? `「${APP_REPLY}」${text}` : text;
// The bridge overwrites session.title with each chapter's title (运行中/回复/电脑续聊…), so derive a stable one:
// first prompt from the journal, else the session's first prompt-like title.
const CHAPTER_TITLES = new Set(["运行中", "回复", "错误", "电脑", "电脑续聊", "未命名会话"]);
function sessionTitle(s) {
  const e = journalLoad().find((x) => x.session_id === s.id);
  const t = (e && e.prompt) || (!CHAPTER_TITLES.has(s.title) && !/^第 \d+ 章$/.test(s.title || "") ? s.title : "") || s.last_prompt || s.id;
  return String(t).replace(/\s+/g, " ").trim().slice(0, 80);
}
// v2 turn grouping: offset so regrouped turns supersede revisions cached by Hub/Panel from the old grouping
const REV_BASE = 100;
const RUNNING = ["running", "awaiting_reply", "pending"];
const fmtDur = (ms) => { const t = Math.max(0, Math.round(ms / 1000)); return `已处理 ${Math.floor(t / 60)}m ${t % 60}s`; };
const pageCache = new Map(); // chapter id -> pages (chapters are immutable once ingested)
async function pagesOf(sessionId, ch) { if (!pageCache.has(ch.id)) pageCache.set(ch.id, await chapterPages(sessionId, ch)); return pageCache.get(ch.id); }

/** Build spec HistoryTurns: running = [user, progress(running)]; terminal = [user, progress(completed|failed), final assistant text].
 *  revision = 1 + 2*chapters + (failed ? 1 : 0) — strictly increases as the same turn progresses. */
async function buildTurns(sessionId) {
  const { session, chapters } = await getSession(sessionId);
  const entries = journalLoad().filter((e) => e.session_id === sessionId).sort((a, b) => a.baseline - b.baseline || String(a.created_at).localeCompare(String(b.created_at)));
  const groups = [];
  const firstBase = entries.length ? Math.min(entries[0].baseline, chapters.length) : chapters.length;
  // chapters not covered by the journal (older sessions): one turn per chapter
  for (let i = 0; i < firstBase; i++) {
    const ch = chapters[i];
    groups.push({ turn_id: ch.id, user: !entries.length && chapters.length === 1 && session.last_prompt ? session.last_prompt : "（早期消息，原文未记录）", created_at: ch.created_at, chs: [ch], attachments: [] });
  }
  if (!entries.length && !chapters.length && session.last_prompt) groups.push({ turn_id: `${sessionId}:prompt`, user: session.last_prompt, created_at: session.created_at, chs: [], attachments: session.last_attachments || [] });
  entries.forEach((e, k) => {
    const end = k + 1 < entries.length ? entries[k + 1].baseline : chapters.length;
    groups.push({ turn_id: e.run_id, user: e.prompt, created_at: e.created_at, chs: chapters.slice(Math.max(e.baseline, firstBase), Math.max(end, firstBase)), attachments: e.attachments || [] });
  });
  // App-side (computer) entries arrive as chapters titled 「电脑」 (user) / 「电脑续聊」 (bot reply):
  // split them into their own turns, drop 「运行中」 placeholders.
  const split = [];
  let cur = null;
  for (const g of groups) {
    // journal-less chapters after an App message belong to that App turn
    if (!(cur && cur.app && g.user === EARLY)) { cur = { ...g, chs: [] }; split.push(cur); }
    for (const ch of g.chs) {
      if (ch.title === APP_USER) {
        const body = (await pagesOf(sessionId, ch)).join("");
        cur = { turn_id: ch.id, user: `「${APP_USER}」${body}`, created_at: ch.created_at, chs: [], attachments: [], app: true }; split.push(cur);
      } else if (ch.title !== "运行中") cur.chs.push(ch);
    }
  }
  groups.length = 0; groups.push(...split.filter((g) => g.app || g.chs.length || g.user !== EARLY));
  const turns = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]; const last = gi === groups.length - 1;
    const failed = !g.app && !g.chs.length && (!last || ["error", "cancelled"].includes(session.status));
    const appDone = g.app && !g.chs.length && (!last || !RUNNING.includes(session.status));
    const running = !g.chs.length && !failed && !appDone;
    const status = running ? "running" : failed ? "failed" : "completed";
    const lastCh = g.chs[g.chs.length - 1];
    const doneAt = lastCh ? lastCh.created_at : (failed ? session.updated_at : appDone ? g.created_at : undefined);
    const steps = [{ id: `${g.turn_id}:started`, kind: "status", title: "Grok Bot 已开始处理", detail: "", status: running ? "running" : status, created_at: g.created_at }];
    const texts = [];
    for (const ch of g.chs) texts.push({ ch, text: labelText(ch, (await pagesOf(sessionId, ch)).join("")) });
    for (const t of texts.slice(0, -1)) steps.push({ id: `${t.ch.id}:text`, kind: "assistant_text", title: cover(t.ch), detail: t.text, status: "completed", created_at: t.ch.created_at });
    if (failed) steps.push({ id: `${g.turn_id}:failed`, kind: "status", title: session.status === "cancelled" ? "Grok Bot 已中断" : "Grok Bot 未回复", detail: "", status: "failed", created_at: doneAt || now() });
    const progress = { status, started_at: g.created_at, ...(doneAt ? { completed_at: doneAt } : {}), steps };
    const msgs = [
      { id: `${g.turn_id}:user`, role: "user", type: "text", content: g.user, status: "completed", created_at: g.created_at, updated_at: g.created_at, ...(g.attachments.length ? { metadata: { attachments: g.attachments } } : {}) },
      { id: `${g.turn_id}:progress`, role: "assistant", type: "progress", content: running ? "" : fmtDur(Date.parse(doneAt || now()) - Date.parse(g.created_at)), status, created_at: g.created_at, updated_at: doneAt || g.created_at, progress },
    ];
    if (texts.length) {
      const f = texts[texts.length - 1];
      msgs.push({ id: f.ch.id, role: "assistant", type: "text", content: f.text, status: "completed", created_at: f.ch.created_at, updated_at: f.ch.created_at, metadata: { model: botNameOf(sessionId), cover: cover(f.ch), page_count: (await pagesOf(sessionId, f.ch)).length } });
    }
    turns.push({ turn_id: g.turn_id, order_key: g.created_at, revision: REV_BASE + 1 + 2 * g.chs.length + (failed ? 1 : 0) + (appDone ? 1 : 0), messages: msgs });
  }
  return turns;
}

const core = {
  probe: () => ({
    plugin_id: PLUGIN_ID, available: true, native_visible_input: true, native_visible_output: true,
    can_attach_session: true, can_start_session_with_message: true, can_list_sessions: true,
    can_read_history: true, can_interrupt: true, can_approval: true, can_open_draft: true, can_forward_sync: true,
    can_reverse_sync: true, can_plugin_wide_watch: true, can_wait_run: true, can_read_status: true,
    can_control_session: true, integration_mode: "protocol-native",
    visibility_surface: "grokbot-session-bridge", unavailable_reason: "",
  }),
  async discover() {
    let ok = false, detail = "";
    try { ok = (await http("GET", "/health")).ok === true; } catch (e) { detail = e.message; }
    return { plugin_id: PLUGIN_ID, surface: "grokbot-session-bridge", endpoint: BRIDGE, process_id: 0, session_hints: {}, verified: ok, detail };
  },
  async listSessions() {
    const { sessions } = await http("GET", "/v1/sessions");
    return sessions.map((s) => { const b = sessionBot(s); sessionBotName.set(s.id, b.name); return {
      plugin_id: PLUGIN_ID, native_session_id: s.id, native_thread_id: s.id, surface: "grokbot-session-bridge",
      endpoint: BRIDGE, cwd: cwdForBot(b), title: sessionTitle(s), prism_conversation_id: "",
      active: ["running", "awaiting_reply"].includes(s.status), visible: true, last_activity_at: s.updated_at || s.created_at || now(),
      metadata: { status: ["running", "awaiting_reply"].includes(s.status) ? "running" : "idle", model: b.name, bot_id: b.agent_id || b.id, sort_at: String(Date.parse(s.updated_at || s.created_at || now()) || Date.now()) },
    }; });
  },
  async attachSession(p) {
    const id = p.native_session_id || p.native_thread_id;
    const { session } = await getSession(id); // 404 -> not_found
    return nativeSession(id, cwdForBot(sessionBot(session)));
  },
  async startSessionWithMessage(p) {
    const m = p.message || {};
    const bot = pickBot(p.bot_id, p.cwd);
    const r = await submit(String(m.text || "").trim(), null, m.prism_message_id, m.attachments, bot);
    return {
      session: nativeSession(r.session.id, cwdForBot(bot)), receipt: r.receipt,
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
  draftControls(d, draftId) {
    const b = botById(draftBots.get(draftId)) || defaultBot();
    return { text: (d && d.text) || "", supported_actions: ["text.set", "text.append", "text.clear", "model.switch"],
      current_model: botOption(b), model_options: botOptions(), actions: [{ id: "model.switch", available: true }] };
  },
  async openDraft(p) {
    const id = p.draft_id; if (!id) throw new AdapterError("invalid_request", "draft_id required");
    let d; try { d = (await http("GET", `/v1/drafts/${encodeURIComponent(id)}`)).draft; } catch (e) { if (e.code !== "not_found") throw e; d = (await http("PUT", `/v1/drafts/${encodeURIComponent(id)}`, { text: "" })).draft; }
    if (!draftBots.has(id)) draftBots.set(id, pickBot(null, p.cwd).id);
    return { draft_id: id, cwd: p.cwd || "", controls: this.draftControls(d, id), draft_fingerprint: `${id}:${d.updated_at}` };
  },
  async controlDraft(p) {
    const id = p.draft_id; const action = String(p.action || "").toLowerCase().replace(/_/g, ".");
    const t = p.target; const val = typeof t === "string" ? t : (t && (t.text ?? t.value)) ?? p.name ?? "";
    const path = `/v1/drafts/${encodeURIComponent(id)}`;
    let d;
    if (action === "text.set") d = (await http("PUT", path, { text: String(val) })).draft;
    else if (action === "text.append") { let cur = ""; try { cur = (await http("GET", path)).draft.text || ""; } catch {} d = (await http("PUT", path, { text: cur + String(val) })).draft; }
    else if (action === "text.clear" || action === "draft.discard") { await http("DELETE", path); d = null; }
    else if (action === "model.switch") {
      const want = (t && typeof t === "object" && (t.option_id || t.id)) || (typeof t === "string" ? t : "") || p.name || "";
      const b = botById(want) || botByName(want);
      if (!b) throw new AdapterError("invalid_request", `unknown bot ${want}`);
      draftBots.set(id, b.id);
      try { d = (await http("GET", path)).draft; } catch { d = null; }
    }
    else throw new AdapterError("not_supported", `draft action ${p.action} not supported`);
    return { draft_id: id, cwd: "", controls: this.draftControls(d, id) };
  },
  async startDraftWithMessage(p) {
    const id = p.draft_id; let draft = "";
    try { draft = (await http("GET", `/v1/drafts/${encodeURIComponent(id)}`)).draft.text || ""; } catch {}
    const m = p.message || {};
    const text = [draft.trim(), String(m.text || "").trim()].filter(Boolean).join("\n");
    const r = await this.startSessionWithMessage({ ...p, bot_id: draftBots.get(id), message: { ...m, text } });
    draftBots.delete(id);
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
    return { status, model: botOption(sessionBot(session)),
      preview: chapters.length ? cover(chapters[chapters.length - 1]) : "", interruptible: status === "running", approval_blocked: blocked,
      primary_action: blocked ? "approval" : status === "running" ? "interrupt" : "send",
      turn_id: p.run_id || latestRun.get(session.id) || "", started_at: session.created_at, completed_at: done ? session.updated_at : undefined };
  },
  async historyTurns(id, limit) {
    const turns = await buildTurns(id);
    return limit > 0 ? turns.slice(-limit) : turns;
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
      plugin_id: PLUGIN_ID, conversation_id: id, title: sessionTitle(session),
      desktop_foreground: false, detail_stale: false, updated_at: Date.now(), status, primary_action: st.primary_action, can_queue: false,
      current_model: botOption(sessionBot(session)), current_reasoning: null, current_permission: null,
      model_options: botOptions(), reasoning_options: [], permission_options: [], interactive_controls: [], composer: null, queue: null,
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
  // controlSession: Panel's chip calls model.switch on existing conversations. Conversations are bound to
  // one bot, so: same bot / controls.describe -> ok; another bot -> ok:false with a friendly message and
  // the unchanged detail (never an adapter error, which would make the conversation "unavailable").
  async controlSession(p) {
    const action = String(p.action || "").toLowerCase().replace(/_/g, ".");
    const details = await this.readDetail({ session: p.session });
    const cur = details.current_model;
    const base = { action, thread_id: sid(p.session), details, details_confirmed: true };
    if (action === "controls.describe") return { ok: true, ...base, message: "" };
    // Panel/glasses remote selection of an existing conversation (conversation.select / resume / open / attach):
    // bridge sessions need no native foregrounding, so any existing session is selectable in any state.
    if (/^(conversation|session|thread)\.(select|resume|open|attach|focus|activate)$/.test(action) || /^(select|resume|open|attach)$/.test(action))
      return { ok: true, ...base, message: "" };
    if (action === "model.switch") {
      const t = p.target; const want = (t && typeof t === "object" && (t.option_id || t.id)) || (typeof t === "string" ? t : "") || p.name || "";
      const b = botById(want) || botByName(want);
      if (b && b.id === cur.id) return { ok: true, ...base, message: `当前已是 ${cur.label}` };
      return { ok: false, ...base, message: `本会话已绑定「${cur.label}」。要和「${b ? b.name : want}」对话，请新建会话并在模型处选择它。` };
    }
    return { ok: false, ...base, message: `不支持的操作：${p.action}` };
  },
  async verifyVisibility(p) { return { visible: true, marker: p.marker, evidence: "bridge session exists", checked_at: now(), failure_reason: "" }; },
};

// ---------------- official SDK adapter (@rokid-prism/pluginbridge-plugin-sdk) ----------------
// The SDK converts wire snake_case -> PascalCase on input and recursively snake_cases output.
// Our core logic speaks snake_case, so inputs are converted back with snk(); outputs pass through
// unchanged (toWire is idempotent on snake_case keys).
const sdk = require("@rokid-prism/pluginbridge-plugin-sdk");
const snakeKey = (k) => k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();
function snk(v) {
  if (Array.isArray(v)) return v.map(snk);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [snakeKey(k), snk(x)]));
  return v;
}
// SDK 0.1.1 reports every thrown error as code "adapter_error". To keep our wire codes
// (not_found / invalid_request / bridge_error / not_supported) the adapter tags the message as
// "[code] msg" and the stdout tap in serve() restores {code, message}.
const SDK_DIST = pathMod.dirname(require.resolve("@rokid-prism/pluginbridge-plugin-sdk"));
let SDK_VERSION = "?"; try { SDK_VERSION = JSON.parse(fs.readFileSync(pathMod.join(SDK_DIST, "../../../package.json"), "utf8")).version; } catch {}
const CODE_TAG = /^\[([a-z_]+)\] /;
function restoreErrorCode(msg) {
  if (msg && msg.ok === false && msg.error && msg.error.code === "adapter_error") {
    const m = CODE_TAG.exec(msg.error.message || "");
    if (m) { msg.error.code = m[1]; msg.error.message = msg.error.message.slice(m[0].length); }
  }
  return msg;
}

/** Async queue merging live send-time notifications with the bridge poll loop. */
function mergedStream(sessionId, signal) {
  const q = []; let wake = null; let done = false;
  const push = (ev) => { q.push(ev); if (wake) { wake(); wake = null; } };
  if (!live.has(sessionId)) live.set(sessionId, new Set());
  live.get(sessionId).add(push);
  const cleanup = () => { done = true; live.get(sessionId) && live.get(sessionId).delete(push); if (wake) { wake(); wake = null; } };
  if (signal) signal.addEventListener("abort", cleanup, { once: true });
  (async () => {
    try {
      const baseline = (await getSession(sessionId)).chapters.length;
      for await (const ev of watch(sessionId, signal, baseline, false)) { if (done) break; push(ev); }
    } catch (e) { log("subscribe ended:", e.message); }
    cleanup();
  })();
  return (async function* () {
    try {
      while (true) {
        while (q.length) yield q.shift();
        if (done || (signal && signal.aborted)) return;
        await new Promise((r) => { wake = r; });
      }
    } finally { cleanup(); }
  })();
}

async function* directoryWatch(signal) {
  yield { id: "grokbot-directory-initial-" + randomUUID(), type: "desktop.session.directory.reconciled", status: "completed", summary: "Grok Bot 会话目录已连接。", payload: { source: "grokbot-session-bridge" }, created_at: now() };
  const known = new Map();
  while (!signal || !signal.aborted) {
    try {
      for (const h of await core.listSessions()) {
        const key = `${h.last_activity_at}|${h.metadata.status}|${h.title}`;
        if (known.get(h.native_session_id) === key) continue;
        known.set(h.native_session_id, key);
        const { active, visible, ...hint } = h;
        yield { id: `grokbot-session-index-${h.native_session_id}-${Date.now()}`, type: "desktop.session.index.changed", status: h.metadata.status, summary: "Grok Bot 会话目录项已更新。",
          payload: { session_hint: hint, native_session: { plugin_id: h.plugin_id, native_session_id: h.native_session_id, native_thread_id: h.native_thread_id, surface: h.surface, endpoint: h.endpoint, cwd: h.cwd } }, created_at: now() };
      }
    } catch (e) { log("directory poll failed:", e.message); }
    await sleep(DIR_POLL_MS, signal);
  }
}

class GrokBotAdapter {
  id() { return PLUGIN_ID; }
  probe() { return core.probe(); }
  discover() { return core.discover(); }
  listSessions() { return core.listSessions(); }
  attachSession(req) { return core.attachSession(snk(req)); }
  startSessionWithMessage(req) { return core.startSessionWithMessage(snk(req)); }
  send(session, msg) { return core.send({ session: snk(session), message: snk(msg) }); }
  subscribe(session, signal) { return mergedStream(sid(snk(session)), signal); }
  subscribePlugin(signal) { return directoryWatch(signal); }
  waitForRun(session, runID) { return core.waitForRun({ session: snk(session), run_id: runID }); }
  readStatus(session, runID) { return core.readStatus({ session: snk(session), run_id: runID }); }
  readHistory(session, limit) { return core.readHistory({ session: snk(session), limit }); }
  readDetail(session) { return core.readDetail({ session: snk(session) }); }
  async *readHistoryStream(session, request, signal) {
    const id = sid(snk(session));
    const limit = Number(request.limit || 0) > 0 ? Number(request.limit) : 5;
    const seen = new Map(); // turn_id -> revision already sent
    const all = await buildTurns(id);
    const initial = all.slice(-limit).reverse(); // newest first, then older
    for (const turn of initial) { if (signal && signal.aborted) return; seen.set(turn.turn_id, turn.revision); yield { type: "turn", source: "initial", operation: "append", turn }; }
    if (!request.live) { yield { type: "end" }; return; }
    while (!signal || !signal.aborted) {
      await sleep(POLL_MS, signal);
      if (signal && signal.aborted) return;
      let turns; try { turns = await buildTurns(id); } catch (e) { log("history live poll failed:", e.message); continue; }
      for (const turn of turns) {
        const prev = seen.get(turn.turn_id);
        if (prev !== undefined && turn.revision <= prev) continue;
        seen.set(turn.turn_id, turn.revision);
        yield { type: "turn", source: "live", operation: prev === undefined ? "append" : "replace", turn };
      }
    }
  }
  async interrupt(session, taskID) { await core.interrupt({ session: snk(session), task_id: taskID }); }
  async resolveApproval(req) { await core.resolveApproval(snk(req)); }
  openDraft(req) { return core.openDraft(snk(req)); }
  // Target/Metadata arrive with their raw wire keys preserved by the SDK.
  controlDraft(req) { return core.controlDraft({ draft_id: req.DraftID, plugin_id: req.PluginID, action: req.Action, target: req.Target, name: req.Name, metadata: req.Metadata }); }
  startDraftWithMessage(req) { return core.startDraftWithMessage(snk(req)); }
  readAgentUsage() { return {}; } // neutral AgentUsage: no quota data
  ackEvent() {}
  controlSession(req) { return core.controlSession({ session: snk(req.session), action: req.action, target: req.target, name: req.name, metadata: req.metadata }); }
  verifyVisibility(session, marker) { return core.verifyVisibility({ session: snk(session), marker }); }
  close() {}
}
// Re-throw AdapterError as the SDK's PluginAdapterError so wire error codes (not_found, invalid_request...) are preserved.
for (const m of Object.getOwnPropertyNames(GrokBotAdapter.prototype)) {
  if (m === "constructor" || m === "subscribe" || m === "subscribePlugin" || m === "readHistoryStream") continue;
  const f = GrokBotAdapter.prototype[m];
  GrokBotAdapter.prototype[m] = async function (...a) {
    try { return await f.apply(this, a); }
    catch (e) { if (e && e.code && typeof e.code === "string" && !CODE_TAG.test(e.message || "")) e.message = `[${e.code}] ${e.message}`; throw e; }
  };
}

/** Entry: SDK stdio server, with a thin tap for redacted debug logging and the non-standard adapter.listApprovals helper. */
function serve(input = process.stdin, output = process.stdout) {
  const { PassThrough } = require("stream");
  const readline = require("readline");
  const sdkIn = new PassThrough(), sdkOut = new PassThrough();
  let outBuf = "";
  sdkOut.on("data", (d) => {
    outBuf += d; let i;
    while ((i = outBuf.indexOf("\n")) >= 0) {
      let line = outBuf.slice(0, i); outBuf = outBuf.slice(i + 1); if (!line.trim()) continue;
      try { const o = restoreErrorCode(JSON.parse(line)); line = JSON.stringify(o); dbg("OUT", o); } catch { dbg("OUT", line); }
      output.write(line + "\n");
    }
  });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const t = line.trim(); if (!t) return;
    let req; try { req = JSON.parse(t); } catch { dbg("IN-BADJSON", t); return; }
    dbg("IN", req);
    if (req.method === "adapter.listApprovals") {
      core.listApprovals(req.params || {}).then((payload) => ({ id: req.id, ok: true, payload }), (e) => ({ id: req.id, ok: false, error: { code: e.code || "adapter_error", message: e.message } }))
        .then((o) => sdkOut.write(JSON.stringify(o) + "\n"));
      return;
    }
    sdkIn.write(t + "\n");
  });
  rl.on("close", () => sdkIn.end());
  log(`ready; sdk=@rokid-prism/pluginbridge-plugin-sdk@${SDK_VERSION} bridge=${BRIDGE} pid=${process.pid} protocol_env=${process.env.PRISM_PLUGIN_PROTOCOL_VERSION || ""} debug_log=${DEBUG_LOG || "off"}`);
  log("config sources:", JSON.stringify(Object.fromEntries(CONFIG_KEYS.map((k) => [k, CONFIG_SOURCES[k] || "missing"]))));
  for (const n of CONFIG_NOTES) log("config note:", n);
  dbg("ENV", Object.fromEntries(Object.entries(process.env).filter(([k]) => /^PRISM|^GROKBOT|^SESSION_BRIDGE|^BRIDGE/.test(k)).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[REDACTED]" : v])));
  return sdk.createStdioServer(new GrokBotAdapter(), sdkIn, sdkOut).run().catch((e) => { log("server failed:", e.message); process.exit(2); });
}

process.on("uncaughtException", (e) => { log("uncaught:", e.stack || e.message); });
process.on("unhandledRejection", (e) => { log("unhandledRejection:", (e && e.stack) || String(e)); });
if (require.main === module) serve();
module.exports = { adapter: core, GrokBotAdapter, serve, cover };
