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
import { newId } from "./identity.ts";
import { sanitizeText } from "./protocol.ts";
import { sanitizeSegment } from "./paths.ts";
import { writePrivateJson } from "./fsutil.ts";

const MAX_ENTRIES = 1000;

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

  constructor(options: KnowledgeOptions) {
    this.sessionId = options.sessionId;
    this.dir = options.dir ?? null;
  }

  /** Load a session board from disk, or an empty one if there is no file. */
  static load(options: KnowledgeOptions): KnowledgeBase {
    const base = new KnowledgeBase(options);
    if (!base.dir) return base;
    try {
      const file = path.join(base.dir, "knowledge.json");
      if (!fs.existsSync(file)) return base;
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      const list: unknown[] = Array.isArray(raw?.entries) ? raw.entries : [];
      for (const item of list) {
        if (isEntry(item)) base.entriesById.set(item.id, item);
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
    };
    const replaced = this.entriesById.has(id);
    this.entriesById.set(id, entry);
    this.enforceLimit();
    this.persist();
    return { entry, replaced };
  }

  /** Merge entries from a peer. Newer wins per id; unknown shape is dropped. */
  merge(incoming: readonly KnowledgeEntry[]): MergeOutcome {
    let added = 0;
    let replaced = 0;
    let ignored = 0;

    for (const candidate of incoming) {
      if (!isEntry(candidate)) {
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
      this.entriesById.set(candidate.id, {
        id: candidate.id,
        sessionId: candidate.sessionId || this.sessionId,
        key: sanitizeText(candidate.key ?? "", MAX_KEY_LENGTH),
        kind: candidate.kind,
        text,
        author: {
          nodeId: sanitizeSegment(candidate.author.nodeId),
          name: sanitizeText(candidate.author.name ?? "unknown", 64),
        },
        ts: candidate.ts,
      });
      if (existing) replaced += 1;
      else added += 1;
    }

    if (added + replaced > 0) {
      this.enforceLimit();
      this.persist();
    }
    return { added, replaced, ignored };
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
