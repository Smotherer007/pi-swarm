/**
 * File offers and received files.
 *
 * Deliberately narrow: an agent offers one file it names itself, the receiver
 * pulls the bytes after accepting, and what lands is a blob with metadata next
 * to it. Nothing here lists directories, follows paths, unpacks archives or
 * executes anything, and no content ever reaches the model on its own -- a file
 * is a file, not a prompt.
 *
 * Three rules shape the storage:
 *
 *   - the file name a peer sends is metadata, never a path. On disk a file is
 *     named after its transfer id, which removes traversal, collisions,
 *     reserved names and length limits in one move instead of five checks
 *   - an offer is single use and expires, so no catalogue can accumulate
 *   - a received file is swept after a retention window, so the directory does
 *     not grow in silence
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { writePrivateJson } from "./fsutil.ts";
import { FILE_OFFER_TTL_MS, MAX_FILE_BYTES_PER_PEER } from "./types.ts";
import type { PeerRef } from "./types.ts";

export interface IncomingOffer {
  offerId: string;
  from: PeerRef;
  /** What the sender calls it. Display only, never used as a path. */
  displayName: string;
  size: number;
  sha256: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "accepted" | "declined" | "expired";
  /** Set once the bytes are stored. */
  storedPath?: string;
  receivedBytes?: number;
}

export interface OutgoingOffer {
  offerId: string;
  to: PeerRef;
  /** Local file this offer points at. It is read at serve time, not copied. */
  sourcePath: string;
  displayName: string;
  size: number;
  sha256: string;
  createdAt: number;
  expiresAt: number;
  served: boolean;
}

export interface ReceivedFile {
  offerId: string;
  fromName: string;
  fromNodeId: string;
  displayName: string;
  size: number;
  sha256: string;
  receivedAt: number;
  storedPath: string;
}

/** A name that is safe to show and to put in a log line, and nothing more. */
export function displayName(input: unknown): string {
  const raw = typeof input === "string" ? input : "";
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (cleaned || "unnamed").slice(0, 120);
}

export function newOfferId(): string {
  return `f_${crypto.randomBytes(12).toString("hex")}`;
}

export class FileStore {
  private readonly root: string;
  private readonly maxPerPeer: number;
  private incoming = new Map<string, IncomingOffer>();
  private outgoing = new Map<string, OutgoingOffer>();

  constructor(options: { root: string; maxPerPeer?: number }) {
    this.root = options.root;
    this.maxPerPeer = options.maxPerPeer ?? MAX_FILE_BYTES_PER_PEER;
  }

  /** The directory this store lives in. */
  fileStoreRootPath(): string {
    return this.root;
  }

