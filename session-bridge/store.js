const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

class Store {
  /**
   * @param {string} dataDir
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.sessionsFile = path.join(dataDir, "sessions.json");
    this.chaptersFile = path.join(dataDir, "chapters.json");
    ensureDir(dataDir);
    this.sessions = loadJson(this.sessionsFile, { sessions: [] });
    this.chapters = loadJson(this.chaptersFile, { chapters: [] });
    this.draftsFile = path.join(dataDir, "drafts.json");
    this.drafts = loadJson(this.draftsFile, { drafts: {} });
    this.gatewayFile = path.join(dataDir, "gateway-queue.json");
    this.gateway = loadJson(this.gatewayFile, {
      jobs: [],
      bindings: {}, // agent_id -> { session_id, updated_at, last_prompt }
      last_claim_at: null,
      stats: { claimed: 0, enqueued: 0, completed: 0, fallback: 0 },
    });
  }

  // ---- drafts (keyed by session id or Prism DraftID) ----
  getDraft(key) { return this.drafts.drafts[key] || null; }
  putDraft(key, patch = {}) {
    const cur = this.drafts.drafts[key] || { id: key, text: "", created_at: new Date().toISOString() };
    const d = { ...cur, ...patch, id: key, updated_at: new Date().toISOString() };
    if (d.text != null) d.text = String(d.text).slice(0, 20000);
    this.drafts.drafts[key] = d; saveJson(this.draftsFile, this.drafts); return d;
  }
  deleteDraft(key) { const had = key in this.drafts.drafts; delete this.drafts.drafts[key]; if (had) saveJson(this.draftsFile, this.drafts); return had; }

  // ---- approvals: "待确认：… 回复 OK/NO" in a chapter body ----
  static parseApproval(body) {
    const m = String(body || "").match(/待确认[:：]\s*([\s\S]*?)\s*[，,。；;]?\s*回复\s*(?:\*\*)?\s*OK\s*[\/／或]\s*NO/i);
    return m ? m[1].trim() : null;
  }
  listApprovals(sessionId) { const s = this.getSession(sessionId); return (s && s.approvals || []).filter((a) => a.status === "pending"); }
  resolveApproval(sessionId, decision, approvalId) {
    const s = this.getSession(sessionId); if (!s) return null;
    const list = (s.approvals || []).filter((a) => a.status === "pending" && (!approvalId || a.id === approvalId));
    for (const a of list) { a.status = decision === "OK" ? "approved" : "denied"; a.resolved_at = new Date().toISOString(); }
    this.touchSession(sessionId, {}); return list;
  }

  persist() {
    saveJson(this.sessionsFile, this.sessions);
    saveJson(this.chaptersFile, this.chapters);
  }

  persistGateway() {
    // Cap completed/failed jobs to last 200
    const keep = [];
    let done = 0;
    for (let i = this.gateway.jobs.length - 1; i >= 0; i--) {
      const j = this.gateway.jobs[i];
      if (j.status === "pending" || j.status === "claimed") {
        keep.push(j);
      } else if (done < 200) {
        keep.push(j);
        done++;
      }
    }
    this.gateway.jobs = keep.reverse();
    saveJson(this.gatewayFile, this.gateway);
  }

  listSessions() {
    return this.sessions.sessions
      .slice()
      .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  }

  getSession(id) {
    return this.sessions.sessions.find((s) => s.id === id) || null;
  }

  createSession({ prompt, source }) {
    const now = new Date().toISOString();
    const session = {
      id: newId("sess"),
      title: String(prompt || "").slice(0, 80) || "未命名会话",
      status: "pending",
      source: source || "api",
      created_at: now,
      updated_at: now,
      last_prompt: prompt || "",
    };
    this.sessions.sessions.push(session);
    this.persist();
    return session;
  }

  touchSession(id, patch = {}) {
    const s = this.getSession(id);
    if (!s) return null;
    Object.assign(s, patch, { updated_at: new Date().toISOString() });
    this.persist();
    return s;
  }

  listChapters(sessionId) {
    return this.chapters.chapters
      .filter((c) => c.session_id === sessionId)
      .sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
  }

  getChapter(sessionId, chapterId) {
    return (
      this.chapters.chapters.find(
        (c) => c.session_id === sessionId && c.id === chapterId
      ) || null
    );
  }

  appendChapter({ session_id, title, summary, body, meta }) {
    let session = this.getSession(session_id);
    if (!session) {
      // auto-create: ingest for an unknown session (e.g. bridge restarted / other instance)
      const ts = new Date().toISOString();
      session = { id: String(session_id), title: title || "未命名会话", last_prompt: "", source: "ingest", status: "pending", created_at: ts, updated_at: ts, auto_created: true };
      this.sessions.sessions.push(session);
      this.persist();
    }
    const now = new Date().toISOString();
    const chapter = {
      id: newId("ch"),
      session_id,
      title: title || `第 ${this.listChapters(session_id).length + 1} 章`,
      summary: summary || String(body || "").slice(0, 120),
      body: String(body ?? ""),
      created_at: now,
      ...(meta ? { meta } : {}),
    };
    this.chapters.chapters.push(chapter);
    const ask = Store.parseApproval(chapter.body);
    if (ask) {
      session.approvals = session.approvals || [];
      for (const a of session.approvals) if (a.status === "pending") a.status = "superseded";
      session.approvals.push({ id: newId("appr"), chapter_id: chapter.id, text: ask.slice(0, 500), status: "pending", created_at: now });
      chapter.approval = ask.slice(0, 500);
    }
    this.touchSession(session_id, {
      status: session.status === "cancelled" ? "cancelled" : "ready",
      title: title || session.title,
      latest_chapter_id: chapter.id,
    });
    return chapter;
  }

  // ---- gateway job queue ----
  enqueueGatewayJob({ session_id, prompt, target_bot_id, target_bot_name, attachments, reply_url, source }) {
    const now = new Date().toISOString();
    const job = {
      id: newId("job"),
      session_id,
      prompt: String(prompt || ""),
      target_bot_id: target_bot_id || "",
      target_bot_name: target_bot_name || "",
      attachments: Array.isArray(attachments) ? attachments : [],
      reply_url: reply_url || "",
      source: source || "api",
      status: "pending",
      created_at: now,
      claimed_at: null,
      claimed_by: null,
      heartbeat_at: null,
      completed_at: null,
    };
    this.gateway.jobs.push(job);
    this.gateway.stats.enqueued = (this.gateway.stats.enqueued || 0) + 1;
    if (target_bot_id) {
      this.gateway.bindings[target_bot_id] = {
        session_id,
        target_bot_name: target_bot_name || "",
        updated_at: now,
        last_prompt: String(prompt || "").slice(0, 200),
      };
    }
    this.persistGateway();
    return job;
  }

  claimGatewayJob(workerId, staleClaimMs = 120000) {
    const now = Date.now();
    // Reclaim stale claimed jobs
    for (const j of this.gateway.jobs) {
      if (j.status === "claimed") {
        const hb = Date.parse(j.heartbeat_at || j.claimed_at || 0) || 0;
        if (now - hb > staleClaimMs) {
          j.status = "pending";
          j.claimed_at = null;
          j.claimed_by = null;
          j.heartbeat_at = null;
          j.reclaimed = true;
        }
      }
    }
    const job = this.gateway.jobs.find((j) => j.status === "pending");
    if (!job) {
      this.persistGateway();
      return null;
    }
    const ts = new Date().toISOString();
    job.status = "claimed";
    job.claimed_at = ts;
    job.claimed_by = String(workerId || "relay").slice(0, 80);
    job.heartbeat_at = ts;
    this.gateway.last_claim_at = ts;
    this.gateway.stats.claimed = (this.gateway.stats.claimed || 0) + 1;
    this.persistGateway();
    // Return a copy without mutating caller's view oddly — include reply_url for ingest convenience
    return { ...job };
  }

  heartbeatGatewayJob(jobId, workerId) {
    const job = this.gateway.jobs.find((j) => j.id === jobId);
    if (!job || job.status !== "claimed") return null;
    if (workerId && job.claimed_by && job.claimed_by !== workerId) return null;
    job.heartbeat_at = new Date().toISOString();
    this.persistGateway();
    return { id: job.id, status: job.status, heartbeat_at: job.heartbeat_at };
  }

  completeGatewayJob(jobId, { status = "done", error } = {}) {
    const job = this.gateway.jobs.find((j) => j.id === jobId);
    if (!job) return null;
    job.status = status === "failed" ? "failed" : "done";
    job.completed_at = new Date().toISOString();
    if (error) job.error = String(error).slice(0, 500);
    this.gateway.stats.completed = (this.gateway.stats.completed || 0) + 1;
    this.persistGateway();
    return job;
  }

  pendingGatewayCount() {
    return this.gateway.jobs.filter((j) => j.status === "pending").length;
  }

  claimedGatewayCount() {
    return this.gateway.jobs.filter((j) => j.status === "claimed").length;
  }

  listBindings({ maxAgeMs = 7 * 24 * 3600 * 1000 } = {}) {
    const cutoff = Date.now() - maxAgeMs;
    const out = [];
    for (const [agent_id, b] of Object.entries(this.gateway.bindings || {})) {
      const ts = Date.parse(b.updated_at || 0) || 0;
      if (ts < cutoff) continue;
      out.push({
        agent_id,
        session_id: b.session_id,
        target_bot_name: b.target_bot_name || "",
        updated_at: b.updated_at,
      });
    }
    return out;
  }

  bumpBinding(agent_id, session_id, patch = {}) {
    if (!agent_id || !session_id) return;
    this.gateway.bindings[agent_id] = {
      ...(this.gateway.bindings[agent_id] || {}),
      session_id,
      updated_at: new Date().toISOString(),
      ...patch,
    };
    this.persistGateway();
  }

  markFallback() {
    this.gateway.stats.fallback = (this.gateway.stats.fallback || 0) + 1;
    this.persistGateway();
  }

  gatewayHealth() {
    return {
      pending: this.pendingGatewayCount(),
      claimed: this.claimedGatewayCount(),
      last_claim_at: this.gateway.last_claim_at,
      bindings: Object.keys(this.gateway.bindings || {}).length,
      stats: { ...(this.gateway.stats || {}) },
    };
  }
}

module.exports = { Store, newId };
