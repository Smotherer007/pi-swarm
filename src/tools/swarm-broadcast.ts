/**
 * swarm_broadcast -- the swarm's "who is there?" call, in two directions.
 *
 * connect: this node announces itself and asks every reachable peer for a
 *          connection; each peer decides whether to accept.
 * invite:  this node announces an open session and waits; the peers ask to
 *          connect, and their requests land in this node's queue.
 */

import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { formatAttempts, formatPeerList } from "../formatting/formatters.ts";
import { runtime } from "../runtime.ts";
import type { Scope } from "../types.ts";

const scopeLiterals = [
  Type.Literal("chat"),
  Type.Literal("knowledge:read"),
  Type.Literal("knowledge:write"),
  Type.Literal("peers:share"),
  Type.Literal("session:invite"),
];

export const SwarmBroadcastTool: ToolDefinition = {
  name: "swarm_broadcast",
  label: "Swarm Broadcast",
  description:
    "Reach every pi agent on the network at once. mode=connect (default) asks each of them for a connection; mode=invite publishes an open invitation to join this session and lets them ask you instead, which is the safer direction because every request still lands in swarm_requests. Both start the node, announce on the multicast group, and report who is visible.",
  parameters: Type.Object({
    mode: Type.Optional(
      Type.Union([Type.Literal("connect"), Type.Literal("invite")], {
        description:
          "connect: this node requests a link to everyone. invite: this node broadcasts an open session and peers request the link.",
      }),
    ),
    message: Type.Optional(
      Type.String({
        description:
          "One line: what this node is working on, or what joining gives the other agent. For mode=invite this is the invitation itself.",
      }),
    ),
    scopes: Type.Optional(
      Type.Array(Type.Union(scopeLiterals), {
        description: "mode=connect: scopes to request from everyone. Default: the configured default scopes.",
      }),
    ),
    wait: Type.Optional(
      Type.Boolean({
        description: "mode=connect: wait for each peer's decision. Default false: return pending requests.",
      }),
    ),
    timeoutSeconds: Type.Optional(
      Type.Number({
        description: "mode=connect: per-peer wait (default 30). mode=invite: how long the invitation stays valid (default 300).",
      }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: {
      mode?: "connect" | "invite";
      message?: string;
      scopes?: Scope[];
      wait?: boolean;
      timeoutSeconds?: number;
    },
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: ExtensionContext,
  ) {
    const node = await runtime().node(ctx);
    const mode = params.mode ?? "connect";

    if (mode === "invite") {
      const published = await node.invite(
        params.message ?? "open swarm session: connect if you can help with the current task",
        { durationSeconds: params.timeoutSeconds ?? 300 },
      );
      const snapshot = node.snapshot();
      const text = [
        published.published
          ? `Invitation published for ${published.durationSeconds}s: "${node.currentInvitation()}".`
          : "The invitation is set, but discovery is off on this node, so nobody will hear it. Enable it with swarm_setup discovery=true, or let peers connect by address.",
        "",
        formatPeerList(published.peers, node.peers.list(), snapshot.connections, snapshot.pending),
        "",
        "Peers that hear it ask to connect; their requests appear in swarm_requests unless this node's policy auto-approves them.",
      ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
        details: {
          mode,
          invitation: node.currentInvitation(),
          durationSeconds: published.durationSeconds,
          published: published.published,
          peers: published.peers,
          warnings: published.warnings,
        },
      };
    }

    const outcome = await node.broadcast({
      scopes: params.scopes,
      message: params.message,
      wait: params.wait ?? false,
      timeoutMs: Math.min(Math.max(params.timeoutSeconds ?? 30, 5), 120) * 1000,
    });

    return {
      content: [
        { type: "text" as const, text: formatAttempts(outcome.attempts, outcome.warnings) },
      ],
      details: {
        mode,
        attempts: outcome.attempts,
        warnings: outcome.warnings,
        connected: node.snapshot().connections.length,
      },
    };
  },
};
