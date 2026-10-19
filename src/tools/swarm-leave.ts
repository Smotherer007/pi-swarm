/**
 * swarm_leave -- stop listening and close every link.
 *
 * The session knowledge stays on disk (pruned after the retention window), so
 * leaving does not lose what the swarm worked out.
 */

import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { runtime } from "../runtime.ts";

export const SwarmLeaveTool: ToolDefinition = {
  name: "swarm_leave",
  label: "Swarm Leave",
  description:
    "Leave the swarm: disconnect every peer, stop the discovery beacon and close the listening port. Shared knowledge of this session stays on disk and can be reopened by starting the node again. Use it when a collaboration is finished or when this node should stop being reachable.",
  parameters: Type.Object({}),

  async execute(
    _toolCallId: string,
    _params: Record<string, never>,
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: ExtensionContext,
  ) {
    const node = runtime().peek();
    if (!node || !node.isRunning) {
      return {
        content: [{ type: "text" as const, text: "This node is not running, so there was nothing to leave." }],
        details: { wasRunning: false },
      };
    }
    const snapshot = node.snapshot();
    const knowledge = node.knowledgeBase;
    await runtime().stop();
    ctx.ui.setStatus("swarm", undefined);

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `Left the swarm: disconnected ${snapshot.connections.length} peer(s), stopped discovery, closed port ${snapshot.port}.`,
            knowledge
              ? `Shared knowledge (${knowledge.size} entries, session ${knowledge.sessionId}) is saved on this node.`
              : "No session knowledge was open.",
            "The next swarm tool starts the node again.",
          ].join("\n"),
        },
      ],
      details: {
        wasRunning: true,
        disconnected: snapshot.connections.map((connection) => connection.name),
        sessionId: knowledge?.sessionId ?? null,
        knowledge: knowledge?.size ?? 0,
      },
    };
  },
};
