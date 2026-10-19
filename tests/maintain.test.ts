/**
 * The background link keeper.
 *
 * "Automatically connected" means the node keeps looking until it is: an
 * attempt happens on a timer, not on a tool call, so the agent can carry on
 * talking while a link is being negotiated.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import { SwarmNode } from "../src/swarm.ts";
import { makeConfig, makeIdentity, pubOf, rmrf, tempDir, waitFor } from "./helpers.ts";

const dirs: string[] = [];
const nodes: SwarmNode[] = [];

after(async () => {
  for (const node of nodes.splice(0)) await node.stop().catch(() => {});
  for (const dir of dirs.splice(0)) rmrf(dir);
});

interface BuildOptions {
  name: string;
  port?: number;
  maintainIntervalMs?: number;
  inboundPolicy?: "ask" | "known-auto" | "open";
}

function build(options: BuildOptions): SwarmNode {
  const root = tempDir(`pi-swarm-${options.name}`);
  dirs.push(root);
  const node = new SwarmNode({
    config: makeConfig({
      name: options.name,
      port: options.port ?? 0,
      inboundPolicy: options.inboundPolicy ?? "known-auto",
    }),
    identity: makeIdentity(options.name),
    peersPath: path.join(root, "peers.json"),
    sessionsDir: path.join(root, "sessions"),
    instanceDir: null,
    discovery: false,
    maintainIntervalMs: options.maintainIntervalMs ?? 250,
  });
  nodes.push(node);
  return node;
}

describe("the background link keeper", () => {
  it("connects to a known peer without any tool call", async () => {
    const host = build({ name: "keeper-host" });
    const guest = build({ name: "keeper-guest" });

    // The guest knows the host and is allowed to dial it; the host trusts the
    // guest, so the handshake needs no human in the loop.
    guest.peers.touch(
      { nodeId: "n_test_keeper-host", publicKey: pubOf("keeper-host"), name: "keeper-host", host: "127.0.0.1", port: 1 },
      { trusted: true, autoConnect: true, scopes: ["chat"] },
    );
    host.peers.touch(
      { nodeId: "n_test_keeper-guest", publicKey: pubOf("keeper-guest"), name: "keeper-guest", host: "127.0.0.1", port: 1 },
      { trusted: true, scopes: ["chat"] },
    );

    const startedHost = await host.start();
    // Point the guest at the real port, then start it: no connect() is called.
    guest.peers.update("n_test_keeper-host", { port: startedHost.port, host: "127.0.0.1" });
    await guest.start();

    await waitFor(() => guest.snapshot().connections.length === 1, 10_000, 100);
    assert.equal(guest.snapshot().connections[0].name, "keeper-host");
    assert.equal(host.snapshot().connections.length, 1);
  });

  it("keeps trying until a peer that was offline comes up", async () => {
    // Reserve a port, then take it away again: that is the address the guest
    // will keep dialing while nothing is listening.
    const placeholder = build({ name: "keeper-late" });
    const reserved = await placeholder.start();
    const latePort = reserved.port;
    await placeholder.stop();

    const guest = build({ name: "keeper-waiter" });
    guest.peers.touch(
      { nodeId: "n_test_keeper-late", publicKey: pubOf("keeper-late"), name: "keeper-late", host: "127.0.0.1", port: latePort },
      { trusted: true, autoConnect: true, scopes: ["chat"] },
    );
    await guest.start();

    // Several rounds happen while nobody is there.
    await waitFor(() => guest.snapshot().connections.length === 0, 1500, 100);
    assert.equal(guest.snapshot().connections.length, 0);

    const late = build({ name: "keeper-late", port: latePort });
    late.peers.touch(
      { nodeId: "n_test_keeper-waiter", publicKey: pubOf("keeper-waiter"), name: "keeper-waiter", host: "127.0.0.1", port: 1 },
      { trusted: true, scopes: ["chat"] },
    );
    await late.start();

    // Nobody asks again: the timer finds it.
    await waitFor(() => guest.snapshot().connections.length === 1, 15_000, 100);
    assert.equal(guest.snapshot().connections[0].name, "keeper-late");
  });

  it("does not block while a link is being negotiated", async () => {
    const guest = build({ name: "keeper-nonblocking" });
    guest.peers.touch(
      { nodeId: "n_test_keeper-nowhere", publicKey: pubOf("keeper-nowhere"), name: "keeper-nowhere", host: "127.0.0.1", port: 1 },
      { trusted: true, autoConnect: true, scopes: ["chat"] },
    );
    await guest.start();

    const started = Date.now();
    const round = await guest.maintainLinks();
    const elapsed = Date.now() - started;

    assert.deepEqual(round.attempted, ["keeper-nowhere"]);
    // The attempt itself is allowed to take its 8 s connect timeout; the round
    // must not wait for it. A generous bound still proves that, and unlike a
    // tight one it does not fail on a loaded machine.
    assert.ok(elapsed < 2000, `a round blocked for ${elapsed} ms instead of returning`);
  });
});

describe("a link that only came in", () => {
  it("is completed by the keeper instead of staying one-way", async () => {
    const host = build({ name: "half-host" });
    const guest = build({ name: "half-guest" });
    const startedHost = await host.start();
    await guest.start();

    // The guest dials; the host only approves, so it holds an inbound token and
    // no outbound one. Nothing else would ever ask for that missing half.
    const connecting = guest.connect(`127.0.0.1:${startedHost.port}`, {
      scopes: ["chat"],
      wait: true,
      timeoutMs: 10_000,
    });
    await waitFor(() => host.pendingRequests().length === 1);
    host.decide(host.pendingRequests()[0].requestId, true, ["chat"]);
    assert.equal((await connecting).status, "connected");

    const half = host.snapshot().connections[0];
    assert.ok(half.inToken, "the host can receive");
    assert.equal(half.outToken, undefined, "but cannot send yet");

    // Make each side known to the other, as an approval would.
    host.peers.touch(
      { nodeId: "n_test_half-guest", publicKey: pubOf("half-guest"), name: "half-guest", host: "127.0.0.1", port: guest.port ?? 1 },
      { trusted: true, autoConnect: true, scopes: ["chat"] },
    );
    guest.peers.touch(
      { nodeId: "n_test_half-host", publicKey: pubOf("half-host"), name: "half-host", host: "127.0.0.1", port: startedHost.port },
      { trusted: true, scopes: ["chat"] },
    );

    await waitFor(() => Boolean(host.snapshot().connections[0]?.outToken), 15_000, 100);
    const whole = host.snapshot().connections[0];
    assert.ok(whole.outToken, "the keeper completed the link");
    assert.deepEqual(whole.grantedToMe, ["chat"], "with what the guest granted");
  });
});
