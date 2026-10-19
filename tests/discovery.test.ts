import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { Discovery } from "../src/discovery.ts";
import type { DiscoveredPeer } from "../src/types.ts";
import { rmrf, tempDir, waitFor } from "./helpers.ts";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

describe("Discovery", () => {
  it("finds another instance on the same machine through the instance registry", async () => {
    const dir = tempDir("pi-swarm-disc");
    cleanup.push(() => rmrf(dir));

    const seenA: DiscoveredPeer[] = [];
    const seenB: DiscoveredPeer[] = [];

    const a = new Discovery({
      nodeId: "n_a",
      name: "alpha",
      port: 1111,
      sessionId: "s_1",
      accepting: true,
      multicast: false,
      intervalSeconds: 2,
      instanceDir: dir,
      onPeer: (peer) => seenA.push(peer),
    });
    const b = new Discovery({
      nodeId: "n_b",
      name: "beta",
      port: 2222,
      sessionId: null,
      accepting: true,
      multicast: false,
      intervalSeconds: 2,
      instanceDir: dir,
      onPeer: (peer) => seenB.push(peer),
    });
    cleanup.push(() => a.stop());
    cleanup.push(() => b.stop());

    await a.start();
    await b.start();
    await a.announce();
    await b.announce();

    assert.equal(seenA.some((peer) => peer.nodeId === "n_a"), false, "a node never sees itself");
    const beta = seenA.find((peer) => peer.nodeId === "n_b");
    assert.ok(beta, "alpha should see beta in the registry");
    assert.equal(beta.host, "127.0.0.1");
    assert.equal(beta.port, 2222);
    assert.equal(beta.via, "local");
    assert.equal(seenB.some((peer) => peer.nodeId === "n_a"), true);
  });

  it("removes the registry entry on stop", async () => {
    const dir = tempDir("pi-swarm-disc-stop");
    cleanup.push(() => rmrf(dir));

    const a = new Discovery({
      nodeId: "n_stop",
      name: "stopper",
      port: 3333,
      sessionId: null,
      accepting: true,
      multicast: false,
      intervalSeconds: 2,
      instanceDir: dir,
      onPeer: () => {},
    });
    await a.start();
    const files = fs.readdirSync(dir);
    assert.equal(files.length, 1);
    await a.stop();
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("prunes a registry entry whose process is gone", async () => {
    const dir = tempDir("pi-swarm-disc-stale");
    cleanup.push(() => rmrf(dir));
    fs.writeFileSync(
      path.join(dir, "n_dead.json"),
      JSON.stringify({
        proto: "pi-swarm/2",
        nodeId: "n_dead",
        name: "ghost",
        port: 4444,
        sessionId: null,
        accepting: true,
        pid: 999_999,
        updatedAt: Date.now(),
      }),
    );

    const seen: DiscoveredPeer[] = [];
    const a = new Discovery({
      nodeId: "n_alive",
      name: "alive",
      port: 5555,
      sessionId: null,
      accepting: true,
      multicast: false,
      intervalSeconds: 2,
      instanceDir: dir,
      onPeer: (peer) => seen.push(peer),
    });
    cleanup.push(() => a.stop());

    await a.start();
    await a.announce();
    assert.equal(seen.some((peer) => peer.nodeId === "n_dead"), false);
    assert.equal(fs.existsSync(path.join(dir, "n_dead.json")), false);
  });

  it("publishes state changes in the registry", async () => {
    const dir = tempDir("pi-swarm-disc-state");
    cleanup.push(() => rmrf(dir));

    const reader: DiscoveredPeer[] = [];
    const writer = new Discovery({
      nodeId: "n_writer",
      name: "writer",
      port: 6666,
      sessionId: null,
      accepting: true,
      multicast: false,
      intervalSeconds: 2,
      instanceDir: dir,
      onPeer: () => {},
    });
    const observer = new Discovery({
      nodeId: "n_observer",
      name: "observer",
      port: 7777,
      sessionId: null,
      accepting: true,
      multicast: false,
      intervalSeconds: 2,
      instanceDir: dir,
      onPeer: (peer) => reader.push(peer),
    });
    cleanup.push(() => writer.stop());
    cleanup.push(() => observer.stop());

    await writer.start();
    await observer.start();
    writer.setState({ sessionId: "s_shared", accepting: false });
    await observer.announce();

    await waitFor(() => reader.some((peer) => peer.sessionId === "s_shared"));
    const peer = reader.filter((candidate) => candidate.nodeId === "n_writer").at(-1)!;
    assert.equal(peer.accepting, false);

    writer.setInvitation("help with the tile cutter");
    await observer.announce();
    const invited = reader
      .filter((candidate) => candidate.nodeId === "n_writer")
      .at(-1)!;
    assert.equal(invited.invitation, "help with the tile cutter");

    writer.setInvitation(null);
    await observer.announce();
    assert.equal(
      reader.filter((candidate) => candidate.nodeId === "n_writer").at(-1)!.invitation,
      undefined,
    );
  });
});
