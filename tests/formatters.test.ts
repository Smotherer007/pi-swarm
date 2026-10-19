import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  formatAttempts,
  formatInbox,
  formatKnowledge,
  formatPeerList,
  formatRequests,
  formatSendOutcome,
  formatStatus,
} from "../src/formatting/formatters.ts";
import type { IncomingRequest, KnowledgeEntry, SwarmMessage } from "../src/types.ts";
import type { SwarmSnapshot } from "../src/swarm.ts";

const message = (overrides: Partial<SwarmMessage> = {}): SwarmMessage => ({
  id: "m_1",
  sessionId: "s_1",
  from: { nodeId: "n_peer01abcdef", name: "beta", host: "10.0.0.2", port: 47823 },
  text: "the API base url is https://api.example.test",
  kind: "chat",
  ts: Date.parse("2026-01-02T03:04:05Z"),
  incoming: true,
  ...overrides,
});

const request: IncomingRequest = {
  requestId: "r_1",
  from: { nodeId: "n_peer01abcdef", name: "beta", host: "10.0.0.2", port: 47823 },
  requestedScopes: ["chat", "knowledge:read"],
  grantedScopes: [],
  intent: "broadcast",
  message: "help with tiles",
  sessionId: "s_1",
  status: "pending",
  reason: "unknown peer",
  createdAt: Date.parse("2026-01-02T03:04:05Z"),
};

const snapshot: SwarmSnapshot = {
  nodeId: "n_self0123456789",
  name: "pi@lab",
  fingerprint: "abcd 0123 abcd 0123 abcd 0123 abcd 0123",
  instance: "",
  running: false,
  port: null,
  bindHost: "0.0.0.0",
  sessionId: null,
  startedAt: null,
  connections: [],
  discovered: [],
  pending: [],
  known: 0,
  inbox: 0,
  knowledge: 0,
  inboundPolicy: "known-auto",
  autoConnectKnown: false,
  seeds: [],
  invitation: null,
  multicast: false,
  warnings: [],
};

describe("formatStatus", () => {
  it("says plainly that a stopped node starts on the next tool", () => {
    const text = formatStatus(snapshot);
    assert.match(text, /not running/);
    assert.match(text, /next swarm tool starts it/);
    assert.match(text, /policy: known-auto/);
    assert.match(text, /instance: primary/);
  });

  it("names the instance slot when there is one", () => {
    const text = formatStatus({ ...snapshot, instance: "worker" });
    assert.match(text, /instance: worker/);
    assert.doesNotMatch(text, /PI_SWARM_INSTANCE/);
  });

  it("lists connections with both scope directions", () => {
    const text = formatStatus({
      ...snapshot,
      running: true,
      port: 47823,
      sessionId: "s_1",
      connections: [
        {
          nodeId: "n_peer01abcdef",
          name: "beta",
          host: "10.0.0.2",
          port: 47824,
          sessionId: "s_1",
          outToken: "t",
          grantedToMe: ["chat"],
          grantedToPeer: ["knowledge:read"],
          direction: "out",
          since: Date.now(),
          lastSeen: Date.now(),
        },
      ],
      pending: [request],
    });
    assert.match(text, /you may use there: chat/);
    assert.match(text, /it may use here: knowledge:read/);
    assert.match(text, /swarm_requests/);
  });
});

describe("formatAttempts", () => {
  it("explains that nothing was reachable", () => {
    assert.match(formatAttempts([]), /No peer was reachable/);
  });

  it("explains that pending is not connected", () => {
    const text = formatAttempts([
      {
        peer: { nodeId: "n_x", name: "x", host: "10.0.0.3", port: 1 },
        status: "pending",
        scopes: [],
        requestId: "r_9",
        reason: "unknown peer",
      },
    ]);
    assert.match(text, /pending/);
    assert.match(text, /not a connection/);
  });
});

describe("formatRequests", () => {
  it("shows the request id and the exact approve command", () => {
    const text = formatRequests([request]);
    assert.match(text, /r_1/);
    assert.match(text, /asks for: chat, knowledge:read/);
    assert.match(text, /decide with swarm_requests approve/);
  });

  it("says clearly when nothing is waiting", () => {
    assert.match(formatRequests([]), /No connect request is waiting/);
  });
});

describe("formatInbox", () => {
  it("labels peer content and says it is a request from another agent", () => {
    const text = formatInbox([message()], "s_1");
    assert.match(text, /\[peer n_peer01ab beta\]/);
    assert.match(text, /request from another agent/);
  });

  it("marks outgoing messages as from you", () => {
    assert.match(formatInbox([message({ incoming: false })], "s_1"), /you \(chat\)/);
  });
});

describe("formatKnowledge", () => {
  const entry: KnowledgeEntry = {
    id: "n_peer01abcdef/decision",
    sessionId: "s_1",
    key: "decision",
    kind: "decision",
    text: "use the existing sftp module",
    author: { nodeId: "n_peer01abcdef", name: "beta" },
    ts: Date.parse("2026-01-02T03:04:05Z"),
  };

  it("shows kind, key, text and author", () => {
    const text = formatKnowledge([entry], "s_1", "n_self0123456789");
    assert.match(text, /\[decision\] decision: use the existing sftp module/);
    assert.match(text, /beta/);
  });

  it("marks own entries as yours", () => {
    const own = { ...entry, author: { nodeId: "n_self0123456789", name: "pi@lab" } };
    assert.match(formatKnowledge([own], "s_1", "n_self0123456789"), /-- you/);
  });
});

describe("formatPeerList", () => {
  it("suggests what to check when nobody answers", () => {
    const text = formatPeerList([], [], [], []);
    assert.match(text, /No peers found/);
    assert.match(text, /UDP 47823/);
  });

  it("separates reachable from known-but-offline peers", () => {
    const reachable = {
      nodeId: "n_beta",
      name: "beta",
      host: "10.0.0.2",
      port: 47823,
      lastSeen: Date.now(),
      sessionId: "s_1",
      accepting: true,
      via: "multicast" as const,
    };
    const offline = {
      nodeId: "n_gamma",
      name: "gamma",
      host: "10.0.0.3",
      port: 47823,
      lastSeen: Date.parse("2026-01-01T00:00:00Z"),
      autoConnect: true,
      trusted: true,
      banned: false,
      scopes: ["chat" as const],
    };
    const text = formatPeerList([reachable], [offline], [], []);
    assert.match(text, /Reachable now \(1\)/);
    assert.match(text, /Known but not reachable \(1\)/);
    assert.match(text, /auto-connect/);
  });
});

describe("formatSendOutcome", () => {
  it("lists failures with their reason", () => {
    const text = formatSendOutcome({
      delivered: [],
      failed: [{ nodeId: "n_x", name: "x", error: "one-way link" }],
    });
    assert.match(text, /x: one-way link/);
  });

  it("says nothing was sent when there are no connections", () => {
    assert.match(
      formatSendOutcome({ delivered: [], failed: [] }),
      /Nothing was sent/,
    );
  });
});
