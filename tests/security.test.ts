/**
 * The attacks the review found, each reproduced against real nodes.
 *
 * Every test here failed before the fix it guards: a node id is public (it is in
 * every beacon), so anything that trusted a node id alone could be taken over;
 * a peer-chosen offer id became a path; a knowledge cursor skipped entries.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { SwarmNode } from "../src/swarm.ts";
import { deriveKeys } from "../src/crypto.ts";
import { HEADER_FROM, HEADER_PUB, newRequestId, sealRequest, SEALED_CONTENT_TYPE } from "../src/envelope.ts";
import { FileStore } from "../src/files.ts";
import { PeerStore } from "../src/peers.ts";
import { ALL_SCOPES } from "../src/types.ts";
import { scopeSchema } from "../src/tools/schema.ts";
import { makeConfig, makeIdentity, pubOf, rmrf, sealedCallAs, tempDir, waitFor } from "./helpers.ts";

const dirs: string[] = [];
const nodes: SwarmNode[] = [];

after(async () => {
  for (const node of nodes.splice(0)) await node.stop().catch(() => {});
  for (const dir of dirs.splice(0)) rmrf(dir);
});

function makeNode(name: string, overrides: Parameters<typeof makeConfig>[0] = {}): SwarmNode {
  const root = tempDir(`pi-swarm-sec-${name}`);
  dirs.push(root);
  const node = new SwarmNode({
    config: makeConfig({ name, inboundPolicy: "known-auto", ...overrides }),
    identity: makeIdentity(name),
    peersPath: path.join(root, "peers.json"),
    sessionsDir: path.join(root, "sessions"),
    filesPath: path.join(root, "files"),
    instanceDir: null,
    discovery: false,
  });
  nodes.push(node);
  return node;
}

/** Connect guest -> host and approve it on the host. */
async function link(guest: SwarmNode, host: SwarmNode, port: number, scopes: string[]): Promise<void> {
  const attempt = guest.connect(`127.0.0.1:${port}`, { scopes: scopes as never, wait: true, timeoutMs: 10_000 });
  await waitFor(() => host.pendingRequests().length === 1);
  host.decide(host.pendingRequests()[0].requestId, true, scopes as never);
  assert.equal((await attempt).status, "connected");
}

/** Send raw bytes as a sealed POST, so a test can replay exactly what went out. */
function rawPost(port: number, route: string, headers: Record<string, string>, body: Buffer) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: `/swarm/v1${route}`, method: "POST", headers: { ...headers, "content-length": String(body.length) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf-8") }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("identity is the key, not the node id", () => {
  it("refuses a hello that claims a trusted peer's node id with another key", async () => {
    const host = makeNode("sec-victim");
    const real = makeNode("sec-real");
    const h = await host.start();
    await real.start();
    await link(real, host, h.port!, ["chat"]);
    const before = host.peers.get(real.identity.nodeId)!;

    // The attacker knows the node id (beacons carry it) but not the private key.
    const attacker = { ...makeIdentity("sec-attacker"), nodeId: real.identity.nodeId };
    await assert.rejects(
      sealedCallAs(attacker, { nodeId: host.identity.nodeId, publicKey: host.identity.keys.publicKey, port: h.port! }, "/hello", {
        body: { proto: "pi-swarm/2", from: { nodeId: real.identity.nodeId, name: "sec-real" }, sessionId: null, scopes: ["chat"], port: 6666 },
      }),
      (err: { statusCode?: number }) => err.statusCode === 409,
    );

    const afterwards = host.peers.get(real.identity.nodeId)!;
    assert.equal(afterwards.port, before.port, "the stored address was not redirected");
    assert.equal(afterwards.publicKey, before.publicKey, "the pinned key is unchanged");
    assert.equal(host.snapshot().connections[0]?.port, before.port);
  });

  it("does not auto-approve a known, trusted peer whose key was never pinned", async () => {
    const host = makeNode("sec-legacy-host");
    const guest = makeNode("sec-legacy-guest");
    const h = await host.start();
    await guest.start();
    // What a peer book from before encryption looks like: trusted, no key.
    host.peers.touch(
      { nodeId: guest.identity.nodeId, name: "sec-legacy-guest", host: "127.0.0.1", port: 1 },
      { trusted: true, autoConnect: true, scopes: ["chat", "knowledge:read"] },
    );

    const attempt = await guest.connect(`127.0.0.1:${h.port}`, { scopes: ["chat"], wait: false });
    assert.equal(attempt.status, "pending", "without a pinned key, 'known' proves nothing");
    assert.match(host.pendingRequests()[0].reason, /encryption key/);
  });

  it("binds a token to the node it was issued to", async () => {
    const host = makeNode("sec-token-host");
    const guest = makeNode("sec-token-guest");
    const h = await host.start();
    await guest.start();
    await link(guest, host, h.port!, ["chat"]);
    const token = (guest as unknown as { connections: Map<string, { outToken?: string }> }).connections.get(
      host.identity.nodeId,
    )!.outToken!;

    // A different node holding the (stolen) token is refused.
    await assert.rejects(
      sealedCallAs(makeIdentity("sec-token-thief"), { nodeId: host.identity.nodeId, publicKey: host.identity.keys.publicKey, port: h.port! }, "/message", {
        body: { text: "hi" },
        token,
      }),
      /unknown or expired token/,
    );
  });

  it("ignores a beacon that names a pinned peer with another key", async () => {
    const host = makeNode("sec-beacon-host");
    const peer = makeNode("sec-beacon-peer");
    const h = await host.start();
    await peer.start();
    await link(peer, host, h.port!, ["chat"]);
    const internals = host as unknown as {
      handleBeacon: (peer: unknown) => void;
      seen: Map<string, { host: string; port: number }>;
    };
    internals.handleBeacon({
      nodeId: peer.identity.nodeId,
      name: "sec-beacon-peer",
      publicKey: pubOf("sec-beacon-spoofer"),
      host: "10.66.66.66",
      port: 6666,
      lastSeen: Date.now(),
      sessionId: null,
      accepting: true,
      via: "multicast",
    });
    assert.notEqual(internals.seen.get(peer.identity.nodeId)?.host, "10.66.66.66");
  });
});

