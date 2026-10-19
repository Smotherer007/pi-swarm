/**
 * What a sniffer on the wire sees, and that a forwarded address survives.
 *
 * Every byte between the two nodes runs through a capturing TCP forwarder, the
 * way an SSH tunnel or a port forward would carry it. The capture must contain
 * the traffic -- and none of the secrets in it.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import { SwarmNode } from "../src/swarm.ts";
import { makeConfig, makeIdentity, rmrf, tempDir, waitFor } from "./helpers.ts";

const dirs: string[] = [];
const nodes: SwarmNode[] = [];
const servers: net.Server[] = [];

after(async () => {
  for (const node of nodes.splice(0)) await node.stop().catch(() => {});
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) rmrf(dir);
});

function makeNode(name: string): SwarmNode {
  const root = tempDir(`pi-swarm-wire-${name}`);
  dirs.push(root);
  const node = new SwarmNode({
    config: makeConfig({ name, inboundPolicy: "known-auto" }),
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

/** A TCP forwarder that keeps a copy of everything in both directions. */
async function forwarder(targetPort: number): Promise<{ port: number; captured: () => string }> {
  const chunks: Buffer[] = [];
  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, "127.0.0.1");
    client.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
      client.write(chunk);
    });
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.end());
    upstream.on("close", () => client.end());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { port, captured: () => Buffer.concat(chunks).toString("latin1") };
}

describe("on the wire", () => {
  it("carries messages, knowledge, files and tokens only sealed, and keeps the forwarded address", async () => {
    const alpha = makeNode("wire-alpha");
    const bravo = makeNode("wire-bravo");
    const a = await alpha.start();
    const b = await bravo.start();
    const toAlpha = await forwarder(a.port);
    const toBravo = await forwarder(b.port);

    // bravo -> alpha through one forwarder, alpha -> bravo through the other
    const first = bravo.connect(`127.0.0.1:${toAlpha.port}`, {
      scopes: ["chat", "knowledge:read", "files:write"],
      wait: true,
      timeoutMs: 10_000,
    });
    await waitFor(() => alpha.pendingRequests().length === 1);
    alpha.decide(alpha.pendingRequests()[0].requestId, true, ["chat", "knowledge:read", "files:write"]);
    assert.equal((await first).status, "connected");

    const second = alpha.connect(`127.0.0.1:${toBravo.port}`, {
      scopes: ["chat", "files:read"],
      wait: true,
      timeoutMs: 10_000,
    });
    await waitFor(() => bravo.pendingRequests().length === 1);
    bravo.decide(bravo.pendingRequests()[0].requestId, true, ["chat", "files:read"]);
    assert.equal((await second).status, "connected");

    // The inbound handshake from alpha must not move bravo's outbound half
    // away from the forwarder it dialed.
    const bravoToAlpha = bravo.snapshot().connections.find((c) => c.nodeId === alpha.identity.nodeId)!;
    assert.equal(bravoToAlpha.port, toAlpha.port, "the outbound address is the one that was dialed");
    assert.equal(bravo.peers.get(alpha.identity.nodeId)?.port, toAlpha.port);

    const message = `secret-message-${crypto.randomBytes(6).toString("hex")}`;
    const knowledge = `secret-knowledge-${crypto.randomBytes(6).toString("hex")}`;
    const content = `secret-file-${crypto.randomBytes(6).toString("hex")}`;

    assert.deepEqual((await bravo.say(message, { to: "wire-alpha" })).delivered, ["wire-alpha"]);
    await alpha.putKnowledge([{ key: "k", text: knowledge }]);
    await bravo.syncAll();
    assert.ok(bravo.knowledgeBase!.all().some((entry) => entry.text === knowledge));

    const source = path.join(dirs[0], "secret.txt");
    fs.writeFileSync(source, content);
    const offered = await bravo.offerFile("wire-alpha", source);
    const accepted = await alpha.acceptFile(offered.offerId);
    assert.equal(fs.readFileSync(accepted.storedPath, "utf-8"), content);

    const wire = toAlpha.captured() + toBravo.captured();
    assert.match(wire, /POST \/swarm\/v1\/message/, "the forwarders carried the traffic");
    assert.match(wire, /\/swarm\/v1\/files\//);
    for (const secret of [message, knowledge, content]) {
      assert.equal(wire.includes(secret), false, `"${secret.split("-")[1]}" is readable on the wire`);
    }
    const internals = [alpha, bravo].flatMap((node) =>
      [...(node as unknown as { connections: Map<string, { inToken?: string; outToken?: string }> }).connections.values()].flatMap(
        (connection) => [connection.inToken, connection.outToken],
      ),
    );
    const tokens = internals.filter((token): token is string => Boolean(token));
    assert.ok(tokens.length >= 4);
    for (const token of tokens) assert.equal(wire.includes(token), false, "a token is readable on the wire");
    assert.equal(/authorization:/i.test(wire), false);
  });
});
