/**
 * swarm_status -- everything about this node in one look.
 *
 * Does not start the node: a status call must not open a port by surprise.
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
    const snapshot = node.snapshot();
    return {
      content: [{ type: "text" as const, text: formatStatus(snapshot) }],
      details: snapshot,
    };
  },
};
