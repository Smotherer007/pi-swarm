import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ProtocolError,
  labelPeerContent,
  parseApproval,
  parseHello,
  parseIntroductions,
  parseKnowledgePush,
  parseMessage,
  sanitizeText,
  shortId,
} from "../src/protocol.ts";

const hello = {
  proto: "pi-swarm/1",
  from: { nodeId: "n_abc", name: "alpha" },
  sessionId: "s_1",
  scopes: ["chat", "knowledge:read"],
  intent: "connect",
  port: 47823,
};

describe("sanitizeText", () => {
  it("strips control characters but keeps newlines and tabs", () => {
    const cleaned = sanitizeText("a\u0000b\u001b[31mc\r\nd\te", 100);
    assert.equal(cleaned, "ab[31mc\nd\te");
  });

  it("trims and truncates with a marker", () => {
    assert.equal(sanitizeText("   hello   ", 100), "hello");
    assert.match(sanitizeText("x".repeat(50), 10), /^x{10}\.\.\.$/);
  });
});

describe("parseHello", () => {
  it("accepts a valid request", () => {
    const parsed = parseHello(hello);
    assert.equal(parsed.from.nodeId, "n_abc");
    assert.equal(parsed.port, 47823);
    assert.deepEqual(parsed.scopes, ["chat", "knowledge:read"]);
  });

  it("rejects a foreign protocol version", () => {
    assert.throws(() => parseHello({ ...hello, proto: "pi-swarm/9" }), ProtocolError);
  });

  it("rejects an empty scope list", () => {
    assert.throws(() => parseHello({ ...hello, scopes: [] }), /at least one valid scope/);
  });

  it("rejects a missing or invalid port", () => {
    assert.throws(() => parseHello({ ...hello, port: 0 }), /port/);
    assert.throws(() => parseHello({ ...hello, port: "47823" }), /port/);
  });

  it("rejects a node id with path characters", () => {
    assert.throws(
      () => parseHello({ ...hello, from: { nodeId: "../../etc/passwd", name: "x" } }),
      /invalid characters/,
    );
  });

  it("rejects a non-object body", () => {
    assert.throws(() => parseHello("hello"), ProtocolError);
    assert.throws(() => parseHello(null), ProtocolError);
  });

  it("labels missing optional fields instead of failing", () => {
    const parsed = parseHello({ ...hello, intent: undefined, message: undefined, sessionId: null });
    assert.equal(parsed.intent, "connect");
    assert.equal(parsed.sessionId, null);
  });
});

describe("parseMessage", () => {
  it("defaults kind to chat and keeps text", () => {
    const message = parseMessage({ text: "hi" });
    assert.equal(message.kind, "chat");
    assert.equal(message.text, "hi");
  });

  it("rejects an empty text", () => {
    assert.throws(() => parseMessage({ text: "   " }), /must not be empty/);
  });

  it("rejects an unknown kind by falling back to chat", () => {
    assert.equal(parseMessage({ text: "x", kind: "shell" }).kind, "chat");
  });
});

describe("parseKnowledgePush", () => {
  const entry = {
    id: "n_a/k",
    sessionId: "s_1",
    key: "k",
    kind: "fact",
    text: "the answer",
    author: { nodeId: "n_a", name: "a" },
    ts: 1234,
  };

  it("accepts a valid entry", () => {
    assert.equal(parseKnowledgePush({ entries: [entry] }).length, 1);
  });

  it("rejects an invalid kind", () => {
    assert.throws(() => parseKnowledgePush({ entries: [{ ...entry, kind: "rumour" }] }), /kind/);
  });

  it("rejects a missing timestamp", () => {
    assert.throws(() => parseKnowledgePush({ entries: [{ ...entry, ts: 0 }] }), /timestamp/);
  });

  it("rejects a non-array payload", () => {
    assert.throws(() => parseKnowledgePush({ entries: entry }), /array/);
  });
});

describe("parseApproval and parseIntroductions", () => {
  it("requires a request id and the collecting node", () => {
    assert.deepEqual(parseApproval({ requestId: "r_1", nodeId: "n_a" }), {
      requestId: "r_1",
      nodeId: "n_a",
    });
    assert.throws(() => parseApproval({}), /requestId/);
    assert.throws(() => parseApproval({ requestId: "r_1" }), /nodeId/);
  });

  it("validates introduced peers", () => {
    const peers = parseIntroductions({
      peers: [
        { nodeId: "n_x", name: "x", host: "10.0.0.5", port: 47823 },
        { nodeId: "n_y", host: "10.0.0.6", port: 47824 },
      ],
    });
    assert.equal(peers.length, 2);
    assert.equal(peers[1].name, "unknown");
    assert.throws(() => parseIntroductions({ peers: [{ nodeId: "n_z", port: 70000 }] }), /port/);
  });
});

describe("labels", () => {
  it("marks peer content with a stable short id", () => {
    assert.equal(shortId("n_abcdefghijklm"), "n_abcdefgh");
    assert.equal(labelPeerContent("alpha", "n_abcdefghijklm"), "[peer n_abcdefgh alpha]");
  });
});
