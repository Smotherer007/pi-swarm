/**
 * The swarm node: the state machine behind every swarm_* tool.
 *
 * Lifecycle
 *   start()   opens the HTTP endpoint and, if enabled, the discovery beacon.
 *             Nothing is open before this; tools call it lazily.
 *   stop()    leaves every connection, stops discovery, closes the endpoint.
 *
 * Connection handshake (deliberately two-phase)
 *   1. A sends /hello with the scopes it wants.
 *   2. B either auto-approves (known, trusted, within B's stored grant), or
 *      queues a request and answers "pending".
 *   3. B's agent or user decides with swarm_requests. On approval B issues a
 *      token and stores it; A collects the token by polling /approval.
 *   4. Every later request carries that token, and the scope is checked again
 *      on each call. A scope is never granted implicitly after the handshake.
 *
 * Nothing in a peer payload is treated as an instruction or executed. Peer
 * text is labelled when it reaches the model.
 */

import * as path from "node:path";

import type {
  ConnectAttempt,
  Connection,
  DiscoveredPeer,
  IncomingRequest,
  KnowledgeEntry,
  KnowledgeInput,
  KnowledgeSyncOutcome,
  KnownPeer,
  MessageKind,
  PeerRef,
  Scope,
  SendOutcome,
  SwarmConfig,
  SwarmMessage,
} from "./types.ts";
import {
  API_PREFIX,
  DEFAULT_PORT,
  MAX_KNOWLEDGE_ENTRIES_PER_PUSH,
  MAX_PENDING_REQUESTS,
  MAX_TEXT_LENGTH,
  PEER_STALE_MS,
  PROTOCOL,
  REQUEST_TTL_MS,
} from "./types.ts";
import { getConfig } from "./config.ts";
import { loadIdentity, newId, newToken } from "./identity.ts";
import type { Identity } from "./identity.ts";
import { PeerStore } from "./peers.ts";
import {
  decideInbound,
  grantedFrom,
  hasScope,
  normalizeScopes,
} from "./permissions.ts";
import { KnowledgeBase, pruneSessions } from "./knowledge.ts";
import {
  ProtocolError,
  parseApproval,
  parseHello,
  parseIntroductions,
  parseKnowledgePush,
  parseMessage,
  sanitizeText,
} from "./protocol.ts";
import { Discovery } from "./discovery.ts";
import {
  baseUrl,
  requestJson,
  sendJson,
  startHttpServer,
  TransportError,
} from "./transport.ts";
import type { HttpServerHandle } from "./transport.ts";
import {
  identityFilePath,
  instanceDir,
  instanceSlug,
  peersFilePath,
  sanitizeSegment,
  sessionsDir,
} from "./paths.ts";

export type SwarmEvent =
  | { type: "request"; request: IncomingRequest }
  | { type: "connected"; connection: Connection }
  | { type: "message"; message: SwarmMessage }
  | { type: "knowledge"; entries: KnowledgeEntry[]; from: Connection }
  | { type: "invitation"; peer: DiscoveredPeer; invitation: string }
  | { type: "disconnected"; nodeId: string; name: string; reason: string };

export interface SwarmNodeOptions {
  config?: SwarmConfig;
  identity?: Identity;
  peerStore?: PeerStore;
  /** Overrides for tests; production uses the paths from paths.ts. */
  peersPath?: string;
  sessionsDir?: string;
  instanceDir?: string | null;
  /** Force discovery off/on regardless of the config. */
  discovery?: boolean;
  discoveryPort?: number;
  multicastGroup?: string;
  onEvent?: (event: SwarmEvent) => void;
  /** Skip waiting for beacons in broadcast(); tests use this. */
  announceWaitMs?: number;
  /** How often the background link keeper runs. Default: twice the beacon interval. */
  maintainIntervalMs?: number;
}

export interface StartResult {
  port: number;
  host: string;
  multicast: boolean;
  warnings: string[];
  alreadyRunning: boolean;
}

export interface SwarmSnapshot {
  nodeId: string;
  name: string;
  /** The instance slot (PI_SWARM_INSTANCE), empty for the primary instance. */
  instance: string;
  running: boolean;
  port: number | null;
  bindHost: string;
  sessionId: string | null;
  startedAt: number | null;
  connections: Connection[];
  discovered: DiscoveredPeer[];
  pending: IncomingRequest[];
  known: number;
  inbox: number;
  knowledge: number;
  inboundPolicy: string;
  autoConnectKnown: boolean;
  /** Addresses probed directly, for peers a beacon cannot reach. */
  seeds: string[];
  /** The open invitation this node is broadcasting, if any. */
  invitation: string | null;
  multicast: boolean;
  warnings: string[];
}

interface RateWindow {
  windowStart: number;
  count: number;
}

function isStale(peer: DiscoveredPeer): boolean {
  return Date.now() - peer.lastSeen > PEER_STALE_MS;
}

/**
 * A stable second port for a named instance slot.
 *
 * Falling back to a random port works, but the address changes on every
 * restart, which breaks seeds and stored peers. Deriving it from the slot name
 * keeps `host:47824` true across restarts. Nothing is reserved: if the port is
 * taken too, the caller falls back to a free one.
 */
function preferredPort(slug: string): number | null {
  if (!slug) return null;
  let hash = 0;
  for (const char of slug) hash = (hash * 33 + char.charCodeAt(0)) % 100_000;
  return DEFAULT_PORT + 1 + (hash % 63);
}

export class SwarmNode {
  readonly config: SwarmConfig;
  readonly identity: Identity;
  readonly peers: PeerStore;

  private readonly peersPath: string;
  private readonly sessionsDirPath: string;
  private readonly instanceDirPath: string | null;
  private readonly discoveryEnabled: boolean;
  private readonly discoveryPort: number;
  private readonly multicastGroup: string;
  private readonly onEvent: ((event: SwarmEvent) => void) | undefined;
  private readonly announceWaitMs: number;

  private server: HttpServerHandle | null = null;
  private discovery: Discovery | null = null;
  private connections = new Map<string, Connection>();
  private tokens = new Map<string, string>();
  private seen = new Map<string, DiscoveredPeer>();
  private incoming = new Map<string, IncomingRequest>();
  private outgoing = new Map<string, { peer: PeerRef; sessionId: string | null }>();
  private inbox: SwarmMessage[] = [];
  private knowledge: KnowledgeBase | null = null;
  private sessionId: string | null = null;
  private startedAt: number | null = null;
  private running = false;
  private rate = new Map<string, RateWindow>();
  private autoConnectTried = new Map<string, number>();
  /** Peers a background attempt is currently negotiating with. */
  private readonly autoConnecting = new Set<string>();
  private maintainTimer: NodeJS.Timeout | null = null;
  private readonly maintainIntervalMs: number;
  /** Highest knowledge timestamp already pulled from each peer. */
  private pullSince = new Map<string, number>();
  private seenInvitation = new Map<string, string>();
  private invitation: string | null = null;
  private invitationUntil = 0;

  constructor(options: SwarmNodeOptions = {}) {
    this.config = options.config ?? getConfig();
    this.identity = options.identity ?? loadIdentity(identityFilePath());
    this.peersPath = options.peersPath ?? peersFilePath();
    this.sessionsDirPath = options.sessionsDir ?? sessionsDir();
    this.instanceDirPath =
      options.instanceDir === null ? null : (options.instanceDir ?? instanceDir());
    this.discoveryEnabled = options.discovery ?? this.config.discovery;
    this.discoveryPort = options.discoveryPort ?? 47823;
    this.multicastGroup = options.multicastGroup ?? "239.255.77.83";
    this.onEvent = options.onEvent;
    this.announceWaitMs = options.announceWaitMs ?? 2000;
    this.maintainIntervalMs =
      options.maintainIntervalMs ?? Math.max(10_000, this.config.beaconIntervalSeconds * 2_000);

    this.peers =
      options.peerStore ??
      new PeerStore({
        filePath: this.peersPath,
        defaultScopes: this.config.defaultScopes,
      });
  }

  get isRunning(): boolean {
    return this.running;
  }

