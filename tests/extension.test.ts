/**
 * Loads the extension the way pi does and drives its tools through a fake API.
 *
 * This catches the wiring mistakes unit tests cannot see: a tool that is
 * registered under a different name than its file, a runtime that was never
 * installed, a tool that throws on its first call.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import extension from "../index.ts";
import { rmrf } from "./helpers.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-swarm-ext-"));
const originalHome = process.env.PI_SWARM_HOME;

interface FakeTool {
  name: string;
  description: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean }>;
}

const tools = new Map<string, FakeTool>();
const commands = new Map<string, { description: string; handler: (...args: unknown[]) => unknown }>();
const sentMessages: Array<{ content: unknown; options?: unknown }> = [];

const fakePi = {
  registerTool: (tool: FakeTool) => {
    tools.set(tool.name, tool);
  },
  registerCommand: (name: string, options: unknown) => {
    commands.set(name, options as { description: string; handler: () => unknown });
  },
  on: () => () => {},
  sendMessage: (message: unknown, options?: unknown) => {
    sentMessages.push({ content: message, options });
  },
  sendUserMessage: () => {},
} as unknown as ExtensionAPI;

const notices: Array<{ text: string; level: string }> = [];
const statuses: Array<string | undefined> = [];

const ctx = {
  mode: "json",
  hasUI: false,
  ui: {
    notify: (text: string, level: string) => notices.push({ text, level }),
    setStatus: (_key: string, value: string | undefined) => statuses.push(value),
  },
} as never;

before(() => {
  process.env.PI_SWARM_HOME = home;
  extension(fakePi);
});

after(() => {
  if (originalHome === undefined) delete process.env.PI_SWARM_HOME;
  else process.env.PI_SWARM_HOME = originalHome;
  rmrf(home);
});

describe("extension wiring", () => {
  it("registers every swarm tool and command", () => {
    assert.deepEqual(
      [...tools.keys()].sort(),
      [
        "swarm_broadcast",
        "swarm_connect",
        "swarm_discover",
        "swarm_file",
        "swarm_inbox",
        "swarm_knowledge",
        "swarm_leave",
        "swarm_peers",
        "swarm_requests",
        "swarm_say",
        "swarm_setup",
        "swarm_status",
      ].sort(),
    );
    assert.deepEqual([...commands.keys()].sort(), ["swarm", "swarm-broadcast", "swarm-leave"]);
    for (const tool of tools.values()) {
      assert.ok(tool.description.length > 40, `${tool.name} needs a model-facing description`);
    }
  });

  it("reports a status without opening a port", async () => {
    const result = await tools.get("swarm_status")!.execute("call", {}, undefined, undefined, ctx);
    const text = result.content[0].text ?? "";
    assert.match(text, /Swarm node/);
    assert.match(text, /not running/);
  });

  it("applies settings through swarm_setup and shows them in the status", async () => {
    const setup = await tools
      .get("swarm_setup")!
      .execute(
        "call",
        // discovery off: a test must not announce itself on the developer's LAN,
        // which is exactly what a real beacon would do.
        { name: "pi@testbed", inboundPolicy: "ask", autoConnectKnown: true, discovery: false, port: 0 },
        undefined,
        undefined,
        ctx,
      );
    assert.match(setup.content[0].text ?? "", /pi@testbed/);
    assert.match(setup.content[0].text ?? "", /auto-connect known peers: on/);

    const status = await tools.get("swarm_status")!.execute("call", {}, undefined, undefined, ctx);
    assert.match(status.content[0].text ?? "", /pi@testbed/);
    assert.match(status.content[0].text ?? "", /policy: ask/);
  });

  it("explains a connect attempt to an address nobody listens on", async () => {
    const result = await tools
      .get("swarm_connect")!
      .execute("call", { peer: "127.0.0.1:1", wait: false, timeoutSeconds: 5 }, undefined, undefined, ctx);
    const text = result.content[0].text ?? "";
    assert.match(text, /unreachable/);
    assert.equal(result.isError, true);
  });

  it("explains an empty inbox instead of pretending there is mail", async () => {
    const result = await tools.get("swarm_inbox")!.execute("call", {}, undefined, undefined, ctx);
    assert.match(result.content[0].text ?? "", /inbox is empty/);
  });

  it("lists an empty peer book with the next step", async () => {
    const result = await tools.get("swarm_peers")!.execute("call", { action: "list" }, undefined, undefined, ctx);
    assert.match(result.content[0].text ?? "", /No known peers yet/);
  });

  it("says when a connect request is unknown", async () => {
    await assert.rejects(
      tools.get("swarm_requests")!.execute("call", { action: "approve", requestId: "r_nope" }, undefined, undefined, ctx),
      /No pending request/,
    );
  });

  it("leaves a running node and cleans up", async () => {
    const result = await tools.get("swarm_leave")!.execute("call", {}, undefined, undefined, ctx);
    assert.match(result.content[0].text ?? "", /Left the swarm/);
    assert.match(result.content[0].text ?? "", /next swarm tool starts the node again/);
  });

  it("stops a node that is not running without complaining", async () => {
    const result = await tools.get("swarm_leave")!.execute("call", {}, undefined, undefined, ctx);
    assert.match(result.content[0].text ?? "", /not running/);
  });
});
