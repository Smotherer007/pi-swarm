/**
 * Shared session knowledge.
 *
 * A small, replicated blackboard: every node keeps its own copy, entries are
 * pushed to connected peers that were granted knowledge:write, and pulled from
 * peers that granted knowledge:read. Merging is last-write-wins per entry id,
 * and an entry id is derived from author + key, so "the current decision" can
 * be replaced without leaving fifteen versions behind.
 *
 * Entries live as long as the session does. The file stays on disk after the
 * session closes and is pruned after knowledgeRetentionDays, so a crashed
 * session does not lose the knowledge it produced.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type {
  KnowledgeEntry,
  KnowledgeInput,
  KnowledgeKind,
} from "./types.ts";
import { MAX_KNOWLEDGE_TEXT, MAX_KEY_LENGTH } from "./types.ts";
import * as crypto from "node:crypto";

import { newId } from "./identity.ts";
import { isKnowledgeKind, sanitizeText } from "./protocol.ts";
import { writePrivateJson } from "./fsutil.ts";

const MAX_ENTRIES = 1000;
/** An entry dated further ahead than this is refused: it would win every merge forever. */
const MAX_FUTURE_MS = 5 * 60 * 1000;
const NODE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;

export interface KnowledgeOptions {
  sessionId: string;
  /** Directory to persist into; omit for an in-memory board. */
  dir?: string | null;
}

export interface PutOutcome {
  entry: KnowledgeEntry;
  replaced: boolean;
}

export interface MergeOutcome {
  added: number;
  replaced: number;
  ignored: number;
  /** Ids of the entries that were added or replaced. */
  ids: string[];
}

export interface MergeOptions {
  /** This node's id: nobody else may write entries in its name. */
  selfNodeId?: string;
  /** Accept only entries authored by this node (a peer pushing in its own name). */
  onlyAuthor?: string;
  /** The peer that delivered the entries, recorded when it is not the author. */
  via?: { nodeId: string; name: string };
}

/** One page of a board, in the order this node stored the entries. */
export interface KnowledgePage {
  /** Changes when the board is recreated, so a stale cursor starts over. */
  epoch: string;
  entries: KnowledgeEntry[];
  /** Cursor for the next page: the sequence of the last entry returned. */
  next: number;
  more: boolean;
}

function entryId(authorNodeId: string, key: string): string {
  return `${authorNodeId}/${key}`;
}

function isEntry(value: unknown): value is KnowledgeEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as KnowledgeEntry;
  return (
    typeof entry.id === "string" &&
    entry.id.length > 0 &&
    typeof entry.text === "string" &&
    typeof entry.ts === "number" &&
    typeof entry.author?.nodeId === "string"
  );
}

export class KnowledgeBase {
  readonly sessionId: string;
  private readonly dir: string | null;
  private entriesById = new Map<string, KnowledgeEntry>();
  /**
   * Local, monotonically increasing store order. Peers pull by it rather than by
   * the author's timestamp: an entry relayed late by a third node still has a
   * new sequence here, so a cursor never skips it.
   */
  private nextSeq = 1;
  private epochId: string = crypto.randomBytes(8).toString("hex");

  constructor(options: KnowledgeOptions) {
    this.sessionId = options.sessionId;
    this.dir = options.dir ?? null;
  }

  get epoch(): string {
    return this.epochId;
  }

  /** Load a session board from disk, or an empty one if there is no file. */
  static load(options: KnowledgeOptions): KnowledgeBase {
    const base = new KnowledgeBase(options);
    if (!base.dir) return base;
    try {
      const file = path.join(base.dir, "knowledge.json");
      if (!fs.existsSync(file)) return base;
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (typeof raw?.epoch === "string" && /^[a-f0-9]{16}$/.test(raw.epoch)) base.epochId = raw.epoch;
      const list: unknown[] = Array.isArray(raw?.entries) ? raw.entries : [];
      const loaded = list.filter(isEntry).sort((a, b) => (a.seq ?? a.ts) - (b.seq ?? b.ts));
      for (const item of loaded) {
        // A board written before sequences existed gets them in time order.
        const seq = typeof item.seq === "number" && item.seq >= base.nextSeq ? item.seq : base.nextSeq;
        base.entriesById.set(item.id, { ...item, seq });
        base.nextSeq = seq + 1;
      }
    } catch {
      /* a broken file starts the session with an empty board */
    }
    return base;
  }

  get size(): number {
    return this.entriesById.size;
  }

  all(): KnowledgeEntry[] {
    return [...this.entriesById.values()].sort((a, b) => a.ts - b.ts);
  }

  since(ts: number): KnowledgeEntry[] {
    return this.all().filter((entry) => entry.ts > ts);
  }

  get(id: string): KnowledgeEntry | undefined {
    return this.entriesById.get(id);
  }

  /** Add or replace one local entry. Replacing keeps one topic to one row. */
  put(input: KnowledgeInput, author: { nodeId: string; name: string }): PutOutcome {
    const text = sanitizeText(input.text, MAX_KNOWLEDGE_TEXT);
    if (!text) throw new Error("text must not be empty.");
    const key = sanitizeText(input.key ?? "", MAX_KEY_LENGTH);
    const kind: KnowledgeKind = input.kind ?? "note";
    const id = key ? entryId(author.nodeId, key) : newId("k");
    const ts = Date.now();
    const entry: KnowledgeEntry = {
      id,
      sessionId: this.sessionId,
      key,
      kind,
      text,
      author: { nodeId: author.nodeId, name: author.name },
      ts,
      seq: this.nextSeq++,
    };
    const replaced = this.entriesById.has(id);
    this.entriesById.set(id, entry);
    this.enforceLimit();
    this.persist();
    return { entry, replaced };
  }

