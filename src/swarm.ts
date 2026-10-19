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
import * as fs from "node:fs";

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
  MIN_FREE_DISK_BYTES,
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
import { writePrivateJson } from "./fsutil.ts";
import {
  ProtocolError,
  parseApproval,
  parseHello,
  parseIntroductions,
  parseKnowledgePage,
  parseKnowledgePush,
  parseMessage,
  sanitizeText,
} from "./protocol.ts";
import { Discovery, pidAlive } from "./discovery.ts";
import { deriveKeys, fingerprint, isValidPublicKey } from "./crypto.ts";
import type { DirectionKeys } from "./crypto.ts";
import {
  HEADER_FROM,
  HEADER_PUB,
  openRequest,
  ReplayGuard,
  sealedDownloadToFile,
  sealedRequest,
  SealedResponse,
} from "./envelope.ts";
import type { SealedRequestOptions } from "./envelope.ts";
import { displayName, FileStore, isValidOfferId, newOfferId } from "./files.ts";
import type { IncomingOffer } from "./files.ts";
import * as crypto from "node:crypto";

import {
  baseUrl,
  requestJson,
  sendJson,
  startHttpServer,
  TransportError,
} from "./transport.ts";
import type { HttpServerHandle } from "./transport.ts";
import {
  filesDir,
  identityFilePath,
  instanceDir,
  instanceSlug,
  peersFilePath,
  sanitizeSegment,
  sessionsDir,
  swarmDir,
} from "./paths.ts";

export type SwarmEvent =
  | { type: "request"; request: IncomingRequest }
  | { type: "connected"; connection: Connection }
  | { type: "message"; message: SwarmMessage }
  | { type: "knowledge"; entries: KnowledgeEntry[]; from: Connection }
  | { type: "file-offer"; offer: IncomingOffer }
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
  /** Where received files live. Overrides the path from paths.ts (tests). */
  filesPath?: string;
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
  /** Fingerprint of this node's public key, for a first-contact compare. */
  fingerprint: string;
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

/** A request whose envelope was opened: who sealed it, with which key, and what it carries. */
interface SealedCall {
  keys: DirectionKeys;
  token: string | undefined;
  inner: unknown;
  from: string;
  pub: string;
  rid: string;
}

interface RateWindow {
  windowStart: number;
  count: number;
}

function isStale(peer: DiscoveredPeer): boolean {
  return Date.now() - peer.lastSeen > PEER_STALE_MS;
}

