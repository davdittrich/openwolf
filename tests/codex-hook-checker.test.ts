import { describe, test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const TEST_TMPDIR = process.env.OPENWOLF_TEST_TMPDIR;
if (TEST_TMPDIR !== "/dev/shm") throw new Error("OPENWOLF_TEST_TMPDIR must be /dev/shm");

const DIST_AGENTS = path.resolve(import.meta.dirname, "..", "dist", "src", "agents", "index.js");
const CHECK = path.resolve(import.meta.dirname, "..", "scripts", "openwolf-check.mjs");
const DIST_HOOKS = path.resolve(import.meta.dirname, "..", "dist", "hooks");

async function codexAdapter(): Promise<{ install: (ctx: { projectRoot: string; templatesDir: string }) => unknown }> {
  const { resolveAgents } = await import(DIST_AGENTS);
  return resolveAgents(["codex"])[0];
}

function check(root: string): boolean {
  const result = spawnSync(process.execPath, [CHECK, root, "--json"], { encoding: "utf-8" });
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).providers.codex.configured;
}

function entry(config: { hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>> }, script: string) {
  for (const [event, entries] of Object.entries(config.hooks)) {
    const candidate = entries.find((item) => item.hooks.some((hook) => hook.command.includes(`/${script}`)));
    if (candidate) return { event, candidate, hook: candidate.hooks.find((item) => item.command.includes(`/${script}`))! };
  }
  throw new Error(`missing installed ${script}`);
}

describe("installed Codex hook checker contract", () => {
  test("accepts actual adapter output and rejects each material mapping mutation", async () => {
    const root = fs.mkdtempSync(path.join(TEST_TMPDIR, "ow-codex-check-"));
    try {
      fs.mkdirSync(path.join(root, ".wolf", "hooks"), { recursive: true });
      fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(root, ".codex", "hooks.json"), JSON.stringify({ hooks: { Custom: [{ matcher: "User", hooks: [{ type: "command", command: "echo user" }] }] } }), "utf-8");
      (await codexAdapter()).install({ projectRoot: root, templatesDir: path.join(root, "templates") });

      const hooksPath = path.join(root, ".codex", "hooks.json");
      const installed = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
      assert.strictEqual(check(root), true);
      assert.strictEqual(entry(installed, "session-start.js").candidate.matcher, "startup|resume|clear|compact");
      assert.ok(JSON.stringify(installed.hooks.Custom).includes("echo user"), "user entry preserved");

      const mutations: Array<[string, (value: typeof installed) => void]> = [
        ["event", (value) => { value.hooks.SessionStart = []; }],
        ["matcher", (value) => { entry(value, "session-start.js").candidate.matcher = "wrong"; }],
        ["compact", (value) => { entry(value, "session-start.js").candidate.matcher = "startup|resume|clear"; }],
        ["type", (value) => { entry(value, "stop.js").hook.type = "mcp_tool"; }],
        ["project root", (value) => { const hook = entry(value, "session-start.js").hook; hook.command = hook.command.replace(root, `${root}-foreign`); }],
        ["pre-Bash", (value) => { entry(value, "pre-bash.js").candidate.matcher = "Read"; }],
        ["post-Bash", (value) => { entry(value, "post-bash.js").candidate.matcher = "Read"; }],
      ];
      for (const [name, mutate] of mutations) {
        const mutated = JSON.parse(JSON.stringify(installed));
        mutate(mutated);
        fs.writeFileSync(hooksPath, JSON.stringify(mutated), "utf-8");
        assert.strictEqual(check(root), false, name);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("compiled SessionStart reinjects persisted state after compact", () => {
    const root = fs.mkdtempSync(path.join(TEST_TMPDIR, "ow-codex-compact-"));
    try {
      const hooksDir = path.join(root, ".wolf", "hooks");
      fs.cpSync(DIST_HOOKS, hooksDir, { recursive: true });
      fs.writeFileSync(path.join(root, ".wolf", "config.json"), JSON.stringify({ openwolf: { context: { session_digest_budget_tokens: 1 } } }), "utf-8");
      fs.mkdirSync(path.join(hooksDir, "sessions"), { recursive: true });
      fs.writeFileSync(path.join(hooksDir, "sessions", "compact-session.json"), JSON.stringify({ files_written: [{ file: "src/already-touched.ts" }], files_read: {}, edit_counts: {} }), "utf-8");

      const result = spawnSync(process.execPath, [path.join(hooksDir, "session-start.js")], {
        cwd: root,
        env: { ...process.env, OPENWOLF_PROJECT_ROOT: root },
        input: JSON.stringify({ source: "compact", session_id: "compact-session" }),
        encoding: "utf-8",
      });
      assert.strictEqual(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.strictEqual(output.hookSpecificOutput.hookEventName, "SessionStart");
      assert.match(output.hookSpecificOutput.additionalContext, /context was just compacted/);
      assert.match(output.hookSpecificOutput.additionalContext, /src\/already-touched\.ts/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
