/**
 * swarm_requests -- decide who may connect.
 *
 * This is the consent step. Until a request is approved, the requester has no
 * token, no scope and no way to send anything; approving it issues the token
 * the requester picks up, with exactly the scopes granted here.
 */

import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { formatRequests } from "../formatting/formatters.ts";
import { describeScopes } from "../permissions.ts";
import { scopeSchema } from "./schema.ts";
import { confirmWithUser } from "./confirm.ts";
import { keyLabel } from "../formatting/formatters.ts";
import { runtime } from "../runtime.ts";
import type { IncomingRequest, Scope } from "../types.ts";

function pickRequest(node: { pendingRequests: () => IncomingRequest[] }, requestId?: string, peer?: string): IncomingRequest {
  const pending = node.pendingRequests();
  if (requestId) {
    const found = pending.find((request) => request.requestId === requestId);
    if (!found) {
      throw new Error(
        pending.length > 0
          ? `No pending request "${requestId}". Waiting: ${pending.map((r) => r.requestId).join(", ")}.`
          : `No pending request "${requestId}", and nothing is waiting.`,
      );
    }
    return found;
  }
  if (peer) {
    const needle = peer.trim().toLowerCase();
    const exact = pending.find(
      (request) =>
        request.from.name.toLowerCase() === needle ||
        request.from.nodeId === peer.trim() ||
        `${request.from.host}:${request.from.port}` === peer.trim(),
    );
    const partial = pending.filter((request) => request.from.name.toLowerCase().includes(needle));
    if (!exact && partial.length > 1) {
      throw new Error(
        `"${peer}" matches several requests; pass requestId. Waiting: ${partial.map((r) => `${r.from.name} (${r.requestId})`).join(", ")}.`,
      );
    }
    const found = exact ?? partial[0];
    if (!found) {
      throw new Error(
        pending.length > 0
          ? `No pending request from "${peer}". Waiting: ${pending.map((r) => `${r.from.name} (${r.requestId})`).join(", ")}.`
          : `No pending request from "${peer}", and nothing is waiting.`,
      );
    }
    return found;
  }
  if (pending.length === 1) return pending[0];
  throw new Error(
    pending.length === 0
      ? "Nothing is waiting for a decision."
      : `Several requests are waiting; pass requestId or peer. Waiting: ${pending.map((r) => `${r.from.name} (${r.requestId})`).join(", ")}.`,
  );
}

export const SwarmRequestsTool: ToolDefinition = {
  name: "swarm_requests",
  label: "Swarm Requests",
  description:
    "List, approve, or deny connect requests from other pi agents. This is the consent step of the swarm: an unapproved requester has no token and no scope. Approving grants exactly the scopes passed (default: what was requested) and can only narrow them, never add a scope the peer did not ask for.",
  parameters: Type.Object({
    action: Type.Union(
      [Type.Literal("list"), Type.Literal("approve"), Type.Literal("deny")],
      { description: "list (default), approve, or deny." },
    ),
    requestId: Type.Optional(Type.String({ description: "Request id from the list." })),
    peer: Type.Optional(
      Type.String({ description: "Peer name or node id, as an alternative to requestId." }),
    ),
    scopes: Type.Optional(
      Type.Array(scopeSchema, {
        description: "On approve: the scopes to grant. Default: what was requested. Knowledge write needs an explicit grant.",
      }),
    ),
    reason: Type.Optional(Type.String({ description: "On deny: why, shown to the requester." })),
  }),

  async execute(
    _toolCallId: string,
    params: { action: "list" | "approve" | "deny"; requestId?: string; peer?: string; scopes?: Scope[]; reason?: string },
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: ExtensionContext,
  ) {
    const node = await runtime().node(ctx);
    const action = params.action ?? "list";

    if (action === "list") {
      const pending = node.pendingRequests();
      return {
        content: [{ type: "text" as const, text: formatRequests(pending) }],
        details: { pending },
      };
    }

    const request = pickRequest(node, params.requestId, params.peer);
    if (action === "approve") {
      await confirmWithUser(
        ctx,
        `Approve the swarm connection from ${request.from.name}?`,
        [
          `${request.from.name} at ${request.from.host}:${request.from.port} (node ${request.from.nodeId})`,
          `Key fingerprint: ${keyLabel(request.from.publicKey)}`,
          `It would be granted: ${describeScopes(params.scopes ?? request.requestedScopes)}`,
          "An approved peer is remembered as trusted and reconnects on its own later.",
        ].join("\n"),
      );
    }
    const decided = node.decide(
      request.requestId,
      action === "approve",
      params.scopes,
      params.reason,
    );
    const text =
      action === "approve"
        ? [
            `Approved ${request.from.name} (${request.from.host}:${request.from.port}).`,
            `Granted: ${describeScopes(decided.grantedScopes)}.`,
            "The peer now picks up its token by polling; swarm_status shows it as connected once it has.",
            "It may use nothing beyond those scopes, and every call is checked again.",
          ].join("\n")
        : [
            `Denied ${request.from.name} (${request.from.host}:${request.from.port}).`,
            params.reason ? `Reason: ${params.reason}` : "No reason given.",
            "The requester receives the denial and cannot retry with the same request id.",
          ].join("\n");

    return {
      content: [{ type: "text" as const, text }],
      details: { request: decided, action },
    };
  },
};
