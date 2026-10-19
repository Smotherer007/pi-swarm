import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  decideInbound,
  describeScopes,
  grantedFrom,
  hasScope,
  intersectScopes,
  normalizeScopes,
} from "../src/permissions.ts";
import type { KnownPeer } from "../src/types.ts";
import { makeConfig } from "./helpers.ts";

function knownPeer(overrides: Partial<KnownPeer> = {}): KnownPeer {
  return {
    nodeId: "n_peer",
    name: "other",
    host: "127.0.0.1",
    port: 1234,
    lastSeen: Date.now(),
    autoConnect: false,
    trusted: false,
    banned: false,
    scopes: ["chat"],
    ...overrides,
  };
}

describe("normalizeScopes", () => {
  it("keeps only valid scopes, deduplicated and ordered", () => {
    assert.deepEqual(normalizeScopes(["knowledge:read", "chat", "chat", "nope", 42]), [
      "chat",
      "knowledge:read",
    ]);
  });

  it("returns an empty list for garbage", () => {
    assert.deepEqual(normalizeScopes(undefined), []);
    assert.deepEqual(normalizeScopes("chat"), []);
  });
});

describe("scope helpers", () => {
  it("checks membership and intersections", () => {
    assert.equal(hasScope(["chat", "knowledge:read"], "chat"), true);
    assert.equal(hasScope(["chat"], "knowledge:write"), false);
    assert.deepEqual(intersectScopes(["chat", "knowledge:read"], ["knowledge:read"]), [
      "knowledge:read",
    ]);
    assert.deepEqual(grantedFrom(["chat", "knowledge:write"], ["chat"]), ["chat"]);
    assert.equal(describeScopes([]), "none");
  });
});

describe("decideInbound", () => {
  it("denies a request that asks for nothing", () => {
    const decision = decideInbound({
      config: makeConfig(),
      known: undefined,
      keyVerified: true,
      requested: [],
      activeConnections: 0,
    });
    assert.equal(decision.decision, "deny");
  });

  it("denies a banned peer even when it is trusted", () => {
    const decision = decideInbound({
      config: makeConfig({ inboundPolicy: "open" }),
      known: knownPeer({ banned: true, trusted: true }),
      keyVerified: true,
      requested: ["chat"],
      activeConnections: 0,
    });
    assert.equal(decision.decision, "deny");
    assert.match(decision.reason, /banned/);
  });

  it("denies when the peer limit is reached", () => {
    const decision = decideInbound({
      config: makeConfig({ maxPeers: 2, inboundPolicy: "open" }),
      known: undefined,
      keyVerified: true,
      requested: ["chat"],
      activeConnections: 2,
    });
    assert.equal(decision.decision, "deny");
    assert.match(decision.reason, /peer limit/);
  });

  it("always asks for an unknown peer under known-auto", () => {
    const decision = decideInbound({
      config: makeConfig({ inboundPolicy: "known-auto" }),
      known: undefined,
      keyVerified: true,
      requested: ["chat"],
      activeConnections: 0,
    });
    assert.equal(decision.decision, "pending");
    assert.match(decision.reason, /unknown peer/);
  });

  it("asks for a known but untrusted peer under known-auto", () => {
    const decision = decideInbound({
      config: makeConfig({ inboundPolicy: "known-auto" }),
      known: knownPeer({ trusted: false, autoConnect: false }),
      keyVerified: true,
      requested: ["chat"],
      activeConnections: 0,
    });
    assert.equal(decision.decision, "pending");
    assert.match(decision.reason, /not trusted/);
  });

  it("approves a trusted peer, limited to its stored scopes", () => {
    const decision = decideInbound({
      config: makeConfig({ inboundPolicy: "known-auto" }),
      known: knownPeer({ trusted: true, scopes: ["chat", "knowledge:read"] }),
      keyVerified: true,
      requested: ["chat", "knowledge:read", "knowledge:write"],
      activeConnections: 0,
    });
    assert.equal(decision.decision, "approve");
    assert.deepEqual(decision.scopes, ["chat", "knowledge:read"]);
  });

  it("approves an auto-connect peer under known-auto", () => {
    const decision = decideInbound({
      config: makeConfig({ inboundPolicy: "known-auto" }),
      known: knownPeer({ autoConnect: true }),
      keyVerified: true,
      requested: ["chat"],
      activeConnections: 0,
    });
    assert.equal(decision.decision, "approve");
    assert.deepEqual(decision.scopes, ["chat"]);
  });

  it("does not grant knowledge:write to a trusted peer that was never allowed it", () => {
    const decision = decideInbound({
      config: makeConfig({
        inboundPolicy: "known-auto",
        defaultScopes: ["chat", "knowledge:read", "knowledge:write"],
      }),
      known: knownPeer({ trusted: true, scopes: ["chat"] }),
      keyVerified: true,
      requested: ["knowledge:write"],
      activeConnections: 0,
    });
    assert.equal(decision.decision, "pending");
    assert.match(decision.reason, /no requested scope/);
  });

  it("grants knowledge:write to a trusted peer that was explicitly allowed", () => {
    const decision = decideInbound({
      config: makeConfig({ inboundPolicy: "known-auto" }),
      known: knownPeer({ trusted: true, scopes: ["knowledge:write"] }),
      keyVerified: true,
      requested: ["knowledge:write"],
      activeConnections: 0,
    });
    assert.equal(decision.decision, "approve");
    assert.deepEqual(decision.scopes, ["knowledge:write"]);
  });

  it("honours autoGrantKnowledgeWrite", () => {
    const decision = decideInbound({
      config: makeConfig({
        inboundPolicy: "known-auto",
        autoGrantKnowledgeWrite: true,
        defaultScopes: ["chat", "knowledge:write"],
      }),
      known: knownPeer({ trusted: true, scopes: ["knowledge:write"] }),
      keyVerified: true,
      requested: ["knowledge:write"],
      activeConnections: 0,
    });
    assert.deepEqual(decision.scopes, ["knowledge:write"]);
  });

  it("drops knowledge scopes when sharing is off, and denies if nothing is left", () => {
    const decision = decideInbound({
      config: makeConfig({ inboundPolicy: "open", shareKnowledge: false }),
      known: undefined,
      keyVerified: true,
      requested: ["knowledge:read"],
      activeConnections: 0,
    });
    assert.equal(decision.decision, "deny");
    assert.match(decision.reason, /disabled/);
  });

  it("asks for knowledge scopes only when the peer is not auto-eligible", () => {
    const decision = decideInbound({
      config: makeConfig({ inboundPolicy: "ask", autoGrantKnowledgeWrite: true }),
      known: knownPeer({ trusted: true }),
      keyVerified: true,
      requested: ["knowledge:write"],
      activeConnections: 0,
    });
    assert.equal(decision.decision, "pending");
  });

  it("open approves everyone within the default scopes", () => {
    const decision = decideInbound({
      config: makeConfig({ inboundPolicy: "open", defaultScopes: ["chat", "knowledge:read"] }),
      known: undefined,
      keyVerified: true,
      requested: ["chat", "knowledge:read", "peers:share"],
      activeConnections: 0,
    });
    assert.equal(decision.decision, "approve");
    assert.deepEqual(decision.scopes, ["chat", "knowledge:read"]);
  });
});
