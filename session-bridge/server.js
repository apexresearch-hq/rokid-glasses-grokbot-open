#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { Store } = require("./store");
const { getPage } = require("./paginate");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const GROK_WEBHOOK_URL = process.env.GROK_WEBHOOK_URL || "";
const GROK_WEBHOOK_KEY = process.env.GROK_WEBHOOK_KEY || "";
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || ""; // optional auth for /v1/*
const DELIVERY_MODE = String(process.env.DELIVERY_MODE || "gateway").toLowerCase(); // gateway | webhook | both
const GATEWAY_FALLBACK_MS = Number(process.env.GATEWAY_FALLBACK_MS || 60000);
const GATEWAY_STALE_CLAIM_MS = Number(process.env.GATEWAY_STALE_CLAIM_MS || 120000);
const PREVIEW_DIR = path.join(ROOT, "reader-preview");

const store = new Store(DATA_DIR);
const crypto = require("crypto");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const UPLOAD_MAX = Number(process.env.UPLOAD_MAX_BYTES || 10 * 1024 * 1024);
const FILE_TTL_MS = 7 * 24 * 3600 * 1000;
// signing secret: BRIDGE_TOKEN, else a random per-process secret (local dev)
const SIGN_SECRET = () => process.env.BRIDGE_TOKEN || BRIDGE_TOKEN || (global.__leqiSecret ||= crypto.randomBytes(32).toString("hex"));
const ALLOWED_MIME = [/^image\/(jpeg|png|gif|webp|heic|heif|bmp)$/, /^application\/pdf$/, /^text\/(plain|markdown|csv|html)$/, /^application\/json$/,
  /^application\/(msword|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet|presentationml\.presentation)|vnd\.ms-excel|vnd\.ms-powerpoint)$/];
const EXT_MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic", heif: "image/heif", bmp: "image/bmp", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation" };
const sign = (id, exp) => crypto.createHmac("sha256", SIGN_SECRET()).update(`${id}.${exp}`).digest("hex");
function publicBase(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0];
  return `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;
}
function cleanupUploads() {
  try {
    const cutoff = Date.now() - FILE_TTL_MS;
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      const fp = path.join(UPLOAD_DIR, f);
      try { if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp); } catch {}
    }
  } catch {}
}
cleanupUploads();
setInterval(cleanupUploads, 3600 * 1000).unref();

function handleUpload(req, res, u) {
  const rawName = String(u.searchParams.get("name") || req.headers["x-filename"] || "file");
  let name; try { name = decodeURIComponent(rawName); } catch { name = rawName; }
  name = path.basename(name).replace(/[\x00-\x1f"\\]/g, "_").slice(0, 120) || "file";
  const ext = (name.split(".").pop() || "").toLowerCase();
  let mimeType = String(u.searchParams.get("mime") || req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (!mimeType || mimeType === "application/octet-stream") mimeType = EXT_MIME[ext] || mimeType;
  if (!ALLOWED_MIME.some((r) => r.test(mimeType))) { req.resume(); return send(res, 415, { error: `type not allowed: ${mimeType || "unknown"}` }); }
  const len = Number(req.headers["content-length"] || 0);
  if (len > UPLOAD_MAX) { req.resume(); return send(res, 413, { error: "file too large (max 10MB)" }); }
  const id = `f_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
  const bin = path.join(UPLOAD_DIR, id), meta = bin + ".json";
  const out = fs.createWriteStream(bin, { flags: "wx" });
  let size = 0, failed = false;
  const abort = (status, msg) => { if (failed) return; failed = true; out.destroy(); fs.rm(bin, { force: true }, () => {}); req.unpipe(out); req.resume(); send(res, status, { error: msg }); };
  req.on("data", (c) => { size += c.length; if (size > UPLOAD_MAX) abort(413, "file too large (max 10MB)"); });
  req.on("error", () => abort(400, "upload aborted"));
  out.on("error", (e) => abort(500, e.message));
  out.on("finish", () => {
    if (failed) return;
    if (!size) { fs.rm(bin, { force: true }, () => {}); return send(res, 400, { error: "empty body" }); }
    fs.writeFileSync(meta, JSON.stringify({ id, name, mime: mimeType, size, created_at: new Date().toISOString() }));
    const exp = Date.now() + FILE_TTL_MS;
    send(res, 200, { id, name, mime: mimeType, size, url: `${publicBase(req)}/files/${id}?exp=${exp}&sig=${sign(id, exp)}` });
  });
  req.pipe(out);
}

