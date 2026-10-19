/**
 * A swarm session outlives a restart.
 *
 * The shared knowledge board is stored per session, and the retention setting
 * keeps those directories for days -- so a fresh session id on every start
 * would quietly contradict that and throw the board away.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import { SwarmNode } from "../src/swarm.ts";
import { makeConfig, makeIdentity, rmrf, tempDir } from "./helpers.ts";

const dirs: string[] = [];
const nodes: SwarmNode[] = [];

after(async () => {
  for (const node of nodes.splice(0)) await node.stop().catch(() => {});
  for (const dir of dirs.splice(0)) rmrf(dir);
});

function instance(root: string, name: string, port = 0): SwarmNode {
  const node = new SwarmNode({
    config: makeConfig({ name, port }),
    identity: makeIdentity("persist"),
    peersPath: path.join(root, "peers.json"),
    sessionsDir: path.join(root, "sessions"),
    instanceDir: null,
    discovery: false,
  });
  nodes.push(node);
  return node;
}

describe("the swarm session", () => {
  it("resumes instead of starting empty, so the board survives a restart", async () => {
    const root = tempDir("pi-swarm-persist");
    dirs.push(root);

    const first = instance(root, "persist-one");
    await first.start();
    await first.putKnowledge([{ key: "bleibt", text: "ueberlebt den Neustart" }]);
    const sessionId = first.currentSessionId;
    assert.ok(sessionId);
    assert.equal(first.knowledgeBase?.size, 1);
    await first.stop();

    const second = instance(root, "persist-two");
    await second.start();
    assert.equal(second.currentSessionId, sessionId, "same session after the restart");
    assert.equal(second.knowledgeBase?.size, 1, "and the entry is still there");
    await second.stop();
  });

  it("starts fresh when the remembered session was pruned", async () => {
    const root = tempDir("pi-swarm-pruned");
    dirs.push(root);

    const first = instance(root, "pruned-one");
    await first.start();
    const sessionId = first.currentSessionId;
    await first.stop();

    // Retention removed the directory; the pointer alone must not resurrect it.
    rmrf(path.join(root, "sessions", String(sessionId)));

    const second = instance(root, "pruned-two");
    await second.start();
    assert.notEqual(second.currentSessionId, sessionId);
    await second.stop();
  });
});
