"use strict";
const fs = require("fs");
const path = require("path");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function load(file, fallback) {
  try {
    if (!fs.existsSync(file)) return structuredClone(fallback);
    return { ...structuredClone(fallback), ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    return structuredClone(fallback);
  }
}

function save(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const DEFAULT = {
  // agent_id -> { last_seq, session_id, ingested: {entryId: true}, glasses_nonces: {nonce: true} }
  agents: {},
  // recently ingested entry ids (global cap)
  ingested: {},
};

class RelayState {
  constructor(file) {
    this.file = file;
    this.data = load(file, DEFAULT);
    if (!this.data.agents) this.data.agents = {};
    if (!this.data.ingested) this.data.ingested = {};
  }

  persist() {
    // Cap ingested map
    const ids = Object.keys(this.data.ingested);
    if (ids.length > 2000) {
      const keep = ids.slice(-1500);
      const next = {};
      for (const id of keep) next[id] = true;
      this.data.ingested = next;
    }
    for (const a of Object.values(this.data.agents)) {
      if (a.ingested) {
        const keys = Object.keys(a.ingested);
        if (keys.length > 500) {
          const keep = keys.slice(-400);
          const next = {};
          for (const k of keep) next[k] = true;
          a.ingested = next;
        }
      }
      if (a.glasses_nonces) {
        const keys = Object.keys(a.glasses_nonces);
        if (keys.length > 100) {
          const keep = keys.slice(-80);
          const next = {};
          for (const k of keep) next[k] = true;
          a.glasses_nonces = next;
        }
      }
    }
    save(this.file, this.data);
  }

  agent(agentId) {
    if (!this.data.agents[agentId]) {
      this.data.agents[agentId] = {
        last_seq: 0,
        session_id: null,
        ingested: {},
        glasses_nonces: {},
      };
    }
    return this.data.agents[agentId];
  }

  markIngested(agentId, entryId) {
    if (!entryId) return;
    this.data.ingested[entryId] = true;
    const a = this.agent(agentId);
    a.ingested = a.ingested || {};
    a.ingested[entryId] = true;
  }

  wasIngested(agentId, entryId) {
    if (!entryId) return false;
    if (this.data.ingested[entryId]) return true;
    const a = this.data.agents[agentId];
    return !!(a && a.ingested && a.ingested[entryId]);
  }

  rememberNonce(agentId, nonce) {
    if (!nonce) return;
    const a = this.agent(agentId);
    a.glasses_nonces = a.glasses_nonces || {};
    a.glasses_nonces[nonce] = true;
  }

  isGlassesNonce(agentId, nonce) {
    if (!nonce) return false;
    const a = this.data.agents[agentId];
    return !!(a && a.glasses_nonces && a.glasses_nonces[nonce]);
  }

  bindSession(agentId, sessionId) {
    const a = this.agent(agentId);
    a.session_id = sessionId;
  }

  setLastSeq(agentId, seq) {
    const a = this.agent(agentId);
    if (seq > (a.last_seq || 0)) a.last_seq = seq;
  }
}

module.exports = { RelayState };