  get port(): number | null {
    return this.server?.port ?? null;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  get knowledgeBase(): KnowledgeBase | null {
    return this.knowledge;
  }

  // ---------------------------------------------------------------- lifecycle

  async start(): Promise<StartResult> {
    if (this.running && this.server) {
      return {
        port: this.server.port,
        host: this.config.bindHost,
        multicast: this.discovery?.usesMulticast ?? false,
        warnings: [],
        alreadyRunning: true,
      };
    }

    const warnings: string[] = [];
    const listen = (port: number) =>
      startHttpServer({
        port,
        host: this.config.bindHost,
        handler: (req, res, body) => this.handleHttp(req, res, body),
      });

    let handle: HttpServerHandle;
    try {
      handle = await listen(this.config.port);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || this.config.port === 0) {
        throw err;
      }
      // A second pi on this machine cannot have the same port. The usual case
      // is an instance slot, and there the same port on every restart keeps
      // host:port addresses (seeds, stored peers) valid.
      const preferred = preferredPort(instanceSlug());
      handle =
        (preferred !== null
          ? await listen(preferred).catch(() => null)
          : null) ?? (await listen(0));
      warnings.push(
        `Port ${this.config.port} is already in use; listening on ${handle.port} instead. Peers learn the real port from the beacon.` +
          (preferred === null
            ? " Start this pi with PI_SWARM_INSTANCE=<name> to give it its own identity and a stable port."
            : ""),
      );
    }

    this.server = handle;
    this.running = true;
    this.startedAt = Date.now();

    this.ensureSession();
    this.pruneOldSessions();

    // The local registry is not discovery in the multicast sense: it is how two
    // pi instances on this machine see each other, and it works with the
    // beacon switched off. Only a node with no registry directory stays silent.
    if (this.discoveryEnabled || this.instanceDirPath !== null) {
      this.discovery = new Discovery({
        nodeId: this.identity.nodeId,
        name: this.config.name,
        port: handle.port,
        sessionId: this.sessionId,
        accepting: this.accepting(),
        multicast: this.discoveryEnabled,
        intervalSeconds: this.config.beaconIntervalSeconds,
        instanceDir: this.instanceDirPath,
        onPeer: (peer) => this.handleBeacon(peer),
        discoveryPort: this.discoveryPort,
        group: this.multicastGroup,
      });
      const outcome = await this.discovery.start();
      warnings.push(...outcome.warnings);
    }

    if ((this.config.seeds ?? []).length > 0) {
      void this.probeSeeds().catch(() => {
        /* an offline seed is retried on the next discover */
      });
    }

    this.startMaintaining();

    return {
      port: handle.port,
      host: this.config.bindHost,
      multicast: this.discovery?.usesMulticast ?? false,
      warnings,
      alreadyRunning: false,
    };
  }

  /** Ensure the node is running; every tool goes through this. */
  async ensureStarted(): Promise<StartResult> {
    return this.start();
  }

  async stop(reason = "left the swarm"): Promise<void> {
    if (this.maintainTimer) {
      clearInterval(this.maintainTimer);
      this.maintainTimer = null;
    }
    const connections = [...this.connections.values()];
    await Promise.allSettled(
      connections
        .filter((connection) => connection.outToken)
        .map((connection) =>
          requestJson(`${baseUrl(connection.host, connection.port)}${API_PREFIX}/leave`, {
            method: "POST",
            token: connection.outToken,
            body: { reason },
            timeoutMs: 1000,
          }),
        ),
    );

    await this.discovery?.stop();
    this.discovery = null;
    await this.server?.close();
    this.server = null;

    this.connections.clear();
    this.tokens.clear();
    this.seen.clear();
    this.incoming.clear();
    this.outgoing.clear();
    this.rate.clear();
    this.inbox = [];
    this.running = false;
    this.startedAt = null;
    this.invitation = null;
    this.invitationUntil = 0;
    this.seenInvitation.clear();
    this.autoConnectTried.clear();
    this.knowledge?.persist();
  }

  /**
   * Keep looking for the links this node is supposed to have.
   *
   * Nothing here is awaited by a tool: the agent keeps working while a link is
   * negotiated in the background. A peer that is offline is retried on every
   * tick, indefinitely, so "connected" becomes true on its own once the other
   * machine is back -- including a peer whose address on file is stale, which
   * is why a quiet peer is probed before it is dialed.
   */
  private startMaintaining(): void {
    if (this.maintainTimer) return;
    this.maintainTimer = setInterval(() => {
      void this.maintainLinks().catch(() => {
        /* a failed round is retried on the next tick */
      });
    }, this.maintainIntervalMs);
    this.maintainTimer.unref?.();
  }

  /** One round of the background link keeper. Public so a test can drive it. */
  async maintainLinks(): Promise<{ attempted: string[]; dropped: string[] }> {
    const attempted: string[] = [];
    if (!this.running) return { attempted, dropped: [] };

    const now = Date.now();
    for (const known of this.peers.list()) {
      if (known.banned || !known.autoConnect) continue;
      if (this.connections.has(known.nodeId)) continue;
      if (this.autoConnecting.has(known.nodeId)) continue;
      if (now - (this.autoConnectTried.get(known.nodeId) ?? 0) < Math.min(this.maintainIntervalMs, 20_000)) {
        continue;
      }

      this.autoConnectTried.set(known.nodeId, now);
      this.autoConnecting.add(known.nodeId);
      attempted.push(known.name);
      void this.autoConnectTo(known).finally(() => this.autoConnecting.delete(known.nodeId));
    }

    const dropped = (await this.checkConnections().catch(() => ({ dropped: [] }))).dropped.map(
      (entry) => entry.name,
    );
    return { attempted, dropped };
  }

  private async autoConnectTo(known: KnownPeer): Promise<void> {
    try {
      let target: PeerRef = {
        nodeId: known.nodeId,
        name: known.name,
        host: known.host,
        port: known.port,
      };
      if (Date.now() - (known.lastSeen ?? 0) > PEER_STALE_MS) {
        // The stored address may be from before a restart; ask the peer where
        // it listens now. A peer that does not answer is simply tried later.
        const probed = await this.probe(target).catch(() => null);
        if (!probed) return;
        target = { nodeId: probed.nodeId, name: probed.name, host: probed.host, port: probed.port };
      }
      await this.connectPeer(target, {
        scopes: known.scopes,
        wait: true,
        timeoutMs: 8000,
        intent: "auto-connect",
      });
    } catch {
      /* offline now, tried again on the next tick */
    }
  }

  private accepting(): boolean {
    return this.running && this.connections.size < this.config.maxPeers;
  }

  private ensureSession(): string {
    if (this.sessionId) {
      if (!this.knowledge) this.openKnowledge(this.sessionId);
      return this.sessionId;
    }
    const sessionId = newId("s");
    this.sessionId = sessionId;
    this.openKnowledge(sessionId);
    this.discovery?.setState({ sessionId, accepting: this.accepting() });
    return sessionId;
  }

  /** Move to another session, keeping the knowledge this node already has. */
  private adoptSession(sessionId: string): void {
    if (this.sessionId === sessionId) {
      this.ensureSession();
      return;
    }
    const previous = this.knowledge;
    this.sessionId = sessionId;
    this.openKnowledge(sessionId);
    if (previous && this.knowledge && previous.size > 0) {
      this.knowledge.merge(previous.all());
    }
    this.discovery?.setState({ sessionId, accepting: this.accepting() });
  }

  private openKnowledge(sessionId: string): void {
    this.knowledge = KnowledgeBase.load({
      sessionId,
      dir: path.join(this.sessionsDirPath, sanitizeSegment(sessionId)),
    });
  }

  private pruneOldSessions(): void {
    try {
      pruneSessions(this.sessionsDirPath, this.config.knowledgeRetentionDays);
    } catch {
      /* pruning is housekeeping, never fatal */
    }
  }

  // ------------------------------------------------------------------ discovery

