/**
 * Configuration: defaults plus whatever the user saved.
 *
 * The defaults describe the steady state of a working pair of agents: the
 * node listens from session start, known peers are reconnected on their next
 * beacon, and what a peer says arrives in the conversation. The one decision
 * that is never automated is the first contact with a stranger: an unknown
 * peer has to be approved once, and only then does the automatic behaviour
 * apply to it.
 *
 * What stays conservative: nothing is granted implicitly beyond the default
 * scopes, a stranger never gets in without an approval, knowledge writing
 * still needs a grant, and peer text is never treated as an instruction.
 */

import * as fs from "node:fs";

import type { InboundPolicy, Scope, SwarmConfig } from "./types.ts";
import { ALL_SCOPES, DEFAULT_PORT } from "./types.ts";
import { configFilePath } from "./paths.ts";
import { defaultName } from "./identity.ts";
import { normalizeScopes } from "./permissions.ts";
import { writePrivateJson } from "./fsutil.ts";

const POLICIES: InboundPolicy[] = ["ask", "known-auto", "open"];

let overrides: Partial<SwarmConfig> = {};
let loaded = false;

export function defaults(): SwarmConfig {
  return {
    name: defaultName(),
    port: 47823,
    bindHost: "0.0.0.0",
    discovery: true,
    autostart: true,
    inboundPolicy: "known-auto",
    autoConnectKnown: true,
    defaultScopes: ["chat", "knowledge:read"],
    seeds: [],
    maxPeers: 8,
    shareKnowledge: true,
    autoGrantKnowledgeWrite: false,
    autoDeliverInbox: true,
    wakeOnRequest: true,
    maxMessagesPerMinute: 40,
    beaconIntervalSeconds: 10,
    knowledgeRetentionDays: 7,
  };
}

