"use strict";
const assert = require("assert");
const { buildPrompt } = require("../relay");
const { entryText, isUserEntry, isBotReplyEntry } = require("../gateway");
const { RelayState } = require("../state");
const fs = require("fs");
const os = require("os");
const path = require("path");

assert.strictEqual(buildPrompt({ prompt: "hi" }), "hi");
const withAtt = buildPrompt({
  prompt: "看图",
  attachments: [{ name: "a.png", mime: "image/png", url: "https://example.com/a.png" }],
});
assert.ok(withAtt.includes("看图"));
assert.ok(withAtt.includes("https://example.com/a.png"));
assert.ok(withAtt.includes("[附件]"));

assert.strictEqual(entryText({ message: { content: "x" } }), "x");
assert.strictEqual(entryText({ content: "y" }), "y");
assert.ok(isUserEntry({ kind: "message", role: "user" }));
assert.ok(isBotReplyEntry({ kind: "send-message" }));
assert.ok(!isBotReplyEntry({ kind: "message", role: "user" }));

const tmp = path.join(os.tmpdir(), `relay-state-test-${process.pid}.json`);
try { fs.unlinkSync(tmp); } catch {}
const st = new RelayState(tmp);
st.markIngested("a1", "e1");
st.rememberNonce("a1", "n1");
st.setLastSeq("a1", 10);
st.persist();
const st2 = new RelayState(tmp);
assert.ok(st2.wasIngested("a1", "e1"));
assert.ok(st2.isGlassesNonce("a1", "n1"));
assert.strictEqual(st2.agent("a1").last_seq, 10);
fs.unlinkSync(tmp);

console.log("unit ok");
