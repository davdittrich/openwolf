import { test, describe } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Issue #81 (davdittrich): the Codex adapter caught the parse failure for an
// existing .codex/hooks.json, kept its OpenWolf-only defaults, and wrote them
// over the user's malformed file. The original bytes (the only material for
// repairing it) were lost, and install still reported success.
//
// Exercised through the build output, like buglog-shape.test.ts, because the
// adapter's relative .js imports do not resolve under type stripping.
// Imported through the agents index, not codex.js directly: codex.js imports
// index.js for readSnippet(), so entering the cycle at codex.js hits the
// adapter registry before it is initialized.
const DIST_AGENTS = path.resolve(import.meta.dirname ?? ".", "..", "dist", "src", "agents", "index.js");
const DIST_CODEX_CONFIG = path.resolve(import.meta.dirname ?? ".", "..", "dist", "src", "agents", "codex-config.js");

async function loadCodexAdapter(): Promise<{ install: (ctx: unknown) => { actions: string[]; warnings: string[] } }> {
  const { resolveAgents } = await import(DIST_AGENTS);
  const [adapter] = resolveAgents(["codex"]);
  return adapter;
}

const TEST_TMPDIR = process.env.OPENWOLF_TEST_TMPDIR;
if (TEST_TMPDIR !== "/dev/shm") throw new Error("OPENWOLF_TEST_TMPDIR must be /dev/shm");