  /**
   * Merge entries from a peer. Newer wins per id; anything malformed, dated in
   * the future, filed under another author's id, or written in a name the
   * options forbid is dropped and counted as ignored.
   */
  merge(incoming: readonly KnowledgeEntry[], options: MergeOptions = {}): MergeOutcome {
    let added = 0;
    let replaced = 0;
    let ignored = 0;
    const ids: string[] = [];
    const now = Date.now();

    for (const candidate of incoming) {
      if (!isEntry(candidate) || !this.acceptable(candidate, options, now)) {
        ignored += 1;
        continue;
      }
      const text = sanitizeText(candidate.text, MAX_KNOWLEDGE_TEXT);
      if (!text) {
        ignored += 1;
        continue;
      }
      const existing = this.entriesById.get(candidate.id);
      if (existing && existing.ts >= candidate.ts) {
        ignored += 1;
        continue;
      }
      const via =
        options.via && options.via.nodeId !== candidate.author.nodeId
          ? { nodeId: options.via.nodeId, name: sanitizeText(options.via.name, 64) || "unknown" }
          : undefined;
      this.entriesById.set(candidate.id, {
        id: candidate.id,
        sessionId: candidate.sessionId || this.sessionId,
        key: sanitizeText(candidate.key ?? "", MAX_KEY_LENGTH),
        kind: candidate.kind,
        text,
        author: {
          nodeId: candidate.author.nodeId,
          name: sanitizeText(candidate.author.name ?? "unknown", 64) || "unknown",
        },
        ts: candidate.ts,
        seq: this.nextSeq++,
        ...(via ? { via } : {}),
      });
      ids.push(candidate.id);
      if (existing) replaced += 1;
      else added += 1;
    }

    if (added + replaced > 0) {
      this.enforceLimit();
      this.persist();
    }
    return { added, replaced, ignored, ids };
  }

  /** Is this entry one this board may take, given who delivered it? */
  private acceptable(entry: KnowledgeEntry, options: MergeOptions, now: number): boolean {
    const author = entry.author.nodeId;
    if (!NODE_ID_PATTERN.test(author)) return false;
    if (!isKnowledgeKind(entry.kind)) return false;
    if (!Number.isFinite(entry.ts) || entry.ts <= 0 || entry.ts > now + MAX_FUTURE_MS) return false;
    if (options.selfNodeId && author === options.selfNodeId) return false;
    if (options.onlyAuthor && author !== options.onlyAuthor) return false;
    // Keyed ids are "<author>/<key>"; an entry must not claim a slot that
    // belongs to another author, or it would overwrite that author's entry.
    const key = sanitizeText(entry.key ?? "", MAX_KEY_LENGTH);
    if (key && entry.id !== `${author}/${key}`) return false;
    if (entry.id.includes("/") && !entry.id.startsWith(`${author}/`)) return false;
    return entry.id.length <= 160;
  }

  /** Entries stored after `after`, oldest first, at most `limit` of them. */
  page(after: number, limit: number): KnowledgePage {
    const ordered = [...this.entriesById.values()]
      .filter((entry) => (entry.seq ?? 0) > after)
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    const entries = ordered.slice(0, limit);
    const last = entries[entries.length - 1];
    return {
      epoch: this.epochId,
      entries,
      next: last?.seq ?? after,
      more: ordered.length > entries.length,
    };
  }

  list(options: { since?: number; kind?: KnowledgeKind; query?: string; key?: string; limit?: number } = {}): KnowledgeEntry[] {
    const needle = options.query?.trim().toLowerCase();
    let result = this.all();
    if (options.since !== undefined) result = result.filter((entry) => entry.ts > options.since!);
    if (options.kind) result = result.filter((entry) => entry.kind === options.kind);
    if (options.key) {
      const key = options.key.toLowerCase();
      result = result.filter((entry) => entry.key.toLowerCase() === key);
    }
    if (needle) {
      result = result.filter(
        (entry) =>
          entry.text.toLowerCase().includes(needle) ||
          entry.key.toLowerCase().includes(needle) ||
          entry.author.name.toLowerCase().includes(needle),
      );
    }
    const limit = options.limit ?? 200;
    return result.length > limit ? result.slice(-limit) : result;
  }

  clear(): void {
    this.entriesById.clear();
    // Peers hold a cursor into this board; a new epoch tells them to start over.
    this.epochId = crypto.randomBytes(8).toString("hex");
    this.persist();
  }

  private enforceLimit(): void {
    if (this.entriesById.size <= MAX_ENTRIES) return;
    const oldest = this.all().slice(0, this.entriesById.size - MAX_ENTRIES);
    for (const entry of oldest) this.entriesById.delete(entry.id);
  }

  persist(): void {
    if (!this.dir) return;
    try {
      writePrivateJson(path.join(this.dir, "knowledge.json"), {
        sessionId: this.sessionId,
        epoch: this.epochId,
        updatedAt: new Date().toISOString(),
        entries: this.all(),
      });
    } catch {
      /* an unwritable board still works in memory */
    }
  }
}

/** Delete session boards older than `days`. Returns how many were removed. */
export function pruneSessions(sessionsDirPath: string, days: number): number {
  if (days <= 0) return 0;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  let names: string[] = [];
  try {
    names = fs.readdirSync(sessionsDirPath);
  } catch {
    return 0;
  }
  for (const name of names) {
    const dir = path.join(sessionsDirPath, name);
    try {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) continue;
      const newest = Math.max(
        stat.mtimeMs,
        fs.existsSync(path.join(dir, "knowledge.json"))
          ? fs.statSync(path.join(dir, "knowledge.json")).mtimeMs
          : 0,
      );
      if (newest < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      /* skip whatever cannot be inspected */
    }
  }
  return removed;
}
