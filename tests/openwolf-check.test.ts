import { test, describe } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const check = path.join(import.meta.dirname, "..", "scripts", "openwolf-check.mjs");

function project(setup: (root: string) => void): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wolf-check-"));
  fs.mkdirSync(path.join(root, ".wolf"), { recursive: true });
  setup(root);
  return root;
}

function run(root: string, json = true) {
  const out = spawnSync(process.execPath, [check, root, ...(json ? ["--json"] : [])], { encoding: "utf-8" });
  assert.strictEqual(out.status, 0, out.stderr);
  return json ? JSON.parse(out.stdout) : out.stdout;
}

function codexConfig(root: string): void {
  fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codex", "hooks.json"), JSON.stringify({ hooks: {} }), "utf-8");
}

function receipt(root: string, status: "confirmed" | "failed"): void {
  fs.writeFileSync(path.join(root, ".wolf", "token-ledger.json"), JSON.stringify({
    lifetime: {},
    sessions: [{ ended: "2026-09-01T00:00:00Z", totals: {}, verified: {
      provider: "claude", status, variant: "claude_attachment",
      hooks_fired: 1, hooks_failed: status === "failed" ? 1 : 0,
      injections_delivered: 0, injection_tokens_delivered: 0, per_hook: {},
    } }],
  }), "utf-8");
}

describe("openwolf-check provider evidence", () => {
  test("configured-only Codex remains unknown in JSON and human output", () => {
    const root = project(codexConfig);
    const json = run(root);
    assert.deepStrictEqual(json.providers.codex, { configured: true, self_tested: false, receipt: "unknown", health: "unknown" });
    assert.match(run(root, false), /codex.*configured.*unknown/i);
  });

  test("a successful installed selfcheck is self-tested, not active", () => {
    const root = project((dir) => {
      codexConfig(dir);
      const hooks = path.join(dir, ".wolf", "hooks");
      fs.mkdirSync(hooks, { recursive: true });
      fs.writeFileSync(path.join(hooks, "session-start.js"), "process.exit(0);", "utf-8");
    });
    const providers = run(root).providers;
    assert.deepStrictEqual(providers.codex, { configured: true, self_tested: true, receipt: "unknown", health: "self-tested" });
    assert.deepStrictEqual(providers.claude, { configured: false, self_tested: false, receipt: "unknown", health: "unknown" });
  });

  test("only confirmed receipt is active and failure is not erased", () => {
    const active = project((dir) => { codexConfig(dir); receipt(dir, "confirmed"); });
    assert.strictEqual(run(active).providers.claude.health, "active");
    const failed = project((dir) => { codexConfig(dir); receipt(dir, "failed"); });
    assert.strictEqual(run(failed).providers.claude.health, "failed");
    assert.strictEqual(run(failed).providers.codex.health, "unknown");
  });

  test("failed selfcheck stays failed with a bounded non-sensitive diagnostic", () => {
    const root = project((dir) => {
      codexConfig(dir);
      const hooks = path.join(dir, ".wolf", "hooks");
      fs.mkdirSync(hooks, { recursive: true });
      fs.writeFileSync(path.join(hooks, "session-start.js"), 'console.error("secret=/outside/project"); process.exit(1);', "utf-8");
    });
    const evidence = run(root).providers.codex;
    assert.strictEqual(evidence.health, "failed");
    assert.strictEqual(evidence.diagnostic, "installed hook selfcheck failed");
    assert.doesNotMatch(JSON.stringify(evidence), /secret|outside/);
  });
});
