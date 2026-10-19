import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import { KnowledgeBase, pruneSessions } from "../src/knowledge.ts";
import { rmrf, tempDir } from "./helpers.ts";

const dirs: string[] = [];

function board(withDir = false): { base: KnowledgeBase; dir: string | null } {
  const dir = withDir ? path.join(tempDir("pi-swarm-kb"), "s_1") : null;
  if (dir) dirs.push(path.dirname(dir));
  return { base: new KnowledgeBase({ sessionId: "s_1", dir }), dir };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmrf(dir);
});

const author = { nodeId: "n_a", name: "node a" };

describe("KnowledgeBase", () => {
  it("stores an entry with a generated id and no key", () => {
    const { base } = board();
    const { entry, replaced } = base.put({ text: "found the bug" }, author);
    assert.equal(replaced, false);
    assert.match(entry.id, /^k_/);
    assert.equal(entry.kind, "note");
    assert.equal(base.size, 1);
  });

  it("derives the id from author and key, so a topic stays one row", () => {
    const { base } = board();
    base.put({ key: "api-base-url", text: "https://a.example", kind: "fact" }, author);
    const second = base.put(
      { key: "api-base-url", text: "https://b.example", kind: "fact" },
      author,
    );
    assert.equal(second.replaced, true);
    assert.equal(base.size, 1);
    assert.equal(base.all()[0].text, "https://b.example");
    assert.equal(second.entry.id, "n_a/api-base-url");
  });

  it("keeps the same key from different authors apart", () => {
    const { base } = board();
    base.put({ key: "decision", text: "use a" }, author);
    base.put({ key: "decision", text: "use b" }, { nodeId: "n_b", name: "node b" });
    assert.equal(base.size, 2);
  });

  it("merges by last write per id", () => {
    const { base } = board();
    const now = Date.now();
    base.merge([
      {
        id: "n_b/x",
        sessionId: "s_1",
        key: "x",
        kind: "fact",
        text: "older",
        author: { nodeId: "n_b", name: "b" },
        ts: now,
      },
    ]);
    const outcome = base.merge([
      {
        id: "n_b/x",
        sessionId: "s_1",
        key: "x",
        kind: "fact",
        text: "newer",
        author: { nodeId: "n_b", name: "b" },
        ts: now + 1000,
      },
      {
        id: "n_b/x",
        sessionId: "s_1",
        key: "x",
        kind: "fact",
        text: "stale",
        author: { nodeId: "n_b", name: "b" },
        ts: now + 500,
      },
    ]);
    assert.equal(outcome.replaced, 1);
    assert.equal(outcome.ignored, 1);
    assert.equal(base.get("n_b/x")?.text, "newer");
  });

  it("caps text and drops empty entries on merge", () => {
    const { base } = board();
    const now = Date.now();
    const outcome = base.merge([
      {
        id: "n_b/long",
        sessionId: "s_1",
        key: "",
        kind: "note",
        text: "x".repeat(9000),
        author: { nodeId: "n_b", name: "b" },
        ts: now,
      },
      {
        id: "n_b/empty",
        sessionId: "s_1",
        key: "",
        kind: "note",
        text: "   ",
        author: { nodeId: "n_b", name: "b" },
        ts: now,
      },
    ]);
    assert.equal(outcome.added, 1);
    assert.equal(outcome.ignored, 1);
    assert.ok(base.get("n_b/long")!.text.length <= 4003);
  });

  it("filters by kind, query and key", () => {
    const { base } = board();
    base.put({ key: "db", text: "postgres 16", kind: "fact" }, author);
    base.put({ key: "ui", text: "use the existing table component", kind: "decision" }, author);
    assert.equal(base.list({ kind: "decision" }).length, 1);
    assert.equal(base.list({ query: "postgres" }).length, 1);
    assert.equal(base.list({ key: "DB" }).length, 1);
    assert.equal(base.list({ query: "nothing-matches" }).length, 0);
  });

  it("reports entries newer than a timestamp", async () => {
    const { base } = board();
    const first = base.put({ text: "one" }, author);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = base.put({ text: "two" }, author);
    const since = base.since(first.entry.ts);
    assert.ok(since.some((entry) => entry.id === second.entry.id));
    assert.ok(!since.some((entry) => entry.id === first.entry.id));
  });

  it("persists and reloads a session board", () => {
    const { base, dir } = board(true);
    base.put({ key: "k", text: "keep me", kind: "decision" }, author);
    const reloaded = KnowledgeBase.load({ sessionId: "s_1", dir: dir! });
    assert.equal(reloaded.size, 1);
    assert.equal(reloaded.all()[0].text, "keep me");
    assert.ok(fs.existsSync(path.join(dir!, "knowledge.json")));
  });

  it("starts empty when the file is broken", () => {
    const { dir } = board(true);
    fs.mkdirSync(dir!, { recursive: true });
    fs.writeFileSync(path.join(dir!, "knowledge.json"), "{ not json");
    const reloaded = KnowledgeBase.load({ sessionId: "s_1", dir });
    assert.equal(reloaded.size, 0);
  });

  it("prunes session directories older than the retention window", () => {
    const root = tempDir("pi-swarm-prune");
    dirs.push(root);
    const oldDir = path.join(root, "s_old");
    const newDir = path.join(root, "s_new");
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, "knowledge.json"), "{}");
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(oldDir, "knowledge.json"), old, old);
    fs.utimesSync(oldDir, old, old);

    assert.equal(pruneSessions(root, 7), 1);
    assert.equal(fs.existsSync(oldDir), false);
    assert.equal(fs.existsSync(newDir), true);
    assert.equal(pruneSessions(root, 0), 0);
  });
});
