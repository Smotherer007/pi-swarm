/**
 * Discovery: how a node finds the swarm.
 *
 * Two channels, on purpose:
 *
 *   multicast  a beacon on 239.255.77.83 every few seconds, reaching other
 *              machines on the same network without any central server
 *   registry   a per-instance file under ~/.pi/swarm/instances, because two pi
 *              instances on one machine cannot both bind the multicast port
 *
 * A direct address always works too, which is what makes a swarm span
 * subnets, VPNs and containers: connect to host:port and skip discovery.
 *
 * Beacons carry no paths, no model names and no conversation content -- only
 * what is needed to reach the node and whether it accepts connections.
 */

import * as dgram from "node:dgram";
import * as fs from "node:fs";
import * as path from "node:path";

import type { DiscoveredPeer } from "./types.ts";
import { DISCOVERY_PORT, MULTICAST_GROUP, PROTOCOL } from "./types.ts";
import { removeQuietly, writePrivateFile } from "./fsutil.ts";

export interface BeaconPayload {
  proto: string;
  nodeId: string;
  name: string;
  port: number;
  sessionId: string | null;
  accepting: boolean;
  /** Present while this node invites others to connect. */
  invitation?: string;
}

export interface DiscoveryOptions {
  nodeId: string;
  name: string;
  /** TCP port the swarm endpoint listens on. */
  port: number;
  sessionId: string | null;
  accepting: boolean;
  /** Multicast on/off. The local registry is kept either way. */
  multicast: boolean;
  intervalSeconds: number;
  /** Per-instance registry directory; null disables the local registry. */
  instanceDir: string | null;
  onPeer: (peer: DiscoveredPeer) => void;
  group?: string;
  discoveryPort?: number;
}

interface InstanceRecord extends BeaconPayload {
  pid: number;
  updatedAt: number;
}