  /** Directory for one peer, created 0700. */
  peerDir(nodeId: string): string {
    const dir = path.join(this.root, nodeId.replace(/[^a-zA-Z0-9._-]/g, "_"));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Where the bytes of a transfer are written: named after the id, not the name. */
  targetPath(nodeId: string, offerId: string): string {
    return path.join(this.peerDir(nodeId), `${offerId}.bin`);
  }

  tempPath(nodeId: string, offerId: string): string {
    return path.join(this.peerDir(nodeId), `${offerId}.part`);
  }

  /** Bytes already stored for one peer, for the quota. */
  usedBytes(nodeId: string): number {
    try {
      return fs
        .readdirSync(this.peerDir(nodeId))
        .filter((name) => name.endsWith(".bin"))
        .reduce((total, name) => {
          try {
            return total + fs.statSync(path.join(this.peerDir(nodeId), name)).size;
          } catch {
            return total;
          }
        }, 0);
    } catch {
      return 0;
    }
  }

  overQuota(nodeId: string, incomingBytes: number): boolean {
    return this.usedBytes(nodeId) + incomingBytes > this.maxPerPeer;
  }

  addIncoming(offer: Omit<IncomingOffer, "createdAt" | "expiresAt" | "status">): IncomingOffer {
    const now = Date.now();
    const entry: IncomingOffer = {
      ...offer,
      createdAt: now,
      expiresAt: now + FILE_OFFER_TTL_MS,
      status: "pending",
    };
    this.incoming.set(entry.offerId, entry);
    return entry;
  }

  incomingOffer(offerId: string): IncomingOffer | undefined {
    const offer = this.incoming.get(offerId);
    if (!offer) return undefined;
    if (offer.status === "pending" && Date.now() > offer.expiresAt) offer.status = "expired";
    return offer;
  }

  /** Pending offers, newest first, expired ones already filtered out. */
  pendingOffers(): IncomingOffer[] {
    const result: IncomingOffer[] = [];
    for (const offer of this.incoming.values()) {
      if (offer.status === "pending" && Date.now() > offer.expiresAt) offer.status = "expired";
      if (offer.status === "pending") result.push(offer);
    }
    return result.sort((a, b) => b.createdAt - a.createdAt);
  }

  allIncoming(): IncomingOffer[] {
    return [...this.incoming.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  decline(offerId: string): IncomingOffer | undefined {
    const offer = this.incomingOffer(offerId);
    if (!offer) return undefined;
    if (offer.status === "pending") offer.status = "declined";
    return offer;
  }

  markAccepted(offerId: string, stored: { storedPath: string; receivedBytes: number }): IncomingOffer | undefined {
    const offer = this.incoming.get(offerId);
    if (!offer) return undefined;
    offer.status = "accepted";
    offer.storedPath = stored.storedPath;
    offer.receivedBytes = stored.receivedBytes;
    return offer;
  }

  addOutgoing(offer: OutgoingOffer): OutgoingOffer {
    this.outgoing.set(offer.offerId, offer);
    return offer;
  }

  /**
   * Hand out an outgoing offer once.
   *
   * Single use is the point: an offer that stays collectable becomes a file
   * server, and a file server becomes the browsing nobody wanted.
   */
  takeOutgoing(offerId: string): OutgoingOffer | { error: string } {
    const offer = this.outgoing.get(offerId);
    if (!offer) return { error: "no such offer on this node" };
    if (offer.served) return { error: "this offer was already collected" };
    if (Date.now() > offer.expiresAt) {
      this.outgoing.delete(offerId);
      return { error: "this offer expired" };
    }
    offer.served = true;
    this.outgoing.delete(offerId);
    return offer;
  }

  outgoingOffers(): OutgoingOffer[] {
    return [...this.outgoing.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  receivedFiles(): ReceivedFile[] {
    const result: ReceivedFile[] = [];
    for (const offer of this.incoming.values()) {
      if (offer.status !== "accepted" || !offer.storedPath) continue;
      result.push({
        offerId: offer.offerId,
        fromName: offer.from.name,
        fromNodeId: offer.from.nodeId,
        displayName: offer.displayName,
        size: offer.receivedBytes ?? offer.size,
        sha256: offer.sha256,
        receivedAt: offer.expiresAt - FILE_OFFER_TTL_MS,
        storedPath: offer.storedPath,
      });
    }
    return result.sort((a, b) => b.receivedAt - a.receivedAt);
  }

  /** Drop memory of a peer: its offers and the files it sent. */
  purgePeer(nodeId: string): { offers: number; files: number } {
    let offers = 0;
    for (const [offerId, offer] of [...this.incoming.entries()]) {
      if (offer.from.nodeId !== nodeId) continue;
      this.incoming.delete(offerId);
      offers += 1;
    }
    for (const [offerId, offer] of [...this.outgoing.entries()]) {
      if (offer.to.nodeId !== nodeId) continue;
      this.outgoing.delete(offerId);
      offers += 1;
    }
    let files = 0;
    const dir = path.join(this.root, nodeId.replace(/[^a-zA-Z0-9._-]/g, "_"));
    try {
      for (const name of fs.readdirSync(dir)) {
        fs.rmSync(path.join(dir, name), { force: true });
        files += 1;
      }
    } catch {
      /* nothing stored for that peer */
    }
    return { offers, files };
  }

  /**
   * Remove received files older than the retention window.
   *
   * Returns what it removed so the caller can log it: silence is what makes a
   * directory grow unnoticed.
   */
  sweep(retentionDays: number, dirRoot = this.root): { removed: Array<{ displayName: string; path: string }> } {
    const removed: Array<{ displayName: string; path: string }> = [];
    if (retentionDays <= 0) return { removed };
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    for (const [offerId, offer] of [...this.incoming.entries()]) {
      if (offer.status !== "accepted" || !offer.storedPath) continue;
      let mtime = 0;
      try {
        mtime = fs.statSync(offer.storedPath).mtimeMs;
      } catch {
        this.incoming.delete(offerId);
        continue;
      }
      if (mtime > cutoff) continue;
      try {
        fs.rmSync(offer.storedPath, { force: true });
      } catch {
        continue;
      }
      this.incoming.delete(offerId);
      removed.push({ displayName: offer.displayName, path: offer.storedPath });
    }
    void dirRoot;
    return { removed };
  }

  /** Persist the small part worth keeping: which files exist, under which name. */
  persist(indexPath: string): void {
    try {
      const entries = this.receivedFiles().map((file) => ({
        offerId: file.offerId,
        fromNodeId: file.fromNodeId,
        fromName: file.fromName,
        displayName: file.displayName,
        size: file.size,
        sha256: file.sha256,
        storedPath: file.storedPath,
        receivedAt: file.receivedAt,
      }));
      writePrivateJson(indexPath, { version: 1, files: entries });
    } catch {
      /* an unwritable index only costs the listing after a restart */
    }
  }

  load(indexPath: string): void {
    try {
      if (!fs.existsSync(indexPath)) return;
      const raw = JSON.parse(fs.readFileSync(indexPath, "utf-8")) as { files?: unknown };
      if (!Array.isArray(raw.files)) return;
      for (const item of raw.files) {
        const file = item as Partial<ReceivedFile>;
        if (typeof file.offerId !== "string" || typeof file.storedPath !== "string") continue;
        if (!fs.existsSync(file.storedPath)) continue;
        this.incoming.set(file.offerId, {
          offerId: file.offerId,
          from: {
            nodeId: String(file.fromNodeId ?? ""),
            name: String(file.fromName ?? "unknown"),
            host: "",
            port: 0,
          },
          displayName: displayName(file.displayName),
          size: Number(file.size ?? 0),
          sha256: String(file.sha256 ?? ""),
          createdAt: Number(file.receivedAt ?? Date.now()),
          expiresAt: Number(file.receivedAt ?? Date.now()) + FILE_OFFER_TTL_MS,
          status: "accepted",
          storedPath: file.storedPath,
          receivedBytes: Number(file.size ?? 0),
        });
      }
    } catch {
      /* a broken index means "no files", never a crash */
    }
  }
}
