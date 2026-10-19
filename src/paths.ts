/**
 * Where pi-swarm keeps its files.
 *
 * Everything lives under the pi home directory, so a swarm node can be moved
 * or removed without touching the rest of the system. PI_SWARM_HOME overrides
 * the base directory, which is how the tests get an isolated store.
 */

import * as path from "node:path";

import { homeDir } from "./fsutil.ts";

/**
 * The instance slot: more than one pi process on the same machine.
 *
 * Two agents on one machine must not share an identity. A node skips every
 * beacon whose nodeId is its own, so two processes with one identity would
 * ignore each other completely -- and they would fight over the same peer book
 * and the same registry file. The slot is therefore chosen by the environment
 * and not by a stored setting: it belongs to the process, and a shared config
 * file cannot switch it off by accident.
 *
 *   PI_SWARM_INSTANCE=worker pi      # second node, own identity, own files
 *
 * Without it the node is the primary instance and keeps the historical
 * paths, so nothing changes for a single-node machine.
 */
export function instanceSlug(): string {
  const raw = process.env.PI_SWARM_INSTANCE?.trim() ?? "";
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 32);
}

/** `swarm-identity.json` for the primary slot, `swarm-identity-worker.json` otherwise. */
function instanceFile(fileName: string): string {
  const slug = instanceSlug();
  if (!slug) return path.join(piHome(), fileName);
  const dot = fileName.lastIndexOf(".");
  const stem = dot === -1 ? fileName : fileName.slice(0, dot);
  const suffix = dot === -1 ? "" : fileName.slice(dot);
  return path.join(piHome(), `${stem}-${slug}${suffix}`);
}

/**
 * The pi directory. os.homedir() rather than $HOME, because that is what pi
 * itself uses for ~/.pi -- on Windows $HOME is often unset or points somewhere
 * else, and the extension must not create a second pi directory.
 */
export function piHome(): string {
  const override = process.env.PI_SWARM_HOME?.trim();
  if (override) return override;
  return path.join(homeDir(), ".pi");
}

export function configFilePath(): string {
  return instanceFile("swarm-config.json");
}

export function identityFilePath(): string {
  return instanceFile("swarm-identity.json");
}

export function peersFilePath(): string {
  return instanceFile("swarm-peers.json");
}

export function swarmDir(): string {
  return path.join(piHome(), "swarm");
}

export function sessionsDir(): string {
  return path.join(swarmDir(), "sessions");
}

export function instanceDir(): string {
  // Shared on purpose: this is how two instances on the same machine find each
  // other even when multicast is unavailable.
  return path.join(swarmDir(), "instances");
}

/** Where received files land, one directory per peer node id. */
export function filesDir(): string {
  return path.join(swarmDir(), "files");
}

export function sessionDir(sessionId: string): string {
  return path.join(sessionsDir(), sanitizeSegment(sessionId));
}

/** Keep a value usable as a path segment. */
export function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "session";
}