function parseBeacon(value: unknown): BeaconPayload | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.proto !== PROTOCOL) return null;
  if (typeof record.nodeId !== "string" || !record.nodeId) return null;
  const port = Number(record.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    proto: PROTOCOL,
    nodeId: record.nodeId,
    name: typeof record.name === "string" ? record.name.slice(0, 64) : "unknown",
    port,
    sessionId: typeof record.sessionId === "string" ? record.sessionId.slice(0, 80) : null,
    accepting: record.accepting !== false,
    invitation:
      typeof record.invitation === "string" && record.invitation
        ? record.invitation.slice(0, 200)
        : undefined,
  };
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class Discovery {
  private readonly options: DiscoveryOptions;
  private sender: dgram.Socket | null = null;
  private listener: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private multicastActive = false;
  private sessionId: string | null;
  private accepting: boolean;
  private port: number;
  private invitation: string | null = null;
  private readonly warnings: string[] = [];

  constructor(options: DiscoveryOptions) {
    this.options = options;
    this.sessionId = options.sessionId;
    this.accepting = options.accepting;
    this.port = options.port;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get usesMulticast(): boolean {
    return this.multicastActive;
  }

  get warningsList(): string[] {
    return [...this.warnings];
  }

  get currentPort(): number {
    return this.port;
  }

  async start(): Promise<{ multicast: boolean; warnings: string[] }> {
    if (this.running) return { multicast: this.multicastActive, warnings: this.warningsList };
    this.running = true;
    this.warnSharedIdentity();
    this.writeInstance();

    if (this.options.multicast) {
      await this.openMulticast();
    }

    const interval = Math.max(2, this.options.intervalSeconds) * 1000;
    this.timer = setInterval(() => {
      void this.tick();
    }, interval);
    this.timer.unref?.();
    await this.tick();

    return { multicast: this.multicastActive, warnings: this.warningsList };
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.removeInstance();
    for (const socket of [this.sender, this.listener]) {
      if (!socket) continue;
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }
    this.sender = null;
    this.listener = null;
    this.multicastActive = false;
  }

  /** Publish current state and probe the registry right away. */
  async announce(): Promise<void> {
    if (!this.running) return;
    await this.tick();
  }

  /** Publish (or clear) an invitation in every following beacon. */
  setInvitation(text: string | null): void {
    this.invitation = text ? text.slice(0, 200) : null;
    if (this.running) {
      this.writeInstance();
      this.sendBeacon();
    }
  }

  setState(patch: {
    sessionId?: string | null;
    accepting?: boolean;
    port?: number;
    invitation?: string | null;
  }): void {
    if (patch.sessionId !== undefined) this.sessionId = patch.sessionId;
    if (patch.accepting !== undefined) this.accepting = patch.accepting;
    if (patch.port !== undefined) this.port = patch.port;
    if (patch.invitation !== undefined) this.invitation = patch.invitation;
    if (this.running) {
      this.writeInstance();
      this.sendBeacon();
    }
  }

  private beacon(): BeaconPayload {
    return {
      proto: PROTOCOL,
      nodeId: this.options.nodeId,
      name: this.options.name,
      port: this.port,
      sessionId: this.sessionId,
      accepting: this.accepting,
      ...(this.invitation ? { invitation: this.invitation } : {}),
    };
  }

  private instancePath(): string | null {
    if (!this.options.instanceDir) return null;
    return path.join(
      this.options.instanceDir,
      `${this.options.nodeId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`,
    );
  }

  private writeInstance(): void {
    const filePath = this.instancePath();
    if (!filePath || !this.options.instanceDir) return;
    try {
      const record: InstanceRecord = {
        ...this.beacon(),
        pid: process.pid,
        updatedAt: Date.now(),
      };
      writePrivateFile(filePath, JSON.stringify(record));
    } catch {
      /* a read-only home only costs the local registry */
    }
  }

  private removeInstance(): void {
    const filePath = this.instancePath();
    if (!filePath) return;
    removeQuietly(filePath);
  }

  /**
   * Two pi processes with one identity ignore each other: every beacon whose
   * nodeId matches this node is dropped as "myself", and both would overwrite
   * the same peer book. That is invisible and confusing, so it is said out
   * loud at start instead.
   */
  private warnSharedIdentity(): void {
    const filePath = this.instancePath();
    if (!filePath) return;
    try {
      if (!fs.existsSync(filePath)) return;
      const record = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<InstanceRecord>;
      const otherPid = Number(record.pid);
      if (!Number.isInteger(otherPid) || otherPid === process.pid) return;
      if (!pidAlive(otherPid)) return;
      this.warnings.push(
        `pid ${otherPid} on this machine already uses this swarm identity (${this.options.nodeId}).` +
          " A second pi needs its own slot, or the two will not see each other:" +
          " start it with PI_SWARM_INSTANCE=<name>.",
      );
    } catch {
      /* an unreadable registry file costs only this warning */
    }
  }

  private async tick(): Promise<void> {
    this.writeInstance();
    this.sendBeacon();
    this.scanInstances();
  }

  private sendBeacon(): void {
    if (!this.sender || !this.multicastActive) return;
    const payload = Buffer.from(JSON.stringify(this.beacon()), "utf-8");
    const group = this.options.group ?? MULTICAST_GROUP;
    const port = this.options.discoveryPort ?? DISCOVERY_PORT;
    for (const target of [group, "255.255.255.255"]) {
      try {
        this.sender.send(payload, port, target);
      } catch {
        /* interface may have gone away mid-announce */
      }
    }
  }

  /** Read the per-instance files so instances on this machine find each other. */
  private scanInstances(): void {
    if (!this.options.instanceDir) return;
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.options.instanceDir);
    } catch {
      return;
    }
    const staleAfter = Math.max(15_000, this.options.intervalSeconds * 3000);
    const now = Date.now();

    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const filePath = path.join(this.options.instanceDir, name);
      try {
        const record = JSON.parse(fs.readFileSync(filePath, "utf-8")) as InstanceRecord;
        const fresh = now - Number(record.updatedAt ?? 0) < staleAfter;
        if (!fresh || !pidAlive(Number(record.pid))) {
          fs.unlinkSync(filePath);
          continue;
        }
        const beacon = parseBeacon(record);
        if (!beacon || beacon.nodeId === this.options.nodeId) continue;
        this.options.onPeer({
          nodeId: beacon.nodeId,
          name: beacon.name,
          host: "127.0.0.1",
          port: beacon.port,
          lastSeen: now,
          sessionId: beacon.sessionId,
          accepting: beacon.accepting,
          invitation: beacon.invitation,
          via: "local",
        });
      } catch {
        /* a half-written file is retried on the next tick */
      }
    }
  }

  private async openMulticast(): Promise<void> {
    const group = this.options.group ?? MULTICAST_GROUP;
    const port = this.options.discoveryPort ?? DISCOVERY_PORT;

    try {
      const sender = dgram.createSocket({ type: "udp4", reuseAddr: true });
      await new Promise<void>((resolve, reject) => {
        sender.once("error", reject);
        sender.bind(0, () => {
          sender.removeAllListeners("error");
          sender.on("error", () => {
            /* sending is best effort */
          });
          try {
            sender.setBroadcast(true);
            sender.setMulticastTTL(1);
          } catch {
            /* not fatal on every platform */
          }
          resolve();
        });
      });
      this.sender = sender;
    } catch (err) {
      this.warnings.push(`Could not open a UDP sender for discovery: ${(err as Error).message}`);
      return;
    }

    await new Promise<void>((resolve) => {
      const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
      let settled = false;
      const done = (ok: boolean, warning?: string) => {
        if (settled) return;
        settled = true;
        if (warning) this.warnings.push(warning);
        this.multicastActive = ok;
        resolve();
      };

      socket.on("error", (err) => {
        try {
          socket.close();
        } catch {
          /* already closed */
        }
        done(
          false,
          `Could not listen on UDP ${port} for discovery (${(err as Error).message}). Other nodes can still reach this one directly or through the local registry.`,
        );
      });

      socket.on("message", (message, rinfo) => {
        let value: unknown;
        try {
          value = JSON.parse(message.toString("utf-8"));
        } catch {
          return;
        }
        // A peer that could not get the multicast port may send a unicast
        // beacon to this port instead; both arrive here and look alike.
        const beacon = parseBeacon(value);
        if (!beacon || beacon.nodeId === this.options.nodeId) return;
        this.options.onPeer({
          nodeId: beacon.nodeId,
          name: beacon.name,
          host: rinfo.address,
          port: beacon.port,
          lastSeen: Date.now(),
          sessionId: beacon.sessionId,
          accepting: beacon.accepting,
          invitation: beacon.invitation,
          via: "multicast",
        });
      });

      socket.bind(port, () => {
        let joined = true;
        try {
          socket.addMembership(group);
        } catch {
          joined = false;
        }
        if (!joined) {
          done(
            false,
            `UDP ${port} is bound but the multicast group ${group} could not be joined; only unicast beacons will arrive.`,
          );
          return;
        }
        this.listener = socket;
        done(true);
      });
    });
  }
}
