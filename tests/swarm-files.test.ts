/**
 * File transfer between two real nodes.
 *
 * The properties worth proving are the ones that are expensive to add later:
 * the offered name never becomes a path, the receiver pulls and verifies the
 * bytes itself, an offer is single use, and nothing enters the conversation.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { SwarmNode } from "../src/swarm.ts";
import { makeConfig, makeIdentity, rmrf, tempDir, waitFor } from "./helpers.ts";

const dirs: string[] = [];
const nodes: SwarmNode[] = [];

after(async () => {
  for (const node of nodes.splice(0)) await node.stop().catch(() => {});
  for (const dir of dirs.splice(0)) rmrf(dir);
});

interface Fixture {
  host: SwarmNode;
  guest: SwarmNode;
  hostFiles: string;
  guestFiles: string;
  port: number;
}

/** Two nodes, connected both ways, with the file scopes negotiated. */
async function fixture(
  name: string,
  options: { hostPolicy?: "ask" | "auto" | "deny" } = {},
): Promise<Fixture> {
  const root = tempDir(`pi-swarm-${name}`);
  dirs.push(root);
  const hostFiles = path.join(root, "host-files");
  const guestFiles = path.join(root, "guest-files");

  const host = new SwarmNode({
    config: makeConfig({
      name: "filehost",
      inboundPolicy: "known-auto",
      defaultScopes: ["chat", "files:write"],
      filesPolicy: options.hostPolicy ?? "ask",
    }),
    identity: makeIdentity(`filehost-${name}`),
    peersPath: path.join(root, "host-peers.json"),
    sessionsDir: path.join(root, "host-sessions"),
    filesPath: hostFiles,
    instanceDir: null,
    discovery: false,
  });
  const guest = new SwarmNode({
    config: makeConfig({
      name: "fileguest",
      inboundPolicy: "known-auto",
      defaultScopes: ["chat", "files:read"],
    }),
    identity: makeIdentity(`fileguest-${name}`),
    peersPath: path.join(root, "guest-peers.json"),
    sessionsDir: path.join(root, "guest-sessions"),
    filesPath: guestFiles,
    instanceDir: null,
    discovery: false,
  });
  nodes.push(host, guest);

  const started = await host.start();
  await guest.start();

  // guest -> host, so the guest may offer files
  const forward = guest.connect(`127.0.0.1:${started.port}`, {
    scopes: ["chat", "files:write"],
    wait: true,
    timeoutMs: 10_000,
  });
  await waitFor(() => host.pendingRequests().length === 1);
  host.decide(host.pendingRequests()[0].requestId, true, ["chat", "files:write"]);
  assert.equal((await forward).status, "connected");

  // host -> guest, so the host may collect a file the guest offers
  const back = host.connect(`127.0.0.1:${guest.port ?? 0}`, {
    scopes: ["chat", "files:read"],
    wait: true,
    timeoutMs: 10_000,
  });
  await waitFor(() => guest.pendingRequests().length === 1);
  guest.decide(guest.pendingRequests()[0].requestId, true, ["chat", "files:read"]);
  assert.equal((await back).status, "connected");

  return { host, guest, hostFiles, guestFiles, port: started.port };
}

describe("file transfer", () => {
  it("moves a file, verifies it and stores it under its own id", async () => {
    const { host, guest, hostFiles } = await fixture("move");

    const source = path.join(dirs[dirs.length - 1], "report.txt");
    fs.writeFileSync(source, "zahlen, die nur im file stehen\n", "utf-8");
    const expected = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");

    const offered = await guest.offerFile("filehost", source);
    assert.equal(offered.status, "pending", "policy ask leaves the decision to the receiver");

    const offers = host.fileOffers();
    assert.equal(offers.length, 1);
    assert.equal(offers[0].displayName, "report.txt");
    assert.equal(offers[0].sha256, expected);

    const accepted = await host.acceptFile(offers[0].offerId);
    assert.equal(accepted.sha256, expected);
    assert.equal(fs.readFileSync(accepted.storedPath, "utf-8"), "zahlen, die nur im file stehen\n");

    // Stored under the transfer id, inside the sender's directory.
    assert.match(accepted.storedPath, new RegExp(`${hostFiles}.*f_[a-f0-9]+\\.bin$`));

    const listed = host.receivedFiles();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].displayName, "report.txt");
    assert.equal(listed[0].size, fs.statSync(accepted.storedPath).size);
  });

  it("never lets the offered name become a path", async () => {
    const { host, guest, hostFiles } = await fixture("traversal");
    const source = path.join(dirs[dirs.length - 1], "..-.txt");
    fs.writeFileSync(source, "harmlos\n", "utf-8");

    // A sender that names its file like a path traversal attempt.
    const sneaky = path.join(dirs[dirs.length - 1], "payload");
    fs.writeFileSync(sneaky, "x\n", "utf-8");
    const offered = await guest.offerFile("filehost", sneaky);
    assert.ok(offered.offerId);

    const offer = host.fileOffers()[0];
    offer.displayName = "../../etc/passwd";
    const accepted = await host.acceptFile(offer.offerId);
    assert.ok(
      accepted.storedPath.startsWith(hostFiles),
      `stored inside the files dir, got ${accepted.storedPath}`,
    );
    assert.equal(path.basename(accepted.storedPath), `${offer.offerId}.bin`);
  });

  it("serves an offer once", async () => {
    const { host, guest } = await fixture("once");
    const source = path.join(dirs[dirs.length - 1], "once.txt");
    fs.writeFileSync(source, "einmal\n", "utf-8");

    const offered = await guest.offerFile("filehost", source);
    const offerId = host.fileOffers()[0].offerId;
    await host.acceptFile(offerId);

    await assert.rejects(() => host.acceptFile(offerId), /already collected|No offer/);
    assert.equal(offered.offerId, offerId);
  });

  it("refuses everything when the policy says deny", async () => {
    const { guest } = await fixture("deny", { hostPolicy: "deny" });
    const source = path.join(dirs[dirs.length - 1], "nope.txt");
    fs.writeFileSync(source, "nein\n", "utf-8");

    await assert.rejects(() => guest.offerFile("filehost", source), /does not accept files/);
  });
});
