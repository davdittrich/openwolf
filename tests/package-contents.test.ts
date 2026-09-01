import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const testRoot = process.env.OPENWOLF_TEST_TMPDIR;
if (testRoot !== "/dev/shm") throw new Error("OPENWOLF_TEST_TMPDIR must be /dev/shm");

const packageRoot = path.join(import.meta.dirname, "..");
const hookRecords = [
  ["SessionStart", "startup|resume|clear|compact", "session-start.js"],
  ["PreToolUse", "Read", "pre-read.js"],
  ["PreToolUse", "Edit|Write|MultiEdit|apply_patch", "pre-write.js"],
  ["PreToolUse", "Bash", "pre-bash.js"],
  ["PostToolUse", "Read", "post-read.js"],
  ["PostToolUse", "Edit|Write|MultiEdit|apply_patch", "post-write.js"],
  ["PostToolUse", "Bash", "post-bash.js"],
  ["PreCompact", "", "precompact.js"],
  ["Stop", "", "stop.js"],
] as const;

function writeCodexFixture(root: string, foreign = false): void {
  const hooks = hookRecords.reduce<Record<string, unknown[]>>((all, [event, matcher, script]) => ({
    ...all,
    [event]: [...(all[event] ?? []), {
      matcher,
      hooks: [{
        type: "command",
        command: `node \"${path.join(foreign ? "/foreign" : root, ".wolf", "hooks", script)}\"`,
      }],
    }],
  }), {});
  fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex", "hooks.json"), JSON.stringify({ hooks }), "utf-8");
}

function pack(root: string): { archive: string; extracted: string } {
  const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", root], {
    cwd: packageRoot,
    encoding: "utf-8",
    env: { ...process.env, npm_config_cache: path.join(root, "npm-cache") },
  });
  assert.strictEqual(packed.status, 0, packed.stderr);
  const manifest = JSON.parse(packed.stdout) as Record<string, { filename?: string }> | Array<{ filename?: string }>;
  const details = Array.isArray(manifest) ? manifest[0] : Object.values(manifest)[0];
  const filename = details?.filename;
  assert.equal(typeof filename, "string");
  const archive = path.join(root, filename);
  const extracted = path.join(root, "extracted");
  fs.mkdirSync(extracted);
  const unpacked = spawnSync("tar", ["-xzf", archive, "-C", extracted], { encoding: "utf-8" });
  assert.strictEqual(unpacked.status, 0, unpacked.stderr);
  const packageDirectory = path.join(extracted, "package");
  const declared = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf-8")) as {
    dependencies?: Record<string, string>;
  };
  const installedDependency = path.join(packageRoot, "node_modules", "smol-toml");
  const installedManifest = JSON.parse(fs.readFileSync(path.join(installedDependency, "package.json"), "utf-8")) as {
    version?: string;
  };
  assert.strictEqual(declared.dependencies?.["smol-toml"], "1.8.0");
  assert.strictEqual(installedManifest.version, "1.8.0");
  fs.mkdirSync(path.join(packageDirectory, "node_modules"), { recursive: true });
  fs.cpSync(installedDependency, path.join(packageDirectory, "node_modules", "smol-toml"), { recursive: true });
  return { archive, extracted: packageDirectory };
}

test("the packed checker is shipped, read-only, and bound to its inspected project", () => {
  const root = fs.mkdtempSync(path.join(testRoot, "wolf-package-"));
  try {
    const { archive, extracted } = pack(root);
    assert.ok(fs.existsSync(archive));
    assert.ok(
      fs.existsSync(path.join(extracted, "node_modules", "smol-toml", "package.json")),
      "packed checker must resolve its declared installed production runtime",
    );
    const checker = path.join(extracted, "scripts", "openwolf-check.mjs");
    assert.ok(fs.existsSync(checker), "archive must contain the public checker");

    const fixture = path.join(root, "fixture");
    fs.mkdirSync(path.join(fixture, ".wolf"), { recursive: true });
    writeCodexFixture(fixture);
    const before = fs.readFileSync(path.join(fixture, ".codex", "hooks.json"));
    const checked = spawnSync(process.execPath, [checker, fixture, "--json"], { encoding: "utf-8" });
    assert.strictEqual(checked.status, 0, checked.stderr);
    assert.deepStrictEqual(JSON.parse(checked.stdout).providers.codex, {
      configured: true,
      self_tested: false,
      receipt: "unknown",
      health: "unknown",
    });
    assert.deepStrictEqual(fs.readFileSync(path.join(fixture, ".codex", "hooks.json")), before);

    const foreign = path.join(root, "foreign");
    fs.mkdirSync(path.join(foreign, ".wolf"), { recursive: true });
    writeCodexFixture(foreign, true);
    const foreignCheck = spawnSync(process.execPath, [checker, foreign, "--json"], { encoding: "utf-8" });
    assert.strictEqual(foreignCheck.status, 0, foreignCheck.stderr);
    assert.strictEqual(JSON.parse(foreignCheck.stdout).providers.codex.configured, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("published documentation states the verified Codex hook and checker contract", () => {
  const documents = ["README.md", "docs/hooks.md", "docs/how-it-works.md"].map((file) =>
    fs.readFileSync(path.join(packageRoot, file), "utf-8"),
  );
  documents.forEach((document) => {
    assert.match(document, /openwolf-check\.mjs/);
    assert.match(document, /default-on/i);
    assert.match(document, /codex_hooks/);
    assert.match(document, /hooks\s*=\s*false/);
    assert.match(document, /fail(?:s)? closed/i);
    assert.match(document, /configured[\s\S]*self-tested[\s\S]*active[\s\S]*unknown[\s\S]*failed/i);
    assert.match(document, /current project|project root/i);
    assert.match(document, /PostToolUse[\s\S]*(?:pass-through|advisory)/i);
  });
});