describe("sealed requests", () => {
  it("refuses a replayed request", async () => {
    const host = makeNode("sec-replay");
    const h = await host.start();
    const caller = makeIdentity("sec-replayer");
    const keys = deriveKeys(caller.keys, host.identity.keys.publicKey, caller.nodeId, host.identity.nodeId);
    const body = sealRequest(
      keys,
      { method: "POST", path: "/swarm/v1/message", from: caller.nodeId, to: host.identity.nodeId },
      { rid: newRequestId(), ts: Date.now(), token: "nope", body: { text: "x" } },
    );
    const headers = { "content-type": SEALED_CONTENT_TYPE, [HEADER_FROM]: caller.nodeId, [HEADER_PUB]: caller.keys.publicKey };

    const first = await rawPost(h.port!, "/message", headers, body);
    assert.equal(first.status, 401, "the first copy is opened and answered (no such token)");
    const second = await rawPost(h.port!, "/message", headers, body);
    assert.equal(second.status, 409);
    assert.match(second.text, /replay/);
  });

  it("refuses a request from far outside this node's clock", async () => {
    const host = makeNode("sec-clock");
    const h = await host.start();
    const caller = makeIdentity("sec-clock-caller");
    const keys = deriveKeys(caller.keys, host.identity.keys.publicKey, caller.nodeId, host.identity.nodeId);
    const body = sealRequest(
      keys,
      { method: "POST", path: "/swarm/v1/message", from: caller.nodeId, to: host.identity.nodeId },
      { rid: newRequestId(), ts: Date.now() - 20 * 60 * 1000, body: { text: "x" } },
    );
    const answer = await rawPost(
      h.port!,
      "/message",
      { "content-type": SEALED_CONTENT_TYPE, [HEADER_FROM]: caller.nodeId, [HEADER_PUB]: caller.keys.publicKey },
      body,
    );
    assert.equal(answer.status, 400);
    assert.match(answer.text, /clock/);
  });

  it("refuses a body sealed for another route", async () => {
    const host = makeNode("sec-route");
    const h = await host.start();
    const caller = makeIdentity("sec-route-caller");
    const keys = deriveKeys(caller.keys, host.identity.keys.publicKey, caller.nodeId, host.identity.nodeId);
    const body = sealRequest(
      keys,
      { method: "POST", path: "/swarm/v1/leave", from: caller.nodeId, to: host.identity.nodeId },
      { rid: newRequestId(), ts: Date.now(), body: {} },
    );
    const answer = await rawPost(
      h.port!,
      "/message",
      { "content-type": SEALED_CONTENT_TYPE, [HEADER_FROM]: caller.nodeId, [HEADER_PUB]: caller.keys.publicKey },
      body,
    );
    assert.equal(answer.status, 400);
  });
});