  private handleBeacon(peer: DiscoveredPeer): void {
    if (peer.nodeId === this.identity.nodeId) return;
    this.expireInvitation();
    const known = this.peers.get(peer.nodeId);
    if (known?.banned) return;

    this.seen.set(peer.nodeId, peer);

    // An invitation is the passive form of "who is there?": the other node
    // announces an open session, and this node's agent or user decides whether
    // to ask for a connection.
    if (peer.invitation && this.seenInvitation.get(peer.nodeId) !== peer.invitation) {
      this.seenInvitation.set(peer.nodeId, peer.invitation);
      this.emit({ type: "invitation", peer, invitation: peer.invitation });
    }
    if (!peer.invitation) this.seenInvitation.delete(peer.nodeId);

    if (
      this.config.autoConnectKnown &&
      known?.autoConnect &&
      !known.banned &&
      peer.accepting &&
      !this.connections.has(peer.nodeId)
    ) {
      this.scheduleAutoConnect(peer);
    }
  }

  /**
   * Dial a peer that just announced itself. Fire and forget: a beacon must
   * never slow the node down, and a failed attempt is simply retried later.
   */
  private scheduleAutoConnect(peer: DiscoveredPeer): void {
    const known = this.peers.get(peer.nodeId);
    if (!known || known.banned || !known.autoConnect) return;
    if (this.connections.has(peer.nodeId) || this.autoConnecting.has(peer.nodeId)) return;
    const now = Date.now();
    if (now - (this.autoConnectTried.get(peer.nodeId) ?? 0) < 5_000) return;

    this.autoConnectTried.set(peer.nodeId, now);
    this.autoConnecting.add(peer.nodeId);
    void this.connectPeer(peer, {
      scopes: known.scopes,
      intent: "auto-connect",
      wait: true,
      timeoutMs: 8000,
    })
      .catch(() => {
        /* a failed auto-connect is retried on a later beacon or tick */
      })
      .finally(() => this.autoConnecting.delete(peer.nodeId));
  }

  private expireInvitation(): void {
    if (this.invitation && Date.now() > this.invitationUntil) {
      this.invitation = null;
      this.discovery?.setInvitation(null);
    }
  }

  private visiblePeers(): DiscoveredPeer[] {
    const result: DiscoveredPeer[] = [];
    for (const peer of this.seen.values()) {
      if (!isStale(peer)) result.push(peer);
      else if (!this.connections.has(peer.nodeId)) this.seen.delete(peer.nodeId);
    }
    for (const connection of this.connections.values()) {
      if (!result.some((peer) => peer.nodeId === connection.nodeId)) {
        result.push({
          nodeId: connection.nodeId,
          name: connection.name,
          host: connection.host,
          port: connection.port,
          lastSeen: connection.lastSeen,
          sessionId: connection.sessionId,
          accepting: true,
          via: "direct",
        });
      }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Broadcast an open invitation: "I have a session, ask me to connect".
   * The invitation rides along in the beacon for `durationSeconds`; peers that
   * hear it have to request a connection, which lands in this node's queue
   * unless the policy auto-approves them.
   */
  async invite(text: string, options: { durationSeconds?: number } = {}): Promise<{
    published: boolean;
    durationSeconds: number;
    peers: DiscoveredPeer[];
    warnings: string[];
  }> {
    await this.ensureStarted();
    this.ensureSession();
    const clean = sanitizeText(text, 200);
    if (!clean) throw new Error("The invitation text must not be empty.");
    const durationSeconds = Math.min(Math.max(options.durationSeconds ?? 300, 10), 3600);
    this.invitation = clean;
    this.invitationUntil = Date.now() + durationSeconds * 1000;
    this.discovery?.setInvitation(clean);

    const peers = await this.discover({ timeoutMs: 1500 });
    return {
      published: Boolean(this.discovery?.isRunning),
      durationSeconds,
      peers: peers.peers,
      warnings: peers.warnings,
    };
  }

  /** The invitation currently published by this node, if any. */
  currentInvitation(): string | null {
    if (!this.invitation) return null;
    if (Date.now() > this.invitationUntil) {
      this.invitation = null;
      this.discovery?.setInvitation(null);
      return null;
    }
    return this.invitation;
  }

  /** Announce, listen briefly, and probe the peers we already know. */
  async discover(options: { timeoutMs?: number; probeKnown?: boolean } = {}): Promise<{
    peers: DiscoveredPeer[];
    warnings: string[];
    multicast: boolean;
  }> {
    const start = await this.ensureStarted();
    const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 2500, 300), 15_000);
    this.ensureSession();

    if (this.discovery) {
      await this.discovery.announce();
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    }

    if (options.probeKnown !== false) {
      await Promise.allSettled(
        this.peers
          .list()
          .filter((peer) => !peer.banned)
          .slice(0, 32)
          .map((peer) => this.probe(peer)),
      );
      await this.probeSeeds();
    }

    return {
      peers: this.visiblePeers(),
      warnings: [...start.warnings, ...(this.discovery?.warningsList ?? [])],
      multicast: this.discovery?.usesMulticast ?? false,
    };
  }

  /**
   * Ask one address for its identity card, without any handshake. This is what
   * makes a swarm cross subnets and VPNs: the address is routable even where a
   * beacon is not broadcast.
   */
  async probe(target: PeerRef | string): Promise<DiscoveredPeer> {
    const peer: PeerRef =
      typeof target === "string"
        ? (() => {
            const match = target.trim().match(/^(\[[^\]]+\]|[^:\s]+):(\d{1,5})$/);
            if (!match) throw new Error(`"${target}" is not host:port.`);
            return {
              nodeId: "",
              name: target,
              host: match[1].replace(/^\[|\]$/g, ""),
              port: Number(match[2]),
            };
          })()
        : target;

