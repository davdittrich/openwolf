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

function run(root: string, json = true, selfcheck = false) {
  const out = spawnSync(process.execPath, [check, root, ...(json ? ["--json"] : []), ...(selfcheck ? ["--selfcheck"] : [])], { encoding: "utf-8" });
  assert.strictEqual(out.status, 0, out.stderr);
  return json ? JSON.parse(out.stdout) : out.stdout;
}

const codexHookRecords = [
  { event: "SessionStart", matcher: "startup|resume|clear", script: "session-start.js" },
  { event: "PreToolUse", matcher: "Read", script: "pre-read.js" },
  { event: "PreToolUse", matcher: "Edit|Write|MultiEdit|apply_patch", script: "pre-write.js" },
  { event: "PreToolUse", matcher: "Bash", script: "pre-bash.js" },
  { event: "PostToolUse", matcher: "Read", script: "post-read.js" },
  { event: "PostToolUse", matcher: "Edit|Write|MultiEdit|apply_patch", script: "post-write.js" },
  { event: "PostToolUse", matcher: "Bash", script: "post-bash.js" },
  { event: "PreCompact", matcher: "", script: "precompact.js" },
  { event: "Stop", matcher: "", script: "stop.js" },
];

const codexHookScripts = codexHookRecords.map(({ script }) => script);

function codexHooks(root: string, records = codexHookRecords): { hooks: Record<string, unknown[]> } {
  return {
    hooks: records.reduce<Record<string, unknown[]>>((hooks, { event, matcher, script }) => ({
      ...hooks,
      [event]: [
        ...(hooks[event] ?? []),
        { matcher, hooks: [{ type: "command", command: `node \"${path.join(root, ".wolf", "hooks", script)}\"` }] },
      ],
    }), {}),
  };
}

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
    JSON.stringify(options.hooks ?? codexHooks(root)),
    "utf-8",
  );
}

function selfcheckHooks(root: string, options: { omit?: string; fail?: string } = {}): string {
  const hooks = path.join(root, ".wolf", "hooks");
  const calls = path.join(root, "selfcheck-calls.txt");
  fs.mkdirSync(hooks, { recursive: true });
  codexHookScripts.filter((script) => script !== options.omit).forEach((script) => {
    fs.writeFileSync(path.join(hooks, script), [
      'const fs = require("node:fs");',
      `fs.appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(`${script}\n`)});`,
      options.fail === script ? 'console.error("secret=/outside/project"); process.exit(1);' : "process.exit(0);",
    ].join("\n"), "utf-8");
  });
  return calls;
}

function receipts(root: string, entries: Array<{
  ended?: string;
  status?: unknown;
  provider?: unknown;
  variant?: unknown;
  verified?: unknown;
  hooks_fired?: unknown;
  hooks_failed?: unknown;
  injections_delivered?: unknown;
  injection_tokens_delivered?: unknown;
  per_hook?: unknown;
  last_failure?: unknown;
}>): void {
  fs.writeFileSync(path.join(root, ".wolf", "token-ledger.json"), JSON.stringify({
    lifetime: {},
    sessions: entries.map(({ ended, status, provider = "claude", variant = "claude_attachment", verified, hooks_fired = 1, hooks_failed, injections_delivered = 0, injection_tokens_delivered = 0, per_hook, last_failure }) => {
      const failed = hooks_failed ?? (status === "failed" ? 1 : 0);
      return {
        ended,
        totals: {},
        verified: verified ?? {
          provider, status, variant, hooks_fired, hooks_failed: failed, injections_delivered, injection_tokens_delivered,
          per_hook: per_hook ?? { "session-start.js": { fired: hooks_fired, failed, last_exit: failed > 0 ? 1 : 0 } },
          ...(last_failure === undefined ? {} : { last_failure }),
        },
      };
    }),
  }), "utf-8");
}

function receipt(root: string, status: "confirmed" | "failed"): void {
  receipts(root, [{ ended: "2026-09-01T00:00:00Z", status }]);
}

