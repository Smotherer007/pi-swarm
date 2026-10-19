/**
 * swarm_discover -- announce this node and list who answers.
 *
 * Starts the node on first use (that is what makes it reachable), announces on
 * the multicast group, waits for beacons, and probes the peers already in the
 * peer book so a node on another subnet is still found by address.
 */

import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { formatPeerList } from "../formatting/formatters.ts";
import { runtime } from "../runtime.ts";

export const SwarmDiscoverTool: ToolDefinition = {
  name: "swarm_discover",
  label: "Swarm Discover",
  description:
    "Announce this node and list the pi agents reachable on this network, with their connection state, trust flags and whether they accept connections. Also probes known peers by address, so a peer outside the multicast domain still shows up. Starts the node if it is not running.",
  parameters: Type.Object({
    timeoutSeconds: Type.Optional(
      Type.Number({ description: "How long to listen for beacons. Default 3, maximum 15." }),
    ),
    probeKnown: Type.Optional(
      Type.Boolean({
        description: "Also ask known peers directly by address (default true).",
      }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: { timeoutSeconds?: number; probeKnown?: boolean },
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: ExtensionContext,
  ) {
    const node = await runtime().node(ctx);
    const seconds = Math.min(Math.max(params.timeoutSeconds ?? 3, 1), 15);
    const outcome = await node.discover({
      timeoutMs: seconds * 1000,
      probeKnown: params.probeKnown ?? true,
    });
    const snapshot = node.snapshot();

    return {
      content: [
        {
          type: "text" as const,
          text: formatPeerList(
            outcome.peers,
            node.peers.list(),
            snapshot.connections,
            snapshot.pending,
          ),
        },
      ],
      details: {
        multicast: outcome.multicast,
        warnings: outcome.warnings,
        peers: outcome.peers.map((peer) => ({
          nodeId: peer.nodeId,
          name: peer.name,
          host: peer.host,
          port: peer.port,
          via: peer.via,
          accepting: peer.accepting,
          sessionId: peer.sessionId,
        })),
      },
    };
  },
};
