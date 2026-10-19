/**
 * Domain types and protocol constants for pi-swarm.
 *
 * Everything the extension exchanges is plain JSON. These interfaces are the
 * single source of truth for the wire format, the on-disk stores and the
 * tool details objects, so no layer invents its own shape.
 */

export const PROTOCOL = "pi-swarm/1";
export const API_PREFIX = "/swarm/v1";

/** Fixed multicast port. Individual peers listen here, their HTTP port is advertised. */
export const DISCOVERY_PORT = 47823;
export const MULTICAST_GROUP = "239.255.77.83";

/** Default HTTP port for the swarm endpoint, advertised in every beacon. */
export const DEFAULT_PORT = 47823;

export const MAX_BODY_BYTES = 512 * 1024;
export const MAX_TEXT_LENGTH = 20_000;
export const MAX_KNOWLEDGE_TEXT = 4_000;
export const MAX_KNOWLEDGE_ENTRIES_PER_PUSH = 100;
export const MAX_KEY_LENGTH = 64;
export const MAX_PENDING_REQUESTS = 8;

/** How long an unanswered connect request stays valid. */
export const REQUEST_TTL_MS = 10 * 60 * 1000;
/** How long a beacon counts as "this peer is alive". */
export const PEER_STALE_MS = 45 * 1000;

/**
 * What a peer may do after a connection is established. Scopes are granted per
 * direction: the host decides what the guest may use, and the guest sees which
 * scopes the host granted in the connect response.
 */
export const ALL_SCOPES = [
  "chat",
  "knowledge:read",
  "knowledge:write",
  "peers:share",
  "session:invite",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

export type InboundPolicy = "ask" | "known-auto" | "open";

export interface SwarmConfig {
  /** Display name other agents see. */
  name: string;
  /** HTTP port to listen on; 0 picks a free one. */
  port: number;
  /** Interface the HTTP server binds to. */
  bindHost: string;
  /** Announce and listen on the multicast group. */
  discovery: boolean;
  /**
   * Start the node when a session starts instead of waiting for the first
   * swarm tool. Without this, two idle agents never find each other.
   */
  autostart: boolean;
  /** How incoming connect requests are decided. */
  inboundPolicy: InboundPolicy;
  /** Connect to known peers automatically when their beacon appears. */
  autoConnectKnown: boolean;
  /** Scopes offered to peers by default, and the ceiling for auto-grants. */
  defaultScopes: Scope[];
  /**
   * Addresses (host:port) that a beacon cannot reach: a peer in another subnet,
   * behind a VPN, or in a container. They are probed directly and then treated
   * like any other discovered peer.
   */
  seeds: string[];
  /** Refuse new connections beyond this many. */
  maxPeers: number;
  /** Allow shared session knowledge at all. */
  shareKnowledge: boolean;
  /** Grant knowledge:write without a human deciding. */
  autoGrantKnowledgeWrite: boolean;
  /** Turn peer messages into a session message (a turn) instead of only an inbox entry. */
  autoDeliverInbox: boolean;
  /** Wake the agent when a connect request arrives. */
  wakeOnRequest: boolean;
  /** Guard against a peer hammering us with messages. */
  maxMessagesPerMinute: number;
  /** Seconds between multicast beacons while the swarm is running. */
  beaconIntervalSeconds: number;
  /** Days a closed session's knowledge file is kept before pruning. */
  knowledgeRetentionDays: number;
}

/** The public part of a peer: everything needed to reach it. */
export interface PeerRef {
  nodeId: string;
  name: string;
  host: string;
  port: number;
}

export type PeerState = "discovered" | "requested" | "pending" | "connected" | "denied";

export interface DiscoveredPeer extends PeerRef {
  /** Unix ms of the last beacon. */
  lastSeen: number;
  sessionId: string | null;
  accepting: boolean;
  /** Set while the peer is broadcasting an open invitation to join its session. */
  invitation?: string;
  /** Where the peer was seen: multicast, the local instance registry, or a direct probe. */
  via: "multicast" | "local" | "direct";
}

/**
 * A peer the user or the agent decided something about. Persisted, because
 * "known" is what makes auto-connect and auto-approval possible.
 */
export interface KnownPeer {
  nodeId: string;
  name: string;
  host: string;
  port: number;
  /** Last time this peer was reachable, unix ms. */
  lastSeen: number;
  /** Connect automatically when this peer announces itself. */
  autoConnect: boolean;
  /** May be auto-approved and may receive the full granted scope set. */
  trusted: boolean;
  /** Never connect, never answer. */
  banned: boolean;
  /** What this peer may use when it connects to us (and, mirrored, what we ask for). */
  scopes: Scope[];
  note?: string;
}

export type Direction = "in" | "out";

/**
 * An established, authenticated link to one peer. A link can carry rights in
 * both directions at once, so the two token fields and the two scope sets are
 * independent: each side issues the token the other one presents.
 */
export interface Connection extends PeerRef {
  /** Session id both sides agreed on. */
  sessionId: string;
  /** Token this peer must present when it calls us (issued by us). */
  inToken?: string;
  /** Token we present when we call this peer (issued by them). */
  outToken?: string;
  /** What we granted the peer on this node. */
  grantedToPeer: Scope[];
  /** What the peer granted us on its node. */
  grantedToMe: Scope[];
  /** Direction of the handshake that opened the link. */
  direction: Direction;
  since: number;
  lastSeen: number;
}

export type RequestStatus = "pending" | "approved" | "denied" | "expired";

/** A connect request waiting for a decision on this node. */
export interface IncomingRequest {
  requestId: string;
  from: PeerRef;
  requestedScopes: Scope[];
  grantedScopes: Scope[];
  intent: string;
  message?: string;
  sessionId: string;
  status: RequestStatus;
  reason: string;
  createdAt: number;
  decidedAt?: number;
  /** Issued when approved; the requester picks it up by polling. */
  token?: string;
}

export type MessageKind = "chat" | "note" | "question" | "answer";

export interface SwarmMessage {
  id: string;
  sessionId: string;
  from: PeerRef;
  text: string;
  kind: MessageKind;
  ts: number;
  /** True when this node received it, false when it sent it. */
  incoming: boolean;
}

export const KNOWLEDGE_KINDS = [
  "fact",
  "decision",
  "question",
  "answer",
  "todo",
  "note",
] as const;

export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

/**
 * One item of shared session knowledge. Entries with a key and the same author
 * share a deterministic id, so newer text replaces older text everywhere.
 */
export interface KnowledgeEntry {
  id: string;
  sessionId: string;
  /** Topic label; entries with the same key from the same author replace each other. */
  key: string;
  kind: KnowledgeKind;
  text: string;
  author: {
    nodeId: string;
    name: string;
  };
  ts: number;
}

export interface KnowledgeInput {
  key?: string;
  kind?: KnowledgeKind;
  text: string;
}

/** Outcome of one connect attempt, used by swarm_connect and swarm_broadcast. */
export interface ConnectAttempt {
  peer: PeerRef;
  status: "connected" | "pending" | "denied" | "unreachable" | "skipped";
  scopes: Scope[];
  sessionId?: string;
  requestId?: string;
  reason: string;
}

export interface SendOutcome {
  delivered: string[];
  failed: Array<{ nodeId: string; name: string; error: string }>;
}

export interface KnowledgeSyncOutcome {
  pulled: number;
  pushed: number;
  errors: string[];
}