async function project<T>(
  body: (ctx: { projectRoot: string; wolfDir: string; templatesDir: string }) => T | Promise<T>,
): Promise<T> {
  const projectRoot = fs.mkdtempSync(path.join(TEST_TMPDIR, "ow-codex-"));
  const wolfDir = path.join(projectRoot, ".wolf");
  const templatesDir = path.join(projectRoot, "templates");
  try {
    fs.mkdirSync(wolfDir, { recursive: true });
    fs.mkdirSync(templatesDir, { recursive: true });
    return await body({ projectRoot, wolfDir, templatesDir });
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
}

describe("codex adapter hooks.json", () => {
  test("runs against the build produced by pnpm test", () => {
    assert.ok(fs.existsSync(DIST_AGENTS), "pnpm test must build dist before importing the Codex adapter");
  });

  test("renders a canonical Node command for Windows-shaped roots", async () => {
    const { renderCodexHookCommand } = await import(DIST_CODEX_CONFIG);
    assert.strictEqual(
      renderCodexHookCommand("C:\\Open Wolf", "pre-write.js"),
      'node "C:/Open Wolf/.wolf/hooks/pre-write.js"',
    );
  });

  test("a malformed existing hooks.json is left byte-identical and warned about", async () => await project(async (ctx) => {
    const codexAdapter = await loadCodexAdapter();
    const hooksPath = path.join(ctx.projectRoot, ".codex", "hooks.json");
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    const original = '{\n  "hooks": {\n    "SessionStart": [{ "matcher": "startup" }],\n  }\n}\n';
    fs.writeFileSync(hooksPath, original, "utf-8");
    const before = fs.readFileSync(hooksPath);

    const result = codexAdapter.install(ctx);

    assert.deepStrictEqual(fs.readFileSync(hooksPath), before, "malformed user file must be byte-identical after install");
    assert.strictEqual(result.warnings.filter((w: string) => w.includes("hooks.json")).length, 1, "exactly one actionable warning about the file");
    assert.ok(!result.actions.some((a: string) => a.includes("hooks registered")), "install must not claim hooks were registered");
  }));

  test("an unreadable-shaped hooks.json (top-level array) is also preserved", async () => await project(async (ctx) => {
    const codexAdapter = await loadCodexAdapter();
    const hooksPath = path.join(ctx.projectRoot, ".codex", "hooks.json");
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, '["something else entirely"]\n', "utf-8");
    const before = fs.readFileSync(hooksPath);

    const result = codexAdapter.install(ctx);

    assert.deepStrictEqual(fs.readFileSync(hooksPath), before);
    assert.ok(result.warnings.some((w: string) => w.includes("hooks.json")));
  }));

  test("a valid existing hooks.json keeps user hooks and unknown top-level keys", async () => await project(async (ctx) => {
    const codexAdapter = await loadCodexAdapter();
    const hooksPath = path.join(ctx.projectRoot, ".codex", "hooks.json");
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, JSON.stringify({
      version: 3,
      hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo mine" }] }] },
    }, null, 2), "utf-8");

    const result = codexAdapter.install(ctx);
    const written = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));

    assert.strictEqual(written.version, 3, "unknown top-level keys survive");
    const sessionStart = JSON.stringify(written.hooks.SessionStart);
    assert.ok(sessionStart.includes("echo mine"), "user hook preserved");
    assert.ok(sessionStart.includes("session-start.js"), "OpenWolf hook added");
    assert.ok(result.actions.some((a: string) => a.includes("hooks registered")));
  }));

  test("no existing file: OpenWolf hooks are written", async () => await project(async (ctx) => {
    const codexAdapter = await loadCodexAdapter();
    const result = codexAdapter.install(ctx);
    const written = JSON.parse(fs.readFileSync(path.join(ctx.projectRoot, ".codex", "hooks.json"), "utf-8"));
    assert.ok(Array.isArray(written.hooks.SessionStart));
    assert.ok(result.actions.some((a: string) => a.includes("hooks registered")));
  }));


  test("default-on hooks leave an absent config.toml absent", async () => await project(async (ctx) => {
    const codexAdapter = await loadCodexAdapter();
    const result = codexAdapter.install(ctx);
    assert.strictEqual(fs.existsSync(path.join(ctx.projectRoot, ".codex", "config.toml")), false);
    assert.ok(!result.actions.some((action: string) => action.includes("hooks feature enabled")));
    assert.deepStrictEqual(result.warnings, []);
  }));


  test("warns only for an explicit disable or ambiguous existing feature state", async () => await project(async (ctx) => {
    const codexAdapter = await loadCodexAdapter();
    for (const [name, config, warning] of [
      ["missing feature key", "[model]\nname = \"x\"\n", false],
      ["deprecated alias enabled", "[features]\ncodex_hooks = true\n", false],
      ["root feature with nested decoy", "[features]\nhooks = true\n[features.nested]\nhooks = false\n", false],
      ["canonical disabled", "[features]\nhooks = false\n", true],
      ["ambiguous feature", "[features]\nhooks = true\nhooks = true\n", true],
    ] as const) {
      const configPath = path.join(ctx.projectRoot, ".codex", "config.toml");
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, config, "utf-8");
      const before = fs.readFileSync(configPath);
      const result = codexAdapter.install(ctx);
      assert.strictEqual(result.warnings.some((entry: string) => entry.includes("config.toml")), warning, name);
      assert.deepStrictEqual(fs.readFileSync(configPath), before, name);
    }
  }));

  test("install is idempotent: a second run does not duplicate OpenWolf entries", async () => await project(async (ctx) => {
    const codexAdapter = await loadCodexAdapter();
    const hooksPath = path.join(ctx.projectRoot, ".codex", "hooks.json");
    fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
    fs.writeFileSync(hooksPath, JSON.stringify({
      version: 3,
      hooks: { PostToolUse: [{ matcher: "Custom", hooks: [{ type: "command", command: "echo mine" }] }] },
    }), "utf-8");
    codexAdapter.install(ctx);
    codexAdapter.install(ctx);
    const written = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
    assert.strictEqual(written.hooks.SessionStart.length, 1);
    const postToolUse = written.hooks.PostToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    const openWolfEntries = postToolUse.filter((entry) => entry.hooks.some((hook) => hook.command.includes(".wolf/hooks")));
    assert.deepStrictEqual(openWolfEntries.map((entry) => entry.matcher), ["Read", "Edit|Write|MultiEdit|apply_patch", "Bash"]);
    assert.deepStrictEqual(postToolUse.filter((entry) => entry.matcher === "Custom"), [{ matcher: "Custom", hooks: [{ type: "command", command: "echo mine" }] }]);
    assert.strictEqual(written.version, 3);
  }));
});
