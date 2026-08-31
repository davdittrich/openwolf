import { test, describe } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { deepMergeMissing, mergeConfigDefaults } from "../src/cli/config-merge.ts";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "wolf-cfg-"));
const DIST_AGENTS = path.resolve(import.meta.dirname, "..", "dist", "src", "agents", "index.js");

async function codexAdapter(): Promise<{ install: (ctx: unknown) => { actions: string[]; warnings: string[] } }> {
  assert.ok(fs.existsSync(DIST_AGENTS), "run pnpm exec tsc before this test");
  const { resolveAgents } = await import(DIST_AGENTS);
  const [adapter] = resolveAgents(["codex"]);
  return adapter;
}

function codexProject(): { projectRoot: string; wolfDir: string; templatesDir: string } {
  const projectRoot = fs.mkdtempSync(path.join(process.env.OPENWOLF_TEST_TMPDIR ?? "/dev/shm", "openwolf-codex-"));
  const wolfDir = path.join(projectRoot, ".wolf");
  const templatesDir = path.join(projectRoot, "templates");
  fs.mkdirSync(wolfDir, { recursive: true });
  fs.mkdirSync(templatesDir, { recursive: true });
  return { projectRoot, wolfDir, templatesDir };
}

describe("deepMergeMissing", () => {
  test("adds missing keys without touching existing values", () => {
    const target: Record<string, unknown> = {
      openwolf: { daemon: { port: 18801 }, anatomy: { max_files: 900 } },
    };
    const defaults = {
      version: 1,
      openwolf: {
        reads: { duplicate_mode: "warn" },
        daemon: { port: 18790, log_level: "info" },
        anatomy: { max_files: 500 },
      },
    };

    const changed = deepMergeMissing(target, defaults);

    assert.strictEqual(changed, true);
    const ow = target.openwolf as any;
    assert.strictEqual(ow.reads.duplicate_mode, "warn");
    assert.strictEqual(ow.daemon.port, 18801);
    assert.strictEqual(ow.daemon.log_level, "info");
    assert.strictEqual(ow.anatomy.max_files, 900);
    assert.strictEqual((target as any).version, 1);
  });

  test("treats arrays as leaves: a customized list is never re-populated", () => {
    const target: Record<string, unknown> = { exclude: ["node_modules"] };
    const changed = deepMergeMissing(target, { exclude: ["node_modules", "dist", ".git"] });
    assert.strictEqual(changed, false);
    assert.deepStrictEqual(target.exclude, ["node_modules"]);
  });

  test("returns false when nothing is missing", () => {
    const target = { a: { b: 1 } };
    assert.strictEqual(deepMergeMissing(target, { a: { b: 2 } }), false);
    assert.strictEqual(target.a.b, 1);
  });
});

describe("mergeConfigDefaults", () => {
  test("merges the shipped template into a legacy project config on disk", () => {
    const dir = tmpDir();
    const templatesDir = path.join(dir, "templates");
    fs.mkdirSync(templatesDir);
    fs.writeFileSync(
      path.join(templatesDir, "config.json"),
      JSON.stringify({
        version: 1,
        openwolf: { reads: { duplicate_mode: "warn" }, dashboard: { port: 18791 } },
      }),
      "utf-8"
    );
    const cfgPath = path.join(dir, "config.json");
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ version: 1, openwolf: { dashboard: { port: 18877 } } }),
      "utf-8"
    );

    assert.strictEqual(mergeConfigDefaults(cfgPath, templatesDir), true);
    const merged = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    assert.strictEqual(merged.openwolf.reads.duplicate_mode, "warn");
    assert.strictEqual(merged.openwolf.dashboard.port, 18877);

    // Second run: nothing missing anymore.
    assert.strictEqual(mergeConfigDefaults(cfgPath, templatesDir), false);
  });

  test("no-ops when the project config does not exist", () => {
    const dir = tmpDir();
    assert.strictEqual(mergeConfigDefaults(path.join(dir, "config.json"), dir), false);
    assert.strictEqual(fs.existsSync(path.join(dir, "config.json")), false);
  });
});

describe("Codex hook merge", () => {
  test("installs one Bash pre-hook idempotently without changing user-owned configuration", async () => {
    const adapter = await codexAdapter();
    const ctx = codexProject();
    try {
      const codexDir = path.join(ctx.projectRoot, ".codex");
      fs.mkdirSync(codexDir, { recursive: true });
      const hooksPath = path.join(codexDir, "hooks.json");
      const configPath = path.join(codexDir, "config.toml");
      const configToml = "# user-owned\n[features]\nhooks = false\n";
      fs.writeFileSync(configPath, configToml, "utf-8");
      fs.writeFileSync(hooksPath, JSON.stringify({
        version: 3,
        hooks: {
          PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "echo user-hook" }] }],
        },
      }, null, 2) + "\n", "utf-8");

      const first = adapter.install(ctx);
      const second = adapter.install(ctx);
      const installed = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
      const bashEntries = installed.hooks.PreToolUse.filter((entry: { matcher?: string }) => entry.matcher === "Bash");

      assert.strictEqual(bashEntries.length, 1);
      assert.strictEqual(bashEntries[0].hooks.length, 1);
      assert.match(bashEntries[0].hooks[0].command, /\.wolf\/hooks\/pre-bash\.js/);
      assert.strictEqual(installed.version, 3);
      assert.strictEqual(installed.hooks.PreToolUse[0].hooks[0].command, "echo user-hook");
      assert.strictEqual(fs.readFileSync(configPath, "utf-8"), configToml);
      assert.ok(first.warnings.some((warning) => warning.includes('hooks = true')));
      assert.ok(second.warnings.some((warning) => warning.includes('hooks = true')));
    } finally {
      fs.rmSync(ctx.projectRoot, { recursive: true, force: true });
    }
  });

  test("leaves malformed hooks bytes untouched while reporting the existing warning", async () => {
    const adapter = await codexAdapter();
    const ctx = codexProject();
    try {
      const hooksPath = path.join(ctx.projectRoot, ".codex", "hooks.json");
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      const malformed = '{"hooks": [}\n';
      fs.writeFileSync(hooksPath, malformed, "utf-8");

      const result = adapter.install(ctx);

      assert.strictEqual(fs.readFileSync(hooksPath, "utf-8"), malformed);
      assert.ok(result.warnings.some((warning) => warning.includes("hooks.json")));
    } finally {
      fs.rmSync(ctx.projectRoot, { recursive: true, force: true });
    }
  });
});
