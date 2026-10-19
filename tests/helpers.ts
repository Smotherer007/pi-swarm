/**
 * Shared test helpers: isolated stores, deterministic configs, polling.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { defaults } from "../src/config.ts";
import type { Identity } from "../src/identity.ts";
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

export function makeIdentity(suffix: string): Identity {
  return { nodeId: `n_test_${suffix}`, createdAt: new Date().toISOString() };
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