function serveFile(req, res, u, id) {
  const exp = Number(u.searchParams.get("exp") || 0), sig = String(u.searchParams.get("sig") || "");
  const want = sign(id, exp);
  if (!/^f_[a-z0-9_]+$/.test(id) || !exp || exp < Date.now() || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)))
    return send(res, 403, { error: "invalid or expired link" });
  const bin = path.join(UPLOAD_DIR, id);
  let meta; try { meta = JSON.parse(fs.readFileSync(bin + ".json", "utf8")); } catch { return send(res, 404, { error: "file not found" }); }
  res.writeHead(200, { "Content-Type": meta.mime, "Content-Length": meta.size, "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(meta.name)}`, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600" });
  fs.createReadStream(bin).pipe(res);
}

function cleanAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 10).filter((a) => a && a.url && /^https?:\/\//.test(String(a.url)))
    .map((a) => ({ name: String(a.name || "file").slice(0, 120), mime: String(a.mime || a.mime_type || "application/octet-stream"), url: String(a.url), ...(a.size ? { size: Number(a.size) } : {}) }));
}

function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
}

loadDotEnv();

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  const isJson = typeof body !== "string";
  res.writeHead(status, {
    "Content-Type": isJson
      ? "application/json; charset=utf-8"
      : headers["Content-Type"] || "text/plain; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function checkAuth(req) {
  if (!BRIDGE_TOKEN) return true;
  const h = req.headers.authorization || "";
  if (h === `Bearer ${BRIDGE_TOKEN}`) return true;
  return false;
}

// Per-bot webhooks (Option B). Secret file, never logged/returned:
//   BOT_WEBHOOKS_FILE (default /etc/leqi-grokbot-bridge-bots.json) = { "<bot_id>": { "url": "...", "key": "..." }, ... }
// Bots without an entry fall back to the default routine with target_bot_id/name (Option A relay).
const BOT_WEBHOOKS_FILE = () => process.env.BOT_WEBHOOKS_FILE || "/etc/leqi-grokbot-bridge-bots.json";
let botHooks = { mtime: 0, map: {} };
function botWebhook(id) {
  if (!id) return null;
  try {
    const st = fs.statSync(BOT_WEBHOOKS_FILE());
    if (st.mtimeMs !== botHooks.mtime) botHooks = { mtime: st.mtimeMs, map: JSON.parse(fs.readFileSync(BOT_WEBHOOKS_FILE(), "utf8")) || {} };
  } catch { botHooks = { mtime: 0, map: {} }; }
  const h = botHooks.map[id];
  return h && h.url ? h : null;
}
const REPLY_TTL_MS = 7 * 24 * 3600 * 1000;
const replySig = (sid, exp) => sign(`reply:${sid}`, exp);
function replyUrl(req, sid) { const exp = Date.now() + REPLY_TTL_MS; return `${publicBase(req)}/reply/${encodeURIComponent(sid)}?exp=${exp}&sig=${replySig(sid, exp)}`; }

async function forwardWebhook({ prompt, session_id, source, target_bot_id, target_bot_name, ...extra }) {
  const direct = botWebhook(target_bot_id);
  const url = direct ? direct.url : (process.env.GROKBOT_WEBHOOK_URL || process.env.GROK_WEBHOOK_URL || GROK_WEBHOOK_URL);
  const key = direct ? direct.key : (process.env.GROKBOT_WEBHOOK_KEY || process.env.GROK_WEBHOOK_KEY || GROK_WEBHOOK_KEY);
  if (target_bot_id) extra = { ...extra, target_bot_id, target_bot_name: target_bot_name || "", route: direct ? "direct" : "relay" };
  if (!url) {
    return {
      ok: false,
      skipped: true,
      reason: "GROK_WEBHOOK_URL not set — command recorded locally only",
    };
  }
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const payload = {
    prompt,
    session_id,
    source: source || "session-bridge",
    // Common routine/webhook shapes; Bot can ignore unused fields
    text: prompt,
    message: prompt,
    ...extra,
  };
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return {
    ok: resp.ok,
    status: resp.status,
    body: json ?? text,
    ...(target_bot_id ? { route: direct ? "direct" : "relay" } : {}),
  };
}

function mime(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath.replace(/^\/preview\/?/, "") || "index.html";
  if (rel.includes("..")) {
    send(res, 400, { error: "bad path" });
    return;
  }
  const file = path.join(PREVIEW_DIR, rel);
  if (!file.startsWith(PREVIEW_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    send(res, 404, { error: "not found" });
    return;
  }
  send(res, 200, fs.readFileSync(file, "utf8"), { "Content-Type": mime(file) });
}

async function handle(req, res) {
  const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const { pathname } = u;

  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return;
  }

  // Static novel-style preview (no auth)
  if (pathname === "/" || pathname === "/preview" || pathname.startsWith("/preview/")) {
    if (pathname === "/" || pathname === "/preview") {
      serveStatic(req, res, "/preview/index.html");
      return;
    }
    serveStatic(req, res, pathname);
    return;
  }

  if (req.method === "GET" && (pathname === "/upload" || pathname === "/upload/")) {
    send(res, 200, fs.readFileSync(path.join(__dirname, "upload.html"), "utf8"), { "Content-Type": "text/html; charset=utf-8" });
    return;
  }
  const fileMatch = pathname.match(/^\/files\/([^/]+)$/);
  if (req.method === "GET" && fileMatch) { serveFile(req, res, u, decodeURIComponent(fileMatch[1])); return; }

  if (pathname === "/health") {
    const gh = store.gatewayHealth();
    send(res, 200, {
      ok: true,
      delivery_mode: DELIVERY_MODE,
      webhook_configured: Boolean(process.env.GROKBOT_WEBHOOK_URL || process.env.GROK_WEBHOOK_URL || GROK_WEBHOOK_URL),
      sessions: store.listSessions().length,
      gateway: gh,
    });
    return;
  }

  // POST /reply/:session_id?exp=&sig= — per-session signed ingest for teammate routines (no bridge token needed)
  const replyMatch = pathname.match(/^\/reply\/([^/]+)$/);
  if (req.method === "POST" && replyMatch) {
    const sid = decodeURIComponent(replyMatch[1]);
    const exp = Number(u.searchParams.get("exp") || 0), sig = String(u.searchParams.get("sig") || "");
    const good = replySig(sid, exp);
    if (!exp || exp < Date.now() || sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) { send(res, 403, { error: "bad or expired reply signature" }); return; }
    if (!store.getSession(sid)) { send(res, 404, { error: "session not found" }); return; }
    let body; try { body = await readBody(req); } catch { send(res, 400, { error: "bad json" }); return; }
    if (body.body == null && body.text == null && body.content == null) { send(res, 400, { error: "body (full text) required" }); return; }
    const chapter = store.appendChapter({ session_id: sid, title: body.title, summary: body.summary, body: body.body ?? body.text ?? body.content });
    send(res, 200, { ok: true, chapter_id: chapter.id });
    return;
  }

  if (pathname.startsWith("/v1/")) {
    if (!checkAuth(req)) {
      send(res, 401, { error: "unauthorized" });
      return;
    }
  }

  try {
    if (req.method === "POST" && pathname === "/v1/upload") { handleUpload(req, res, u); return; }

    // POST /v1/command
    if (req.method === "POST" && pathname === "/v1/command") {
      const body = await readBody(req);
      const attachments = cleanAttachments(body.attachments);
      const prompt = String(body.prompt || body.text || body.message || "").trim() || (attachments.length ? "请查看附件。" : "");
      if (!prompt) {
        send(res, 400, { error: "prompt required" });
        return;
      }
      let session;
      if (body.session_id) {
        session = store.getSession(body.session_id);
        if (!session) {
          send(res, 404, { error: "session not found" });
          return;
        }
        store.touchSession(session.id, {
          status: "running",
          last_prompt: prompt,
          cancelled_at: null,
        });
      } else {
        session = store.createSession({ prompt, source: body.source });
        const tb = String(body.target_bot_id || "").trim();
        store.touchSession(session.id, { status: "running", ...(tb ? { target_bot_id: tb.slice(0, 80), target_bot_name: String(body.target_bot_name || "").slice(0, 80) } : {}) });
      }
      session = store.getSession(session.id); // target bot is bound at creation; later commands cannot change it
      const rurl = replyUrl(req, session.id);
      const useGateway = DELIVERY_MODE === "gateway" || DELIVERY_MODE === "both";
      const useWebhook = DELIVERY_MODE === "webhook" || DELIVERY_MODE === "both";
      let gateway_job = null;
      let webhook = { ok: false, skipped: true, reason: "delivery_mode=" + DELIVERY_MODE };

      if (useGateway) {
        gateway_job = store.enqueueGatewayJob({
          session_id: session.id,
          prompt,
          target_bot_id: session.target_bot_id || "",
          target_bot_name: session.target_bot_name || "",
          attachments,
          reply_url: rurl,
          source: body.source,
        });
        store.touchSession(session.id, { status: "awaiting_reply", delivery: "gateway", gateway_job_id: gateway_job.id });
        // Fallback to webhook if no claim within GATEWAY_FALLBACK_MS (gateway-only mode)
        if (DELIVERY_MODE === "gateway" && GATEWAY_FALLBACK_MS > 0) {
          const jobId = gateway_job.id;
          const sid = session.id;
          const p = prompt;
          const atts = attachments;
          setTimeout(async () => {
            try {
              const j = store.gateway.jobs.find((x) => x.id === jobId);
              if (!j || j.status !== "pending") return;
              j.status = "fallback_webhook";
              store.markFallback();
              store.persistGateway();
              let wh;
              try {
                wh = await forwardWebhook({
                  prompt: p,
                  session_id: sid,
                  source: "gateway-fallback",
                  reply_url: rurl,
                  ...(session.target_bot_id ? { target_bot_id: session.target_bot_id, target_bot_name: session.target_bot_name } : {}),
                  ...(atts.length ? { attachments: atts } : {}),
                });
              } catch (e) {
                wh = { ok: false, error: String(e.message || e) };
              }
              store.touchSession(sid, {
                status: wh.ok ? "awaiting_reply" : wh.skipped ? "local_only" : "error",
                delivery: "webhook_fallback",
              });
            } catch (e) {
              console.error("[session-bridge] gateway fallback error:", e.message || e);
            }
          }, GATEWAY_FALLBACK_MS).unref();
        }
      }

      if (useWebhook) {
        try {
          webhook = await forwardWebhook({
            prompt,
            session_id: session.id,
            source: body.source,
            reply_url: rurl,
            ...(session.target_bot_id ? { target_bot_id: session.target_bot_id, target_bot_name: session.target_bot_name } : {}),
            ...(attachments.length ? { attachments } : {}),
          });
        } catch (e) {
          webhook = { ok: false, error: String(e.message || e) };
          if (!useGateway) store.touchSession(session.id, { status: "error" });
        }
        if (!useGateway) {
          if (webhook.ok) {
            store.touchSession(session.id, { status: "awaiting_reply", delivery: "webhook" });
          } else if (!webhook.skipped) {
            store.touchSession(session.id, { status: "error" });
          } else {
            store.touchSession(session.id, { status: "local_only" });
          }
        } else if (webhook.ok) {
          store.touchSession(session.id, { delivery: "both" });
        }
      }

      if (attachments.length) store.touchSession(session.id, { last_attachments: attachments.map(({ name, mime }) => ({ name, mime_type: mime, kind: mime.startsWith("image/") ? "image" : "file" })) });
      send(res, 200, {
        session: store.getSession(session.id),
        attachments: attachments.length,
        delivery_mode: DELIVERY_MODE,
        gateway_job: gateway_job ? { id: gateway_job.id, status: gateway_job.status } : null,
        webhook,
      });
      return;
    }

    // POST /v1/gateway/claim  — local relay long-polls this
    if ((req.method === "POST" || req.method === "GET") && pathname === "/v1/gateway/claim") {
      let body = {};
      if (req.method === "POST") {
        try { body = await readBody(req); } catch { body = {}; }
      }
      const workerId = String(body.worker_id || u.searchParams.get("worker_id") || "relay").slice(0, 80);
      const waitMs = Math.min(Number(body.wait_ms || u.searchParams.get("wait_ms") || 0), 25000);
      const staleMs = Number(body.stale_claim_ms || GATEWAY_STALE_CLAIM_MS);
      const tryClaim = () => store.claimGatewayJob(workerId, staleMs);
      let job = tryClaim();
      if (!job && waitMs > 0) {
        const start = Date.now();
        while (!job && Date.now() - start < waitMs) {
          await new Promise((r) => setTimeout(r, 500));
          job = tryClaim();
        }
      }
      send(res, 200, {
        job: job || null,
        pending: store.pendingGatewayCount(),
        claimed: store.claimedGatewayCount(),
        // omit reply_url contents from logs; still return in job for worker
      });
      return;
    }

    // POST /v1/gateway/heartbeat
    if (req.method === "POST" && pathname === "/v1/gateway/heartbeat") {
      const body = await readBody(req);
      const jobId = String(body.job_id || body.id || "").trim();
      if (!jobId) { send(res, 400, { error: "job_id required" }); return; }
      const hb = store.heartbeatGatewayJob(jobId, body.worker_id);
      if (!hb) { send(res, 404, { error: "job not found or not claimed by worker" }); return; }
      send(res, 200, { ok: true, ...hb });
      return;
    }

    // POST /v1/gateway/complete
    if (req.method === "POST" && pathname === "/v1/gateway/complete") {
      const body = await readBody(req);
      const jobId = String(body.job_id || body.id || "").trim();
      if (!jobId) { send(res, 400, { error: "job_id required" }); return; }
      const done = store.completeGatewayJob(jobId, { status: body.status || "done", error: body.error });
      if (!done) { send(res, 404, { error: "job not found" }); return; }
      send(res, 200, { ok: true, job: { id: done.id, status: done.status } });
      return;
    }

    // GET /v1/gateway/bindings — active session↔agent maps for computer→glasses sync
    if (req.method === "GET" && pathname === "/v1/gateway/bindings") {
      send(res, 200, { bindings: store.listBindings() });
      return;
    }

    // POST /v1/ingest
    if (req.method === "POST" && pathname === "/v1/ingest") {
      const body = await readBody(req);
      const session_id = body.session_id;
      if (!session_id) {
        send(res, 400, { error: "session_id required" });
        return;
      }
      if (body.body == null && body.text == null && body.content == null) {
        send(res, 400, { error: "body (full text) required" });
        return;
      }
      const chapter = store.appendChapter({
        session_id,
        title: body.title,
        summary: body.summary,
        body: body.body ?? body.text ?? body.content,
      });
      send(res, 200, {
        chapter,
        session: store.getSession(session_id),
        preview_url: `/preview/?session=${encodeURIComponent(session_id)}&chapter=${encodeURIComponent(chapter.id)}`,
      });
      return;
    }

    // GET /v1/sessions
    if (req.method === "GET" && pathname === "/v1/sessions") {
      const sessions = store.listSessions().map((s) => ({
        ...s,
        chapter_count: store.listChapters(s.id).length,
      }));
      send(res, 200, { sessions });
      return;
    }

    // interrupt / approvals / draft
    const actMatch = pathname.match(/^\/v1\/sessions\/([^/]+)\/(interrupt|approval|approvals|draft)$/);
    const draftMatch = pathname.match(/^\/v1\/drafts\/([^/]+)$/);
    if (actMatch || draftMatch) {
      const id = decodeURIComponent((actMatch || draftMatch)[1]);
      const action = actMatch ? actMatch[2] : "draft";
      if (action === "draft") {
        if (req.method === "GET") { const d = store.getDraft(id); return send(res, d ? 200 : 404, d ? { draft: d } : { error: "no draft" }); }
        if (req.method === "PUT") { const b = await readBody(req); const patch = {}; if ("text" in b) patch.text = b.text; if (b.controls) patch.controls = b.controls; return send(res, 200, { draft: store.putDraft(id, patch) }); }
        if (req.method === "DELETE") return send(res, 200, { deleted: store.deleteDraft(id) });
      }
      const session = store.getSession(id);
      if (!session) return send(res, 404, { error: "session not found" });
      if (action === "approvals" && req.method === "GET") return send(res, 200, { approvals: store.listApprovals(id) });
      if (action === "interrupt" && req.method === "POST") {
        const b = await readBody(req);
        store.touchSession(id, { status: "cancelled", cancelled_at: new Date().toISOString() });
        let webhook; try { webhook = await forwardWebhook({ prompt: "[control] interrupt", session_id: id, source: "prism", control: "interrupt", ...(b.task_id ? { task_id: String(b.task_id) } : {}) }); } catch (e) { webhook = { ok: false, error: String(e.message || e) }; }
        return send(res, 200, { session: store.getSession(id), webhook });
      }
      if (action === "approval" && req.method === "POST") {
        const b = await readBody(req);
        const decision = String(b.decision || "").trim().toUpperCase();
        if (!["OK", "NO"].includes(decision)) return send(res, 400, { error: "decision must be OK or NO" });
        const resolved = store.resolveApproval(id, decision, b.approval_id);
        store.touchSession(id, { status: "running" });
        let webhook; try { webhook = await forwardWebhook({ prompt: decision, session_id: id, source: "prism", approval: decision, ...(b.note ? { note: String(b.note).slice(0, 500) } : {}) }); } catch (e) { webhook = { ok: false, error: String(e.message || e) }; }
        store.touchSession(id, { status: webhook.ok ? "awaiting_reply" : webhook.skipped ? "local_only" : "error" });
        return send(res, 200, { resolved, session: store.getSession(id), webhook });
      }
      return send(res, 405, { error: "method not allowed" });
    }

    // GET /v1/sessions/:id
    const sessMatch = pathname.match(/^\/v1\/sessions\/([^/]+)$/);
    if (req.method === "GET" && sessMatch) {
      const session = store.getSession(decodeURIComponent(sessMatch[1]));
      if (!session) {
        send(res, 404, { error: "session not found" });
        return;
      }
      send(res, 200, {
        session,
        chapters: store.listChapters(session.id).map((c) => ({
          id: c.id,
          title: c.title,
          summary: c.summary,
          created_at: c.created_at,
          approval: c.approval || undefined,
          body_length: (c.body || "").length,
        })),
      });
      return;
    }

    // GET /v1/sessions/:id/chapters/:cid/pages
    const pageMatch = pathname.match(
      /^\/v1\/sessions\/([^/]+)\/chapters\/([^/]+)\/pages$/
    );
    if (req.method === "GET" && pageMatch) {
      const sessionId = decodeURIComponent(pageMatch[1]);
      const chapterId = decodeURIComponent(pageMatch[2]);
      const chapter = store.getChapter(sessionId, chapterId);
      if (!chapter) {
        send(res, 404, { error: "chapter not found" });
        return;
      }
      const page = Number(u.searchParams.get("page") || 1);
      const charsPerPage = Number(u.searchParams.get("charsPerPage") || 180);
      const result = getPage(chapter.body, page, charsPerPage);
      send(res, 200, {
        session_id: sessionId,
        chapter_id: chapterId,
        title: chapter.title,
        charsPerPage,
        ...result,
      });
      return;
    }

    send(res, 404, { error: "not found", path: pathname });
  } catch (e) {
    const status = e.status || 500;
    send(res, status, { error: String(e.message || e) });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    send(res, 500, { error: String(e.message || e) });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[session-bridge] http://${HOST}:${PORT}`);
  console.log(`[session-bridge] preview  http://127.0.0.1:${PORT}/preview/`);
  console.log(`[session-bridge] delivery ${DELIVERY_MODE} (fallback_ms=${GATEWAY_FALLBACK_MS})`);
  console.log(
    `[session-bridge] webhook  ${
      process.env.GROKBOT_WEBHOOK_URL || process.env.GROK_WEBHOOK_URL || GROK_WEBHOOK_URL
        ? "configured"
        : "NOT set"
    }`
  );
  console.log(`[session-bridge] data     ${DATA_DIR}`);
});
