/**
 * swarm_connect -- request a connection to one peer.
 *
 * The peer decides. With wait=true (default) this tool polls until the peer
 * approves, denies or the timeout passes, because a pending request is not a
 * connection and pretending otherwise is the classic way to lose a message.
 */

import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { formatAttempts } from "../formatting/formatters.ts";
import { runtime } from "../runtime.ts";
import type { Scope } from "../types.ts";

const scopeLiterals = [
  Type.Literal("chat"),
  Type.Literal("knowledge:read"),
  Type.Literal("knowledge:write"),
  Type.Literal("peers:share"),
  Type.Literal("session:invite"),
];

export const SwarmConnectTool: ToolDefinition = {
  name: "swarm_connect",
  label: "Swarm Connect",
  description:
    "Ask one pi agent to connect. The target is a peer name, node id, or host:port. The other node decides: a known, trusted peer may be approved automatically, anyone else queues a request that its agent or user has to approve. With wait=true (default) the tool polls until that decision arrives. Returns the scopes actually granted by the peer, which bound what this node may do there.",
  parameters: Type.Object({
    peer: Type.String({ description: "Peer name, node id, or host:port." }),
    scopes: Type.Optional(
      Type.Array(Type.Union(scopeLiterals), {
        description:
          "Scopes to ask for. Default: the scopes stored for a known peer, otherwise the configured default scopes.",
      }),
    ),
    message: Type.Optional(
      Type.String({ description: "Short note sent with the request, shown in the peer's request queue." }),
    ),
    wait: Type.Optional(
      Type.Boolean({
        description: "Poll for the peer's decision instead of returning a pending request immediately. Default true.",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({ description: "How long to wait for the decision. Default 60, maximum 300." }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: { peer: string; scopes?: Scope[]; message?: string; wait?: boolean; timeoutSeconds?: number },
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: ExtensionContext,
  ) {
    const node = await runtime().node(ctx);
    const timeoutMs = Math.min(Math.max(params.timeoutSeconds ?? 60, 5), 300) * 1000;

    const attempt = await node.connect(params.peer, {
      scopes: params.scopes,
      message: params.message,
      wait: params.wait ?? true,
      timeoutMs,
    });

    // An abort in the middle of the wait is not a failure of the link: the peer
    // may already have approved, and a pending request stays in its queue. Say
    // what actually happened instead of calling everything "aborted".
    if (signal?.aborted && attempt.status !== "connected") {
      const stillPending = attempt.status === "pending";
      return {
        content: [
          {
            type: "text" as const,
            text: [
              "Stopped waiting for the peer's decision.",
              stillPending
                ? `The request${attempt.requestId ? ` (${attempt.requestId})` : ""} stays queued there; swarm_connect again resumes it.`
                : "The attempt did not end in a link.",
              "",
              formatAttempts([attempt]),
            ].join("\n"),
          },
        ],
        details: { attempt },
        isError: !stillPending && attempt.status === "denied",
      };
    }

    return {
      content: [{ type: "text" as const, text: formatAttempts([attempt]) }],
      details: { attempt },
      isError: attempt.status === "denied" || attempt.status === "unreachable",
    };
  },
};
