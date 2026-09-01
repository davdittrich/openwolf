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

const codexHookScripts = [
  "session-start.js",
  "pre-read.js",
  "pre-write.js",
  "post-read.js",
  "post-write.js",
  "precompact.js",
  "stop.js",
];

function codexConfig(
  root: string,
  options: { config?: string | null; hooks?: unknown } = {},
): void {
  fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
  if (options.config !== null) {
    fs.writeFileSync(path.join(root, ".codex", "config.toml"), options.config ?? "[features]\nhooks = true\n", "utf-8");
  }
  fs.writeFileSync(
    path.join(root, ".codex", "hooks.json"),
    JSON.stringify(options.hooks ?? {
      hooks: {
        SessionStart: [{ hooks: codexHookScripts.map((script) => ({ command: `node \"${path.join(root, ".wolf", "hooks", script)}\"` })) }],
      },
    }),
    "utf-8",
  );
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
  test("Codex configuration requires the enabled feature and every installed OpenWolf command without rewriting either config", () => {
    const invalidConfigs = [
      { name: "missing config", config: null, hooks: undefined },
      { name: "disabled feature", config: "[features]\nhooks = false\n", hooks: undefined },
      { name: "commented assignment", config: "[features]\n# hooks = true\n", hooks: undefined },
      { name: "foreign section", config: "[other]\nhooks = true\n", hooks: undefined },
      { name: "webhooks only", config: "[features]\nwebhooks = true\n", hooks: undefined },
      { name: "partial commands", config: "[features]\nhooks = true\n", hooks: { hooks: { Stop: [{ hooks: [{ command: "node .wolf/hooks/stop.js" }] }] } } },
      { name: "foreign commands", config: "[features]\nhooks = true\n", hooks: { hooks: { Stop: [{ hooks: [{ command: "echo user-hook" }] }] } } },
      { name: "wrong command type", config: "[features]\nhooks = true\n", hooks: { hooks: { Stop: [{ hooks: [{ command: 1 }] }] } } },
      { name: "empty hook object", config: "[features]\nhooks = true\n", hooks: { hooks: {} } },
    ];

    for (const fixture of invalidConfigs) {
      project((root) => codexConfig(root, fixture), (root) => {
        const configPath = path.join(root, ".codex", "config.toml");
        const hooksPath = path.join(root, ".codex", "hooks.json");
        const configBefore = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
        const hooksBefore = fs.readFileSync(hooksPath);
        assert.strictEqual(run(root).providers.codex.configured, false, fixture.name);
        assert.match(run(root, false), /codex.*configured no/i, fixture.name);
        assert.deepStrictEqual(fs.existsSync(configPath) ? fs.readFileSync(configPath) : null, configBefore, fixture.name);
        assert.deepStrictEqual(fs.readFileSync(hooksPath), hooksBefore, fixture.name);
      });
    }

    project((root) => codexConfig(root, {
      hooks: { version: 3, hooks: { SessionStart: [{ hooks: [
        ...codexHookScripts.map((script) => ({ command: `node \"${path.join(root, ".wolf", "hooks", script)}\"` })),
        { command: "echo user-hook" },
      ] }] } },
    }), (root) => {
      assert.strictEqual(run(root).providers.codex.configured, true);
    });
  });

  test("malformed Codex configuration remains unknown and byte-identical", () => {
    project((root) => {
      fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(root, ".codex", "config.toml"), "[features\nhooks = true\n", "utf-8");
      fs.writeFileSync(path.join(root, ".codex", "hooks.json"), '{"hooks": [}\n', "utf-8");
    }, (root) => {
      const configPath = path.join(root, ".codex", "config.toml");
      const hooksPath = path.join(root, ".codex", "hooks.json");
      const configBefore = fs.readFileSync(configPath);
      const hooksBefore = fs.readFileSync(hooksPath);
      assert.deepStrictEqual(run(root).providers.codex, { configured: false, self_tested: false, receipt: "unknown", health: "unknown" });
      assert.match(run(root, false), /codex.*configured no.*unknown/i);
      assert.deepStrictEqual(fs.readFileSync(configPath), configBefore);
      assert.deepStrictEqual(fs.readFileSync(hooksPath), hooksBefore);
    });
  });

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