describe("openwolf-check provider evidence", () => {
  test("Codex configuration requires the exact generated hook topology without rewriting either config", () => {
    const invalidConfigs = [
      { name: "disabled feature", config: "[features]\nhooks = false\n", hooks: undefined },
      { name: "all mappings under SessionStart", config: "[features]\nhooks = true\n", hooks: { hooks: { SessionStart: codexHookRecords.map(({ matcher, script }) => ({ matcher, hooks: [{ type: "command", command: `node \".wolf/hooks/${script}\"` }] })) } } },
      { name: "foreign-root command", config: "[features]\nhooks = true\n", hooks: (root: string) => codexHooks(root, codexHookRecords.map((record) => record.script === "post-bash.js" ? { ...record, script: "../../foreign/.wolf/hooks/post-bash.js" } : record)) },
      { name: "missing pre-Bash mapping", config: "[features]\nhooks = true\n", hooks: (root: string) => codexHooks(root, codexHookRecords.filter(({ script }) => script !== "pre-bash.js")) },
      { name: "missing post-Bash mapping", config: "[features]\nhooks = true\n", hooks: (root: string) => codexHooks(root, codexHookRecords.filter(({ script }) => script !== "post-bash.js")) },
      { name: "wrong command type", config: "[features]\nhooks = true\n", hooks: (root: string) => ({ hooks: { ...codexHooks(root).hooks, Stop: [{ matcher: "", hooks: [{ type: "mcp_tool", command: `node \"${path.join(root, ".wolf", "hooks", "stop.js")}\"` }] }] } }) },
      { name: "nested event decoy", config: "[features]\nhooks = true\n", hooks: (root: string) => ({ hooks: { ...codexHooks(root).hooks, SessionStart: { nested: codexHooks(root).hooks.SessionStart } } }) },
      { name: "nested matcher decoy", config: "[features]\nhooks = true\n", hooks: (root: string) => ({ hooks: { ...codexHooks(root).hooks, SessionStart: [{ nested: codexHooks(root).hooks.SessionStart?.[0] }] } }) },
      { name: "empty hook object", config: "[features]\nhooks = true\n", hooks: { hooks: {} } },
    ];

    for (const fixture of invalidConfigs) {
      project((root) => codexConfig(root, { ...fixture, hooks: typeof fixture.hooks === "function" ? fixture.hooks(root) : fixture.hooks }), (root) => {
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

    for (const feature of [
      { name: "omitted config file", config: null },
      { name: "omitted feature", config: "[model]\nname = \"x\"\n" },
      { name: "commented feature", config: "[features]\n# hooks = true\n" },
      { name: "foreign-section hook key", config: "[other]\nhooks = true\n" },
      { name: "webhooks key", config: "[features]\nwebhooks = true\n" },
      { name: "enabled feature", config: "[features]\nhooks = true\n" },
    ]) {
      project((root) => {
        const hooks = codexHooks(root);
        hooks.hooks.Stop.push({ matcher: "UserTool", hooks: [{ type: "command", command: "echo user-hook" }] });
        codexConfig(root, { config: feature.config, hooks });
      }, (root) => {
        const configPath = path.join(root, ".codex", "config.toml");
        const hooksPath = path.join(root, ".codex", "hooks.json");
        const configBefore = fs.existsSync(configPath) ? fs.readFileSync(configPath) : null;
        const hooksBefore = fs.readFileSync(hooksPath);
        assert.strictEqual(run(root).providers.codex.configured, true, feature.name);
        assert.match(run(root, false), /codex.*configured yes/i, feature.name);
        assert.deepStrictEqual(fs.existsSync(configPath) ? fs.readFileSync(configPath) : null, configBefore, feature.name);
        assert.deepStrictEqual(fs.readFileSync(hooksPath), hooksBefore, feature.name);
      });
    }
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

  test("a configured Codex surface remains read-only until an explicit selfcheck", () => {
    project(codexConfig, (root) => {
      assert.deepStrictEqual(run(root).providers.codex, { configured: true, self_tested: false, receipt: "unknown", health: "unknown" });
      assert.deepStrictEqual(run(root, true, true).providers.codex, { configured: true, self_tested: false, receipt: "unknown", health: "failed", diagnostic: "Codex hook selfcheck failed" });
    });
  });

  test("a successful Codex selfcheck invokes every canonical script and no user hook", () => {
    project((dir) => {
      const userHookMarker = path.join(dir, "user-hook-marker.txt");
      const hooks = codexHooks(dir);
      hooks.hooks.Stop.push({ matcher: "UserTool", hooks: [{ type: "command", command: `node \"${path.join(dir, "user-hook.js")}\"` }] });
      codexConfig(dir, { hooks });
      fs.writeFileSync(path.join(dir, "user-hook.js"), `require("node:fs").writeFileSync(${JSON.stringify(userHookMarker)}, "ran");`, "utf-8");
      selfcheckHooks(dir);
    }, (root) => {
      assert.deepStrictEqual(run(root).providers.codex, { configured: true, self_tested: false, receipt: "unknown", health: "unknown" });
      assert.strictEqual(fs.existsSync(path.join(root, "selfcheck-calls.txt")), false);
      const providers = run(root, true, true).providers;
      assert.deepStrictEqual(providers.codex, { configured: true, self_tested: true, receipt: "unknown", health: "self-tested" });
      assert.deepStrictEqual(providers.claude, { configured: false, self_tested: false, receipt: "unknown", health: "unknown" });
      assert.deepStrictEqual(fs.readFileSync(path.join(root, "selfcheck-calls.txt"), "utf-8").trim().split("\n"), codexHookScripts);
      assert.strictEqual(fs.existsSync(path.join(root, "user-hook-marker.txt")), false);
    });
  });

  test("README documents read-only inspection and explicit Codex selfcheck", () => {
    const readme = fs.readFileSync(path.join(import.meta.dirname, "..", "README.md"), "utf-8");
    assert.match(readme, /node scripts\/openwolf-check\.mjs --selfcheck/);
    assert.match(readme, /default.*read-only/i);
    assert.match(readme, /configured.*self-tested.*active/i);
  });

  test("Codex receipt claims never promote health through selfchecks", () => {
    const active = project((dir) => {
      codexConfig(dir);
      receipts(dir, [{ ended: "2000-01-01T00:00:00Z", status: "confirmed", provider: "codex" }]);
      selfcheckHooks(dir);
    }, (root) => run(root, true, true)).providers.codex;
    assert.deepStrictEqual(active, { configured: true, self_tested: true, receipt: "unknown", health: "self-tested" });

    const selfcheckFailure = project((dir) => {
      codexConfig(dir);
      receipts(dir, [{ ended: "2000-01-01T00:00:00Z", status: "confirmed", provider: "codex" }]);
      selfcheckHooks(dir, { fail: "post-bash.js" });
    }, (root) => run(root, true, true)).providers.codex;
    assert.strictEqual(selfcheckFailure.health, "failed", "a selfcheck failure remains independently authoritative");

    const recovered = project((dir) => {
      codexConfig(dir);
      receipts(dir, [
        { ended: "2000-01-01T00:00:00Z", status: "failed", provider: "codex" },
        { ended: "2000-01-01T01:00:00Z", status: "confirmed", provider: "codex" },
      ]);
    }, (root) => run(root, true, true)).providers.codex;
    assert.strictEqual(recovered.health, "failed", "a configured Codex surface still fails when its canonical hooks are unavailable");
  });

  test("only exact Claude delivery tuples are receipt authority", () => {
    const codexMutants = [
      { provider: "codex", status: "confirmed", variant: "claude_attachment" },
      { provider: "codex", status: "failed", variant: "claude_attachment" },
      { provider: "codex", status: "confirmed", variant: "unavailable" },
      { provider: "codex", status: "failed", variant: "invented" },
      { provider: "codex", status: "confirmed", variant: 1 },
    ];
    for (const evidence of codexMutants) {
      const providers = project((dir) => { codexConfig(dir); receipts(dir, [{ ended: "2026-09-01T00:00:00Z", ...evidence }]); }, run).providers;
      assert.strictEqual(providers.codex.receipt, "unknown", JSON.stringify(evidence));
    }

    const invalidClaude = [
      { provider: "claude", status: "confirmed", variant: "unavailable" },
      { provider: "claude", status: "failed", variant: "invented" },
      { provider: "claude", status: "confirmed", variant: "claude_attachment", hooks_fired: -1 },
      { provider: "claude", status: "failed", variant: "claude_attachment", hooks_failed: "1" },
      { provider: "unknown", status: "confirmed", variant: "claude_attachment" },
    ];
    for (const evidence of invalidClaude) {
      const providers = project((dir) => { receipts(dir, [{ ended: "2026-09-01T00:00:00Z", ...evidence }]); }, run).providers;
      assert.strictEqual(providers.claude.health, "unknown", JSON.stringify(evidence));
    }

    const malformedReceipts = [
      { name: "empty legacy map", verified: { hooks_fired: 1, hooks_failed: 0, injections_delivered: 0, injection_tokens_delivered: 0, per_hook: {} } },
      { name: "fired sum mismatch", verified: { hooks_fired: 2, hooks_failed: 0, injections_delivered: 0, injection_tokens_delivered: 0, per_hook: { "session-start.js": { fired: 1, failed: 0, last_exit: 0 } } } },
      { name: "failed sum mismatch", verified: { hooks_fired: 1, hooks_failed: 1, injections_delivered: 0, injection_tokens_delivered: 0, per_hook: { "session-start.js": { fired: 1, failed: 0, last_exit: 0 } } } },
      { name: "zero-fired entry", verified: { hooks_fired: 1, hooks_failed: 0, injections_delivered: 0, injection_tokens_delivered: 0, per_hook: { "session-start.js": { fired: 1, failed: 0, last_exit: 0 }, "post-read.js": { fired: 0, failed: 0, last_exit: 0 } } } },
      { name: "nonzero exit without failure", verified: { hooks_fired: 1, hooks_failed: 0, injections_delivered: 0, injection_tokens_delivered: 0, per_hook: { "session-start.js": { fired: 1, failed: 0, last_exit: 1 } } } },
      { name: "failure detail names successful hook", verified: { hooks_fired: 1, hooks_failed: 1, injections_delivered: 0, injection_tokens_delivered: 0, per_hook: { "session-start.js": { fired: 1, failed: 1, last_exit: 1 } }, last_failure: { hook: "post-read.js", stderr_head: "failure" } } },
      { name: "unbounded failure detail", verified: { hooks_fired: 1, hooks_failed: 1, injections_delivered: 0, injection_tokens_delivered: 0, per_hook: { "session-start.js": { fired: 1, failed: 1, last_exit: 1 } }, last_failure: { hook: "session-start.js", stderr_head: "x".repeat(201) } } },
    ];
    for (const evidence of malformedReceipts) {
      const providers = project((dir) => { receipts(dir, [{ ended: "2026-09-01T00:00:00Z", verified: evidence.verified }]); }, run).providers;
      assert.strictEqual(providers.claude.health, "unknown", evidence.name);
      assert.strictEqual(providers.codex.health, "unknown", evidence.name);
    }

    const legacy = project((dir) => {
      receipts(dir, [{ ended: "2026-09-01T00:00:00Z", verified: {
        hooks_fired: 1, hooks_failed: 0, injections_delivered: 0, injection_tokens_delivered: 0,
        per_hook: { "session-start.js": { fired: 1, failed: 0, last_exit: 0 } },
      } }]);
    }, run).providers;
    assert.strictEqual(legacy.claude.health, "active");
    assert.strictEqual(legacy.codex.health, "unknown");

    const historicalFailure = project((dir) => {
      receipts(dir, [{ ended: "2026-09-01T00:00:00Z", status: "failed", hooks_fired: 2, hooks_failed: 1, per_hook: { "session-start.js": { fired: 2, failed: 1, last_exit: 0 } }, last_failure: { hook: "session-start.js", stderr_head: "earlier failure" } }]);
    }, run).providers;
    assert.strictEqual(historicalFailure.claude.health, "failed", "a later per-hook success does not make historical aggregate failure evidence malformed");

    const laterValidWins = project((dir) => {
      receipts(dir, [
        { ended: "2026-09-01T02:00:00Z", provider: "codex", status: "failed", variant: "invented" },
        { ended: "2026-09-01T01:00:00Z", provider: "claude", status: "confirmed" },
      ]);
    }, run).providers;
    assert.strictEqual(laterValidWins.claude.health, "active");
  });

  test("only confirmed receipt is active and failure is not erased", () => {
    assert.strictEqual(project((dir) => { codexConfig(dir); receipt(dir, "confirmed"); }, run).providers.claude.health, "active");
    const failed = project((dir) => { codexConfig(dir); receipt(dir, "failed"); }, run).providers;
    assert.strictEqual(failed.claude.health, "failed");
    assert.strictEqual(failed.codex.health, "failed");
  });

  test("the latest valid receipt supersedes array order, with failed ties fail-closed", () => {
    const recovered = project((dir) => {
      receipts(dir, [
        { ended: "2026-09-01T00:00:00Z", status: "failed" },
        { ended: "2026-09-01T01:00:00Z", status: "confirmed" },
      ]);
    }, (root) => run(root, true, true));
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
      selfcheckHooks(dir);
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
      selfcheckHooks(dir, { omit: "post-bash.js" });
    }, (root) => run(root, true, true)).providers.codex;
    assert.strictEqual(evidence.health, "failed");
    assert.strictEqual(evidence.diagnostic, "Codex hook selfcheck failed");
    assert.doesNotMatch(JSON.stringify(evidence), /post-bash|outside|\.wolf/);
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
