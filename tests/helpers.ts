/**
 * Shared test helpers: isolated stores, deterministic configs, polling.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { defaults } from "../src/config.ts";
import type { Identity } from "../src/identity.ts";
import { newKeyPair } from "../src/crypto.ts";
import type { KeyPair } from "../src/crypto.ts";
import type { SwarmConfig } from "../src/types.ts";

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
}

export function makeConfig(overrides: Partial<SwarmConfig> = {}): SwarmConfig {
  return {
    ...defaults(),
    bindHost: "127.0.0.1",
    port: 0,
    discovery: false,
    inboundPolicy: "ask",
    name: "pi-test",
    ...overrides,
  };
}

const keyCache = new Map<string, KeyPair>();

/**
 * A deterministic identity for a suffix.
 *
 * The keys are generated once per suffix and reused, because a restarted node
 * must present the same public key -- peers pin it, and a different key on every
 * construction would look like a stolen identity.
 */
export function makeIdentity(suffix: string): Identity {
  let keys = keyCache.get(suffix);
  if (!keys) {
    keys = newKeyPair();
    keyCache.set(suffix, keys);
  }
  return { nodeId: `n_test_${suffix}`, createdAt: new Date().toISOString(), keys };
}

/** The public key a test identity presents, as a peer would pin it. */
export function pubOf(suffix: string): string {
  return makeIdentity(suffix).keys.publicKey;
}

/**
 * One sealed call as an arbitrary identity, for tests that act as a peer --
 * or as an intruder -- without a whole node behind them.
 */
export async function sealedCallAs(
  caller: Identity,
  target: { nodeId: string; publicKey: string; port: number },
  route: string,
  options: { method?: "GET" | "POST"; token?: string; body?: unknown } = {},
): Promise<{ status: number; data: any }> {
  const { deriveKeys } = await import("../src/crypto.ts");
  const { sealedRequest } = await import("../src/envelope.ts");
  const keys = deriveKeys(caller.keys, target.publicKey, caller.nodeId, target.nodeId);
  return sealedRequest(
    `http://127.0.0.1:${target.port}/swarm/v1${route}`,
    keys,
    { nodeId: caller.nodeId, publicKey: caller.keys.publicKey },
    target.nodeId,
    options,
  );
}

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
  intervalMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition was not met within ${timeoutMs} ms`);
}

export function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
