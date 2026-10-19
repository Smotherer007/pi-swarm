/**
 * pi Swarm -- a peer-to-peer network of pi agents.
 *
 * Each pi instance can announce itself, ask other agents to connect, exchange
 * messages, and share a session knowledge board. There is no central server:
 * discovery is a multicast beacon, connections are two-phase (request, then a
 * decision), and every call after the handshake carries a token plus a scope
 * check.
 *
 * Tools:
 *   swarm_setup       identity, policy, auto-connect, permissions
 *   swarm_status      what this node is and who it is talking to
 *   swarm_discover    announce and list reachable agents
 *   swarm_connect     request a link to one agent
 *   swarm_broadcast   announce and invite everyone at once
 *   swarm_requests    list / approve / deny connect requests
 *   swarm_say         send a message
 *   swarm_inbox       read what arrived
 *   swarm_knowledge   the shared session board
 *   swarm_peers       trust, auto-connect, ban
 *   swarm_leave       stop listening
 *
 * Nothing a peer sends is treated as an instruction. The node starts with the
 * session, so an idle agent is discoverable without anyone calling a tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { getConfig } from "./src/config.ts";
import { installRuntime, runtime } from "./src/runtime.ts";
import { SwarmSetupTool } from "./src/tools/swarm-setup.ts";
import { SwarmStatusTool } from "./src/tools/swarm-status.ts";
import { SwarmDiscoverTool } from "./src/tools/swarm-discover.ts";
import { SwarmConnectTool } from "./src/tools/swarm-connect.ts";
import { SwarmBroadcastTool } from "./src/tools/swarm-broadcast.ts";
import { SwarmRequestsTool } from "./src/tools/swarm-requests.ts";
import { SwarmSayTool } from "./src/tools/swarm-say.ts";
import { SwarmInboxTool } from "./src/tools/swarm-inbox.ts";
import { SwarmKnowledgeTool } from "./src/tools/swarm-knowledge.ts";
import { SwarmPeersTool } from "./src/tools/swarm-peers.ts";
import { SwarmLeaveTool } from "./src/tools/swarm-leave.ts";

export default function (pi: ExtensionAPI) {
  const swarm = installRuntime(pi);

  pi.registerTool(SwarmSetupTool);
  pi.registerTool(SwarmStatusTool);
  pi.registerTool(SwarmDiscoverTool);
  pi.registerTool(SwarmConnectTool);
  pi.registerTool(SwarmBroadcastTool);
  pi.registerTool(SwarmRequestsTool);
  pi.registerTool(SwarmSayTool);
  pi.registerTool(SwarmInboxTool);
  pi.registerTool(SwarmKnowledgeTool);
  pi.registerTool(SwarmPeersTool);
  pi.registerTool(SwarmLeaveTool);

  // The runtime needs a context to show notifications and a status line.
  pi.on("session_start", (_event, ctx) => {
    runtime().attach(ctx);
    // Autostart is what makes discovery work without a first tool call: two
    // idle agents that both listen find each other on their own.
    if (getConfig().autostart) {
      void runtime()
        .node(ctx)
        .catch((error: unknown) => {
          // A refused start (a duplicate identity, a port that cannot be bound)
          // must not be silent: the swarm would simply look dead.
          runtime().reportStartFailure(error);
        });
    }
  });

  // Always close sockets, even when the session is replaced or reloaded.
  pi.on("session_shutdown", async () => {
    await runtime()
      .stop()
      .catch(() => {
        /* shutdown must not throw */
      });
  });

  pi.registerCommand("swarm", {
    description: "Show this node's swarm state (status, peers, pending requests)",
    handler: async (_args, ctx) => {
      swarm.attach(ctx);
      pi.sendUserMessage(
        "Use swarm_status to show the swarm state, and if connect requests are pending, list them with swarm_requests and tell me who wants what.",
        { deliverAs: "steer" },
      );
    },
  });

  pi.registerCommand("swarm-leave", {
    description: "Leave the swarm: disconnect everyone and stop listening",
    handler: async (_args, ctx) => {
      swarm.attach(ctx);
      const node = swarm.peek();
      if (!node || !node.isRunning) {
        ctx.ui.notify("The swarm node is not running.", "info");
        return;
      }
      const peers = node.snapshot().connections.length;
      await swarm.stop();
      ctx.ui.setStatus("swarm", undefined);
      ctx.ui.notify(`Left the swarm and disconnected ${peers} peer(s).`, "info");
    },
  });

  pi.registerCommand("swarm-broadcast", {
    description: "Announce this node and invite every reachable agent",
    handler: async (_args, ctx) => {
      swarm.attach(ctx);
      pi.sendUserMessage(
        "Use swarm_broadcast to announce this node and invite every reachable pi agent into a swarm session, then report who accepted and who is waiting for approval.",
        { deliverAs: "steer" },
      );
    },
  });
}
