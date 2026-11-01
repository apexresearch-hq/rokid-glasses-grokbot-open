"use strict";
/**
 * Thin client for the local Grok Bot internal gateway (127.0.0.1:1340).
 * Token is read from gateway.json; never logged.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_GATEWAY_FILE =
  process.env.GROK_GATEWAY_FILE ||
  path.join(process.env.HOME || process.env.USERPROFILE || ".", "agent-data/gateway.json");

function loadGatewayConfig(file = DEFAULT_GATEWAY_FILE) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const port = Number(raw.port || 1340);
  const host = "127.0.0.1"; // always loopback; never use 0.0.0.0 for client
  const token = raw.token;
  if (!token) throw new Error("gateway.json missing token");
  return {
    base: `http://${host}:${port}`,
    token,
    port,
    file,
    token_len: String(token).length,
  };
}

async function gwCall(cfg, method, body) {
  const url = `${cfg.base}/api/${method}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (!resp.ok) {
    const err = new Error(
      `gateway ${method} HTTP ${resp.status}: ${json.error || text.slice(0, 200)}`
    );
    err.status = resp.status;
    err.body = json;
    throw err;
  }
  return json;
}

function listAgents(cfg) {
  return gwCall(cfg, "listAgents", {});
}

function getTranscriptTail(cfg, { id, limit = 30, beforeSeq } = {}) {
  const body = { id, limit };
  if (beforeSeq != null) body.beforeSeq = beforeSeq;
  return gwCall(cfg, "getAgentTranscriptTail", body);
}

function sendPrompt(cfg, { agentId, prompt, clientNonce, replyToId, sessionId }) {
  const body = {
    agentId,
    prompt: String(prompt),
    clientNonce: clientNonce || crypto.randomUUID(),
  };
  if (replyToId) body.replyToId = replyToId;
  if (sessionId) body.sessionId = sessionId;
  return gwCall(cfg, "sendPrompt", body).then((r) => ({
    ...r,
    clientNonce: body.clientNonce,
  }));
}

function findAgent(agents, agentId) {
  if (!Array.isArray(agents)) return null;
  return agents.find((a) => a && a.id === agentId) || null;
}

function entryText(entry) {
  if (!entry) return "";
  if (typeof entry.content === "string") return entry.content;
  const msg = entry.message;
  if (msg && typeof msg.content === "string") return msg.content;
  if (typeof entry.text === "string") return entry.text;
  return "";
}

function isUserEntry(entry) {
  if (!entry) return false;
  if (entry.kind === "user-prompt") return true;
  if (entry.kind === "message" && entry.role === "user") return true;
  return false;
}

function isBotReplyEntry(entry) {
  if (!entry) return false;
  if (entry.kind === "send-message") return true;
  if (entry.kind === "message" && entry.role === "assistant") return true;
  return false;
}

module.exports = {
  loadGatewayConfig,
  listAgents,
  getTranscriptTail,
  sendPrompt,
  findAgent,
  entryText,
  isUserEntry,
  isBotReplyEntry,
  gwCall,
};
