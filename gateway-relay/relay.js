#!/usr/bin/env node
"use strict";
/**
 * Local gateway relay.
 * - Long-polls session-bridge /v1/gateway/claim
 * - sendPrompt via local Grok Bot gateway (127.0.0.1:1340)
 * - Polls transcript; POSTs bot replies to /v1/ingest (or signed reply_url)
 * - Also syncs computer-side bot replies → glasses (feature 6)
 *
 * Secrets: gateway token from gateway.json; BRIDGE_TOKEN from env or ~/.secrets/leqi-bridge-token.
 * Never log tokens or reply_url.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const {
  loadGatewayConfig,
  listAgents,
  getTranscriptTail,
  sendPrompt,
  findAgent,
  entryText,
  isUserEntry,
  isBotReplyEntry,
} = require("./gateway");
const { RelayState } = require("./state");

const DEFAULT_BOT =
  process.env.DEFAULT_BOT_ID || "";
const WORKER_ID =
  process.env.RELAY_WORKER_ID ||
  `relay-${os.hostname().slice(0, 24)}-${process.pid}`;
const BRIDGE_URL = (
  process.env.SESSION_BRIDGE_URL ||
  readSecretFile(path.join(os.homedir(), ".secrets/leqi-bridge-url")) ||
  ""
).replace(/\/$/, "");
const BRIDGE_TOKEN =
  process.env.BRIDGE_TOKEN ||
  readSecretFile(path.join(os.homedir(), ".secrets/leqi-bridge-token")) ||
  "";
const STATE_FILE =
  process.env.RELAY_STATE_FILE ||
  path.join(os.homedir(), ".prism/leqi-gateway-relay-state.json");
const CLAIM_WAIT_MS = Number(process.env.CLAIM_WAIT_MS || 15000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1500);
const REPLY_TIMEOUT_MS = Number(process.env.REPLY_TIMEOUT_MS || 12 * 60 * 1000);
const QUIET_MS = Number(process.env.REPLY_QUIET_MS || 4000);
const SYNC_INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS || 5000);
const PROGRESS_AFTER_MS = Number(process.env.PROGRESS_AFTER_MS || 8000);

function readSecretFile(p) {
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

function log(...args) {
  const ts = new Date().toISOString();
  console.log(`[relay ${ts}]`, ...args);
}

function redactUrl(u) {
  if (!u) return "";
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}?…`;
  } catch {
    return "[url]";
  }
}

async function bridgeFetch(pathname, { method = "GET", body, waitMs } = {}) {
  if (!BRIDGE_TOKEN) throw new Error("BRIDGE_TOKEN not set");
  const url = new URL(BRIDGE_URL + pathname);
  if (waitMs) url.searchParams.set("wait_ms", String(waitMs));
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${BRIDGE_TOKEN}`,
      "Content-Type": "application/json",
    },
  };
  if (body != null) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  if (!resp.ok) {
    const err = new Error(
      `bridge ${method} ${pathname} HTTP ${resp.status}: ${json.error || text.slice(0, 200)}`
    );
    err.status = resp.status;
    err.body = json;
    throw err;
  }
  return json;
}

async function ingest({ session_id, reply_url, title, summary, body }) {
  const payload = {
    session_id,
    title: title || "回复",
    summary: summary || String(body || "").slice(0, 120),
    body: String(body ?? ""),
  };
  // Prefer signed reply_url (no need to send token again over the wire for auth)
  if (reply_url) {
    const resp = await fetch(reply_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`ingest via reply_url HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    return { ok: true, via: "reply_url" };
  }
  const r = await bridgeFetch("/v1/ingest", { method: "POST", body: payload });
  return { ok: true, via: "ingest", chapter_id: r.chapter && r.chapter.id };
}

function buildPrompt(job) {
  let prompt = String(job.prompt || "").trim();
  const atts = Array.isArray(job.attachments) ? job.attachments : [];
  if (atts.length) {
    const lines = atts.map((a, i) => {
      const name = a.name || `file${i + 1}`;
      const mime = a.mime || a.mime_type || "";
      return `- ${name}${mime ? ` (${mime})` : ""}: ${a.url}`;
    });
    prompt += `\n\n[附件]\n${lines.join("\n")}`;
  }
  return prompt;
}

async function maxSeq(cfg, agentId) {
  const t = await getTranscriptTail(cfg, { id: agentId, limit: 5 });
  const ents = t.entries || [];
  let m = 0;
  for (const e of ents) if (e.seq > m) m = e.seq;
  return m;
}

async function waitForReply(cfg, state, {
  agentId,
  clientNonce,
  afterSeq,
  session_id,
  reply_url,
  job_id,
  onProgress,
}) {
  const started = Date.now();
  let sawUser = false;
  let lastBotAt = 0;
  let collected = [];
  let collectedIds = new Set();
  let progressSent = false;
  let lastHeartbeat = 0;

  while (Date.now() - started < REPLY_TIMEOUT_MS) {
    // heartbeat
    if (job_id && Date.now() - lastHeartbeat > 15000) {
      try {
        await bridgeFetch("/v1/gateway/heartbeat", {
          method: "POST",
          body: { job_id, worker_id: WORKER_ID },
        });
      } catch (e) {
        log("heartbeat failed:", e.message);
      }
      lastHeartbeat = Date.now();
    }

    if (!progressSent && Date.now() - started > PROGRESS_AFTER_MS && onProgress) {
      progressSent = true;
      try {
        await onProgress();
      } catch (e) {
        log("progress ingest failed:", e.message);
      }
    }

    let tail;
    try {
      tail = await getTranscriptTail(cfg, { id: agentId, limit: 40 });
    } catch (e) {
      // Transient gateway timeouts must not kill the whole glasses turn.
      log("transcript poll failed:", e.message);
      await sleep(Math.min(POLL_INTERVAL_MS * 2, 5000));
      continue;
    }
    const ents = (tail.entries || []).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));

    let appTookOver = false;
    for (const e of ents) {
      if ((e.seq || 0) <= afterSeq) continue;
      if (isUserEntry(e) && e.clientNonce === clientNonce) {
        sawUser = true;
        state.rememberNonce(agentId, clientNonce);
        state.markIngested(agentId, e.id); // don't re-sync as computer chat
        if (e.seq) state.setLastSeq(agentId, e.seq);
        continue;
      }
      if (!sawUser) continue;
      // App/computer typed while we wait — stop owning this turn; sync will push App lines.
      if (isUserEntry(e) && e.clientNonce !== clientNonce) {
        appTookOver = true;
        break;
      }
      if (isBotReplyEntry(e)) {
        const text = entryText(e).trim();
        if (!text) continue;
        if (collectedIds.has(e.id)) continue;
        collectedIds.add(e.id);
        collected.push(text);
        state.markIngested(agentId, e.id);
        lastBotAt = Date.now();
      }
      if (e.seq) state.setLastSeq(agentId, e.seq);
    }

    if (appTookOver) {
      if (collected.length) {
        return { text: collected.join("\n\n"), entries: [...collectedIds], app_took_over: true };
      }
      return {
        text: "（电脑端已继续说话，眼镜这轮不等回复了；电脑上的话会标成「电脑」同步过来。）",
        entries: [],
        app_took_over: true,
        empty: false,
      };
    }

    // Check agent running state
    let running = true;
    try {
      const agents = await listAgents(cfg);
      const ag = findAgent(agents, agentId);
      if (ag) {
        running = !!(ag.isRunningTurn || ag.isComposingMessage);
      }
    } catch (e) {
      log("listAgents failed:", e.message);
    }

    if (collected.length && !running && Date.now() - lastBotAt >= QUIET_MS) {
      return { text: collected.join("\n\n"), entries: [...collectedIds] };
    }
    // Also accept if we have text, saw user, quiet even if running flag sticky
    if (
      collected.length &&
      sawUser &&
      lastBotAt &&
      Date.now() - lastBotAt >= QUIET_MS * 2 &&
      Date.now() - started > 20000
    ) {
      return { text: collected.join("\n\n"), entries: [...collectedIds] };
    }

    await sleep(POLL_INTERVAL_MS);
  }

  if (collected.length) {
    return { text: collected.join("\n\n"), entries: [...collectedIds], timed_out: true };
  }
  return {
    text: "（眼镜网关：等待 bot 回复超时，请到电脑端该 bot 聊天窗口查看。）",
    entries: [],
    timed_out: true,
    empty: true,
  };
}

async function processJob(cfg, state, job) {
  const agentId = job.target_bot_id || DEFAULT_BOT;
  const session_id = job.session_id;
  const reply_url = job.reply_url || "";
  log(
    `job ${job.id} → agent ${agentId.slice(0, 8)}… sess ${session_id} prompt_len=${(job.prompt || "").length}`
  );

  state.bindSession(agentId, session_id);
  const beforeSeq = await maxSeq(cfg, agentId);
  state.setLastSeq(agentId, beforeSeq);

  const prompt = buildPrompt(job);
  const sent = await sendPrompt(cfg, {
    agentId,
    prompt,
    clientNonce: crypto.randomUUID(),
  });
  const clientNonce = sent.clientNonce;
  state.rememberNonce(agentId, clientNonce);
  log(`sendPrompt accepted nonce=${clientNonce.slice(0, 8)}… afterSeq=${beforeSeq}`);

  const result = await waitForReply(cfg, state, {
    agentId,
    clientNonce,
    afterSeq: beforeSeq,
    session_id,
    reply_url,
    job_id: job.id,
    onProgress: async () => {
      await ingest({
        session_id,
        reply_url,
        title: "运行中",
        summary: "运行中…",
        body: "运行中…",
      });
      log("progress ingested");
    },
  });

  await ingest({
    session_id,
    reply_url,
    title: result.timed_out && result.empty ? "超时" : "回复",
    summary: result.text.slice(0, 120),
    body: result.text,
  });
  log(
    `ingested reply chars=${result.text.length} timed_out=${!!result.timed_out} via=${redactUrl(reply_url) || "token"}`
  );

  try {
    await bridgeFetch("/v1/gateway/complete", {
      method: "POST",
      body: {
        job_id: job.id,
        status: result.empty ? "failed" : "done",
        error: result.empty ? "timeout_no_reply" : undefined,
      },
    });
  } catch (e) {
    log("complete failed:", e.message);
  }

  state.persist();
  return result;
}

/**
 * Feature 6: computer → glasses
 * For each binding, pull new transcript entries after last_seq.
 * - Glasses-originated user entries (our clientNonce) are marked ingested and skipped.
 * - Other user entries (computer App) → ingest title 「电脑」.
 * - Bot replies outside glasses turns → ingest title 「电脑续聊」.
 * Dedup by entry.id. Glasses-turn bot replies are owned by processJob.
 */
