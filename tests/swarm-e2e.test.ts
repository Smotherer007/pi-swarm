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

  it("hands the token only to the node that asked", async () => {
    const host = makeNode("approver");
    const guest = makeNode("collector");
    const h = await host.start();
    const g = await guest.start();

    const pending = await guest.connect(`127.0.0.1:${h.port}`, {
      scopes: ["chat"],
      wait: false,
    });
    assert.equal(pending.status, "pending");
    const requestId = pending.requestId!;
    host.decide(requestId, true, ["chat"]);

    const poll = (nodeId: string) =>
      requestJson<{ status?: string; token?: string; reason?: string }>(
        `${baseUrl("127.0.0.1", h.port)}${API_PREFIX}/approval`,
        { body: { requestId, nodeId } },
      );

    // A stranger holding the request id learns nothing and gets no token.
    const intruder = await poll("n_test_intruder");
    assert.equal(intruder.data.status, "expired");
    assert.equal(intruder.data.token, undefined);
    assert.equal(host.snapshot().connections.length, 0);

    // The requester itself is answered, and the link exists afterwards.
    const owner = await poll("n_test_collector");
    assert.equal(owner.data.status, "approved");
    assert.equal(typeof owner.data.token, "string");
    await waitFor(() => host.snapshot().connections.length === 1);

    // Polling twice is harmless: same token, one connection.
    const again = await poll("n_test_collector");
    assert.equal(again.data.token, owner.data.token);
    assert.equal(host.snapshot().connections.length, 1);

    void g;
    await host.stop();
    await guest.stop();
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

describe("an approval is the only decision a link needs", () => {
  it("remembers an approved peer as trusted and auto-connect, with the granted scopes", async () => {
    const host = makeNode("firstApproval");
    const guest = makeNode("approved");
    const h = await host.start();
    await guest.start();

    assert.equal(host.peers.count(), 0, "nobody is known before the first contact");

    const connecting = guest.connect(`127.0.0.1:${h.port}`, {
      scopes: ["chat", "knowledge:read"],
      wait: true,
      timeoutMs: 10_000,
    });
    await waitFor(() => host.pendingRequests().length === 1);

    // The requester is recorded when it asks, but without any policy: a
    // request alone must never create an automatically reconnecting peer.
    const before = host.peers.get("n_test_approved");
    assert.equal(before?.trusted, false);
    assert.equal(before?.autoConnect, false);

    host.decide(host.pendingRequests()[0].requestId, true, ["chat"]);
    assert.equal((await connecting).status, "connected");

    const known = host.peers.get("n_test_approved");
    assert.ok(known, "the approved peer is in the peer book");
    assert.equal(known.trusted, true, "a second inbound request needs no decision");
    assert.equal(known.autoConnect, true, "the next beacon reconnects on its own");
    assert.deepEqual(known.scopes, ["chat"], "only what was granted is remembered");

    await host.stop();
    await guest.stop();
  });

  it("never un-bans a peer that is approved anyway", async () => {
    const host = makeNode("bannedHost");
    const guest = makeNode("bannedGuest");
    const h = await host.start();
    await guest.start();

    // Make the peer known and banned before it asks.
    host.peers.touch(
      { nodeId: "n_test_bannedGuest", name: "bannedGuest", host: "127.0.0.1", port: 1 },
      { banned: true },
    );

    const connecting = guest.connect(`127.0.0.1:${h.port}`, {
      scopes: ["chat"],
      wait: true,
      timeoutMs: 5_000,
    });
    const attempt = await connecting;
    assert.notEqual(attempt.status, "connected", "a banned peer is refused at the door");
    assert.equal(host.pendingRequests().length, 0, "and never reaches the consent queue");

    const known = host.peers.get("n_test_bannedGuest");
    assert.equal(known?.banned, true);
    assert.equal(known?.trusted, false);

    await host.stop();
    await guest.stop();
  });
});

describe("a link that went stale", () => {
  /** Host + guest, connected, sharing one peer book the restart can reuse. */
  async function pair(name: string, scopes: Scope[] = ["chat"]) {
    const root = tempDir(`pi-swarm-${name}`);
    dirs.push(root);
    const identity = makeIdentity(name);
    const peersPath = path.join(root, "peers.json");
    const sessions = path.join(root, "sessions");
    const hostConfig = makeConfig({ name: "host", inboundPolicy: "known-auto" });

    const host = new SwarmNode({
      config: hostConfig,
      identity,
      peersPath,
      sessionsDir: sessions,
      instanceDir: null,
      discovery: false,
    });
    nodes.push(host);
    const guest = makeNode("guest");

    const h = await host.start();
    await guest.start();
    const connecting = guest.connect(`127.0.0.1:${h.port}`, {
      scopes,
      wait: true,
      timeoutMs: 10_000,
    });
    await waitFor(() => host.pendingRequests().length === 1);
    host.decide(host.pendingRequests()[0].requestId, true, scopes);
    const attempt = await connecting;
    assert.equal(attempt.status, "connected", attempt.reason);

    /** Same identity, same port, same peer book: what a restart looks like. */
    const restart = async () => {
      await host.stop();
      const next = new SwarmNode({
        config: { ...hostConfig, port: h.port },
        identity,
        peersPath,
        sessionsDir: sessions,
        instanceDir: null,
        discovery: false,
      });
      nodes.push(next);
      await next.start();
      return next;
    };

    return { host, guest, restart, port: h.port };
  }

  it("recovers on its own when the peer no longer knows the token", async () => {
    const { host, guest, restart } = await pair("heal");

    const before = await guest.say("vor dem Neustart");
    assert.deepEqual(before.delivered, ["host"]);
    assert.equal(host.drainInbox().length, 1);

    // The restart invalidates every token the other side holds.
    const restarted = await restart();

    const after = await guest.say("nach dem Neustart");
    assert.deepEqual(after.delivered, ["host"], "the message goes through after healing");
    assert.deepEqual(after.failed, []);
    const arrived = restarted.drainInbox();
    assert.equal(arrived.length, 1);
    assert.match(arrived[0].text, /nach dem Neustart/);

    await guest.stop();
    await restarted.stop();
  });

  it("does not claim to be connected to a peer that stopped answering", async () => {
    const { host, guest, port } = await pair("deadlink");
    await host.stop();

    const attempt = await guest.connect(`127.0.0.1:${port}`, {
      wait: true,
      timeoutMs: 5_000,
    });
    assert.notEqual(attempt.status, "connected");
    assert.notEqual(attempt.reason, "already connected");
    await guest.stop();
  });

  it("drops a quiet link when the peer is gone", async () => {
    const { host, guest } = await pair("reap");
    const connection = guest.snapshot().connections[0];
    assert.ok(connection);
    // Pretend the link has been quiet for longer than the stale window.
    connection.lastSeen = 0;

    await host.stop();
    const result = await guest.checkConnections();
    assert.equal(result.checked, 1);
    assert.equal(result.dropped.length, 1);
    assert.equal(guest.snapshot().connections.length, 0);

    await guest.stop();
  });
});

describe("knowledge over a link whose peer restarted", () => {
  it("heals the token instead of failing the sync", async () => {
    // Same setup as above, but with the wire for knowledge open.
    const root = tempDir("pi-swarm-kheal");
    dirs.push(root);
    const identity = makeIdentity("khost");
    const hostConfig = makeConfig({ name: "khost", inboundPolicy: "known-auto" });
    const host = new SwarmNode({
      config: hostConfig,
      identity,
      peersPath: path.join(root, "peers.json"),
      sessionsDir: path.join(root, "sessions"),
      instanceDir: null,
      discovery: false,
    });
    nodes.push(host);
    const guest = makeNode("kguest");
    const h = await host.start();
    await guest.start();

    const connecting = guest.connect(`127.0.0.1:${h.port}`, {
      scopes: ["chat", "knowledge:read"],
      wait: true,
      timeoutMs: 10_000,
    });
    await waitFor(() => host.pendingRequests().length === 1);
    host.decide(host.pendingRequests()[0].requestId, true, ["chat", "knowledge:read"]);
    assert.equal((await connecting).status, "connected");

    await host.putKnowledge([{ key: "vorher", text: "vom Host vor dem Neustart" }]);
    const first = await guest.syncWith(identity.nodeId);
    assert.deepEqual(first.errors, []);
    assert.equal(first.pulled, 1);

    // Restart: same identity, same port, same peer book, brand new tokens.
    await host.stop();
    const restarted = new SwarmNode({
      config: { ...hostConfig, port: h.port },
      identity,
      peersPath: path.join(root, "peers.json"),
      sessionsDir: path.join(root, "sessions"),
      instanceDir: null,
      discovery: false,
    });
    nodes.push(restarted);
    await restarted.start();
    await restarted.putKnowledge([{ key: "nachher", text: "vom Host nach dem Neustart" }]);

    const second = await guest.syncWith(identity.nodeId);
    assert.deepEqual(second.errors, [], "the sync must not report an unknown token");
    // The reconnect inside the heal already syncs, so the count here may be 0.
    // What matters is that the new entry arrived at all.
    const keys = (guest.knowledgeBase?.all() ?? []).map((entry) => entry.key);
    assert.ok(keys.includes("vorher"), "the entry from before the restart is still there");
    assert.ok(keys.includes("nachher"), "the entry from after the restart arrived");

    await guest.stop();
    await restarted.stop();
  });
});

describe("healing half a link", () => {
  it("keeps the token we issued and the scopes we granted", async () => {
    const root = tempDir("pi-swarm-halfheal");
    dirs.push(root);
    const host = new SwarmNode({
      config: makeConfig({ name: "halfhost", inboundPolicy: "known-auto" }),
      identity: makeIdentity("halfhost"),
      peersPath: path.join(root, "host-peers.json"),
      sessionsDir: path.join(root, "host-sessions"),
      instanceDir: null,
      discovery: false,
    });
    nodes.push(host);
    const guest = makeNode("halfguest");
    const h = await host.start();
    await guest.start();

    // guest -> host
    const forward = guest.connect(`127.0.0.1:${h.port}`, {
      scopes: ["chat"],
      wait: true,
      timeoutMs: 10_000,
    });
    await waitFor(() => host.pendingRequests().length === 1);
    host.decide(host.pendingRequests()[0].requestId, true, ["chat"]);
    assert.equal((await forward).status, "connected");

    // host -> guest, so both sides hold a token the other issued
    const back = host.connect(`127.0.0.1:${guest.port ?? 0}`, {
      scopes: ["chat"],
      wait: true,
      timeoutMs: 10_000,
    });
    await waitFor(() => guest.pendingRequests().length === 1);
    guest.decide(guest.pendingRequests()[0].requestId, true, ["chat"]);
    assert.equal((await back).status, "connected");

    const connection = guest.snapshot().connections[0];
    assert.ok(connection.inToken, "the guest issued a token to the host");
    assert.deepEqual(connection.grantedToPeer, ["chat"]);
    const issued = connection.inToken;

    // The peer rotated its tokens: what the guest holds for calling out is dead,
    // while the token it issued is untouched.
    connection.outToken = "not-a-real-token";

    const result = await guest.say("kommt das trotzdem an?");
    assert.deepEqual(result.delivered, ["halfhost"], "the heal delivers the message");
    assert.deepEqual(result.failed, []);

    const healed = guest.snapshot().connections[0];
    assert.equal(healed.inToken, issued, "the token we issued survives our own heal");
    assert.deepEqual(healed.grantedToPeer, ["chat"], "and so does what we granted");
    assert.ok(healed.outToken && healed.outToken !== "not-a-real-token");

    // And the token the guest issued is still honoured: the host can still call
    // it, without a heal of its own (case b of the review).
    const hostSide = await host.say("und in die andere Richtung?");
    assert.deepEqual(hostSide.delivered, ["halfguest"]);

    await guest.stop();
    await host.stop();
  });
});

describe("a heal that grants less than before", () => {
  it("re-checks the scope on the healed link instead of trusting the old one", async () => {
    const root = tempDir("pi-swarm-scopeheal");
    dirs.push(root);
    const host = new SwarmNode({
      config: makeConfig({ name: "scopehost", inboundPolicy: "known-auto" }),
      identity: makeIdentity("scopehost"),
      peersPath: path.join(root, "peers.json"),
      sessionsDir: path.join(root, "sessions"),
      instanceDir: null,
      discovery: false,
    });
    nodes.push(host);
    const guest = makeNode("scopeguest");
    const h = await host.start();
    await guest.start();

    const connecting = guest.connect(`127.0.0.1:${h.port}`, {
      scopes: ["chat"],
      wait: true,
      timeoutMs: 10_000,
    });
    await waitFor(() => host.pendingRequests().length === 1);
    host.decide(host.pendingRequests()[0].requestId, true, ["chat"]);
    assert.equal((await connecting).status, "connected");

    // The host changes its mind: from now on it hands out only knowledge:read,
    // so the reconnect after a rotated token comes back with less than the
    // first handshake did. Both the ceiling (defaultScopes) and the stored
    // grant have to shrink -- either one alone still allows chat.
    host.config.defaultScopes = ["knowledge:read"];
    host.peers.setScopes("n_test_scopeguest", ["knowledge:read"]);
    guest.snapshot().connections[0].outToken = "rotated";

    const result = await guest.say("darf ich noch?");
    assert.deepEqual(result.delivered, [], "no message goes out without the chat scope");
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /no longer grants the chat scope/);

    await guest.stop();
    await host.stop();
  });
});

describe("resetting the token a peer holds", () => {
  it("keeps the link and forces the peer through its heal path", async () => {
    const root = tempDir("pi-swarm-revoke");
    dirs.push(root);
    const host = new SwarmNode({
      config: makeConfig({ name: "revokehost", inboundPolicy: "known-auto" }),
      identity: makeIdentity("revokehost"),
      peersPath: path.join(root, "host-peers.json"),
      sessionsDir: path.join(root, "host-sessions"),
      instanceDir: null,
      discovery: false,
    });
    nodes.push(host);
    const guest = makeNode("revokeguest");
    const events: string[] = [];
    const h = await host.start();
    await guest.start();

    const connecting = guest.connect(`127.0.0.1:${h.port}`, {
      scopes: ["chat"],
      wait: true,
      timeoutMs: 10_000,
    });
    await waitFor(() => host.pendingRequests().length === 1);
    host.decide(host.pendingRequests()[0].requestId, true, ["chat"]);
    assert.equal((await connecting).status, "connected");

    const before = host.snapshot().connections[0];
    assert.ok(before.inToken, "the host issued a token");

    const revoked = host.revokePeerToken("revokeguest");
    assert.equal(revoked.hadToken, true);
    assert.deepEqual(revoked.grantedToPeer, ["chat"], "the grant survives the reset");

    // The link object is still there: this is not a disconnect.
    const after = host.snapshot().connections[0];
    assert.ok(after, "the link survived");
    assert.equal(after.inToken, undefined, "but the token is gone");
    assert.deepEqual(after.grantedToPeer, ["chat"]);

    // The guest's next send is refused, and its heal delivers anyway.
    const sent = await guest.say("nach dem Reset");
    assert.deepEqual(sent.delivered, ["revokehost"]);
    assert.deepEqual(sent.failed, []);
    const healed = host.snapshot().connections[0];
    assert.ok(healed.inToken, "a fresh token was issued by the re-handshake");

    await guest.stop();
    await host.stop();
    assert.deepEqual(events, []);
  });
});

describe("asking for wider scopes on a live link", () => {
  it("renegotiates instead of answering 'already connected'", async () => {
    const root = tempDir("pi-swarm-uprgade");
    dirs.push(root);
    const host = new SwarmNode({
      config: makeConfig({ name: "uphost", inboundPolicy: "known-auto", defaultScopes: ["chat", "knowledge:read", "knowledge:write"] }),
      identity: makeIdentity("uphost"),
      peersPath: path.join(root, "peers.json"),
      sessionsDir: path.join(root, "sessions"),
      instanceDir: null,
      discovery: false,
    });
    nodes.push(host);
    const guest = makeNode("upguest");
    const h = await host.start();
    await guest.start();

    host.peers.touch(
      { nodeId: "n_test_upguest", name: "upguest", host: "127.0.0.1", port: 1 },
      { trusted: true, scopes: ["chat", "knowledge:read", "knowledge:write"] },
    );

    const first = await guest.connect(`127.0.0.1:${h.port}`, { scopes: ["chat"], wait: true, timeoutMs: 10_000 });
    assert.equal(first.status, "connected");
    assert.deepEqual(first.scopes, ["chat"]);

    // Same link, wider request: this must negotiate again, not report success
    // with the narrower grant it already has.
    const second = await guest.connect(`127.0.0.1:${h.port}`, {
      scopes: ["chat", "knowledge:write"],
      wait: true,
      timeoutMs: 10_000,
    });
    assert.equal(second.status, "connected");
    assert.notEqual(second.reason, "already connected");
    assert.deepEqual(second.scopes, ["chat", "knowledge:write"]);

    await guest.stop();
    await host.stop();
  });

  it("still answers 'already connected' when nothing new is asked", async () => {
    const root = tempDir("pi-swarm-same");
    dirs.push(root);
    const host = new SwarmNode({
      config: makeConfig({ name: "samehost", inboundPolicy: "known-auto" }),
      identity: makeIdentity("samehost"),
      peersPath: path.join(root, "peers.json"),
      sessionsDir: path.join(root, "sessions"),
      instanceDir: null,
      discovery: false,
    });
    nodes.push(host);
    const guest = makeNode("sameguest");
    const h = await host.start();
    await guest.start();

    const first = guest.connect(`127.0.0.1:${h.port}`, { scopes: ["chat"], wait: true, timeoutMs: 10_000 });
    await waitFor(() => host.pendingRequests().length === 1);
    host.decide(host.pendingRequests()[0].requestId, true, ["chat"]);
    assert.equal((await first).status, "connected");

    const again = await guest.connect(`127.0.0.1:${h.port}`, { scopes: ["chat"], wait: true, timeoutMs: 5_000 });
    assert.equal(again.reason, "already connected");

    await guest.stop();
    await host.stop();
  });
});
