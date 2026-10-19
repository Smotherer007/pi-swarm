/**
 * Rights are handed out by the user, not by the model.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import { _resetForTesting, updateConfig } from "../src/config.ts";
import { confirmWithUser } from "../src/tools/confirm.ts";
import { rmrf, tempDir } from "./helpers.ts";

const home = tempDir("pi-swarm-confirm");
const originalHome = process.env.PI_SWARM_HOME;

before(() => {
  process.env.PI_SWARM_HOME = home;
  _resetForTesting();
});

after(() => {
  if (originalHome === undefined) delete process.env.PI_SWARM_HOME;
  else process.env.PI_SWARM_HOME = originalHome;
  _resetForTesting();
  rmrf(home);
});

function uiAnswering(answer: boolean, seen: string[] = []) {
  return {
    hasUI: true,
    ui: {
      confirm: async (title: string) => {
        seen.push(title);
        return answer;
      },
    },
  } as never;
}

describe("confirmWithUser", () => {
  it("refuses without a UI instead of deciding for the user", async () => {
    await assert.rejects(confirmWithUser({ hasUI: false } as never, "Approve x?", "details"), /no UI to ask in/);
    await assert.rejects(confirmWithUser(undefined, "Approve x?", "details"), /no UI/);
  });

  it("goes ahead only when the user says yes", async () => {
    const seen: string[] = [];
    await confirmWithUser(uiAnswering(true, seen), "Approve x?", "details");
    assert.deepEqual(seen, ["Approve x?"]);
    await assert.rejects(confirmWithUser(uiAnswering(false), "Approve x?", "details"), /declined/);
  });

  it("can be switched off by the user's configuration", async () => {
    updateConfig({ confirmSensitive: false });
    await confirmWithUser(undefined, "Approve x?", "details");
    updateConfig({ confirmSensitive: true });
  });
});
