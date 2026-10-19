/**
 * swarm_say -- send a message to one connected peer or to all of them.
 *
 * Only the `chat` scope counts, and only in the direction the peer granted it.
 * A one-way link (the peer connected to us but we never connected to it) is
 * reported as such instead of silently dropping the message.
 */

import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { formatSendOutcome } from "../formatting/formatters.ts";
import { runtime } from "../runtime.ts";
import type { MessageKind } from "../types.ts";

export const SwarmSayTool: ToolDefinition = {
  name: "swarm_say",
  label: "Swarm Say",
  description:
    "Send a message to one connected pi agent (to = name/node id) or to every connected peer. Requires the chat scope granted by the peer; a link that only runs the other way is reported instead of pretended. The peer sees the text labelled as coming from this agent.",
  parameters: Type.Object({
    text: Type.String({ description: "The message. Plain text; keep it short and factual." }),
    to: Type.Optional(
      Type.String({ description: "Peer name or node id. Omit to send to all connected peers." }),
    ),
    kind: Type.Optional(
      Type.Union(
        [Type.Literal("chat"), Type.Literal("note"), Type.Literal("question"), Type.Literal("answer")],
        { description: "Message kind, default chat. 'question' invites a reply." },
      ),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: { text: string; to?: string; kind?: MessageKind },
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: ExtensionContext,
  ) {
    const node = await runtime().node(ctx);
    const outcome = await node.say(params.text, { to: params.to, kind: params.kind });
    return {
      content: [{ type: "text" as const, text: formatSendOutcome(outcome) }],
      details: outcome,
      isError: outcome.delivered.length === 0,
    };
  },
};
