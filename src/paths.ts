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
  return path.join(piHome(), "swarm-config.json");
}

export function identityFilePath(): string {
  return path.join(piHome(), "swarm-identity.json");
}

export function peersFilePath(): string {
  return path.join(piHome(), "swarm-peers.json");
}

export function swarmDir(): string {
  return path.join(piHome(), "swarm");
}

export function sessionsDir(): string {
  return path.join(swarmDir(), "sessions");
}

export function instanceDir(): string {
  return path.join(swarmDir(), "instances");
}

export function sessionDir(sessionId: string): string {
  return path.join(sessionsDir(), sanitizeSegment(sessionId));
}

/** Keep a value usable as a path segment. */
export function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "session";
}