describe("files", () => {
  it("moves a file of a few megabytes intact", async () => {
    const host = makeNode("sec-bigfile-host", { defaultScopes: ["chat"] });
    const guest = makeNode("sec-bigfile-guest", { defaultScopes: ["chat"] });
    const h = await host.start();
    const g = await guest.start();
    await link(guest, host, h.port!, ["chat", "files:write"]);
    await link(host, guest, g.port!, ["chat", "files:read"]);

    const source = path.join(dirs[dirs.length - 1], "big.bin");
    const bytes = crypto.randomBytes(3 * 1024 * 1024);
    fs.writeFileSync(source, bytes);
    const offered = await guest.offerFile("sec-bigfile-host", source);
    const accepted = await host.acceptFile(offered.offerId);
    assert.equal(accepted.bytes, bytes.length);
    assert.equal(accepted.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  });

  it("never lets a peer-chosen offer id become a path", async () => {
    const host = makeNode("sec-traversal-host");
    const guest = makeNode("sec-traversal-guest");
    const h = await host.start();
    await guest.start();
    await link(guest, host, h.port!, ["chat", "files:write"]);
    const internals = guest as unknown as {
      call: (peer: unknown, route: string, options: unknown) => Promise<unknown>;
      connections: Map<string, { outToken?: string; nodeId: string; host: string; port: number }>;
    };
    const connection = internals.connections.get(host.identity.nodeId)!;
    await assert.rejects(
      internals.call(connection, "/files/offer", {
        token: connection.outToken,
        body: { offerId: "../../../../tmp/escaped", name: "x", size: 1, sha256: "a".repeat(64) },
      }),
      /offer id is malformed/,
    );
    assert.equal(host.fileOffers().length, 0);
  });

  it("files every offer under a local id and refuses ids that are not its own", () => {
    const root = tempDir("pi-swarm-sec-store");
    dirs.push(root);
    const store = new FileStore({ root });
    const from = { nodeId: "n_a", name: "a", host: "", port: 1 };
    assert.equal(store.addIncoming({ remoteOfferId: "../x", from, displayName: "x", size: 1, sha256: "a".repeat(64) }), null);
    const first = store.addIncoming({ remoteOfferId: "f_" + "1".repeat(24), from, displayName: "x", size: 1, sha256: "a".repeat(64) })!;
    assert.notEqual(first.offerId, first.remoteOfferId);
    const other = { ...from, nodeId: "n_b" };
    const second = store.addIncoming({ remoteOfferId: "f_" + "1".repeat(24), from: other, displayName: "y", size: 1, sha256: "b".repeat(64) })!;
    assert.ok(second, "another peer reusing the id gets its own entry");
    assert.equal(store.incomingOffer(first.offerId)?.displayName, "x", "and cannot overwrite the first");
    assert.throws(() => store.targetPath("n_a", "../../escape"), /not a valid offer id/);
  });

  it("serves an offer only to the peer it was made to", () => {
    const root = tempDir("pi-swarm-sec-out");
    dirs.push(root);
    const store = new FileStore({ root });
    store.addOutgoing({
      offerId: "f_" + "2".repeat(24),
      to: { nodeId: "n_receiver", name: "r", host: "", port: 1 },
      sourcePath: "/dev/null",
      displayName: "x",
      size: 0,
      sha256: "c".repeat(64),
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      served: false,
    });
    assert.ok("error" in store.takeOutgoing("f_" + "2".repeat(24), "n_someone_else"));
    assert.ok(!("error" in store.takeOutgoing("f_" + "2".repeat(24), "n_receiver")), "a wrong taker does not use it up");
  });
});

describe("knowledge", () => {
  it("pulls a board of several pages completely, then only what is new", async () => {
    const host = makeNode("sec-pages-host");
    const guest = makeNode("sec-pages-guest");
    const h = await host.start();
    await guest.start();
    for (let index = 0; index < 250; index += 1) {
      await host.putKnowledge([{ key: `k${index}`, text: `entry ${index}` }]);
    }
    await link(guest, host, h.port!, ["chat", "knowledge:read"]);
    await guest.syncAll();
    assert.equal(guest.knowledgeBase!.size, 250);

    await host.putKnowledge([{ key: "late", text: "one more" }]);
    const second = await guest.syncAll();
    assert.equal(second.pulled, 1);
    assert.equal(guest.knowledgeBase!.size, 251);
  });

  it("does not let a writer forge entries in another name or from the future", async () => {
    const host = makeNode("sec-forge-host");
    const guest = makeNode("sec-forge-guest");
    const h = await host.start();
    await guest.start();
    await host.putKnowledge([{ key: "decision", text: "the real decision" }]);
    await link(guest, host, h.port!, ["chat", "knowledge:write"]);
    const internals = guest as unknown as {
      call: (peer: unknown, route: string, options: unknown) => Promise<{ data: { added: number; ignored: number } }>;
      connections: Map<string, { outToken?: string }>;
    };
    const connection = internals.connections.get(host.identity.nodeId)!;
    const forged = [
      // in the host's own name, overwriting its decision
      { id: `${host.identity.nodeId}/decision`, sessionId: "", key: "decision", kind: "decision", text: "forged", author: { nodeId: host.identity.nodeId, name: "host" }, ts: Date.now() + 1000 },
      // in a third node's name
      { id: "n_third/x", sessionId: "", key: "x", kind: "fact", text: "forged", author: { nodeId: "n_third", name: "third" }, ts: Date.now() },
      // its own name, but dated a year ahead so it would win every merge
      { id: `${guest.identity.nodeId}/future`, sessionId: "", key: "future", kind: "fact", text: "forged", author: { nodeId: guest.identity.nodeId, name: "guest" }, ts: Date.now() + 365 * 24 * 3600 * 1000 },
      // its own name, filed under another author's slot
      { id: `${host.identity.nodeId}/slot`, sessionId: "", key: "slot", kind: "fact", text: "forged", author: { nodeId: guest.identity.nodeId, name: "guest" }, ts: Date.now() },
    ];
    const answer = await internals.call(connection, "/knowledge", { token: connection.outToken, body: { entries: forged } });
    assert.equal(answer.data.added, 0);
    assert.equal(answer.data.ignored, 4);
    assert.equal(host.knowledgeBase!.get(`${host.identity.nodeId}/decision`)?.text, "the real decision");
  });
});

describe("small things that were easy to get wrong", () => {
  it("offers every scope in the tool schemas", () => {
    const literals = (scopeSchema as unknown as { anyOf: Array<{ const: string }> }).anyOf.map((entry) => entry.const);
    assert.deepEqual(literals, [...ALL_SCOPES]);
    assert.ok(literals.includes("files:read") && literals.includes("files:write"));
  });

  it("refuses to guess between two peers that share a partial name", () => {
    const root = tempDir("pi-swarm-sec-names");
    dirs.push(root);
    const store = new PeerStore({ filePath: path.join(root, "peers.json"), defaultScopes: ["chat"] });
    store.touch({ nodeId: "n_1", name: "pi@workshop", host: "h", port: 1 });
    store.touch({ nodeId: "n_2", name: "pi@work-laptop", host: "h", port: 2 });
    assert.equal(store.byName("work"), undefined);
    assert.equal(store.byName("workshop")?.nodeId, "n_1");
  });

  it("never replaces a pinned key in passing", () => {
    const root = tempDir("pi-swarm-sec-pin");
    dirs.push(root);
    const store = new PeerStore({ filePath: path.join(root, "peers.json"), defaultScopes: ["chat"] });
    store.touch({ nodeId: "n_1", name: "a", host: "h", port: 1, publicKey: pubOf("pin-a") });
    store.touch({ nodeId: "n_1", name: "a", host: "h", port: 1, publicKey: pubOf("pin-b") });
    store.update("n_1", { publicKey: pubOf("pin-b") });
    assert.equal(store.get("n_1")?.publicKey, pubOf("pin-a"));
  });
});
