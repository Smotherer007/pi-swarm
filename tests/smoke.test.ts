/**
 * The parts of the package that are not code but still break in production:
 * the skill frontmatter pi parses, the manifest pi reads, and the release
 * pipeline that publishes it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

const root = path.join(import.meta.dirname, "..");
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), "utf-8");
const manifest = JSON.parse(read("package.json"));

describe("Skills", () => {
  it("ships a SKILL.md whose frontmatter is valid YAML", async () => {
    // Parsed for real, not with a regex: pi loads skills with a YAML parser,
    // and an unquoted value containing ": " is read as a nested mapping and
    // rejected. A regex is happy with that, which is how a broken skill once
    // shipped.
    const { parse } = await import("yaml");
    const skillsDir = path.join(root, "skills");
    const names = fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    assert.ok(names.length >= 1, "the package declares a skills directory but ships none");

    for (const name of names) {
      const file = path.join(skillsDir, name, "SKILL.md");
      assert.ok(fs.existsSync(file), `${name} has no SKILL.md`);

      const content = fs.readFileSync(file, "utf-8");
      assert.ok(content.startsWith("---\n"), `${name} has no frontmatter`);
      const end = content.indexOf("\n---", 4);
      assert.ok(end > 0, `${name}: the frontmatter is not closed`);

      let frontmatter: Record<string, unknown>;
      try {
        frontmatter = parse(content.slice(4, end)) as Record<string, unknown>;
      } catch (err) {
        assert.fail(`${name}: the frontmatter is not valid YAML -- ${(err as Error).message}`);
      }

      assert.equal(frontmatter.name, name, `${name}: frontmatter name mismatch`);
      assert.match(String(frontmatter.name), /^[a-z0-9-]{1,64}$/);
      const description = frontmatter.description;
      assert.equal(typeof description, "string", `${name}: description must be a string`);
      assert.ok(
        String(description).length > 0 && String(description).length <= 1024,
        `${name}: description must be 1..1024 characters`,
      );
    }
  });
});

describe("Package manifest", () => {
  it("declares entry points that exist", () => {
    assert.ok(Array.isArray(manifest.pi?.extensions) && manifest.pi.extensions.length > 0);
    for (const entry of manifest.pi.extensions) {
      assert.ok(fs.existsSync(path.join(root, entry)), `${entry} does not exist`);
    }
    for (const entry of manifest.pi?.skills ?? []) {
      assert.ok(fs.existsSync(path.join(root, entry)), `${entry} does not exist`);
    }
  });

  it("asks pi for typebox instead of shipping a second copy", () => {
    assert.equal(manifest.peerDependencies?.typebox, "*");
    assert.equal(manifest.dependencies?.typebox, undefined);
  });

  it("declares a Node floor that can run the test suite", () => {
    // 22.18 is where type stripping stopped needing a flag, which the test
    // script relies on.
    assert.match(manifest.engines?.node ?? "", /^>=22\.(\d+)\.0$/);
    const minor = Number((manifest.engines.node.match(/^>=22\.(\d+)\.0$/) ?? [])[1]);
    assert.ok(minor >= 18, `node floor 22.${minor} cannot run the .ts test suite`);
  });

  it("points at the repository the pipeline publishes from", () => {
    // npm normalizes this to the git+ prefix on publish; declaring it that way
    // keeps the release log free of "npm auto-corrected your package.json".
    assert.equal(manifest.repository?.url, "git+https://github.com/Smotherer007/pi-swarm.git");
    assert.equal(manifest.publishConfig?.access, "public");
  });
});

describe("Release pipeline", () => {
  it("publishes on feats and fixes from main and next", () => {
    const require = createRequire(import.meta.url);
    const config = require(path.join(root, "release.config.cjs"));
    assert.deepEqual(config.branches, ["main", { name: "next", prerelease: true }]);
    assert.ok(config.plugins.some((plugin: unknown) => plugin === "@semantic-release/npm"));
    assert.ok(
      config.plugins.some(
        (plugin: unknown) => Array.isArray(plugin) && plugin[0] === "@semantic-release/git",
      ),
      "the release must commit the new version back",
    );
  });

  it("hands semantic-release a token and the full history", async () => {
    const { parse } = await import("yaml");
    const workflow = parse(read(".github", "workflows", "release.yml"));
    const job = workflow.jobs.release;
    assert.equal(job["runs-on"], "ubuntu-latest");
    const checkout = job.steps.find((step: { uses?: string }) =>
      String(step.uses ?? "").startsWith("actions/checkout"),
    );
    assert.equal(checkout?.with?.["fetch-depth"], 0, "semantic-release needs the tags");
    const release = job.steps.find((step: { run?: string }) =>
      String(step.run ?? "").includes("semantic-release"),
    );
    assert.ok(release, "no step runs semantic-release");
    assert.ok(release.env?.NPM_TOKEN, "no NPM_TOKEN passed to the release step");
    assert.ok(release.env?.GITHUB_TOKEN, "no GITHUB_TOKEN passed to the release step");
  });

  it("gates the package on the tests and the typecheck on every platform it claims", async () => {
    const { parse } = await import("yaml");
    const workflow = parse(read(".github", "workflows", "ci.yml"));
    const steps = workflow.jobs.test.steps.map((step: { run?: string }) => String(step.run ?? ""));
    assert.ok(steps.includes("npm ci"));
    assert.ok(steps.includes("npm test"), "CI does not run the tests");
    assert.ok(steps.includes("npm run typecheck"), "CI does not typecheck");

    const matrix = workflow.jobs.test.strategy.matrix.include as Array<{ os: string; node: number }>;
    const systems = new Set(matrix.map((entry) => entry.os.replace(/-latest$/, "")));
    for (const os of ["ubuntu", "macos", "windows"]) {
      assert.ok(systems.has(os), `CI does not run on ${os}, which the README promises`);
    }
    const versions = new Set(matrix.filter((entry) => entry.os === "ubuntu-latest").map((entry) => entry.node));
    for (const node of [22, 24, 26]) {
      assert.ok(versions.has(node), `CI does not cover Node ${node} on Linux`);
    }
  });
});

describe("Portability", () => {
  it("never shells out, so every platform behaves the same", () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
      });

    const sources = [...walk(path.join(root, "src")), path.join(root, "index.ts")];
    for (const file of sources) {
      const content = fs.readFileSync(file, "utf-8");
      assert.ok(
        !/from "node:child_process"|require\("node:child_process"\)/.test(content),
        `${path.basename(file)} spawns a process; the swarm must stay in process to work everywhere`,
      );
    }
  });
});
