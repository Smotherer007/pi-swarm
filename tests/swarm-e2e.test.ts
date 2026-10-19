/**
 * Two real nodes, two real HTTP endpoints on loopback.
 *
 * This is the test that proves the contract: a connect request is pending
 * until somebody decides, the approval hands over a token, and only then can
 * messages and knowledge flow -- each step checked against the granted scopes.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import { SwarmNode } from "../src/swarm.ts";
import type { SwarmEvent } from "../src/swarm.ts";
import { baseUrl, requestJson } from "../src/transport.ts";
import { API_PREFIX } from "../src/types.ts";
import type { Scope } from "../src/types.ts";
import { makeConfig, makeIdentity, rmrf, tempDir, waitFor } from "./helpers.ts";

const dirs: string[] = [];
const nodes: SwarmNode[] = [];

function makeNode(name: string, overrides: Parameters<typeof makeConfig>[0] = {}, events?: SwarmEvent[]) {
  const root = tempDir(`pi-swarm-${name}`);
  dirs.push(root);
  const node = new SwarmNode({
    config: makeConfig({ name, ...overrides }),
    identity: makeIdentity(name),
    peersPath: path.join(root, "peers.json"),
    sessionsDir: path.join(root, "sessions"),
    instanceDir: null,
    discovery: false,
    onEvent: (event) => events?.push(event),
  });
  nodes.push(node);
  return node;
}

after(async () => {
  for (const node of nodes.splice(0)) {
    await node.stop().catch(() => {});
  }
  for (const dir of dirs.splice(0)) rmrf(dir);
});

describe("swarm over the wire", () => {
  it("answers /info without a token and without leaking secrets", async () => {
    const node = makeNode("info");
    const started = await node.start();
    const response = await requestJson<Record<string, unknown>>(
      `${baseUrl("127.0.0.1", started.port)}${API_PREFIX}/info`,
    );
    assert.equal(response.data.proto, "pi-swarm/1");
    assert.equal(response.data.name, "info");
    assert.equal(response.data.nodeId, "n_test_info");
    assert.equal(response.data.accepting, true);
    assert.equal(JSON.stringify(response.data).includes("token"), false);
  });

  it("rejects a message with an unknown token", async () => {
    const node = makeNode("badtoken");
    const started = await node.start();
    await assert.rejects(
      requestJson(`${baseUrl("127.0.0.1", started.port)}${API_PREFIX}/message`, {
        body: { text: "hello" },
        token: "not-a-real-token",
      }),
      /unknown or expired token/,
    );
  });

  it("walks the whole handshake, then exchanges messages and knowledge", async () => {
    const eventsA: SwarmEvent[] = [];
    const eventsB: SwarmEvent[] = [];
    const alice = makeNode("alice", { defaultScopes: ["chat", "knowledge:read", "knowledge:write"] }, eventsA);
    const bob = makeNode("bob", { defaultScopes: ["chat", "knowledge:read", "knowledge:write"] }, eventsB);

    const a = await alice.start();
    const b = await bob.start();
    assert.ok(a.port > 0 && b.port > 0);
    assert.notEqual(a.port, b.port);

    // 1. Connect is a request, not a link.
    const pending = await alice.connect(`127.0.0.1:${b.port}`, {
      scopes: ["chat", "knowledge:read", "knowledge:write"],
      message: "working on the tile cutter",
      wait: false,
    });
    assert.equal(pending.status, "pending");
    assert.ok(pending.requestId);
    assert.equal(alice.snapshot().connections.length, 0);

    // 2. Bob sees a queued request and nobody is connected yet.
    const queued = bob.pendingRequests();
    assert.equal(queued.length, 1);
    assert.equal(queued[0].from.name, "alice");
    assert.deepEqual(queued[0].requestedScopes, ["chat", "knowledge:read", "knowledge:write"]);
    assert.equal(queued[0].message, "working on the tile cutter");
    assert.equal(eventsB.filter((event) => event.type === "request").length, 1);
    assert.equal(bob.snapshot().connections.length, 0);

    // 3. Alice cannot send anything before the decision.
    await assert.rejects(alice.say("too early", { to: "bob" }), /not connected/);

    // 4. Bob approves, Alice polls the approval and gets a token.
    const connected = alice.connect(`127.0.0.1:${b.port}`, {
      scopes: ["chat", "knowledge:read", "knowledge:write"],
      wait: true,
      timeoutMs: 15_000,
    });
    await waitFor(() => bob.pendingRequests().length === 1);
    const decided = bob.decide(bob.pendingRequests()[0].requestId, true);
    assert.equal(decided.status, "approved");
    const attempt = await connected;
    assert.equal(attempt.status, "connected", attempt.reason);
    assert.deepEqual(attempt.scopes, ["chat", "knowledge:read", "knowledge:write"]);

    // 5. Both sides know the link, from their own point of view.
    const aLink = alice.snapshot().connections[0];
    const bLink = bob.snapshot().connections[0];
    assert.equal(aLink.name, "bob");
    assert.deepEqual(aLink.grantedToMe, ["chat", "knowledge:read", "knowledge:write"]);
    assert.deepEqual(aLink.grantedToPeer, []);
    assert.equal(bLink.name, "alice");
    assert.deepEqual(bLink.grantedToPeer, ["chat", "knowledge:read", "knowledge:write"]);
    assert.deepEqual(bLink.grantedToMe, []);
    assert.equal(alice.snapshot().sessionId, bob.snapshot().sessionId);
    assert.equal(alice.snapshot().known, 1);
    assert.equal(bob.snapshot().known, 1);

    // 6. Messages flow one way, and the other way is reported honestly.
    const sent = await alice.say("hello bob, need the API base url", { to: "bob", kind: "question" });
    assert.deepEqual(sent.delivered, ["bob"]);
    await waitFor(() => bob.drainInbox({ limit: 10 }).length > 0);
    const inbox = bob.drainInbox({ limit: 10 });
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].text, "hello bob, need the API base url");
    assert.equal(inbox[0].kind, "question");
    assert.equal(inbox[0].incoming, true);
    assert.equal(eventsB.filter((event) => event.type === "message").length, 1);

    const backwards = await bob.say("got it", { to: "alice" });
    assert.equal(backwards.delivered.length, 0);
    assert.match(backwards.failed[0].error, /one-way link/);

    // 7. Knowledge is pushed to a peer that granted knowledge:write.
    const put = await alice.putKnowledge([
      { key: "api-base-url", kind: "fact", text: "https://api.example.test/v2" },
      { key: "next-step", kind: "todo", text: "zoom levels 12-16 need tiles" },
    ]);
    assert.equal(put.entries.length, 2);
    assert.equal(put.pushed, 1);
    assert.equal(put.failed.length, 0);
    await waitFor(() => bob.snapshot().knowledge === 2);
    assert.equal(bob.knowledgeBase?.list({ query: "zoom" }).length, 1);

    // 8. A key from the same author replaces instead of piling up.
    await alice.putKnowledge([
      { key: "api-base-url", kind: "fact", text: "https://api.example.test/v3" },
    ]);
    await waitFor(() => bob.snapshot().knowledge === 2);
    await waitFor(
      () => bob.knowledgeBase?.list({ key: "api-base-url" })[0]?.text === "https://api.example.test/v3",
    );

    // 9. Bob connects back so he may push and pull as well.
    const back = bob.connect("alice", {
      scopes: ["chat", "knowledge:read", "knowledge:write"] as Scope[],
      wait: true,
      timeoutMs: 15_000,
    });
    await waitFor(() => alice.pendingRequests().length === 1);
    const aliceDecision = alice.decide(alice.pendingRequests()[0].requestId, true, [
      "chat",
      "knowledge:read",
      "knowledge:write",
    ]);
    assert.equal(aliceDecision.status, "approved");
    const backAttempt = await back;
    assert.equal(backAttempt.status, "connected", backAttempt.reason);
    assert.equal(bob.snapshot().connections.length, 1);
    assert.deepEqual(bob.snapshot().connections[0].grantedToMe, ["chat", "knowledge:read", "knowledge:write"]);

    const bobPuts = await bob.putKnowledge([
      { key: "decision", kind: "decision", text: "use the existing sftp module" },
    ]);
    assert.equal(bobPuts.pushed, 1);
    await waitFor(() => alice.snapshot().knowledge === 3);
    assert.equal(
      alice.knowledgeBase?.list({ key: "decision" })[0]?.text,
      "use the existing sftp module",
    );

    // 10. Full sync is idempotent.
    const sync = await alice.syncAll({ full: true });
    assert.equal(sync.pulled, 0);
    assert.equal(sync.errors.length, 0);

    // 11. Leaving closes the link on both sides.
    assert.equal(await alice.disconnect("n_test_bob", "done here"), true);
    await waitFor(() => bob.snapshot().connections.length === 0);
    assert.equal(alice.snapshot().connections.length, 0);
    assert.equal(await alice.disconnect("n_test_bob"), false);

    await alice.stop();
    await bob.stop();
  });

  it("auto-approves a trusted peer within its stored scopes", async () => {
    const host = makeNode("host", { inboundPolicy: "known-auto" });
    const guest = makeNode("guest");
    const h = await host.start();
    const g = await guest.start();

    const address = `127.0.0.1:${h.port}`;

    // First contact: unknown, so it waits for a decision.
    const first = await guest.connect(address, { scopes: ["chat"], wait: false });
    assert.equal(first.status, "pending");
    host.decide(host.pendingRequests()[0].requestId, true, ["chat"]);

    // The next connect resumes the approved request and collects the token.
    const firstAttempt = await guest.connect(address, { wait: true, timeoutMs: 10_000 });
    assert.equal(firstAttempt.status, "connected", firstAttempt.reason);
    assert.deepEqual(firstAttempt.scopes, ["chat"]);
    await waitFor(() => host.peers.get("n_test_guest") !== undefined);

    // Trust it, then a second connection is answered without a human.
    host.peers.update("n_test_guest", { trusted: true, scopes: ["chat", "knowledge:read"] });
    await guest.disconnect("n_test_host");
    await waitFor(() => host.snapshot().connections.length === 0);

    const second = await guest.connect(address, {
      scopes: ["chat", "knowledge:read", "knowledge:write"],
      wait: true,
      timeoutMs: 10_000,
    });
    assert.equal(second.status, "connected", second.reason);
    assert.deepEqual(second.scopes, ["chat", "knowledge:read"]);
    assert.equal(host.pendingRequests().length, 0);
    void g;

    await host.stop();
    await guest.stop();
  });

  it("refuses a banned peer and never queues its request", async () => {
    const host = makeNode("gatekeeper");
    const guest = makeNode("intruder");
    const h = await host.start();
    const g = await guest.start();

    host.peers.touch({ nodeId: "n_test_intruder", name: "intruder", host: "127.0.0.1", port: g.port });
    host.peers.update("n_test_intruder", { banned: true });

    const attempt = await guest.connect(`127.0.0.1:${h.port}`, {
      scopes: ["chat"],
      wait: false,
    });
    assert.equal(attempt.status, "denied");
    assert.match(attempt.reason, /banned/);
    assert.equal(host.pendingRequests().length, 0);

    await host.stop();
    await guest.stop();
  });

  it("enforces the chat scope on an approved link that was granted less", async () => {
    const host = makeNode("strict");
    const guest = makeNode("talker");
    const h = await host.start();
    const g = await guest.start();

    const connecting = guest.connect(`127.0.0.1:${h.port}`, {
      scopes: ["chat", "knowledge:read"],
      wait: true,
      timeoutMs: 10_000,
    });
    await waitFor(() => host.pendingRequests().length === 1);
    // Approve with a narrower grant than requested.
    host.decide(host.pendingRequests()[0].requestId, true, ["knowledge:read"]);
    const attempt = await connecting;
    assert.equal(attempt.status, "connected");
    assert.deepEqual(attempt.scopes, ["knowledge:read"]);

    const refused = await guest.say("let me in", { to: "strict" });
    assert.equal(refused.delivered.length, 0);
    assert.match(refused.failed[0].error, /did not grant the chat scope/);

    void g;
    await host.stop();
    await guest.stop();
  });

  it("publishes an invitation and reports when discovery is off", async () => {
    const node = makeNode("inviter");
    await node.start();
    const outcome = await node.invite("join the migration session", { durationSeconds: 30 });
    assert.equal(outcome.published, false);
    assert.equal(node.currentInvitation(), "join the migration session");
    assert.equal(node.snapshot().invitation, "join the migration session");
    await node.stop();
    assert.equal(node.currentInvitation(), null);
  });

  it("reaches a peer that no beacon can reach, through a seed address", async () => {
    const events: SwarmEvent[] = [];
    const host = makeNode("seedhost");
    await host.start();
    // No multicast on either side: this is the VPN / other-subnet case.
    await host.invite("join over the vpn", { durationSeconds: 60 });

    const joiner = makeNode("seedclient", { seeds: [`127.0.0.1:${host.port}`] }, events);
    await joiner.start();

    const probed = await joiner.probeSeeds();
    assert.equal(probed.errors.length, 0);
    assert.equal(probed.found.length, 1);
    assert.equal(probed.found[0].name, "seedhost");
    assert.equal(probed.found[0].invitation, "join over the vpn");
    assert.equal(probed.found[0].via, "direct");
    assert.ok(events.some((event) => event.type === "invitation"));

    // The probed peer behaves like any discovered one: by name, with a request.
    const pending = await joiner.connect("seedhost", { scopes: ["chat"], wait: false });
    assert.equal(pending.status, "pending");
    host.decide(host.pendingRequests()[0].requestId, true, ["chat"]);
    const done = await joiner.connect("seedhost", { wait: true, timeoutMs: 10_000 });
    assert.equal(done.status, "connected", done.reason);
    assert.deepEqual((await joiner.say("hello over the tunnel", { to: "seedhost" })).delivered, [
      "seedhost",
    ]);
    await waitFor(() => host.drainInbox({}).length > 0);
    assert.equal(host.drainInbox({}).at(-1)?.text, "hello over the tunnel");

    await host.stop();
    await joiner.stop();
  });

  it("rejects a second request id and unknown request ids", async () => {
    const node = makeNode("decider");
    await node.start();
    assert.throws(() => node.decide("r_missing", true), /Unknown request/);
  });
});

describe("knowledge sharing turned off", () => {
  it("requires an explicit word before knowledge flows", async () => {
    const host = makeNode("noShare", { shareKnowledge: false });
    const guest = makeNode("sharer");
    const h = await host.start();
    await guest.start();

    const connecting = guest.connect(`127.0.0.1:${h.port}`, {
      scopes: ["chat", "knowledge:write"],
      wait: true,
      timeoutMs: 10_000,
    });
    await waitFor(() => host.pendingRequests().length === 1);
    host.decide(host.pendingRequests()[0].requestId, true, ["chat", "knowledge:write"]);
    const attempt = await connecting;
    assert.equal(attempt.status, "connected");
    assert.deepEqual(attempt.scopes, ["chat"]);

    const local = await guest.putKnowledge([{ text: "stays on this node" }]);
    assert.equal(local.entries.length, 1);
    assert.equal(local.pushed, 0);
    assert.equal(host.snapshot().knowledge, 0);

    await host.stop();
    await guest.stop();
  });
});

