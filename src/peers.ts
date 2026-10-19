/**
 * The peer book: who we already know, what they may use, and who is banned.
 *
 * "Known" is the state that makes the automatic behaviours possible, so it is
 * persisted rather than derived from whatever happens to be online.
 */

import * as fs from "node:fs";

import type { KnownPeer, PeerRef, Scope } from "./types.ts";
import { normalizeScopes } from "./permissions.ts";
import { writePrivateJson } from "./fsutil.ts";

export interface PeerStoreOptions {
  filePath: string;
  defaultScopes: readonly Scope[];
}

function isKnownPeer(value: unknown): value is KnownPeer {
  if (!value || typeof value !== "object") return false;
  const candidate = value as KnownPeer;
  return (
    typeof candidate.nodeId === "string" &&
    candidate.nodeId.length > 0 &&
    typeof candidate.name === "string" &&
    typeof candidate.host === "string" &&
    typeof candidate.port === "number"
  );
}

function coerce(raw: Partial<KnownPeer>, defaults: readonly Scope[]): KnownPeer {
  return {
    nodeId: String(raw.nodeId),
    name: String(raw.name ?? "unknown"),
    ...(raw.publicKey ? { publicKey: String(raw.publicKey) } : {}),
    host: String(raw.host ?? ""),
    port: Number(raw.port ?? 0),
    lastSeen: Number(raw.lastSeen ?? 0),
    autoConnect: Boolean(raw.autoConnect),
    trusted: Boolean(raw.trusted),
    banned: Boolean(raw.banned),
    scopes: normalizeScopes(raw.scopes ?? defaults),
    ...(raw.note ? { note: String(raw.note) } : {}),
  };
}

export class PeerStore {
  private readonly filePath: string;
  private defaultScopes: Scope[];
  private peers = new Map<string, KnownPeer>();

  constructor(options: PeerStoreOptions) {
    this.filePath = options.filePath;
    this.defaultScopes = [...options.defaultScopes];
    this.load();
  }

  load(): void {
    this.peers.clear();
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8"));
      const list: unknown[] = Array.isArray(raw?.peers) ? raw.peers : [];
      for (const item of list) {
        if (isKnownPeer(item)) {
          const peer = coerce(item, this.defaultScopes);
          this.peers.set(peer.nodeId, peer);
        }
      }
    } catch {
      /* a broken file means "we know nobody", never a crash */
    }
  }

  private persist(): void {
    writePrivateJson(this.filePath, { version: 1, peers: [...this.peers.values()] });
  }

  list(): KnownPeer[] {
    return [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(nodeId: string): KnownPeer | undefined {
    return this.peers.get(nodeId);
  }

  byName(name: string): KnownPeer | undefined {
    const needle = name.trim().toLowerCase();
    if (!needle) return undefined;
    const exact =
      this.list().find((peer) => peer.name.toLowerCase() === needle) ??
      this.list().find((peer) => peer.nodeId === name.trim());
    if (exact) return exact;
    // A partial name only counts when it is unambiguous: "work" must not ban
    // whichever of "pi@workshop" and "pi@work-laptop" happens to sort first.
    const partial = this.list().filter((peer) => peer.name.toLowerCase().includes(needle));
    return partial.length === 1 ? partial[0] : undefined;
  }

  count(): number {
    return this.peers.size;
  }

  /** Record that a peer exists and was reachable, without changing its policy. */
  touch(ref: PeerRef, patch: Partial<KnownPeer> = {}): KnownPeer {
    const existing = this.peers.get(ref.nodeId);
    const next: KnownPeer = coerce(
      {
        ...(existing ?? {
          autoConnect: false,
          trusted: false,
          banned: false,
          scopes: this.defaultScopes,
          lastSeen: 0,
        }),
        ...ref,
        ...patch,
        lastSeen: Date.now(),
        // A pinned key is never replaced in passing: only forgetting the peer
        // unpins it, so no code path can re-pin a key by accident.
        publicKey: existing?.publicKey ?? patch.publicKey ?? ref.publicKey,
      },
      this.defaultScopes,
    );
    this.peers.set(next.nodeId, next);
    try {
      this.persist();
    } catch {
      /* an unwritable peer book must not break a connection */
    }
    return next;
  }

  update(nodeId: string, patch: Partial<KnownPeer>): KnownPeer {
    const existing = this.peers.get(nodeId);
    if (!existing) throw new Error(`Unknown peer "${nodeId}". Use swarm_peers list to see known peers.`);
    const next = coerce({ ...existing, ...patch, publicKey: existing.publicKey }, this.defaultScopes);
    if (next.banned) {
      next.trusted = false;
      next.autoConnect = false;
    }
    if (patch.scopes !== undefined) next.scopes = normalizeScopes(patch.scopes);
    this.peers.set(nodeId, next);
    this.persist();
    return next;
  }

  forget(nodeId: string): boolean {
    const existed = this.peers.delete(nodeId);
    if (existed) this.persist();
    return existed;
  }

  setScopes(nodeId: string, scopes: readonly Scope[]): KnownPeer {
    return this.update(nodeId, { scopes: normalizeScopes(scopes) });
  }
}