/** Identities this process is running, so a second node here is refused too. */
const runningIdentities = new Set<string>();

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
  private readonly files: FileStore;
  private sessionId: string | null = null;
  private startedAt: number | null = null;
  private running = false;
  private rate = new Map<string, RateWindow>();
  private autoConnectTried = new Map<string, number>();
  /** Peers a background attempt is currently negotiating with. */
  private readonly autoConnecting = new Set<string>();
  private maintainTimer: NodeJS.Timeout | null = null;
  private readonly maintainIntervalMs: number;
  /** Knowledge cursor per peer: the board epoch and the last sequence pulled. */
  private pullSince = new Map<string, { epoch: string; seq: number }>();
  /** Request ids already served, so a captured request cannot be replayed. */
  private readonly replay = new ReplayGuard();
  /** Derived transport keys per (peer, public key); ECDH is not free. */
  private readonly keyCache = new Map<string, DirectionKeys>();
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

    this.files = new FileStore({ root: options.filesPath ?? filesDir() });
    this.files.load(this.fileIndexPath());
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

  get fileStore(): FileStore {
    return this.files;
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

    this.assertUniqueIdentity();

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
    runningIdentities.add(this.identity.nodeId);
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
        publicKey: this.identity.keys.publicKey,
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
          this.call(connection, "/leave", {
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
    runningIdentities.delete(this.identity.nodeId);
    this.startedAt = null;
    this.invitation = null;
    this.invitationUntil = 0;
    this.seenInvitation.clear();
    this.autoConnectTried.clear();
    this.knowledge?.persist();
  }

  /** One slot per identity, across every process on this machine. */
  private instanceRecordPath(): string | null {
    if (!this.instanceDirPath) return null;
    const name = `${this.identity.nodeId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
    return path.join(this.instanceDirPath, name);
  }

  /**
   * Refuse to run two nodes under one identity.
   *
   * A duplicate identity is not a cosmetic problem. Peers identify a link by
   * nodeId, so two processes under one id look to them like one peer whose port
   * and token map change every few seconds: their heals alternate between a
   * process that knows their token and one that does not, which is exactly the
   * shape of a healing bug. Since nobody can tell those apart from the outside,
   * the second node does not start at all and says why.
   */
  private assertUniqueIdentity(): void {
    const nodeId = this.identity.nodeId;
    if (runningIdentities.has(nodeId)) {
      throw new Error(
        `This process already runs a swarm node as ${nodeId}. A second node needs its own identity: ` +
          "start it with PI_SWARM_INSTANCE=<name>. Two nodes under one identity are indistinguishable " +
          "from one peer with a changing port, which breaks the link for everyone else.",
      );
    }

    const filePath = this.instanceRecordPath();
    if (!filePath) return;

    let otherPid = 0;
    try {
      if (!fs.existsSync(filePath)) return;
      const record = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { pid?: unknown };
      otherPid = Number(record.pid);
    } catch {
      // An unreadable registry file is not a reason to refuse to start.
      return;
    }
    if (!Number.isInteger(otherPid) || otherPid <= 0 || otherPid === process.pid) return;
    if (!pidAlive(otherPid)) return;

    throw new Error(
      `Another pi on this machine already runs this swarm identity (pid ${otherPid}, node ${nodeId}). ` +
        "A second node needs its own slot: start it with PI_SWARM_INSTANCE=<name>. " +
        "Two processes under one identity are indistinguishable from one peer with a changing port, " +
        "which breaks the link for everyone else.",
    );
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
      // A connection without an outbound token is half a link: this node may
      // receive but cannot send, and nothing else ever asks for the missing
      // half -- the peer has no reason to dial again. Completing it is part of
      // being connected, so it is treated like no connection at all.
      if (this.connections.get(known.nodeId)?.outToken) continue;
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
    // Resume the session this instance had before the restart. The shared board
    // belongs to the session, so a new id on every start would throw the
    // knowledge away -- while the retention setting promises to keep it.
    const sessionId = this.rememberedSession() ?? newId("s");
    this.sessionId = sessionId;
    this.openKnowledge(sessionId);
    this.rememberSession(sessionId);
    this.discovery?.setState({ sessionId, accepting: this.accepting() });
    return sessionId;
  }

  /** Where this instance notes the session it is on, so a restart can resume it. */
  private sessionPointerPath(): string {
    const slug = instanceSlug();
    return path.join(this.sessionsDirPath, slug ? `current-${slug}.json` : "current.json");
  }

  private rememberedSession(): string | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.sessionPointerPath(), "utf-8")) as {
        sessionId?: unknown;
      };
      const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
      if (!sessionId) return null;
      // A pruned session cannot be resumed; its directory is the evidence.
      const dir = path.join(this.sessionsDirPath, sanitizeSegment(sessionId));
      return fs.existsSync(dir) ? sessionId : null;
    } catch {
      return null;
    }
  }

  private rememberSession(sessionId: string): void {
    try {
      writePrivateJson(this.sessionPointerPath(), { sessionId, updatedAt: Date.now() });
    } catch {
      /* an unwritable home only costs the resumption */
    }
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
    this.rememberSession(sessionId);
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
    // A beacon is unauthenticated. One that names a pinned peer with another
    // key is either a reinstall or a spoof; neither may move that peer's entry.
    if (known?.publicKey && peer.publicKey && peer.publicKey !== known.publicKey) return;
    // A flood of made-up node ids must not grow the table without bound.
    if (!this.seen.has(peer.nodeId) && this.seen.size >= 256) return;

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
    // Only a link with both halves counts; one with nothing outbound can send
    // nothing and still needs its handshake.
    if (this.connections.get(peer.nodeId)?.outToken) return;
    if (this.autoConnecting.has(peer.nodeId)) return;
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
      proto?: string;
      nodeId?: string;
      name?: string;
      pub?: string;
      port?: number;
      sessionId?: string | null;
      accepting?: boolean;
      invitation?: string;
    }>(`${baseUrl(peer.host, peer.port)}${API_PREFIX}/info`, { timeoutMs: 2500 });
    const data = response.data ?? {};
    if (typeof data.nodeId !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(data.nodeId)) {
      throw new TransportError("the address did not answer like a swarm node");
    }
    if (data.proto !== PROTOCOL) {
      throw new TransportError(
        `the node there speaks ${typeof data.proto === "string" ? data.proto : "an unknown protocol"}, ` +
          `this one speaks ${PROTOCOL} (encrypted); update pi-swarm on both machines`,
      );
    }
    const discovered: DiscoveredPeer = {
      nodeId: data.nodeId,
      name: typeof data.name === "string" ? sanitizeText(data.name, 64) || peer.name : peer.name,
      ...(isValidPublicKey(data.pub) ? { publicKey: data.pub } : {}),
      host: peer.host,
      // The address that answered is the address that works: behind a tunnel
      // or a port forward, the port the peer believes it has is not this one.
      port: peer.port,
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

    return this.withFingerprint(
      await this.connectPeer(peer, {
        scopes: options.scopes,
        message: options.message,
        wait: options.wait,
        timeoutMs: options.timeoutMs,
        intent: options.intent,
      }),
    );
  }

  /** Attach the fingerprint of the key pinned for the attempt's peer, if any. */
  private withFingerprint(attempt: ConnectAttempt): ConnectAttempt {
    const pinned = attempt.peer.nodeId ? this.peers.get(attempt.peer.nodeId)?.publicKey : undefined;
    return pinned ? { ...attempt, fingerprint: fingerprint(pinned) } : attempt;
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
    peerInput: PeerRef,
    options: {
      scopes?: Scope[];
      message?: string;
      wait?: boolean;
      timeoutMs?: number;
      intent?: string;
    } = {},
  ): Promise<ConnectAttempt> {
    let peer = peerInput;

    // A handshake needs the peer's public key to seal its first request. When it
    // is not known yet -- a plain host:port, a seed, a peer added by hand -- ask
    // the peer itself, which is also where a changed port would show up.
    if (!peer.nodeId || !this.keysForPeer(peer)) {
      let probed: DiscoveredPeer;
      try {
        probed = await this.probe({ ...peer });
      } catch (err) {
        return {
          peer,
          status: "unreachable",
          scopes: [],
          reason: `could not ask ${peer.host}:${peer.port} who it is: ${(err as Error).message}`,
        };
      }
      if (peer.nodeId && probed.nodeId !== peer.nodeId) {
        return {
          peer,
          status: "unreachable",
          scopes: [],
          reason: `${peer.host}:${peer.port} answers as a different node (${probed.nodeId}) than expected`,
        };
      }
      // The address stays the one that was dialed: behind a tunnel or a port
      // forward the peer's own idea of its port is not where it is reached.
      peer = {
        ...peer,
        nodeId: probed.nodeId,
        name: peer.name === `${peer.host}:${peer.port}` ? probed.name : peer.name,
        ...(probed.publicKey ? { publicKey: probed.publicKey } : {}),
      };
      if (this.peers.get(peer.nodeId)?.banned) {
        return {
          peer,
          status: "denied",
          scopes: [],
          reason: "this peer is banned on this node (swarm_peers unban to allow it again)",
        };
      }
    }

    const existing = peer.nodeId ? this.connections.get(peer.nodeId) : undefined;
    if (existing && existing.outToken) {
      // Asking for scopes the link does not hold needs a new handshake: the
      // grant lives in the token, so "already connected" would look like success
      // while quietly keeping the old, narrower grant.
      const missing = normalizeScopes(options.scopes ?? []).filter(
        (scope) => !hasScope(existing.grantedToMe, scope),
      );
      if (missing.length > 0) {
        // Only our own half is reset; whatever we granted the peer stays.
        this.invalidateOutbound(existing, "renegotiating for wider scopes");
      } else if (await this.isReachable(existing)) {
        // A stored link can outlive the peer: it was restarted, moved, or shut
        // down. Claiming "already connected" for a link that cannot send is
        // worse than a fresh handshake, so the peer is asked whether it still
        // answers.
        existing.lastSeen = Date.now();
        return {
          peer: { nodeId: existing.nodeId, name: existing.name, host: existing.host, port: existing.port },
          status: "connected",
          scopes: existing.grantedToMe,
          sessionId: existing.sessionId,
          reason: "already connected",
        };
      } else {
        this.dropConnection(existing.nodeId, "no answer from the peer");
      }
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

    let response: {
      status?: string;
      token?: string;
      scopes?: unknown;
      sessionId?: string;
      requestId?: string;
      reason?: string;
      nodeId?: string;
      name?: string;
      port?: number;
    };
    // The key this hello is sealed to. Whoever opens it and answers sealed
    // holds the private half -- which is what pins it below.
    const usedKey = this.peers.get(peer.nodeId)?.publicKey ?? peer.publicKey;
    try {
      const answer = await this.call<typeof response>(peer, "/hello", {
        body,
        timeoutMs: options.timeoutMs ?? 6000,
      });
      response = answer.data;
    } catch (err) {
      const error = err as TransportError;
      if (error.statusCode === 403 || error.statusCode === 409 || error.statusCode === 426) {
        return { peer, status: "denied", scopes: [], reason: error.message };
      }
      return { peer, status: "unreachable", scopes: [], reason: error.message };
    }

    if (response?.status === "denied") {
      return { peer, status: "denied", scopes: [], reason: response.reason ?? "denied by the peer" };
    }

    if (response?.nodeId && response.nodeId !== peer.nodeId) {
      return {
        peer,
        status: "denied",
        scopes: [],
        reason: "the peer answered under a different node id than the one it was reached as",
      };
    }

    // Pin the key before any token is trusted: from here on, a different key
    // means a different peer.
    if (response?.status === "pending" || response?.status === "accepted") {
      const pinned = this.pinKey(peer, usedKey);
      if (!pinned.ok) {
        return { peer, status: "denied", scopes: [], reason: pinned.reason };
      }
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
        const answer = await this.call<typeof data>(peer, "/approval", {
          body: { requestId, nodeId: this.identity.nodeId },
          timeoutMs: 4000,
        });
        data = answer.data;
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
        this.withFingerprint(
          await this.connectPeer(candidate, {
            scopes: options.scopes,
            message: options.message,
            wait: options.wait,
            timeoutMs: options.timeoutMs,
            intent: "broadcast",
          }),
        ),
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
    // The address of a link is where this node reaches the peer. An inbound
    // handshake only says where the peer *thinks* it listens, which behind an
    // SSH tunnel, a port forward or a container mapping is not reachable from
    // here -- so it must not move an outbound half that works.
    const keepAddress = input.direction === "in" && Boolean(existing?.outToken);
    const connection: Connection = {
      nodeId: input.nodeId,
      name: input.name || existing?.name || "unknown",
      host: keepAddress && existing ? existing.host : input.host,
      port: keepAddress && existing ? existing.port : input.port,
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
      await this.call(connection, "/leave", {
        token: connection.outToken,
        body: { reason },
        timeoutMs: 1000,
      }).catch(() => {
        /* the peer may already be gone */
      });
    }
    this.dropConnection(nodeId, reason);
    return true;
  }

  /** Forget everything a peer sent or was offered. */
  purgePeerFiles(nodeId: string): void {
    const purged = this.files.purgePeer(nodeId);
    if (purged.files > 0 || purged.offers > 0) this.files.persist(this.fileIndexPath());
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

  /**
   * The link a sealed call belongs to, or null.
   *
   * The token comes out of the sealed envelope, and it only counts when the node
   * that sealed the call is the node it was issued to: a token is bound to its
   * peer, not a bearer secret anybody could present.
   */
  private authorize(sealed: { token?: string | undefined; from: string; pub: string }): Connection | null {
    const token = sealed.token;
    if (!token) return null;
    const nodeId = this.tokens.get(token);
    if (!nodeId || nodeId !== sealed.from) return null;
    const connection = this.connections.get(nodeId);
    if (!connection || connection.inToken !== token) return null;
    if (this.peers.get(nodeId)?.publicKey !== sealed.pub) return null;
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
          pub: this.identity.keys.publicKey,
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

      // Everything below this line arrives sealed. The headers name the sender
      // and carry its public key (both public); the token rides inside.
      let sealed: SealedCall;
      try {
        sealed = this.openSealed(req, method, `${url.pathname}${url.search}`, body);
      } catch (err) {
        // Refused before the envelope was open, so the answer cannot be sealed:
        // the caller treats it as unauthenticated.
        const error = err as TransportError;
        sendJson(res, error.statusCode ?? 400, { error: error.message });
        return;
      }
      res = new SealedResponse(
        res,
        sealed.keys,
        method,
        `${url.pathname}${url.search}`,
        sealed.rid,
      ) as unknown as import("node:http").ServerResponse;
      const json = (): unknown => sealed.inner ?? {};

      if (method === "POST" && route === `${API_PREFIX}/hello`) {
        await this.handleHello(json(), remoteHost, res, sealed);
        return;
      }

      if (method === "POST" && route === `${API_PREFIX}/approval`) {
        this.handleApprovalRequest(json(), res, sealed);
        return;
      }

      // Every other route belongs to an established link: a token this node
      // issued, presented by the very node it was issued to, plus the scope.
      const link = (scope: Scope | null, rateLimited: boolean): Connection | null => {
        const connection = this.authorize(sealed);
        if (!connection) {
          sendJson(res, 401, { error: "unknown or expired token" });
          return null;
        }
        if (scope && !hasScope(connection.grantedToPeer, scope)) {
          sendJson(res, 403, { error: `this connection was not granted the ${scope} scope` });
          return null;
        }
        if (rateLimited && !this.allowRate(connection)) {
          sendJson(res, 429, {
            error: `rate limit reached (${this.config.maxMessagesPerMinute} calls per minute)`,
          });
          return null;
        }
        return connection;
      };

      if (method === "POST" && route === `${API_PREFIX}/files/offer`) {
        const connection = link("files:write", true);
        if (!connection) return;
        const parsed = (json() ?? {}) as { offerId?: unknown; name?: unknown; size?: unknown; sha256?: unknown };
        const size = Number(parsed.size);
        const sha256 = String(parsed.sha256 ?? "");
        const remoteOfferId = parsed.offerId;
        if (!isValidOfferId(remoteOfferId)) {
          sendJson(res, 400, { error: "the offer id is malformed" });
          return;
        }
        if (!Number.isInteger(size) || size < 0 || size > this.config.filesMaxBytes) {
          sendJson(res, 413, {
            error: `the offer is ${size} bytes; this node accepts files up to ${this.config.filesMaxBytes}`,
          });
          return;
        }
        if (!/^[a-f0-9]{64}$/.test(sha256)) {
          sendJson(res, 400, { error: "the offer must carry the sha256 of the file" });
          return;
        }
        if (this.files.overQuota(connection.nodeId, size)) {
          sendJson(res, 429, { error: "the quota for this peer is used up" });
          return;
        }

        const policy = this.config.filesPolicy;
        if (policy === "deny") {
          sendJson(res, 403, { error: "this node does not accept files" });
          return;
        }

        const offer = this.files.addIncoming({
          remoteOfferId,
          from: { nodeId: connection.nodeId, name: connection.name, host: connection.host, port: connection.port },
          displayName: displayName(parsed.name),
          size,
          sha256,
        });
        if (!offer) {
          sendJson(res, 409, { error: "this offer was already made" });
          return;
        }
        this.emit({ type: "file-offer", offer });
        if (policy === "auto") {
          // Consent was given by configuration, so the bytes are collected
          // without a further step. If the sender never granted files:read the
          // pull fails and the offer stays pending for a manual accept.
          void this.acceptFile(offer.offerId).catch(() => {
            /* the offer stays pending */
          });
        }
        sendJson(res, 200, {
          status: policy === "auto" ? "accepted" : "pending",
          offerId: offer.offerId,
          reason: policy === "auto" ? "this node accepts files automatically" : "waiting for a decision",
        });
        return;
      }

      if (method === "GET" && route.startsWith(`${API_PREFIX}/files/`)) {
        const connection = link("files:read", false);
        if (!connection) return;
        let offerId = "";
        try {
          offerId = decodeURIComponent(route.slice(`${API_PREFIX}/files/`.length));
        } catch {
          /* a malformed escape is simply no offer */
        }
        const offer = this.files.takeOutgoing(offerId, connection.nodeId);
        if ("error" in offer) {
          sendJson(res, 404, { error: offer.error });
          return;
        }
        let bytes: Buffer;
        try {
          bytes = fs.readFileSync(offer.sourcePath);
        } catch {
          sendJson(res, 410, { error: "the offered file is no longer readable on this node" });
          return;
        }
        // The bytes are the sealed payload as they are; the receiver checks
        // them against the sha256 promised in the offer.
        res.writeHead(200);
        res.end(bytes);
        return;
      }

      if (method === "POST" && route === `${API_PREFIX}/leave`) {
        const connection = link(null, false);
        if (!connection) return;
        this.dropConnection(connection.nodeId, "peer left");
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && route === `${API_PREFIX}/message`) {
        const connection = link("chat", true);
        if (!connection) return;
        const message = parseMessage(json());
        this.receiveMessage(connection, message);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === "POST" && route === `${API_PREFIX}/knowledge`) {
        if (!this.config.shareKnowledge) {
          sendJson(res, 403, { error: "shared knowledge is disabled on this node" });
          return;
        }
        const connection = link("knowledge:write", true);
        if (!connection) return;
        const entries = parseKnowledgePush(json());
        this.ensureSession();
        // A peer writes in its own name only; third-party entries reach this
        // node through the peers it chose to read from.
        const outcome =
          this.knowledge?.merge(entries, {
            selfNodeId: this.identity.nodeId,
            onlyAuthor: connection.nodeId,
            via: { nodeId: connection.nodeId, name: connection.name },
          }) ?? { added: 0, replaced: 0, ignored: 0, ids: [] };
        sendJson(res, 200, { added: outcome.added, replaced: outcome.replaced, ignored: outcome.ignored });
        return;
      }

      if (method === "GET" && route === `${API_PREFIX}/knowledge`) {
        if (!this.config.shareKnowledge) {
          sendJson(res, 403, { error: "shared knowledge is disabled on this node" });
          return;
        }
        const connection = link("knowledge:read", false);
        if (!connection) return;
        this.ensureSession();
        const after = Number(url.searchParams.get("after") ?? 0);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100) || 100, 1), 200);
        const page = this.knowledge?.page(Number.isFinite(after) ? after : 0, limit) ?? {
          entries: [],
          next: 0,
          more: false,
          epoch: "",
        };
        sendJson(res, 200, { sessionId: this.sessionId, ...page });
        return;
      }

      if (method === "POST" && route === `${API_PREFIX}/peers`) {
        const connection = link("peers:share", true);
        if (!connection) return;
        const introductions = parseIntroductions(json());
        let accepted = 0;
        for (const peer of introductions) {
          if (peer.nodeId === this.identity.nodeId) continue;
          // An introduction is a hint. It never replaces what this node saw or
          // pinned itself, so it cannot redirect a known peer to another address.
          if (this.seen.has(peer.nodeId) || this.peers.get(peer.nodeId)) continue;
          this.seen.set(peer.nodeId, {
            ...peer,
            lastSeen: Date.now(),
            sessionId: null,
            accepting: true,
            via: "direct",
          });
          accepted += 1;
        }
        sendJson(res, 200, { accepted });
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
    raw: unknown,
    remoteHost: string,
    res: import("node:http").ServerResponse,
    sealed: SealedCall,
  ): Promise<void> {
    const request = parseHello(raw);
    if (request.from.nodeId === this.identity.nodeId) {
      sendJson(res, 400, { error: "a node cannot connect to itself" });
      return;
    }
    // The node that sealed the envelope is the node that asks; the body cannot
    // name somebody else.
    if (request.from.nodeId !== sealed.from) {
      sendJson(res, 400, { error: "the request names a different node than the one that sealed it" });
      return;
    }

    const known = this.peers.get(request.from.nodeId);
    if (known?.banned) {
      sendJson(res, 403, { status: "denied", reason: "this peer is banned on this node" });
      return;
    }
    // openSealed already refused a key that differs from the pinned one, so
    // "pinned" here means "pinned and presented".
    const keyVerified = Boolean(known?.publicKey && known.publicKey === sealed.pub);

    const from: PeerRef = {
      nodeId: request.from.nodeId,
      name: request.from.name,
      publicKey: sealed.pub,
      host: remoteHost,
      port: request.port,
    };

    // A retry that names its request is answered from that request, never by
    // opening a second one. Only the holder of the request id -- and of the key
    // the request was made with -- can do this.
    if (request.requestId) {
      const previous = this.incoming.get(request.requestId);
      if (previous && previous.from.nodeId === from.nodeId && previous.from.publicKey === sealed.pub) {
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
      keyVerified,
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
      // The key that proved itself here is the one this link is bound to.
      this.peers.touch({ ...connection, publicKey: sealed.pub });
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
    this.pruneRequests();
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
      (entry) =>
        entry.from.nodeId === from.nodeId && entry.from.publicKey === sealed.pub && entry.status === "pending",
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
    // A stranger is not written to the peer book before anyone decided about
    // it: that would let any host fill the book (and push real peers out of
    // the probe list). Only a peer this node already pinned gets its address
    // refreshed here.
    if (keyVerified) this.peers.touch(from);
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
   * Forget decided and expired requests after a while, so a stream of hellos
   * cannot grow the queue without bound.
   */
  private pruneRequests(): void {
    const now = Date.now();
    for (const [requestId, request] of this.incoming) {
      if (request.status === "pending" && now - request.createdAt > REQUEST_TTL_MS) {
        request.status = "expired";
        request.reason = "the request was not decided in time";
      }
      if (request.status !== "pending" && now - (request.decidedAt ?? request.createdAt) > REQUEST_TTL_MS) {
        this.incoming.delete(requestId);
      }
    }
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

  private handleApprovalRequest(
    raw: unknown,
    res: import("node:http").ServerResponse,
    sealed: SealedCall,
  ): void {
    const { requestId, nodeId } = parseApproval(raw);
    const request = this.incoming.get(requestId);
    // Answer exactly as if the request were unknown: only the node that made
    // the request, sealing with the key it made it with, may collect a token.
    if (
      !request ||
      request.from.nodeId !== nodeId ||
      nodeId !== sealed.from ||
      request.from.publicKey !== sealed.pub
    ) {
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
      nodeId: this.identity.nodeId,
      name: this.config.name,
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

    const pinned = this.pinKey(request.from, request.from.publicKey);
    if (!pinned.ok) {
      throw new Error(pinned.reason);
    }

    // Same rule as for the link: an address this node dials successfully beats
    // the one the peer announced in its request.
    const outbound = this.connections.get(request.from.nodeId);
    const address = outbound?.outToken ? { host: outbound.host, port: outbound.port } : {};
    this.peers.touch({ ...request.from, ...address }, {
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

  /** Refuse a transfer when the disk is nearly full instead of filling it. */
  private assertDiskSpace(): void {
    try {
      const stat = fs.statfsSync(this.files.fileStoreRootPath());
      const free = Number(stat.bavail) * Number(stat.bsize);
      if (Number.isFinite(free) && free < MIN_FREE_DISK_BYTES) {
        throw new Error(
          `Refusing the transfer: only ${Math.round(free / (1024 * 1024))} MB free where files are stored.`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Refusing the transfer")) throw err;
      /* an unsupported statfs on this platform must not block transfers */
    }
  }

  // ------------------------------------------------------------ sealed calls

  /** How this node names itself in a sealed call. */
  private sealedSelf(): { nodeId: string; publicKey: string } {
    return { nodeId: this.identity.nodeId, publicKey: this.identity.keys.publicKey };
  }

  /** Transport keys for one (peer, key) pair, derived once and cached. */
  private keysFor(nodeId: string, publicKey: string): DirectionKeys {
    const cacheKey = `${nodeId}|${publicKey}`;
    const cached = this.keyCache.get(cacheKey);
    if (cached) return cached;
    const keys = deriveKeys(this.identity.keys, publicKey, this.identity.nodeId, nodeId);
    if (this.keyCache.size >= 512) this.keyCache.clear();
    this.keyCache.set(cacheKey, keys);
    return keys;
  }

  /**
   * The keys for one peer, or null when no key is known for it.
   *
   * A pinned key always wins over one that arrived with a beacon or a probe:
   * those are unauthenticated, and preferring them would let a spoofed beacon
   * decide which key this node encrypts to.
   */
  private keysForPeer(peer: { nodeId: string; publicKey?: string | undefined }): DirectionKeys | null {
    if (!peer.nodeId) return null;
    const publicKey = this.peers.get(peer.nodeId)?.publicKey ?? peer.publicKey;
    if (!publicKey || !isValidPublicKey(publicKey)) return null;
    return this.keysFor(peer.nodeId, publicKey);
  }

  /** One sealed call to a peer's endpoint, e.g. call(link, "/message", {...}). */
  private async call<T = unknown>(
    peer: { nodeId: string; host: string; port: number; publicKey?: string | undefined },
    route: string,
    options: SealedRequestOptions,
  ): Promise<{ status: number; data: T }> {
    const keys = this.keysForPeer(peer);
    // A plain Error, not a TransportError: a missing key is not a dead link and
    // must not send withLink into a reconnect loop.
    if (!keys) throw new Error(`no encryption key is known for ${peer.nodeId || `${peer.host}:${peer.port}`}`);
    return sealedRequest<T>(
      `${baseUrl(peer.host, peer.port)}${API_PREFIX}${route}`,
      keys,
      this.sealedSelf(),
      peer.nodeId,
      options,
    );
  }

  /**
   * Open a sealed request, or refuse it.
   *
   * Everything except /info has to arrive sealed: the headers name the sender
   * and carry its public key, and being able to open the body proves the sender
   * holds the matching private key. A key that differs from the pinned one is
   * refused before anything else happens, and so is a replayed request.
   */
  private openSealed(
    req: import("node:http").IncomingMessage,
    method: string,
    pathWithQuery: string,
    body: Buffer,
  ): SealedCall {
    const header = (name: string): string => {
      const value = req.headers[name];
      return (Array.isArray(value) ? value[0] : value ?? "").trim();
    };
    const from = header(HEADER_FROM);
    const pub = header(HEADER_PUB);
    if (!from || !pub) {
      throw new TransportError(
        `this node speaks ${PROTOCOL} and accepts only sealed requests; update pi-swarm on the calling machine`,
        426,
      );
    }
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(from)) throw new TransportError("the sender id is malformed", 400);
    if (from === this.identity.nodeId) throw new TransportError("a node cannot call itself", 400);
    if (!isValidPublicKey(pub)) throw new TransportError("the sender key is not an X25519 public key", 400);

    const known = this.peers.get(from);
    if (known?.banned) throw new TransportError("this peer is banned on this node", 403);
    if (known?.publicKey && known.publicKey !== pub) {
      throw new TransportError(
        "this node has a different encryption key pinned for you; if you were reinstalled on purpose, " +
          "ask the user there to forget this peer (swarm_peers forget) and approve again",
        409,
      );
    }

    const keys = this.keysFor(from, pub);
    const envelope = openRequest(keys, { method, path: pathWithQuery, from, to: this.identity.nodeId }, body);
    this.replay.check(from, envelope.rid, envelope.ts);
    return { keys, token: envelope.token, inner: envelope.body, from, pub, rid: envelope.rid };
  }

  /**
   * Record the key of a peer, or confirm it matches what was pinned before.
   *
   * The first contact pins the key, the way ssh remembers a host key. A peer
   * that later presents a different key is not the peer that was approved --
   * either it was reinstalled, or somebody is in the middle -- and neither case
   * may be resolved automatically.
   */
  private pinKey(peer: PeerRef, publicKey: string | undefined): { ok: true } | { ok: false; reason: string } {
    if (!publicKey || !isValidPublicKey(publicKey)) {
      return { ok: false, reason: "the peer did not present a usable encryption key" };
    }
    const pinned = this.peers.get(peer.nodeId)?.publicKey;
    if (!pinned) {
      this.peers.touch({ ...peer, publicKey });
      return { ok: true };
    }
    if (pinned === publicKey) return { ok: true };
    return {
      ok: false,
      reason:
        `this peer presents a different encryption key (${fingerprint(publicKey)}) than the one pinned ` +
        `for it (${fingerprint(pinned)}). If it was reinstalled on purpose, forget it here ` +
        "(swarm_peers forget) and approve it again.",
    };
  }

  private fileIndexPath(): string {
    return path.join(this.files.fileStoreRootPath(), "index.json");
  }

  // -------------------------------------------------------------- file offers

  /**
   * Offer one local file to a peer.
   *
   * Nothing is copied here: the receiver pulls the bytes later, which is what
   * keeps a half-written file from ever existing on the receiving side.
   */
  async offerFile(
    target: string,
    filePath: string,
    options: { expiresInSeconds?: number } = {},
  ): Promise<{ offerId: string; status: string; reason: string; peer: string; size: number; sha256: string }> {
    await this.ensureStarted();
    this.ensureSession();

    const peer = this.resolvePeer(target);
    if (!peer) throw new Error(`No peer matches "${target}".`);
    const connection = peer.nodeId ? this.connections.get(peer.nodeId) : undefined;
    if (!connection || !connection.outToken) {
      throw new Error(`"${target}" is not connected, so a file cannot be offered to it.`);
    }
    if (!hasScope(connection.grantedToMe, "files:write")) {
      throw new Error(
        `${connection.name} did not grant this node the files:write scope. Use swarm_connect scopes=[...,"files:write"] to negotiate it.`,
      );
    }

    const absolute = path.resolve(filePath);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) throw new Error(`"${filePath}" is not a file.`);
    if (stat.size > this.config.filesMaxBytes) {
      throw new Error(
        `"${filePath}" is ${stat.size} bytes; this node only offers files up to ${this.config.filesMaxBytes} bytes.`,
      );
    }
    const bytes = fs.readFileSync(absolute);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const offerId = newOfferId();
    const sentName = path.basename(absolute);

    // Registered before the offer goes out: a receiver with filesPolicy=auto
    // collects the bytes right away, possibly before our POST has returned.
    const expiresAt = Date.now() + Math.min(Math.max(options.expiresInSeconds ?? 600, 10), 3600) * 1000;
    this.files.addOutgoing({
      offerId,
      to: { nodeId: connection.nodeId, name: connection.name, host: connection.host, port: connection.port },
      sourcePath: absolute,
      displayName: sentName,
      size: bytes.length,
      sha256,
      createdAt: Date.now(),
      expiresAt,
      served: false,
    });

    let response: { status: number; data: unknown };
    try {
      response = await this.call(connection, "/files/offer", {
        body: { offerId, name: sentName, size: bytes.length, sha256 },
        token: connection.outToken,
        timeoutMs: 8000,
      });
    } catch (err) {
      this.files.dropOutgoing(offerId);
      throw err;
    }
    const responseData = (response.data ?? {}) as { status?: unknown; offerId?: unknown; reason?: unknown };

    const status = typeof responseData.status === "string" ? responseData.status : "unknown";
    if (status === "declined") {
      this.files.dropOutgoing(offerId);
      return {
        offerId: "",
        status,
        reason: typeof responseData.reason === "string" ? responseData.reason : "declined",
        peer: connection.name,
        size: bytes.length,
        sha256,
      };
    }

    // The receiver files the offer under its own id; that is the id its user
    // accepts, so it is the one worth reporting.
    return {
      offerId: isValidOfferId(responseData.offerId) ? responseData.offerId : offerId,
      status,
      reason: typeof responseData.reason === "string" ? responseData.reason : "offered",
      peer: connection.name,
      size: bytes.length,
      sha256,
    };
  }

  /** Pull an offered file: the receiver fetches, verifies and stores it. */
  async acceptFile(offerId: string): Promise<{
    offer: IncomingOffer;
    storedPath: string;
    bytes: number;
    sha256: string;
  }> {
    await this.ensureStarted();
    const offer = this.files.incomingOffer(offerId);
    if (!offer) throw new Error(`No offer with id "${offerId}".`);
    if (offer.status === "accepted") throw new Error(`Offer ${offerId} was already collected.`);
    if (offer.status !== "pending") throw new Error(`Offer ${offerId} is ${offer.status}.`);

    const connection = this.connections.get(offer.from.nodeId);
    if (!connection || !connection.outToken) {
      throw new Error(`Not connected to ${offer.from.name}; the bytes come from there, so the link is needed.`);
    }
    if (!hasScope(connection.grantedToMe, "files:read")) {
      throw new Error(
        `${connection.name} did not grant this node the files:read scope, so the file cannot be collected.`,
      );
    }
    if (offer.size > this.config.filesMaxBytes) {
      throw new Error(`The offer is ${offer.size} bytes; this node accepts up to ${this.config.filesMaxBytes}.`);
    }
    if (this.files.overQuota(offer.from.nodeId, offer.size)) {
      throw new Error(
        `Accepting this would exceed the quota for ${offer.from.name}. Remove files with swarm_file action=delete first.`,
      );
    }
    this.assertDiskSpace();

    const target = this.files.targetPath(offer.from.nodeId, offerId);
    const temp = this.files.tempPath(offer.from.nodeId, offerId);
    fs.rmSync(temp, { force: true });

    const downloadKeys = this.keysForPeer(connection);
    if (!downloadKeys) throw new Error(`No encryption key is pinned for ${connection.name}.`);
    let result: { bytes: number; sha256: string };
    try {
      result = await sealedDownloadToFile(
        `${baseUrl(connection.host, connection.port)}${API_PREFIX}/files/${encodeURIComponent(offer.remoteOfferId)}`,
        downloadKeys,
        this.sealedSelf(),
        connection.nodeId,
        temp,
        {
          token: connection.outToken,
          maxBytes: Math.min(this.config.filesMaxBytes, Math.max(offer.size, 1)),
        },
      );
    } catch (err) {
      fs.rmSync(temp, { force: true });
      throw err;
    }

    if (offer.sha256 && result.sha256 !== offer.sha256) {
      fs.rmSync(temp, { force: true });
      throw new Error(
        `The file does not match what was offered (sha256 ${result.sha256.slice(0, 12)} instead of ${offer.sha256.slice(0, 12)}); it was deleted.`,
      );
    }

    fs.renameSync(temp, target);
    this.files.markAccepted(offerId, { storedPath: target, receivedBytes: result.bytes });
    this.files.persist(this.fileIndexPath());
    return { offer: offer, storedPath: target, bytes: result.bytes, sha256: result.sha256 };
  }

  declineFile(offerId: string): IncomingOffer {
    const offer = this.files.decline(offerId);
    if (!offer) throw new Error(`No offer with id "${offerId}".`);
    return offer;
  }

  fileOffers(): IncomingOffer[] {
    return this.files.pendingOffers();
  }

  receivedFiles() {
    return this.files.receivedFiles();
  }

  /** Remove received files past their retention window; returns what went. */
  sweepFiles(): Array<{ displayName: string; path: string }> {
    const { removed } = this.files.sweep(this.config.filesRetentionDays);
    if (removed.length > 0) this.files.persist(this.fileIndexPath());
    return removed;
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
        // A plain refusal (a scope that is gone, a policy) is the answer we
        // want to report; only a transport failure gets the retry note.
        const retry = retryError as Error;
        const suffix = retryError instanceof TransportError ? " (after reconnecting)" : "";
        return { ok: false, error: `${retry.message}${suffix}` };
      }
    }
  }

  private async deliver(
    connection: Connection,
    text: string,
    kind: MessageKind,
  ): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
    const result = await this.withLink(connection, async (link) => {
      // Checked on the link that actually sends: after a heal the peer may have
      // granted less than before, and the scope from before the 401 proves
      // nothing.
      if (!hasScope(link.grantedToMe, "chat")) {
        throw new Error("the peer no longer grants the chat scope to this node");
      }
      await this.call(link, "/message", {
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

  /**
   * Forget the token this node issued to a peer, keeping the link.
   *
   * A peer whose token is gone while its own state still says "connected" is
   * the one situation the heal path exists for, and it is otherwise impossible
   * to produce without restarting a process: dropping the connection makes both
   * sides re-handshake immediately, which skips the interesting step. The grant
   * in the peer book stays, so the next handshake is approved without a human.
   */
  revokePeerToken(target: string): {
    nodeId: string;
    name: string;
    hadToken: boolean;
    grantedToPeer: Scope[];
  } {
    const peer = this.resolvePeer(target);
    if (!peer) throw new Error(`No peer matches "${target}".`);
    const connection = peer.nodeId ? this.connections.get(peer.nodeId) : undefined;
    if (!connection) {
      throw new Error(
        `"${target}" is not connected, so this node holds no token for it. A token is only ever issued during a handshake.`,
      );
    }

    const hadToken = Boolean(connection.inToken);
    if (connection.inToken) {
      this.tokens.delete(connection.inToken);
      connection.inToken = undefined;
    }
    // A reset means this node no longer trusts that peer's state: its offers
    // and the files it already sent go with the token.
    this.purgePeerFiles(connection.nodeId);
    return {
      nodeId: connection.nodeId,
      name: connection.name,
      hadToken,
      grantedToPeer: [...connection.grantedToPeer],
    };
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
    await this.call(connection, "/knowledge", {
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
      const cursor = options.full ? undefined : this.pullSince.get(nodeId);
      const board = this.knowledge;
      const result = await this.withLink(connection, async (link) => {
        if (!hasScope(link.grantedToMe, "knowledge:read")) {
          throw new Error("the peer no longer grants knowledge:read");
        }
        // Page through everything stored on the peer after our cursor. The
        // cursor is the peer's own store order, so nothing is skipped when
        // more than one page is new or when an entry was relayed late.
        let epoch = cursor?.epoch ?? "";
        let after = cursor?.seq ?? 0;
        const accepted: KnowledgeEntry[] = [];
        let restarted = false;
        for (let page = 0; page < 20; page += 1) {
          const response = await this.call(link, `/knowledge?after=${after}&limit=100`, {
            method: "GET",
            token: link.outToken,
            timeoutMs: 5000,
          });
          const data = parseKnowledgePage(response.data);
          if (epoch && data.epoch && data.epoch !== epoch && !restarted) {
            // The peer's board was recreated: our cursor means nothing there.
            restarted = true;
            epoch = data.epoch;
            after = 0;
            page = -1;
            continue;
          }
          epoch = data.epoch || epoch;
          const merged = board.merge(data.entries, {
            selfNodeId: this.identity.nodeId,
            via: { nodeId: link.nodeId, name: link.name },
          });
          for (const id of merged.ids) {
            const stored = board.get(id);
            if (stored) accepted.push(stored);
          }
          after = Math.max(after, data.next);
          if (!data.more || data.entries.length === 0) break;
        }
        return { epoch, after, accepted };
      });
      if (result.ok) {
        this.pullSince.set(nodeId, { epoch: result.value.epoch, seq: result.value.after });
        const fresh = result.value.accepted.filter((entry, index, all) => all.indexOf(entry) === index);
        outcome.pulled = fresh.length;
        if (fresh.length > 0) {
          this.emit({ type: "knowledge", entries: fresh, from: result.link });
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
      fingerprint: fingerprint(this.identity.keys.publicKey),
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
