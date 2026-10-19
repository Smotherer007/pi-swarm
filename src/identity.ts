/**
 * Node identity.
 *
 * A swarm node is identified by a random 128-bit id that is generated once and
 * kept. The display name is configuration, not identity: renaming a node must
 * not make it a stranger to its peers.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";

import { identityFilePath, instanceSlug } from "./paths.ts";
import { writePrivateJson } from "./fsutil.ts";

export interface Identity {
  nodeId: string;
  createdAt: string;
}

export function newNodeId(): string {
  return `n_${crypto.randomBytes(12).toString("hex")}`;
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

/** A bearer token: 32 random bytes, url-safe, no padding. */
export function newToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function generate(): Identity {
  return { nodeId: newNodeId(), createdAt: new Date().toISOString() };
}

function writeIdentity(identity: Identity, filePath: string): void {
  writePrivateJson(filePath, identity);
}

export function loadIdentity(filePath: string = identityFilePath()): Identity {
  try {
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (raw && typeof raw === "object" && typeof raw.nodeId === "string" && raw.nodeId) {
        return {
          nodeId: raw.nodeId,
          createdAt:
            typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
        };
      }
    }
  } catch {
    /* a broken identity file is replaced, not fatal */
  }

  const identity = generate();
  try {
    writeIdentity(identity, filePath);
  } catch {
    /* an unwritable home must not stop the swarm */
  }
  return identity;
}

/**
 * Default display name: pi@<hostname>, plus the instance slot when there is
 * one, so two agents on the same machine are distinguishable by name too.
 */
export function defaultName(instance: string = instanceSlug()): string {
  const host = os.hostname().replace(/\.local$/i, "").trim();
  const base = host ? `pi@${host}` : "pi";
  return instance ? `${base}/${instance}` : base;
}

/** Short label for transcripts and status lines. */
export function shortName(name: string): string {
  return name.length > 32 ? `${name.slice(0, 29)}...` : name;
}
