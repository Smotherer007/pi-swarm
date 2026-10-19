import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { _resetForTesting, defaults, getConfig, resetConfig, updateConfig } from "../src/config.ts";

const testHome = path.join(os.tmpdir(), `pi-swarm-cfg-${process.pid}`);
const configFile = path.join(testHome, "swarm-config.json");
const originalHome = process.env.PI_SWARM_HOME;

describe("config", () => {
  beforeEach(() => {
    fs.mkdirSync(testHome, { recursive: true, mode: 0o700 });
    process.env.PI_SWARM_HOME = testHome;
    if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
    _resetForTesting();
  });

  afterEach(() => {
    if (fs.existsSync(configFile)) fs.unlinkSync(configFile);
    if (originalHome === undefined) delete process.env.PI_SWARM_HOME;
    else process.env.PI_SWARM_HOME = originalHome;
    _resetForTesting();
  });

  it("is usable with no saved settings", () => {
    const config = getConfig();
    assert.equal(config.port, 47823);
    assert.equal(config.discovery, true);
    assert.equal(config.autostart, true);
    assert.equal(config.inboundPolicy, "known-auto");
    assert.equal(config.autoConnectKnown, true);
    assert.equal(config.autoGrantKnowledgeWrite, false);
    assert.equal(config.autoDeliverInbox, true);
    assert.equal(config.wakeOnRequest, true);
    assert.deepEqual(config.defaultScopes, ["chat", "knowledge:read"]);
    assert.ok(config.name.length > 0);
  });

  it("persists a patch and applies it", () => {
    const updated = updateConfig({ name: "pi@lab", autoConnectKnown: true, maxPeers: 3 });
    assert.equal(updated.name, "pi@lab");
    assert.equal(updated.autoConnectKnown, true);
    assert.equal(updated.maxPeers, 3);
    assert.ok(fs.existsSync(configFile));

    _resetForTesting();
    const reloaded = getConfig();
    assert.equal(reloaded.name, "pi@lab");
    assert.equal(reloaded.autoConnectKnown, true);
  });

  it("rejects invalid values with a clear message", () => {
    assert.throws(() => updateConfig({ name: "  " }), /must not be empty/);
    assert.throws(() => updateConfig({ port: 70000 }), /between 0 and 65535/);
    assert.throws(() => updateConfig({ port: 1.5 }), /integer/);
    assert.throws(() => updateConfig({ inboundPolicy: "yolo" as never }), /inboundPolicy/);
    assert.throws(() => updateConfig({ defaultScopes: ["admin"] as never }), /unknown scopes/);
    assert.throws(() => updateConfig({ maxPeers: 0 }), /maxPeers/);
    assert.throws(() => updateConfig({ maxMessagesPerMinute: 5000 }), /maxMessagesPerMinute/);
    assert.throws(() => updateConfig({ beaconIntervalSeconds: 1 }), /beaconIntervalSeconds/);
  });

  it("normalizes seed addresses and rejects nonsense", () => {
    const updated = updateConfig({
      seeds: [" 10.0.0.5 ", "100.64.0.7:47900", "10.0.0.5", "[fd00::1]:47824"],
    });
    assert.deepEqual(updated.seeds, ["10.0.0.5:47823", "100.64.0.7:47900", "[fd00::1]:47824"]);
    assert.throws(() => updateConfig({ seeds: ["not a host"] }), /host:port/);
    assert.throws(() => updateConfig({ seeds: ["10.0.0.5:70000"] }), /invalid port/);
    assert.throws(
      () => updateConfig({ seeds: Array.from({ length: 33 }, (_, i) => `10.0.0.${i}:1`) }),
      /at most 32/,
    );
  });

  it("drops knowledge scopes when knowledge sharing is turned off", () => {
    const updated = updateConfig({ shareKnowledge: false });
    assert.deepEqual(updated.defaultScopes, ["chat"]);
    assert.equal(updated.shareKnowledge, false);
  });

  it("resets to the defaults", () => {
    updateConfig({ name: "temporary" });
    const reset = resetConfig();
    assert.equal(reset.name, defaults().name);
  });

  it("ignores unknown keys instead of storing them", () => {
    updateConfig({ nonsense: true } as never);
    const raw = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    assert.equal(raw.nonsense, undefined);
  });
});