export function loadConfig(filePath: string = configFilePath()): void {
  loaded = true;
  try {
    if (!fs.existsSync(filePath)) {
      overrides = {};
      return;
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    overrides = raw && typeof raw === "object" ? raw : {};
  } catch {
    overrides = {};
  }
}

export function getConfig(filePath: string = configFilePath()): SwarmConfig {
  if (!loaded) loadConfig(filePath);
  return { ...defaults(), ...overrides };
}

function persist(filePath: string): void {
  writePrivateJson(filePath, overrides);
}

function validateScopeList(input: unknown, field: string): Scope[] {
  if (!Array.isArray(input)) throw new Error(`${field} must be an array of scopes.`);
  const scopes = normalizeScopes(input);
  const unknown = input.filter(
    (value) => typeof value !== "string" || !ALL_SCOPES.includes(value as Scope),
  );
  if (unknown.length > 0) {
    throw new Error(
      `${field} contains unknown scopes: ${unknown.join(", ")}. Valid: ${ALL_SCOPES.join(", ")}.`,
    );
  }
  return scopes;
}

/**
 * Apply a validated patch and save it. Returns the effective configuration.
 * Unknown keys are ignored rather than stored, so a typo cannot silently
 * become a setting.
 */
export function updateConfig(
  patch: Partial<SwarmConfig>,
  filePath: string = configFilePath(),
): SwarmConfig {
  if (!loaded) loadConfig(filePath);
  const next: Partial<SwarmConfig> = { ...overrides };

  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name) throw new Error("name must not be empty.");
    if (name.length > 64) throw new Error("name must be 64 characters or fewer.");
    next.name = name;
  }
  if (patch.port !== undefined) {
    if (!Number.isInteger(patch.port) || patch.port < 0 || patch.port > 65535) {
      throw new Error("port must be an integer between 0 and 65535 (0 picks a free port).");
    }
    next.port = patch.port;
  }
  if (patch.bindHost !== undefined) {
    const bindHost = String(patch.bindHost).trim();
    if (!bindHost) throw new Error("bindHost must not be empty.");
    next.bindHost = bindHost;
  }
  if (patch.discovery !== undefined) next.discovery = Boolean(patch.discovery);
  if (patch.autostart !== undefined) next.autostart = Boolean(patch.autostart);
  if (patch.inboundPolicy !== undefined) {
    if (!POLICIES.includes(patch.inboundPolicy)) {
      throw new Error(`inboundPolicy must be one of: ${POLICIES.join(", ")}.`);
    }
    next.inboundPolicy = patch.inboundPolicy;
  }
  if (patch.autoConnectKnown !== undefined) next.autoConnectKnown = Boolean(patch.autoConnectKnown);
  if (patch.defaultScopes !== undefined) {
    next.defaultScopes = validateScopeList(patch.defaultScopes, "defaultScopes");
  }
  if (patch.seeds !== undefined) {
    if (!Array.isArray(patch.seeds)) throw new Error("seeds must be an array of host:port.");
    const seeds: string[] = [];
    for (const raw of patch.seeds) {
      const seed = String(raw).trim();
      if (!seed) continue;
      // A bare host is fine: the default port is implied.
      const withPort = /\]?:\d{1,5}$/.test(seed) ? seed : `${seed}:${DEFAULT_PORT}`;
      const match = withPort.match(/^(\[[^\]]+\]|[^:\s]+):(\d{1,5})$/);
      if (!match) throw new Error(`seed "${seed}" is not host:port.`);
      const port = Number(match[2]);
      if (port < 1 || port > 65535) throw new Error(`seed "${seed}" has an invalid port.`);
      if (!seeds.includes(withPort)) seeds.push(withPort);
    }
    if (seeds.length > 32) throw new Error("at most 32 seeds.");
    next.seeds = seeds;
  }
  if (patch.maxPeers !== undefined) {
    if (!Number.isInteger(patch.maxPeers) || patch.maxPeers < 1 || patch.maxPeers > 64) {
      throw new Error("maxPeers must be an integer between 1 and 64.");
    }
    next.maxPeers = patch.maxPeers;
  }
  if (patch.shareKnowledge !== undefined) next.shareKnowledge = Boolean(patch.shareKnowledge);
  if (patch.autoGrantKnowledgeWrite !== undefined) {
    next.autoGrantKnowledgeWrite = Boolean(patch.autoGrantKnowledgeWrite);
  }
  if (patch.autoDeliverInbox !== undefined) next.autoDeliverInbox = Boolean(patch.autoDeliverInbox);
  if (patch.wakeOnRequest !== undefined) next.wakeOnRequest = Boolean(patch.wakeOnRequest);
  if (patch.maxMessagesPerMinute !== undefined) {
    const value = patch.maxMessagesPerMinute;
    if (!Number.isInteger(value) || value < 1 || value > 600) {
      throw new Error("maxMessagesPerMinute must be an integer between 1 and 600.");
    }
    next.maxMessagesPerMinute = value;
  }
  if (patch.beaconIntervalSeconds !== undefined) {
    const value = patch.beaconIntervalSeconds;
    if (!Number.isInteger(value) || value < 2 || value > 120) {
      throw new Error("beaconIntervalSeconds must be an integer between 2 and 120.");
    }
    next.beaconIntervalSeconds = value;
  }
  if (patch.knowledgeRetentionDays !== undefined) {
    const value = patch.knowledgeRetentionDays;
    if (!Number.isInteger(value) || value < 0 || value > 365) {
      throw new Error("knowledgeRetentionDays must be an integer between 0 and 365.");
    }
    next.knowledgeRetentionDays = value;
  }

  // Knowledge scopes are meaningless when sharing is off; never grant them then.
  if (next.shareKnowledge === false) {
    next.defaultScopes = (next.defaultScopes ?? defaults().defaultScopes).filter(
      (scope) => !scope.startsWith("knowledge:"),
    );
  }

  overrides = next;
  persist(filePath);
  return getConfig(filePath);
}

export function resetConfig(filePath: string = configFilePath()): SwarmConfig {
  overrides = {};
  persist(filePath);
  return getConfig(filePath);
}

/** @internal Reset in-memory state -- for testing only */
export function _resetForTesting(): void {
  overrides = {};
  loaded = false;
}
