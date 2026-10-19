/**
 * swarm_status -- everything about this node in one look.
 *
 * Does not start the node: a status call must not open a port by surprise.
 * It does ask whether a quiet link is still there, because a status that keeps
 * listing a switched-off machine as connected is worse than no status.
 */

import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { formatStatus } from "../formatting/formatters.ts";
import { runtime } from "../runtime.ts";

export const SwarmStatusTool: ToolDefinition = {
  name: "swarm_status",
  label: "Swarm Status",
  description:
    "Show this swarm node: identity, listening port, session id, policy, connected peers with the scopes exchanged in both directions, pending connect requests, visible peers, inbox size and shared knowledge count. Read-only; does not start the node.",
  parameters: Type.Object({}),

  async execute() {
    const node = runtime().instance();
    const dropped = node.isRunning ? (await node.checkConnections()).dropped : [];
    const snapshot = node.snapshot();
    const lines = [formatStatus(snapshot)];
    if (dropped.length > 0) {
      lines.push(
        "",
        `Dropped ${dropped.length} link${dropped.length === 1 ? "" : "s"} that no longer answered:`,
        ...dropped.map((entry) => `- ${entry.name}: ${entry.reason}`),
      );
    }
    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      details: { ...snapshot, dropped },
    };
  },
};