async function syncComputerToGlasses(cfg, state) {
  let bindings;
  try {
    const r = await bridgeFetch("/v1/gateway/bindings");
    bindings = r.bindings || [];
  } catch (e) {
    log("bindings fetch failed:", e.message);
    return;
  }
  if (!bindings.length) return;

  for (const b of bindings) {
    const agentId = b.agent_id;
    const session_id = b.session_id;
    if (!agentId || !session_id) continue;
    state.bindSession(agentId, session_id);
    const st = state.agent(agentId);
    let afterSeq = st.last_seq || 0;

    let ents;
    try {
      const tail = await getTranscriptTail(cfg, { id: agentId, limit: 30 });
      ents = (tail.entries || []).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
    } catch (e) {
      log(`sync transcript ${agentId.slice(0, 8)}:`, e.message);
      continue;
    }

    // Track whether we are inside a glasses-originated turn
    let inGlassesTurn = false;
    const batch = [];

    for (const e of ents) {
      if ((e.seq || 0) <= afterSeq) {
        // still need to update glasses-turn tracking for context near the boundary
        if (isUserEntry(e)) {
          inGlassesTurn = state.isGlassesNonce(agentId, e.clientNonce);
        }
        continue;
      }
      if (e.seq) state.setLastSeq(agentId, e.seq);

      if (isUserEntry(e)) {
        inGlassesTurn = state.isGlassesNonce(agentId, e.clientNonce);
        if (inGlassesTurn) {
          // glasses sendPrompt echo — never re-ingest to Panel
          state.markIngested(agentId, e.id);
          continue;
        }
        if (state.wasIngested(agentId, e.id)) continue;
        const text = entryText(e).trim();
        if (!text) {
          state.markIngested(agentId, e.id);
          continue;
        }
        batch.push({ id: e.id, text, title: "电脑", kind: "user" });
        continue;
      }

      if (!isBotReplyEntry(e)) continue;
      if (state.wasIngested(agentId, e.id)) continue;

      // Skip replies that belong to an in-flight glasses turn (claim handler owns those)
      if (inGlassesTurn) {
        continue;
      }

      const text = entryText(e).trim();
      if (!text) {
        state.markIngested(agentId, e.id);
        continue;
      }
      batch.push({ id: e.id, text, title: "电脑续聊", kind: "bot" });
    }

    for (const item of batch) {
      try {
        await ingest({
          session_id,
          reply_url: "", // use token ingest; bindings don't carry reply_url
          title: item.title,
          summary: item.text.slice(0, 120),
          body: item.text,
        });
        state.markIngested(agentId, item.id);
        log(`${item.title} → ${session_id} entry=${item.id} chars=${item.text.length}`);
      } catch (e) {
        log(`${item.title} ingest failed:`, e.message);
      }
    }
  }
  state.persist();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!BRIDGE_TOKEN) {
    console.error("BRIDGE_TOKEN missing (env or ~/.secrets/leqi-bridge-token)");
    process.exit(1);
  }
  const cfg = loadGatewayConfig();
  const state = new RelayState(STATE_FILE);
  log(
    `start worker=${WORKER_ID} bridge=${BRIDGE_URL} gateway=127.0.0.1:${cfg.port} token_len=${cfg.token_len} state=${STATE_FILE}`
  );

  // Smoke: listAgents
  try {
    const agents = await listAgents(cfg);
    log(`gateway ok, agents=${Array.isArray(agents) ? agents.length : "?"}`);
  } catch (e) {
    console.error("gateway unreachable:", e.message);
    process.exit(1);
  }

  let lastSync = 0;
  let busy = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      if (!busy) {
        const claim = await bridgeFetch("/v1/gateway/claim", {
          method: "POST",
          body: { worker_id: WORKER_ID, wait_ms: CLAIM_WAIT_MS },
        });
        if (claim.job) {
          busy = true;
          try {
            await processJob(cfg, state, claim.job);
          } catch (e) {
            log("job error:", e.message);
            try {
              await bridgeFetch("/v1/gateway/complete", {
                method: "POST",
                body: { job_id: claim.job.id, status: "failed", error: e.message },
              });
            } catch {}
            try {
              await ingest({
                session_id: claim.job.session_id,
                reply_url: claim.job.reply_url,
                title: "错误",
                summary: e.message,
                body: `眼镜网关处理失败：${e.message}`,
              });
            } catch {}
          } finally {
            busy = false;
            state.persist();
          }
          continue;
        }
      }

      if (Date.now() - lastSync >= SYNC_INTERVAL_MS) {
        lastSync = Date.now();
        try {
          await syncComputerToGlasses(cfg, state);
        } catch (e) {
          log("sync error:", e.message);
        }
      }

      if (busy) await sleep(POLL_INTERVAL_MS);
      // when claim returned empty without long wait, brief pause
      else await sleep(200);
    } catch (e) {
      if (e.status === 404 && String(e.message || "").includes("/v1/gateway/")) {
        log("bridge missing gateway API (not upgraded yet); retry in 15s");
        await sleep(15000);
      } else {
        log("loop error:", e.message);
        await sleep(3000);
      }
    }
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = {
  buildPrompt,
  processJob,
  syncComputerToGlasses,
  ingest,
  WORKER_ID,
};
