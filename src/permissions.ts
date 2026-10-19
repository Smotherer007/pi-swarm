/**
 * Permission decisions.
 *
 * Two directions, both enforced:
 *
 *   inbound  -- what a connecting peer may do on this node, checked against
 *               the scopes granted in the connect response and re-checked on
 *               every request that carries a token.
 *   outbound -- what this node may do on the peer's node. The peer states its
 *               grant in the connect response, so using a scope it did not
 *               grant fails locally instead of being rejected remotely.
 *
 * Auto-approval is deliberately narrow: only a known peer that the user
 * marked as trusted or auto-connect can be answered without a decision, and
 * only within the scopes stored for that peer. Nothing else is automatic.
 */

import type {
  InboundPolicy,
  KnownPeer,
  Scope,
  SwarmConfig,
} from "./types.ts";
import { ALL_SCOPES } from "./types.ts";

export function isScope(value: unknown): value is Scope {
  return typeof value === "string" && (ALL_SCOPES as readonly string[]).includes(value);
}

/** Keep the valid scopes, deduplicate, and order them predictably. */
export function normalizeScopes(input: unknown): Scope[] {
  if (!Array.isArray(input)) return [];
  const wanted = new Set(input.filter(isScope));
  return ALL_SCOPES.filter((scope) => wanted.has(scope));
}

export function hasScope(granted: readonly Scope[], needed: Scope): boolean {
  return granted.includes(needed);
}

/** Everything in `wanted` that `granted` covers. */
export function grantedFrom(wanted: readonly Scope[], granted: readonly Scope[]): Scope[] {
  return wanted.filter((scope) => granted.includes(scope));
}

export function intersectScopes(a: readonly Scope[], b: readonly Scope[]): Scope[] {
  return ALL_SCOPES.filter((scope) => a.includes(scope) && b.includes(scope));
}

export function describeScopes(scopes: readonly Scope[]): string {
  return scopes.length > 0 ? scopes.join(", ") : "none";
}

export interface InboundDecision {
  decision: "approve" | "pending" | "deny";
  scopes: Scope[];
  reason: string;
}

export interface InboundDecisionInput {
  config: SwarmConfig;
  known: KnownPeer | undefined;
  /**
   * True when the requester sealed its request with the key pinned for this
   * peer. A node id alone is public (it is in every beacon), so without this
   * "known" proves nothing and nothing stored for that peer may be used.
   */
  keyVerified: boolean;
  requested: readonly Scope[];
  activeConnections: number;
}

/**
 * Decide how to answer a connect request before a human or the agent looks at
 * it. "pending" means the request is queued and shows up in swarm_requests.
 */
export function decideInbound(input: InboundDecisionInput): InboundDecision {
  const { config, requested } = input;
  // A ban holds whatever key is presented; every privilege of a known peer
  // needs the pinned key.
  const banned = Boolean(input.known?.banned);
  const known = input.keyVerified ? input.known : undefined;
  const claimsKnown = Boolean(input.known) && !input.keyVerified;
  const policy: InboundPolicy = config.inboundPolicy;

  if (requested.length === 0) {
    return { decision: "deny", scopes: [], reason: "the request asked for no scopes" };
  }
  if (banned) {
    return { decision: "deny", scopes: [], reason: "this peer is banned on this node" };
  }
  if (input.activeConnections >= config.maxPeers) {
    return {
      decision: "deny",
      scopes: [],
      reason: `the peer limit (${config.maxPeers}) is reached`,
    };
  }

  const wanted = requested.filter(
    (scope) => config.shareKnowledge || !scope.startsWith("knowledge:"),
  );
  if (wanted.length === 0) {
    return {
      decision: "deny",
      scopes: [],
      reason: "shared knowledge is disabled here, and nothing else was requested",
    };
  }

  // The ceiling: what this node is willing to hand out without a decision.
  const ceiling = new Set<Scope>([
    ...config.defaultScopes,
    ...(known?.scopes ?? []),
  ]);
  if (!config.shareKnowledge) {
    for (const scope of [...ceiling]) {
      if (scope.startsWith("knowledge:")) ceiling.delete(scope);
    }
  }
  const writeKnowledge =
    config.autoGrantKnowledgeWrite ||
    Boolean(known?.trusted && known.scopes.includes("knowledge:write"));
  if (!writeKnowledge) ceiling.delete("knowledge:write");

  // Files are never handed out or accepted by default: an explicit grant on the
  // peer is the whole point, so the default ceiling does not apply to them.
  for (const scope of ["files:read", "files:write"] as const) {
    if (!known?.scopes.includes(scope)) ceiling.delete(scope);
  }

  const grantable = wanted.filter((scope) => ceiling.has(scope));

  if (policy === "open") {
    return grantable.length > 0
      ? {
          decision: "approve",
          scopes: grantable,
          reason: "inboundPolicy is open",
        }
      : {
          decision: "deny",
          scopes: [],
          reason: "none of the requested scopes may be granted automatically",
        };
  }

  const autoEligible = Boolean(known && (known.trusted || known.autoConnect));
  if (policy === "known-auto" && autoEligible) {
    return grantable.length > 0
      ? {
          decision: "approve",
          scopes: grantable,
          reason: known?.trusted
            ? "known peer, marked trusted"
            : "known peer with auto-connect enabled",
        }
      : {
          decision: "pending",
          scopes: [],
          reason: "no requested scope may be granted automatically; needs a decision",
        };
  }

  return {
    decision: "pending",
    scopes: [],
    reason:
      policy === "ask"
        ? "inboundPolicy is ask"
        : claimsKnown
          ? "known peer id, but no matching encryption key is pinned for it yet -- compare the key fingerprint with its owner before approving"
          : known
            ? "known peer, but not trusted or set to auto-connect"
            : "unknown peer",
  };
}
