/**
 * Several pi processes on one machine.
 *
 * Two agents on the same host must be two nodes: own identity, own peer book,
 * own port -- and they find each other through the local registry, because
 * multicast alone is not enough when both sit behind one address.
 */

import { describe, it, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { SwarmNode } from "../src/swarm.ts";
import {
  configFilePath,
  identityFilePath,
  instanceDir,
  instanceSlug,
  peersFilePath,
} from "../src/paths.ts";
import { defaultName, loadIdentity } from "../src/identity.ts";
import { makeConfig, rmrf, tempDir, waitFor } from "./helpers.ts";

const savedHome = process.env.PI_SWARM_HOME;
const savedInstance = process.env.PI_SWARM_INSTANCE;
const dirs: string[] = [];
const nodes: SwarmNode[] = [];

beforeEach(() => {
  const home = tempDir("pi-swarm-home");
  dirs.push(home);
  process.env.PI_SWARM_HOME = home;
  delete process.env.PI_SWARM_INSTANCE;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.PI_SWARM_HOME;
  else process.env.PI_SWARM_HOME = savedHome;
  if (savedInstance === undefined) delete process.env.PI_SWARM_INSTANCE;
  else process.env.PI_SWARM_INSTANCE = savedInstance;
});

after(async () => {
  for (const node of nodes.splice(0)) await node.stop().catch(() => {});
  for (const dir of dirs.splice(0)) rmrf(dir);
});

describe("the instance slot", () => {
  it("leaves the primary instance on the historical paths", () => {
    assert.equal(instanceSlug(), "");
    assert.match(identityFilePath(), /swarm-identity\.json$/);
    assert.match(peersFilePath(), /swarm-peers\.json$/);
    assert.match(configFilePath(), /swarm-config\.json$/);
  });

  it("gives a named slot its own files", () => {
    process.env.PI_SWARM_INSTANCE = "worker";
    assert.equal(instanceSlug(), "worker");
    assert.match(identityFilePath(), /swarm-identity-worker\.json$/);
    assert.match(peersFilePath(), /swarm-peers-worker\.json$/);
    assert.match(configFilePath(), /swarm-config-worker\.json$/);
    // Same base directory: one pi home, several instances.
    assert.equal(path.dirname(identityFilePath()), path.dirname(peersFilePath()));
  });

  it("normalizes a slot name into a usable file name", () => {
    process.env.PI_SWARM_INSTANCE = "  My Worker!? ";
    assert.equal(instanceSlug(), "my-worker");
    process.env.PI_SWARM_INSTANCE = "___";
    assert.equal(instanceSlug(), "");
  });

  it("gives each slot its own identity, and keeps it across loads", () => {
    const primary = loadIdentity();
    process.env.PI_SWARM_INSTANCE = "worker";
    const worker = loadIdentity();
    assert.notEqual(worker.nodeId, primary.nodeId);
    assert.equal(loadIdentity().nodeId, worker.nodeId, "the slot keeps its id");
    delete process.env.PI_SWARM_INSTANCE;
    assert.equal(loadIdentity().nodeId, primary.nodeId, "and the primary keeps its own");
  });

  it("makes the default display name tell the instances apart", () => {
    const primary = defaultName();
    const worker = defaultName("worker");
    assert.notEqual(primary, worker);
    assert.match(worker, /\/worker$/);
  });
});

describe("two instances on one machine", () => {
  it("find each other through the local registry and can connect", async () => {
    const primary = loadIdentity();
    process.env.PI_SWARM_INSTANCE = "worker";
    const worker = loadIdentity();

    // What a real second pi gets: the same registry directory, nothing else.
    const registry = instanceDir();

    const a = new SwarmNode({
      config: makeConfig({ name: `pi@host` }),
      identity: primary,
      peersPath: peersFilePath(),
      sessionsDir: path.join(registry, "..", "sessions-a"),
      instanceDir: registry,
      discovery: false,
    });
    const b = new SwarmNode({
      config: makeConfig({ name: `pi@host/worker` }),
      identity: worker,
      peersPath: peersFilePath(),
      sessionsDir: path.join(registry, "..", "sessions-b"),
      instanceDir: registry,
      discovery: false,
    });
    nodes.push(a, b);

    const startedA = await a.start();
    const startedB = await b.start();
    assert.notEqual(startedA.port, startedB.port, "they cannot share one port");

    await waitFor(
      () => a.snapshot().discovered.some((peer) => peer.nodeId === worker.nodeId),
      15_000,
      100,
    );
    await waitFor(
      () => b.snapshot().discovered.some((peer) => peer.nodeId === primary.nodeId),
      15_000,
      100,
    );

    const connecting = b.connect(`127.0.0.1:${startedA.port}`, {
      scopes: ["chat"],
      wait: true,
      timeoutMs: 15_000,
    });
    await waitFor(() => a.pendingRequests().length === 1, 15_000, 50);
    a.decide(a.pendingRequests()[0].requestId, true, ["chat"]);
    const attempt = await connecting;
    assert.equal(attempt.status, "connected", attempt.reason);
    assert.equal(a.snapshot().connections.length, 1);
  });
});