    const response = await requestJson<{
      nodeId?: string;
      name?: string;
      port?: number;
      sessionId?: string | null;
      accepting?: boolean;
      invitation?: string;
    }>(`${baseUrl(peer.host, peer.port)}${API_PREFIX}/info`, { timeoutMs: 2500 });
    const data = response.data ?? {};
    if (typeof data.nodeId !== "string" || !data.nodeId) {
      throw new TransportError("the address did not answer like a swarm node");
    }
    const discovered: DiscoveredPeer = {
      nodeId: data.nodeId,
      name: typeof data.name === "string" ? data.name : peer.name,
      host: peer.host,
      port: typeof data.port === "number" ? data.port : peer.port,
      lastSeen: Date.now(),
      sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
      accepting: data.accepting !== false,
      invitation: typeof data.invitation === "string" ? data.invitation : undefined,
      via: "direct",
    };
    this.handleBeacon(discovered);
    return discovered;
  }

  /** Probe configured seeds. Addresses a beacon cannot reach live here. */
  async probeSeeds(): Promise<{ found: DiscoveredPeer[]; errors: string[] }> {
    const found: DiscoveredPeer[] = [];
    const errors: string[] = [];
    for (const seed of this.config.seeds ?? []) {
      try {
        found.push(await this.probe(seed));
      } catch (err) {
        errors.push(`${seed}: ${(err as Error).message}`);
      }
    }
    return { found, errors };
  }

  // ---------------------------------------------------------------- connecting

  /** Turn a name, node id, alias or host:port into a peer reference. */
  resolvePeer(target: string): PeerRef | null {
    const needle = target.trim();
    if (!needle) return null;
    const lower = needle.toLowerCase();

    const connected = [...this.connections.values()].find(
      (connection) =>
        connection.nodeId === needle ||
        connection.name.toLowerCase() === lower ||
        `${connection.host}:${connection.port}` === needle,
    );
    if (connected) {
      return {
        nodeId: connected.nodeId,
        name: connected.name,
        host: connected.host,
        port: connected.port,
      };
    }

    const seen = this.visiblePeers().find(
      (peer) =>
        peer.nodeId === needle ||
        peer.name.toLowerCase() === lower ||
        `${peer.host}:${peer.port}` === needle,
    );
    if (seen) {
      return { nodeId: seen.nodeId, name: seen.name, host: seen.host, port: seen.port };
    }

    const known =
      this.peers.get(needle) ??
      this.peers.byName(needle) ??
      this.peers.list().find((peer) => `${peer.host}:${peer.port}` === needle);
    if (known) {
      return { nodeId: known.nodeId, name: known.name, host: known.host, port: known.port };
    }

    const address = needle.match(/^([^:\s]+|\[[^\]]+\]):(\d{1,5})$/);
    if (address) {
      const host = address[1].replace(/^\[|\]$/g, "");
      const port = Number(address[2]);
      if (port >= 1 && port <= 65535) {
        return { nodeId: "", name: `${host}:${port}`, host, port };
      }
    }

    return null;
  }

  async connect(
    target: string,
    options: {
      scopes?: Scope[];
      message?: string;
      wait?: boolean;
      timeoutMs?: number;
      intent?: string;
    } = {},
  ): Promise<ConnectAttempt> {
    await this.ensureStarted();
    this.ensureSession();

    const peer = this.resolvePeer(target);
    if (!peer) {
      throw new Error(
        `No peer matches "${target}". Use swarm_discover to see who is reachable, or pass host:port.`,
      );
    }

    const known = peer.nodeId ? this.peers.get(peer.nodeId) : undefined;
    if (known?.banned) {
      return {
        peer,
        status: "denied",
        scopes: [],
        reason: "this peer is banned on this node (swarm_peers unban to allow it again)",
      };
    }

    return this.connectPeer(peer, {
      scopes: options.scopes,
      message: options.message,
      wait: options.wait,
      timeoutMs: options.timeoutMs,
      intent: options.intent,
    });
  }

  private resolveScopes(peer: PeerRef, requested?: Scope[]): Scope[] {
    const known = peer.nodeId ? this.peers.get(peer.nodeId) : undefined;
    const scopes = normalizeScopes(requested ?? known?.scopes ?? this.config.defaultScopes);
    if (!this.config.shareKnowledge) {
      return scopes.filter((scope) => !scope.startsWith("knowledge:"));
    }
    return scopes;
  }

  private async connectPeer(
    peer: PeerRef,
    options: {
      scopes?: Scope[];
      message?: string;
      wait?: boolean;
      timeoutMs?: number;
      intent?: string;
    } = {},
  ): Promise<ConnectAttempt> {
    const existing = peer.nodeId ? this.connections.get(peer.nodeId) : undefined;
    if (existing && existing.outToken) {
      // A stored link can outlive the peer: it was restarted, moved, or shut
      // down. Claiming "already connected" for a link that cannot send is worse
      // than a fresh handshake, so the peer is asked whether it still answers.
      if (await this.isReachable(existing)) {
        existing.lastSeen = Date.now();
        return {
          peer: { nodeId: existing.nodeId, name: existing.name, host: existing.host, port: existing.port },
          status: "connected",
          scopes: existing.grantedToMe,
          sessionId: existing.sessionId,
          reason: "already connected",
        };
      }
      this.dropConnection(existing.nodeId, "no answer from the peer");
    }

    // A retry must resume the request that is already queued on the peer, not
    // open a second one: two pending requests for one peer is a race nobody wins.
    const resumable = [...this.outgoing.entries()].find(
      ([, entry]) =>
        (entry.peer.nodeId && entry.peer.nodeId === peer.nodeId) ||
        (entry.peer.host === peer.host && entry.peer.port === peer.port),
    );
    if (resumable) {
      const [requestId, entry] = resumable;
      if (options.wait === false) {
        return {
          peer: entry.peer,
          status: "pending",
          scopes: [],
          requestId,
          reason: "the earlier request for this peer is still pending",
        };
      }
      return this.awaitApproval(entry.peer, requestId, options.timeoutMs ?? 60_000);
    }

    const scopes = this.resolveScopes(peer, options.scopes);
    if (scopes.length === 0) {
      return {
        peer,
        status: "skipped",
        scopes: [],
        reason: "no scopes left to request (knowledge sharing is disabled here)",
      };
    }

    const body = {
      proto: PROTOCOL,
      from: { nodeId: this.identity.nodeId, name: this.config.name },
      sessionId: this.sessionId,
      scopes,
      intent: options.intent ?? "connect",
      message: options.message ? sanitizeText(options.message, 2000) : undefined,
      port: this.server?.port ?? DEFAULT_PORT,
    };

    let response: { status?: string; token?: string; scopes?: unknown; sessionId?: string; requestId?: string; reason?: string; nodeId?: string; name?: string; port?: number };
    try {
      response = (
        await requestJson<typeof response>(
          `${baseUrl(peer.host, peer.port)}${API_PREFIX}/hello`,
          { body, timeoutMs: options.timeoutMs ?? 6000 },
        )
      ).data;
    } catch (err) {
      const error = err as TransportError;
      if (error.statusCode === 403) {
        return { peer, status: "denied", scopes: [], reason: error.message };
      }
      return { peer, status: "unreachable", scopes: [], reason: error.message };
    }

    if (response?.status === "denied") {
      return { peer, status: "denied", scopes: [], reason: response.reason ?? "denied by the peer" };
    }

    if (response?.status === "pending" && response.requestId) {
      const identified: PeerRef = {
        nodeId: response.nodeId ?? peer.nodeId,
        name: response.name ?? peer.name,
        host: peer.host,
        port: peer.port,
      };
      this.outgoing.set(response.requestId, { peer: identified, sessionId: this.sessionId });
      this.peers.touch(identified);
      if (options.wait === false) {
        return {
          peer: identified,
          status: "pending",
          scopes: [],
          requestId: response.requestId,
          reason: response.reason ?? "waiting for the peer to approve the connection",
        };
      }
      return this.awaitApproval(identified, response.requestId, options.timeoutMs ?? 60_000);
    }

    if (response?.status === "accepted" && typeof response.token === "string") {
      const granted = grantedFrom(scopes, normalizeScopes(response.scopes));
      const connection = this.upsertConnection({
        nodeId: response.nodeId ?? peer.nodeId,
        name: response.name ?? peer.name,
        host: peer.host,
        port: peer.port,
        sessionId: response.sessionId ?? this.sessionId ?? "",
        outToken: response.token,
        grantedToMe: granted,
        direction: "out",
      });
      if (response.sessionId && response.sessionId !== this.sessionId) {
        this.adoptSession(response.sessionId);
        connection.sessionId = response.sessionId;
      }
      this.peers.touch(connection);
      await this.syncWith(connection.nodeId);
      return {
        peer: connection,
        status: "connected",
        scopes: granted,
        sessionId: connection.sessionId,
        reason: "accepted",
      };
    }

    return {
      peer,
      status: "denied",
      scopes: [],
      reason: "the peer answered with something this node does not understand",
    };
  }

  private async awaitApproval(
    peer: PeerRef,
    requestId: string,
    timeoutMs: number,
  ): Promise<ConnectAttempt> {
    const deadline = Date.now() + timeoutMs;
    let lastReason = "waiting for approval";

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      let data: {
        status?: string;
        token?: string;
        scopes?: unknown;
        sessionId?: string;
        reason?: string;
      };
      try {
        data = (
          await requestJson<typeof data>(
            `${baseUrl(peer.host, peer.port)}${API_PREFIX}/approval`,
            { body: { requestId, nodeId: this.identity.nodeId }, timeoutMs: 4000 },
          )
        ).data;
      } catch (err) {
        return {
          peer,
          status: "unreachable",
          scopes: [],
          requestId,
          reason: (err as Error).message,
        };
      }

      if (data?.status === "approved" && typeof data.token === "string") {
        const pending = this.outgoing.get(requestId);
        this.outgoing.delete(requestId);
        const granted = normalizeScopes(data.scopes);
        const connection = this.upsertConnection({
          nodeId: peer.nodeId || pending?.peer.nodeId || "",
          name: peer.name,
          host: peer.host,
          port: peer.port,
          sessionId: data.sessionId ?? this.sessionId ?? "",
          outToken: data.token,
          grantedToMe: granted,
          direction: "out",
        });
        if (data.sessionId && data.sessionId !== this.sessionId) {
          this.adoptSession(data.sessionId);
          connection.sessionId = data.sessionId;
        }
        this.peers.touch(connection);
        await this.syncWith(connection.nodeId);
        return {
          peer: connection,
          status: "connected",
          scopes: granted,
          sessionId: connection.sessionId,
          requestId,
          reason: "approved",
        };
      }

      if (data?.status === "denied" || data?.status === "expired") {
        this.outgoing.delete(requestId);
        return {
          peer,
          status: "denied",
          scopes: [],
          requestId,
          reason: data.reason ?? "the peer denied the connection",
        };
      }
      lastReason = data?.reason ?? lastReason;
    }
    this.outgoing.delete(requestId);
    return { peer, status: "pending", scopes: [], requestId, reason: lastReason };
  }

  /**
   * Announce this node and request a connection to every peer that is
   * currently visible. This is the "broadcast" side of the swarm: each receiver
   * decides for itself whether the connection may be established.
   */
  async broadcast(options: {
    scopes?: Scope[];
    message?: string;
    wait?: boolean;
    timeoutMs?: number;
  } = {}): Promise<{ attempts: ConnectAttempt[]; warnings: string[] }> {
    const discovery = await this.discover({ timeoutMs: this.announceWaitMs });
    const candidates = discovery.peers.filter(
      (peer) => peer.nodeId !== this.identity.nodeId && !this.connections.get(peer.nodeId)?.outToken,
    );

    const attempts: ConnectAttempt[] = [];
    for (const candidate of candidates) {
      const known = this.peers.get(candidate.nodeId);
      if (known?.banned) {
        attempts.push({
          peer: candidate,
          status: "skipped",
          scopes: [],
          reason: "banned on this node",
        });
        continue;
      }
      attempts.push(
        await this.connectPeer(candidate, {
          scopes: options.scopes,
          message: options.message,
          wait: options.wait,
          timeoutMs: options.timeoutMs,
          intent: "broadcast",
        }),
      );
    }
    return { attempts, warnings: discovery.warnings };
  }

  private upsertConnection(input: {
    nodeId: string;
    name: string;
    host: string;
    port: number;
    sessionId: string;
    direction: "in" | "out";
    inToken?: string;
    outToken?: string;
    grantedToPeer?: Scope[];
    grantedToMe?: Scope[];
  }): Connection {
    const existing = this.connections.get(input.nodeId);
    const now = Date.now();
    const connection: Connection = {
      nodeId: input.nodeId,
      name: input.name || existing?.name || "unknown",
      host: input.host,
      port: input.port,
      sessionId: input.sessionId || existing?.sessionId || this.sessionId || "",
      inToken: input.inToken ?? existing?.inToken,
      outToken: input.outToken ?? existing?.outToken,
      grantedToPeer: input.grantedToPeer ?? existing?.grantedToPeer ?? [],
      grantedToMe: input.grantedToMe ?? existing?.grantedToMe ?? [],
      direction: input.direction,
      since: existing?.since ?? now,
      lastSeen: now,
    };
    if (connection.inToken) this.tokens.set(connection.inToken, connection.nodeId);
    this.connections.set(connection.nodeId, connection);
    if (this.invitation) {
      this.invitation = null;
      this.invitationUntil = 0;
      this.discovery?.setInvitation(null);
    }
    this.discovery?.setState({ accepting: this.accepting() });
    if (!existing) this.emit({ type: "connected", connection });
    return connection;
  }

  /** Close one link, telling the peer if we are allowed to. */
  async disconnect(nodeId: string, reason = "disconnected from this node"): Promise<boolean> {
    const connection = this.connections.get(nodeId);
    if (!connection) return false;
    if (connection.outToken) {
      await requestJson(
        `${baseUrl(connection.host, connection.port)}${API_PREFIX}/leave`,
        { method: "POST", token: connection.outToken, body: { reason }, timeoutMs: 1000 },
      ).catch(() => {
        /* the peer may already be gone */
      });
    }
    this.dropConnection(nodeId, reason);
    return true;
  }

  private dropConnection(nodeId: string, reason: string): void {
    const connection = this.connections.get(nodeId);
    if (!connection) return;
    if (connection.inToken) this.tokens.delete(connection.inToken);
    this.connections.delete(nodeId);
    this.pullSince.delete(nodeId);
    for (const [requestId, request] of [...this.incoming.entries()]) {
      if (request.from.nodeId === nodeId && request.status === "pending") {
        request.status = "denied";
        request.reason = `the link was closed: ${reason}`;
        this.incoming.delete(requestId);
      }
    }
    this.discovery?.setState({ accepting: this.accepting() });
    this.emit({ type: "disconnected", nodeId, name: connection.name, reason });
  }

  // --------------------------------------------------------------- inbound side

  private authorize(
    req: { headers: { authorization?: string | string[] } },
  ): Connection | null {
    const header = req.headers.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    if (!value || !value.startsWith("Bearer ")) return null;
    const token = value.slice("Bearer ".length).trim();
    if (!token) return null;
    const nodeId = this.tokens.get(token);
    if (!nodeId) return null;
    const connection = this.connections.get(nodeId);
    if (!connection || connection.inToken !== token) return null;
    // No idle expiry on purpose: a link that nobody uses for an hour is still
    // the link both sides approved. A peer that is gone shows up as a failed
    // request, which is the honest signal.
    connection.lastSeen = Date.now();
    return connection;
  }

  private allowRate(connection: Connection): boolean {
    const window = this.rate.get(connection.nodeId);
    const now = Date.now();
    if (!window || now - window.windowStart > 60_000) {
      this.rate.set(connection.nodeId, { windowStart: now, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= this.config.maxMessagesPerMinute;
  }

  private async handleHttp(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    body: Buffer,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = url.pathname.replace(/\/+$/, "");
    const method = req.method ?? "GET";
    const remoteHost = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");

    try {
      if (method === "GET" && route === `${API_PREFIX}/info`) {
        sendJson(res, 200, {
          proto: PROTOCOL,
          nodeId: this.identity.nodeId,
          name: this.config.name,
          port: this.server?.port ?? this.config.port,
          sessionId: this.sessionId,
          accepting: this.accepting(),
          peers: this.connections.size,
          policy: this.config.inboundPolicy,
          knowledge: this.config.shareKnowledge,
          invitation: this.currentInvitation(),
        });
        return;
      }

      if (method === "POST" && route === `${API_PREFIX}/hello`) {
        await this.handleHello(body, remoteHost, res);
        return;
      }

      if (method === "POST" && route === `${API_PREFIX}/approval`) {
        this.handleApprovalRequest(body, res);
        return;
      }

      if (method === "POST" && route === `${API_PREFIX}/leave`) {
        const connection = this.authorize(req);
        if (!connection) {
          sendJson(res, 401, { error: "unknown or expired token" });
          return;
        }
        this.dropConnection(connection.nodeId, "peer left");
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && route === `${API_PREFIX}/message`) {
        const connection = this.authorize(req);
        if (!connection) {
          sendJson(res, 401, { error: "unknown or expired token" });
          return;
        }
        if (!hasScope(connection.grantedToPeer, "chat")) {
          sendJson(res, 403, { error: "this connection was not granted the chat scope" });
          return;
        }
        if (!this.allowRate(connection)) {
          sendJson(res, 429, {
            error: `rate limit reached (${this.config.maxMessagesPerMinute} messages per minute)`,
          });
          return;
        }
        const message = parseMessage(JSON.parse(body.toString("utf-8") || "{}"));
        this.receiveMessage(connection, message);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && route === `${API_PREFIX}/knowledge`) {
        const connection = this.authorize(req);
        if (!connection) {
          sendJson(res, 401, { error: "unknown or expired token" });
          return;
        }
        if (!this.config.shareKnowledge) {
          sendJson(res, 403, { error: "shared knowledge is disabled on this node" });
          return;
        }
        if (!hasScope(connection.grantedToPeer, "knowledge:write")) {
          sendJson(res, 403, { error: "this connection was not granted the knowledge:write scope" });
          return;
        }
        const entries = parseKnowledgePush(JSON.parse(body.toString("utf-8") || "{}"));
        this.ensureSession();
        const outcome = this.knowledge?.merge(entries) ?? { added: 0, replaced: 0, ignored: 0 };
        sendJson(res, 200, outcome);
        return;
      }

      if (method === "GET" && route === `${API_PREFIX}/knowledge`) {
        const connection = this.authorize(req);
        if (!connection) {
          sendJson(res, 401, { error: "unknown or expired token" });
          return;
        }
        if (!this.config.shareKnowledge) {
          sendJson(res, 403, { error: "shared knowledge is disabled on this node" });
          return;
        }
        if (!hasScope(connection.grantedToPeer, "knowledge:read")) {
          sendJson(res, 403, { error: "this connection was not granted the knowledge:read scope" });
          return;
        }
        this.ensureSession();
        const since = Number(url.searchParams.get("since") ?? 0);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 200);
        const entries = (this.knowledge?.since(Number.isFinite(since) ? since : 0) ?? []).slice(
          -limit,
        );
        sendJson(res, 200, { sessionId: this.sessionId, entries });
        return;
      }

      if (method === "POST" && route === `${API_PREFIX}/peers`) {
        const connection = this.authorize(req);
        if (!connection) {
          sendJson(res, 401, { error: "unknown or expired token" });
          return;
        }
        if (!hasScope(connection.grantedToPeer, "peers:share")) {
          sendJson(res, 403, { error: "this connection was not granted the peers:share scope" });
          return;
        }
        const introductions = parseIntroductions(JSON.parse(body.toString("utf-8") || "{}"));
        for (const peer of introductions) {
          if (peer.nodeId === this.identity.nodeId) continue;
          this.seen.set(peer.nodeId, {
            ...peer,
            lastSeen: Date.now(),
            sessionId: null,
            accepting: true,
            via: "direct",
          });
        }
        sendJson(res, 200, { accepted: introductions.length });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof ProtocolError) {
        sendJson(res, 400, { error: err.message });
        return;
      }
      if (err instanceof SyntaxError) {
        sendJson(res, 400, { error: "body must be JSON" });
        return;
      }
      if (err instanceof TransportError) {
        sendJson(res, err.statusCode && err.statusCode >= 400 ? err.statusCode : 400, {
          error: err.message,
        });
        return;
      }
      sendJson(res, 500, { error: err instanceof Error ? err.message : "internal error" });
    }
  }

  private async handleHello(
    body: Buffer,
    remoteHost: string,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    const request = parseHello(JSON.parse(body.toString("utf-8") || "{}"));
    if (request.from.nodeId === this.identity.nodeId) {
      sendJson(res, 400, { error: "a node cannot connect to itself" });
      return;
    }

    const known = this.peers.get(request.from.nodeId);
    if (known?.banned) {
      sendJson(res, 403, { status: "denied", reason: "this peer is banned on this node" });
      return;
    }

    const from: PeerRef = {
      nodeId: request.from.nodeId,
      name: request.from.name,
      host: remoteHost,
      port: request.port,
    };

    // A retry that names its request is answered from that request, never by
    // opening a second one. Only the holder of the request id can do this.
    if (request.requestId) {
      const previous = this.incoming.get(request.requestId);
      if (previous && previous.from.nodeId === from.nodeId) {
        if (previous.status === "approved" && previous.token) {
          this.completeApproval(previous);
          sendJson(res, 200, {
            status: "accepted",
            token: previous.token,
            scopes: previous.grantedScopes,
            sessionId: previous.sessionId,
            nodeId: this.identity.nodeId,
            name: this.config.name,
            port: this.server?.port ?? this.config.port,
            reason: "the earlier request was approved",
          });
          return;
        }
        if (previous.status === "pending") {
          sendJson(res, 200, {
            status: "pending",
            requestId: previous.requestId,
            reason: previous.reason,
            sessionId: this.sessionId,
            nodeId: this.identity.nodeId,
            name: this.config.name,
            port: this.server?.port ?? this.config.port,
          });
          return;
        }
        sendJson(res, 403, {
          status: "denied",
          reason: previous.reason || `the earlier request is ${previous.status}`,
        });
        return;
      }
    }

    const decision = decideInbound({
      config: this.config,
      known,
      requested: request.scopes,
      activeConnections: this.connections.size,
    });

    if (decision.decision === "deny") {
      sendJson(res, 403, { status: "denied", reason: decision.reason });
      return;
    }

    if (decision.decision === "approve") {
      // Adopting the requester's session keeps both nodes on one blackboard.
      if (!this.sessionId && request.sessionId) this.adoptSession(request.sessionId);
      const sessionId = this.ensureSession();
      const token = newToken();
      const connection = this.upsertConnection({
        nodeId: from.nodeId,
        name: from.name,
        host: from.host,
        port: from.port,
        sessionId,
        inToken: token,
        grantedToPeer: decision.scopes,
        direction: "in",
      });
      this.peers.touch(connection);
      sendJson(res, 200, {
        status: "accepted",
        token,
        scopes: decision.scopes,
        sessionId,
        nodeId: this.identity.nodeId,
        name: this.config.name,
        port: this.server?.port ?? this.config.port,
        reason: decision.reason,
      });
      void this.syncWith(connection.nodeId).catch(() => {
        /* knowledge sync is best effort */
      });
      return;
    }

    // Pending: queue it and let the agent or the user decide.
    const pendingFromHost = [...this.incoming.values()].filter(
      (entry) => entry.from.host === remoteHost && entry.status === "pending",
    );
    if (pendingFromHost.length >= MAX_PENDING_REQUESTS) {
      sendJson(res, 429, {
        status: "denied",
        reason: "too many pending requests from this address",
      });
      return;
    }

    const duplicate = [...this.incoming.values()].find(
      (entry) => entry.from.nodeId === from.nodeId && entry.status === "pending",
    );
    const requestId = duplicate?.requestId ?? newId("r");
    const incoming: IncomingRequest = {
      requestId,
      from,
      requestedScopes: request.scopes,
      grantedScopes: [],
      intent: request.intent,
      message: request.message,
      sessionId: request.sessionId ?? this.sessionId ?? "",
      status: "pending",
      reason: decision.reason,
      createdAt: Date.now(),
    };
    this.incoming.set(requestId, incoming);
    this.peers.touch(from);
    if (!duplicate) this.emit({ type: "request", request: incoming });

    sendJson(res, 200, {
      status: "pending",
      requestId,
      reason: decision.reason,
      sessionId: this.sessionId,
      nodeId: this.identity.nodeId,
      name: this.config.name,
      port: this.server?.port ?? this.config.port,
    });
  }

  /**
   * Turn an approved request into a live link. Idempotent: a peer that polls
   * twice gets the same token and does not end up with two connections.
   */
  private completeApproval(request: IncomingRequest): Connection | null {
    if (request.status !== "approved" || !request.token) return null;
    const existing = this.connections.get(request.from.nodeId);
    if (existing && existing.inToken === request.token) return existing;
    return this.upsertConnection({
      nodeId: request.from.nodeId,
      name: request.from.name,
      host: request.from.host,
      port: request.from.port,
      sessionId: request.sessionId,
      inToken: request.token,
      grantedToPeer: request.grantedScopes,
      direction: "in",
    });
  }

  private handleApprovalRequest(body: Buffer, res: import("node:http").ServerResponse): void {
    const { requestId, nodeId } = parseApproval(JSON.parse(body.toString("utf-8") || "{}"));
    const request = this.incoming.get(requestId);
    // Answer exactly as if the request were unknown: a caller that cannot name
    // the requesting node learns nothing about who is queued here.
    if (!request || request.from.nodeId !== nodeId) {
      sendJson(res, 200, { status: "expired", reason: "no such request (any more)" });
      return;
    }
    if (
      request.status === "pending" &&
      Date.now() - request.createdAt > REQUEST_TTL_MS
    ) {
      request.status = "expired";
      request.reason = "the request was not decided in time";
    }
    if (request.status === "approved") {
      this.completeApproval(request);
    }
    sendJson(res, 200, {
      status: request.status,
      token: request.status === "approved" ? request.token : undefined,
      scopes: request.status === "approved" ? request.grantedScopes : undefined,
      sessionId: request.sessionId,
      reason: request.reason,
    });
  }

  private receiveMessage(
    connection: Connection,
    message: { id: string; text: string; kind: MessageKind },
  ): void {
    const entry: SwarmMessage = {
      id: message.id,
      sessionId: this.sessionId ?? connection.sessionId,
      from: {
        nodeId: connection.nodeId,
        name: connection.name,
        host: connection.host,
        port: connection.port,
      },
      text: message.text,
      kind: message.kind,
      ts: Date.now(),
      incoming: true,
    };
    this.pushInbox(entry);
    this.emit({ type: "message", message: entry });
  }

  private pushInbox(message: SwarmMessage): void {
    this.inbox.push(message);
    if (this.inbox.length > 500) this.inbox = this.inbox.slice(-500);
  }

  // -------------------------------------------------------------- decisions

  pendingRequests(): IncomingRequest[] {
    const result: IncomingRequest[] = [];
    for (const request of this.incoming.values()) {
      if (request.status === "pending" && Date.now() - request.createdAt > REQUEST_TTL_MS) {
        request.status = "expired";
        request.reason = "the request was not decided in time";
      }
      if (request.status === "pending") result.push(request);
    }
    return result.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Approve or deny a queued connect request. */
  decide(requestId: string, approve: boolean, scopes?: Scope[], reason?: string): IncomingRequest {
    const request = this.incoming.get(requestId);
    if (!request) {
      const hint = this.pendingRequests().map((entry) => entry.requestId);
      throw new Error(
        hint.length > 0
          ? `Unknown request "${requestId}". Pending: ${hint.join(", ")}.`
          : `Unknown request "${requestId}", and nothing is pending.`,
      );
    }
    if (request.status !== "pending") {
      throw new Error(`Request ${requestId} is already ${request.status}.`);
    }

    if (!approve) {
      request.status = "denied";
      request.reason = reason?.trim() ? `denied: ${sanitizeText(reason, 200)}` : "denied by this node";
      request.decidedAt = Date.now();
      return request;
    }

    if (this.connections.size >= this.config.maxPeers) {
      throw new Error(
        `The peer limit (${this.config.maxPeers}) is reached. Use swarm_leave first, or raise maxPeers.`,
      );
    }

    const granted = normalizeScopes(scopes ?? request.requestedScopes).filter(
      (scope) => this.config.shareKnowledge || !scope.startsWith("knowledge:"),
    );
    if (granted.length === 0) {
      throw new Error("Refusing to approve a connection with no granted scope.");
    }

    const sessionId = this.ensureSession();
    const token = newToken();

    // The link is not established until the requester collects its token, so
    // an approval that is never picked up leaves no half-open connection.
    request.status = "approved";
    request.grantedScopes = granted;
    request.token = token;
    request.reason = "approved on this node";
    request.decidedAt = Date.now();
    request.sessionId = sessionId;

    this.peers.touch(request.from, {
      scopes: granted,
      // The approval is the decision this link needs. Recording it as trusted
      // and auto-connect is what makes the pair of nodes reconnect on their
      // own afterwards: this side dials out on the next beacon, and an inbound
      // request from the same peer is approved without asking again.
      // A banned peer stays banned -- an approval never undoes a ban.
      ...(this.peers.get(request.from.nodeId)?.banned ? {} : { trusted: true, autoConnect: true }),
    });
    return request;
  }

  // ------------------------------------------------------------------ talking

  async say(
    text: string,
    options: { to?: string; kind?: MessageKind } = {},
  ): Promise<SendOutcome & { errors: string[] }> {
    await this.ensureStarted();
    this.ensureSession();
    const clean = sanitizeText(text, MAX_TEXT_LENGTH);
    if (!clean) throw new Error("text must not be empty.");
    const kind: MessageKind = options.kind ?? "chat";

    const targets: Connection[] = [];
    const errors: string[] = [];

    if (options.to) {
      const peer = this.resolvePeer(options.to);
      if (!peer) {
        const names = [...this.connections.values()].map((connection) => connection.name);
        throw new Error(
          names.length > 0
            ? `No peer matches "${options.to}". Connected: ${names.join(", ")}.`
            : `No peer matches "${options.to}", and nothing is connected. Use swarm_broadcast or swarm_connect first.`,
        );
      }
      const connection = this.connections.get(peer.nodeId);
      if (!connection) {
        throw new Error(
          `"${options.to}" is reachable but not connected. Use swarm_connect first.`,
        );
      }
      targets.push(connection);
    } else {
      targets.push(...this.connections.values());
    }

    const delivered: string[] = [];
    const failed: Array<{ nodeId: string; name: string; error: string }> = [];

    for (const connection of targets) {
      if (!connection.outToken) {
        failed.push({
          nodeId: connection.nodeId,
          name: connection.name,
          error: "one-way link: this node may receive from it but not send; ask it to connect back",
        });
        continue;
      }
      if (!hasScope(connection.grantedToMe, "chat")) {
        failed.push({
          nodeId: connection.nodeId,
          name: connection.name,
          error: "the peer did not grant the chat scope to this node",
        });
        continue;
      }

      const outcome = await this.deliver(connection, clean, kind);
      if (outcome.ok) {
        delivered.push(outcome.name);
        this.pushInbox({
          id: newId("m"),
          sessionId: this.sessionId ?? connection.sessionId,
          from: {
            nodeId: this.identity.nodeId,
            name: this.config.name,
            host: "",
            port: this.server?.port ?? 0,
          },
          text: clean,
          kind,
          ts: Date.now(),
          incoming: false,
        });
      } else {
        failed.push({ nodeId: connection.nodeId, name: connection.name, error: outcome.error });
      }
    }

    if (targets.length === 0) errors.push("no connections to send to");
    return { delivered, failed, errors };
  }

  /**
   * Send one message, healing a link that has gone stale.
   *
   * A token outlives the peer that issued it. When the other pi restarts, the
   * token is unknown there, and a link that still says "connected" cannot send
   * any more. Rather than failing the message, the dead link is dropped and the
   * handshake repeated once -- a peer that knows and trusts this node approves
   * that on its own, so the message goes through without the user doing
   * anything.
   */
  /**
   * Run an authenticated call against a peer, healing the link once if the peer
   * no longer knows the token.
   *
   * A restart on the other side invalidates every token it ever issued, and
   * that hits every endpoint the same way -- chat, knowledge, leave. Healing in
   * one place keeps them all working instead of only the one that was patched
   * last.
   */
  private async withLink<T>(
    connection: Connection,
    call: (link: Connection) => Promise<T>,
  ): Promise<{ ok: true; value: T; link: Connection } | { ok: false; error: string }> {
    try {
      return { ok: true, value: await call(connection), link: connection };
    } catch (err) {
      // 401: the peer forgot the token. No status: it did not answer at all.
      // Anything else (403, 429, 500) is an answer and must not be masked by a
      // reconnect.
      const dead =
        err instanceof TransportError &&
        (err.statusCode === 401 || err.statusCode === undefined);
      const error = err as Error;
      if (!dead) return { ok: false, error: error.message };

      const transport = err as TransportError;
      const why = transport.statusCode === 401 ? "token rejected" : "no answer from the peer";
      this.invalidateOutbound(connection, why);
      const fresh = await this.reconnect(connection).catch(() => null);
      if (!fresh) return { ok: false, error: `${error.message} (${why}; reconnecting failed)` };
      try {
        return { ok: true, value: await call(fresh), link: fresh };
      } catch (retryError) {
        return { ok: false, error: `${(retryError as Error).message} (after reconnecting)` };
      }
    }
  }

  private async deliver(
    connection: Connection,
    text: string,
    kind: MessageKind,
  ): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
    const result = await this.withLink(connection, async (link) => {
      await requestJson(`${baseUrl(link.host, link.port)}${API_PREFIX}/message`, {
        body: { id: newId("m"), text, kind, sessionId: this.sessionId },
        token: link.outToken,
        timeoutMs: 6000,
      });
      link.lastSeen = Date.now();
      return link.name;
    });
    return result.ok ? { ok: true, name: result.value } : { ok: false, error: result.error };
  }

  /**
   * Our token to the peer is dead; the token we issued it is not.
   *
   * A rejected outbound token normally means the peer restarted, which says
   * nothing about the half of the link we own. Dropping the whole connection
   * would delete the inbound token and the scopes we granted, so the peer's
   * next call to us would be refused for no reason, and the status would claim
   * we granted nothing. Only the outbound half is reset here; a link with
   * nothing inbound is a real disconnect and goes through dropConnection.
   */
  private invalidateOutbound(connection: Connection, reason: string): void {
    connection.outToken = undefined;
    connection.grantedToMe = [];
    if (!connection.inToken) {
      this.dropConnection(connection.nodeId, reason);
      return;
    }
    // The peer may still call us with the token it already holds.
    this.tokens.set(connection.inToken, connection.nodeId);
  }

  private async reconnect(connection: Connection): Promise<Connection | null> {
    const peer: PeerRef = {
      nodeId: connection.nodeId,
      name: connection.name,
      host: connection.host,
      port: connection.port,
    };
    const attempt = await this.connectPeer(peer, {
      wait: true,
      timeoutMs: 12_000,
      intent: "reconnect",
    });
    if (attempt.status !== "connected") return null;
    return this.connections.get(connection.nodeId) ?? null;
  }

  /** Does the peer answer at all? Unauthenticated, so a rotated token is no death. */
  private async isReachable(connection: Connection, timeoutMs = 2500): Promise<boolean> {
    try {
      await requestJson(`${baseUrl(connection.host, connection.port)}${API_PREFIX}/info`, { timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Drop links whose peer is gone.
   *
   * Without this a node keeps claiming a link to a machine that was shut down
   * hours ago, and the first message to it fails. Only links that have been
   * quiet for the stale window are checked, so healthy ones cost nothing.
   */
  async checkConnections(options: { timeoutMs?: number } = {}): Promise<{
    checked: number;
    dropped: Array<{ nodeId: string; name: string; reason: string }>;
  }> {
    const dropped: Array<{ nodeId: string; name: string; reason: string }> = [];
    let checked = 0;
    for (const connection of [...this.connections.values()]) {
      if (Date.now() - connection.lastSeen < PEER_STALE_MS) continue;
      checked += 1;
      if (await this.isReachable(connection, options.timeoutMs)) {
        connection.lastSeen = Date.now();
        continue;
      }
      this.dropConnection(connection.nodeId, "no answer from the peer");
      dropped.push({
        nodeId: connection.nodeId,
        name: connection.name,
        reason: "no answer from the peer",
      });
    }
    return { checked, dropped };
  }

  drainInbox(options: { limit?: number; clear?: boolean; since?: number } = {}): SwarmMessage[] {
    let messages = [...this.inbox];
    if (options.since !== undefined) {
      messages = messages.filter((message) => message.ts > options.since!);
    }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const result = messages.slice(-limit);
    if (options.clear) {
      const delivered = new Set(result);
      this.inbox = this.inbox.filter((message) => !delivered.has(message));
    }
    return result;
  }

  // ---------------------------------------------------------------- knowledge

  async putKnowledge(inputs: KnowledgeInput[]): Promise<{
    entries: KnowledgeEntry[];
    pushed: number;
    failed: Array<{ name: string; error: string }>;
  }> {
    await this.ensureStarted();
    this.ensureSession();
    if (!this.config.shareKnowledge) {
      throw new Error("Shared knowledge is disabled here. Enable it with swarm_setup shareKnowledge true.");
    }
    if (!this.knowledge) throw new Error("No session knowledge board is open.");

    const entries: KnowledgeEntry[] = [];
    for (const input of inputs) {
      const outcome = this.knowledge.put(input, {
        nodeId: this.identity.nodeId,
        name: this.config.name,
      });
      entries.push(outcome.entry);
    }

    let pushed = 0;
    const failed: Array<{ name: string; error: string }> = [];
    const targets = [...this.connections.values()].filter(
      (connection) => connection.outToken && hasScope(connection.grantedToMe, "knowledge:write"),
    );
    for (const connection of targets) {
      try {
        await this.pushKnowledgeTo(connection, entries);
        pushed += 1;
      } catch (err) {
        failed.push({ name: connection.name, error: (err as Error).message });
      }
    }

    return { entries, pushed, failed };
  }

  private async pushKnowledgeTo(
    connection: Connection,
    entries: readonly KnowledgeEntry[],
  ): Promise<number> {
    if (!connection.outToken) throw new Error("no outbound token for this peer");
    const batch = entries.slice(-MAX_KNOWLEDGE_ENTRIES_PER_PUSH);
    if (batch.length === 0) return 0;
    await requestJson(`${baseUrl(connection.host, connection.port)}${API_PREFIX}/knowledge`, {
      body: { entries: batch },
      token: connection.outToken,
      timeoutMs: 8000,
    });
    return batch.length;
  }

  /** Pull what is new on the peer and push what it does not have yet. */
  async syncWith(nodeId: string, options: { full?: boolean } = {}): Promise<KnowledgeSyncOutcome> {
    const connection = this.connections.get(nodeId);
    const outcome: KnowledgeSyncOutcome = { pulled: 0, pushed: 0, errors: [] };
    if (!connection || !connection.outToken || !this.config.shareKnowledge) return outcome;
    this.ensureSession();
    if (!this.knowledge) return outcome;

    if (hasScope(connection.grantedToMe, "knowledge:read")) {
      const since = options.full ? 0 : (this.pullSince.get(nodeId) ?? 0);
      const result = await this.withLink(connection, async (link) => {
        if (!hasScope(link.grantedToMe, "knowledge:read")) {
          throw new Error("the peer no longer grants knowledge:read");
        }
        const response = await requestJson<{ entries?: unknown }>(
          `${baseUrl(link.host, link.port)}${API_PREFIX}/knowledge?since=${since}&limit=100`,
          { token: link.outToken, timeoutMs: 5000 },
        );
        return (Array.isArray(response.data?.entries) ? response.data.entries : []) as KnowledgeEntry[];
      });
      if (result.ok) {
        const merged = this.knowledge.merge(result.value);
        outcome.pulled = merged.added + merged.replaced;
        const newest = result.value.reduce((max, entry) => Math.max(max, Number(entry.ts) || 0), since);
        this.pullSince.set(nodeId, newest);
        if (outcome.pulled > 0) {
          this.emit({ type: "knowledge", entries: this.knowledge.since(since), from: result.link });
        }
      } else {
        outcome.errors.push(`${connection.name}: ${result.error}`);
      }
    }

    if (hasScope(connection.grantedToMe, "knowledge:write")) {
      const entries = this.knowledge.all().slice(-MAX_KNOWLEDGE_ENTRIES_PER_PUSH);
      const result = await this.withLink(connection, async (link) => {
        if (!hasScope(link.grantedToMe, "knowledge:write")) {
          throw new Error("the peer no longer grants knowledge:write");
        }
        return this.pushKnowledgeTo(link, entries);
      });
      if (result.ok) outcome.pushed = result.value;
      else outcome.errors.push(`${connection.name}: ${result.error}`);
    }

    return outcome;
  }

  async syncAll(options: { full?: boolean } = {}): Promise<KnowledgeSyncOutcome> {
    const total: KnowledgeSyncOutcome = { pulled: 0, pushed: 0, errors: [] };
    for (const connection of [...this.connections.values()]) {
      const outcome = await this.syncWith(connection.nodeId, options);
      total.pulled += outcome.pulled;
      total.pushed += outcome.pushed;
      total.errors.push(...outcome.errors);
    }
    return total;
  }

  // ------------------------------------------------------------------ reports

  snapshot(): SwarmSnapshot {
    this.expireInvitation();
    const connections = [...this.connections.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    return {
      nodeId: this.identity.nodeId,
      name: this.config.name,
      instance: instanceSlug(),
      running: this.running,
      port: this.server?.port ?? null,
      bindHost: this.config.bindHost,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      connections,
      discovered: this.visiblePeers(),
      pending: this.pendingRequests(),
      known: this.peers.count(),
      inbox: this.inbox.length,
      knowledge: this.knowledge?.size ?? 0,
      inboundPolicy: this.config.inboundPolicy,
      autoConnectKnown: this.config.autoConnectKnown,
      seeds: this.config.seeds ?? [],
      invitation: this.currentInvitation(),
      multicast: this.discovery?.usesMulticast ?? false,
      warnings: [...(this.discovery?.warningsList ?? [])],
    };
  }

  knownPeer(nodeId: string): KnownPeer | undefined {
    return this.peers.get(nodeId);
  }


  private emit(event: SwarmEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      /* a listener must never break the node */
    }
  }
}
