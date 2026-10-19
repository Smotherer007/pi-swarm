/**
 * swarm_peers -- the peer book.
 *
 * Trust, auto-connect and bans are the settings that make the swarm automatic
 * or careful, so they are explicit and persistent. Banning drops an existing
 * link immediately.
 */

import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { describeScopes } from "../permissions.ts";
import { keyLabel } from "../formatting/formatters.ts";
import { scopeSchema } from "./schema.ts";
import { confirmWithUser } from "./confirm.ts";
import { runtime } from "../runtime.ts";
import type { Scope } from "../types.ts";

const ACTIONS = [
  "list",
  "trust",
  "untrust",
  "ban",
  "unban",
  "forget",
  "auto-connect",
  "manual-connect",
  "scopes",
  "reset-peer-token",
  "note",
] as const;

type PeerAction = (typeof ACTIONS)[number];

export const SwarmPeersTool: ToolDefinition = {
  name: "swarm_peers",
  label: "Swarm Peers",
  description:
    "Manage the peers this node knows: list them with trust, auto-connect, ban state, stored scopes and the pinned key fingerprint; mark a peer trusted (may be auto-approved within its scopes); enable auto-connect for it (connect automatically when its beacon appears); ban it (never answer, drop existing link); unban, or forget it entirely. Changes persist across sessions.",
  parameters: Type.Object({
    action: Type.Union(ACTIONS.map((action) => Type.Literal(action)), {
      description:
        "list (default), trust, untrust, ban, unban, forget, auto-connect, manual-connect, scopes, reset-peer-token, note.",
    }),
    peer: Type.Optional(Type.String({ description: "Peer name, node id, or host:port." })),
    scopes: Type.Optional(
      Type.Array(scopeSchema, {
        description: "On scopes: what this peer may use when it connects to this node.",
      }),
    ),
    note: Type.Optional(Type.String({ description: "On note: a reminder about this peer." })),
  }),

  async execute(
    _toolCallId: string,
    params: { action: PeerAction; peer?: string; scopes?: Scope[]; note?: string },
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: ExtensionContext,
  ) {
    const node = await runtime().node(ctx);
    const action = params.action ?? "list";

    if (action === "list") {
      const known = node.peers.list();
      if (known.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "No known peers yet.",
                "",
                "A peer becomes known when a connection is approved in either direction, or when swarm_connect reaches it.",
                "Known peers are what auto-connect and automatic approval can work with -- an unknown agent always waits for a decision.",
              ].join("\n"),
            },
          ],
          details: { peers: [] },
        };
      }
      const lines = [`Known peers (${known.length}):`];
      for (const peer of known) {
        const flags: string[] = [];
        if (peer.trusted) flags.push("trusted");
        if (peer.autoConnect) flags.push("auto-connect");
        if (peer.banned) flags.push("banned");
        lines.push(
          `- ${peer.name} (${peer.host}:${peer.port}) ${peer.nodeId}`,
          `  ${flags.join(", ") || "known"}; it may use here: ${describeScopes(peer.scopes)}`,
          `  key: ${peer.publicKey ? keyLabel(peer.publicKey) : "not pinned yet (pinned on the next approval or handshake)"}`,
          `  last seen ${peer.lastSeen ? new Date(peer.lastSeen).toISOString() : "never"}${peer.note ? `; note: ${peer.note}` : ""}`,
        );
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { peers: known },
      };
    }

    if (!params.peer) throw new Error(`action "${action}" needs a peer name, node id, or host:port.`);

    const resolved = node.resolvePeer(params.peer) ?? node.peers.byName(params.peer);
    if (!resolved) {
      throw new Error(
        `Unknown peer "${params.peer}". Use swarm_peers list for known peers, or swarm_discover for reachable ones.`,
      );
    }
    const nodeId = resolved.nodeId;
    if (!nodeId) {
      throw new Error(`"${params.peer}" is an address, not a peer this node has heard of yet. Connect first.`);
    }
    const widening: Partial<Record<PeerAction, string>> = {
      trust: "trust it: its connect requests are then approved without asking, within its stored scopes",
      "auto-connect": "connect to it automatically whenever its beacon appears",
      unban: "lift its ban",
      scopes: `let it use: ${describeScopes(params.scopes ?? [])}`,
    };
    const what = widening[action];
    if (what) {
      const pinned = node.peers.get(nodeId)?.publicKey;
      await confirmWithUser(
        ctx,
        `Change what ${resolved.name} may do?`,
        [
          `${resolved.name} (node ${nodeId})`,
          `Key fingerprint: ${pinned ? keyLabel(pinned) : "not pinned yet"}`,
          `This would ${what}.`,
        ].join("\n"),
      );
    }

    const known = node.peers.get(nodeId);
    if (!known) {
      // Make the peer known so there is something to act on.
      node.peers.touch({
        nodeId,
        name: resolved.name,
        host: resolved.host,
        port: resolved.port,
      });
    }

    switch (action) {
      case "trust": {
        const peer = node.peers.update(nodeId, { trusted: true, banned: false });
        return {
          content: [
            {
              type: "text" as const,
              text: `${peer.name} is trusted: with inboundPolicy known-auto it is approved automatically, but only within ${describeScopes(peer.scopes)}.`,
            },
          ],
          details: { peer },
        };
      }
      case "untrust": {
        const peer = node.peers.update(nodeId, { trusted: false });
        return {
          content: [{ type: "text" as const, text: `${peer.name} is no longer trusted.` }],
          details: { peer },
        };
      }
      case "ban": {
        const peer = node.peers.update(nodeId, { banned: true });
        if (node.snapshot().connections.some((connection) => connection.nodeId === nodeId)) {
          await node.disconnect(nodeId, "banned on this node");
        }
        // A ban is a statement about the peer, not only about its link: its
        // open offers and the files it sent go too.
        node.purgePeerFiles(nodeId);
        return {
          content: [
            {
              type: "text" as const,
              text: `${peer.name} is banned: requests are refused, beacons are ignored, and an existing link was dropped.`,
            },
          ],
          details: { peer },
        };
      }
      case "unban": {
        const peer = node.peers.update(nodeId, { banned: false });
        return {
          content: [{ type: "text" as const, text: `${peer.name} may connect again (it is not trusted automatically).` }],
          details: { peer },
        };
      }
      case "forget": {
        node.peers.forget(nodeId);
        await node.disconnect(nodeId, "forgotten");
        node.purgePeerFiles(nodeId);
        return {
          content: [
            {
              type: "text" as const,
              text: `${known?.name ?? nodeId} was removed from the peer book. It will be treated as a stranger again.`,
            },
          ],
          details: { nodeId, removed: true },
        };
      }
      case "auto-connect": {
        const peer = node.peers.update(nodeId, { autoConnect: true, banned: false });
        return {
          content: [
            {
              type: "text" as const,
              text: `${peer.name} will be connected automatically when its beacon appears (setting autoConnectKnown is ${node.config.autoConnectKnown ? "on" : "off"}).`,
            },
          ],
          details: { peer },
        };
      }
      case "manual-connect": {
        const peer = node.peers.update(nodeId, { autoConnect: false });
        return {
          content: [{ type: "text" as const, text: `${peer.name} is no longer connected automatically.` }],
          details: { peer },
        };
      }
      case "scopes": {
        const peer = node.peers.update(nodeId, { scopes: params.scopes ?? [] });
        return {
          content: [
            {
              type: "text" as const,
              text: `${peer.name} may use here: ${describeScopes(peer.scopes)}. A running link keeps its current grant; reconnect to apply.`,
            },
          ],
          details: { peer },
        };
      }
      case "reset-peer-token": {
        // The link stays; only the token this node issued is forgotten. That is
        // the one state a peer cannot reach: it still believes it is connected,
        // so the next call is refused and it has to re-handshake -- which is
        // exactly the healing path, without dropping the connection first.
        const revoked = node.revokePeerToken(nodeId);
        return {
          content: [
            {
              type: "text" as const,
              text: revoked.hadToken
                ? [
                    `Forgot the token issued to ${revoked.name}. The link is still there, so its next call is refused and it re-handshakes on its own.`,
                    `What it may use here is unchanged: ${describeScopes(revoked.grantedToPeer)}.`,
                  ].join("\n")
                : `${revoked.name} holds no token from this node; nothing to reset.`,
            },
          ],
          details: { revoked },
        };
      }
      case "note": {
        const peer = node.peers.update(nodeId, { note: params.note ?? "" });
        return {
          content: [{ type: "text" as const, text: `Note for ${peer.name}: ${peer.note ?? "(cleared)"}` }],
          details: { peer },
        };
      }
      default: {
        throw new Error(`Unknown action "${action}".`);
      }
    }
  },
};
