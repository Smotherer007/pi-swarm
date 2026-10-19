import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { PeerStore } from "../src/peers.ts";
import { rmrf, tempDir } from "./helpers.ts";

const dirs: string[] = [];

function store(filePath?: string): { peers: PeerStore; file: string } {
  const dir = filePath ? path.dirname(filePath) : tempDir("pi-swarm-peers");
  if (!filePath) dirs.push(dir);
  const file = filePath ?? path.join(dir, "peers.json");
  return {
    peers: new PeerStore({ filePath: file, defaultScopes: ["chat", "knowledge:read"] }),
    file,
  };
}

const ref = { nodeId: "n_a", name: "alpha", host: "127.0.0.1", port: 47823 };

afterEach(() => {
  for (const dir of dirs.splice(0)) rmrf(dir);
});

describe("PeerStore", () => {
  it("starts empty and requires no file", () => {
    const { peers } = store();
    assert.equal(peers.count(), 0);
    assert.equal(peers.get("n_a"), undefined);
  });

  it("records a peer with defaults that are safe", () => {
    const { peers } = store();
    const peer = peers.touch(ref);
    assert.equal(peer.autoConnect, false);
    assert.equal(peer.trusted, false);
    assert.equal(peer.banned, false);
    assert.deepEqual(peer.scopes, ["chat", "knowledge:read"]);
    assert.ok(peer.lastSeen > 0);
  });

  it("persists across instances", () => {
    const { peers, file } = store();
    peers.touch(ref, { trusted: true, autoConnect: true });
    const reloaded = new PeerStore({ filePath: file, defaultScopes: ["chat"] });
    const peer = reloaded.get("n_a");
    assert.equal(peer?.trusted, true);
    assert.equal(peer?.autoConnect, true);
  });

  it("finds peers by exact name, node id and partial name", () => {
    const { peers } = store();
    peers.touch(ref);
    assert.equal(peers.byName("alpha")?.nodeId, "n_a");
    assert.equal(peers.byName("n_a")?.nodeId, "n_a");
    assert.equal(peers.byName("alp")?.nodeId, "n_a");
    assert.equal(peers.byName("beta"), undefined);
  });

  it("refuses to update an unknown peer", () => {
    const { peers } = store();
    assert.throws(() => peers.update("n_missing", { trusted: true }), /Unknown peer/);
  });

  it("clears trust and auto-connect when a peer is banned", () => {
    const { peers } = store();
    peers.touch(ref, { trusted: true, autoConnect: true });
    const banned = peers.update("n_a", { banned: true });
    assert.equal(banned.banned, true);
    assert.equal(banned.trusted, false);
    assert.equal(banned.autoConnect, false);
  });

  it("stores scopes normalized", () => {
    const { peers } = store();
    peers.touch(ref);
    const updated = peers.update("n_a", { scopes: ["knowledge:write", "chat", "chat"] });
    assert.deepEqual(updated.scopes, ["chat", "knowledge:write"]);
  });

  it("forgets a peer", () => {
    const { peers } = store();
    peers.touch(ref);
    assert.equal(peers.forget("n_a"), true);
    assert.equal(peers.forget("n_a"), false);
    assert.equal(peers.count(), 0);
  });

  it("survives a corrupt file by starting empty", () => {
    const dir = tempDir("pi-swarm-peers-bad");
    dirs.push(dir);
    const file = path.join(dir, "peers.json");
    fs.writeFileSync(file, "{ nope");
    const peers = new PeerStore({ filePath: file, defaultScopes: ["chat"] });
    assert.equal(peers.count(), 0);
    peers.touch(ref);
    assert.equal(peers.count(), 1);
  });

  it("ignores entries of the wrong shape", () => {
    const dir = tempDir("pi-swarm-peers-shape");
    dirs.push(dir);
    const file = path.join(dir, "peers.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ peers: [{ nodeId: "n_ok", name: "ok", host: "h", port: 1 }, { nope: true }] }),
    );
    const peers = new PeerStore({ filePath: file, defaultScopes: ["chat"] });
    assert.equal(peers.count(), 1);
  });
});
