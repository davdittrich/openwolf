import { test, describe } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const check = path.join(import.meta.dirname, "..", "scripts", "openwolf-check.mjs");

function withProject<T>(body: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wolf-check-"));
  try {
    fs.mkdirSync(path.join(root, ".wolf"), { recursive: true });
    return body(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function project<T>(setup: (root: string) => void, body: (root: string) => T): T {
  return withProject((root) => {
    setup(root);
    return body(root);
  });
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

function receipts(root: string, entries: Array<{ ended?: string; status: "confirmed" | "failed"; provider?: "claude" | "codex" }>): void {
  fs.writeFileSync(path.join(root, ".wolf", "token-ledger.json"), JSON.stringify({
    lifetime: {},
    sessions: entries.map(({ ended, status, provider = "claude" }) => ({ ended, totals: {}, verified: {
      provider, status, variant: "claude_attachment",
      hooks_fired: 1, hooks_failed: status === "failed" ? 1 : 0,
      injections_delivered: 0, injection_tokens_delivered: 0, per_hook: {},
    } })),
  }), "utf-8");
}

function receipt(root: string, status: "confirmed" | "failed"): void {
  receipts(root, [{ ended: "2026-09-01T00:00:00Z", status }]);
}

describe("openwolf-check provider evidence", () => {
  test("configured-only Codex remains unknown in JSON and human output", () => {
    project(codexConfig, (root) => {
      const json = run(root);
      assert.deepStrictEqual(json.providers.codex, { configured: true, self_tested: false, receipt: "unknown", health: "unknown" });
      assert.match(run(root, false), /codex.*configured.*unknown/i);
    });
  });

  test("a successful installed selfcheck is self-tested, not active", () => {
    project((dir) => {
      codexConfig(dir);
      const hooks = path.join(dir, ".wolf", "hooks");
      fs.mkdirSync(hooks, { recursive: true });
      fs.writeFileSync(path.join(hooks, "session-start.js"), "process.exit(0);", "utf-8");
    }, (root) => {
      const providers = run(root).providers;
      assert.deepStrictEqual(providers.codex, { configured: true, self_tested: true, receipt: "unknown", health: "self-tested" });
      assert.deepStrictEqual(providers.claude, { configured: false, self_tested: false, receipt: "unknown", health: "unknown" });
    });
  });

  test("confirmed receipts retain authority through selfchecks while newer explicit evidence controls failure and recovery", () => {
    const active = project((dir) => {
      codexConfig(dir);
      receipts(dir, [{ ended: "2000-01-01T00:00:00Z", status: "confirmed", provider: "codex" }]);
      const hooks = path.join(dir, ".wolf", "hooks");
      fs.mkdirSync(hooks, { recursive: true });
      fs.writeFileSync(path.join(hooks, "session-start.js"), "process.exit(0);", "utf-8");
    }, run).providers.codex;
    assert.deepStrictEqual(active, { configured: true, self_tested: true, receipt: "confirmed", health: "active" });

    const selfcheckFailure = project((dir) => {
      codexConfig(dir);
      receipts(dir, [{ ended: "2000-01-01T00:00:00Z", status: "confirmed", provider: "codex" }]);
      const hooks = path.join(dir, ".wolf", "hooks");
      fs.mkdirSync(hooks, { recursive: true });
      fs.writeFileSync(path.join(hooks, "session-start.js"), "process.exit(1);", "utf-8");
    }, run).providers.codex;
    assert.strictEqual(selfcheckFailure.health, "failed");

    const recovered = project((dir) => {
      codexConfig(dir);
      receipts(dir, [
        { ended: "2000-01-01T00:00:00Z", status: "failed", provider: "codex" },
        { ended: "2000-01-01T01:00:00Z", status: "confirmed", provider: "codex" },
      ]);
    }, run).providers.codex;
    assert.strictEqual(recovered.health, "active");
  });

  test("only confirmed receipt is active and failure is not erased", () => {
    assert.strictEqual(project((dir) => { codexConfig(dir); receipt(dir, "confirmed"); }, run).providers.claude.health, "active");
    const failed = project((dir) => { codexConfig(dir); receipt(dir, "failed"); }, run).providers;
    assert.strictEqual(failed.claude.health, "failed");
    assert.strictEqual(failed.codex.health, "unknown");
  });

  test("the latest valid receipt supersedes array order, with failed ties fail-closed", () => {
    const recovered = project((dir) => {
      receipts(dir, [
        { ended: "2026-09-01T00:00:00Z", status: "failed" },
        { ended: "2026-09-01T01:00:00Z", status: "confirmed" },
      ]);
    }, run);
    assert.strictEqual(recovered.providers.claude.health, "active");

    const reversed = project((dir) => {
      receipts(dir, [
        { ended: "2026-09-01T01:00:00Z", status: "confirmed" },
        { ended: "2026-09-01T00:00:00Z", status: "failed" },
      ]);
    }, run);
    assert.strictEqual(reversed.providers.claude.health, "active");

    const laterFailure = project((dir) => {
      receipts(dir, [
        { ended: "2026-09-01T00:00:00Z", status: "confirmed" },
        { ended: "2026-09-01T01:00:00Z", status: "failed" },
      ]);
    }, run);
    assert.strictEqual(laterFailure.providers.claude.health, "failed");

    const tied = project((dir) => {
      receipts(dir, [
        { ended: "2026-09-01T01:00:00Z", status: "confirmed" },
        { ended: "2026-09-01T01:00:00Z", status: "failed" },
      ]);
    }, run);
    assert.strictEqual(tied.providers.claude.health, "failed");
  });

  test("the latest selfcheck is self-tested, but invalid receipt times never override valid authority", () => {
    const selfTested = project((dir) => {
      codexConfig(dir);
      receipts(dir, [{ ended: "2000-01-01T00:00:00Z", status: "failed", provider: "codex" }]);
      const hooks = path.join(dir, ".wolf", "hooks");
      fs.mkdirSync(hooks, { recursive: true });
      fs.writeFileSync(path.join(hooks, "session-start.js"), "process.exit(0);", "utf-8");
    }, run);
    assert.strictEqual(selfTested.providers.codex.health, "self-tested");

    const validWins = project((dir) => {
      receipts(dir, [
        { ended: "not-a-date", status: "failed" },
        { ended: "2026-09-01T01:00:00Z", status: "confirmed" },
        { status: "failed" },
      ]);
    }, run);
    const json = validWins;
    assert.strictEqual(json.providers.claude.health, "active");
    assert.match(project((dir) => {
      receipts(dir, [
        { ended: "not-a-date", status: "failed" },
        { ended: "2026-09-01T01:00:00Z", status: "confirmed" },
        { status: "failed" },
      ]);
    }, (root) => run(root, false)), /claude.*active/i);
  });

  test("failed selfcheck stays failed with a bounded non-sensitive diagnostic", () => {
    const evidence = project((dir) => {
      codexConfig(dir);
      const hooks = path.join(dir, ".wolf", "hooks");
      fs.mkdirSync(hooks, { recursive: true });
      fs.writeFileSync(path.join(hooks, "session-start.js"), 'console.error("secret=/outside/project"); process.exit(1);', "utf-8");
    }, run).providers.codex;
    assert.strictEqual(evidence.health, "failed");
    assert.strictEqual(evidence.diagnostic, "installed hook selfcheck failed");
    assert.doesNotMatch(JSON.stringify(evidence), /secret|outside/);
  });
});

describe("openwolf-check fixture lifecycle (#18)", () => {
  test("removes its exact temporary root when the fixture body throws", () => {
    let root = "";
    assert.throws(() => withProject((dir) => {
      root = dir;
      throw new Error("intentional fixture failure");
    }), /intentional fixture failure/);
    assert.strictEqual(fs.existsSync(root), false);
  });
});
