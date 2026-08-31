import { test, describe } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { shouldSuggestFilter } from "../src/hooks/bash-filter.ts";

const DIST_HOOKS = path.resolve(import.meta.dirname, "..", "dist", "hooks");
const TEST_TMPDIR = process.env.OPENWOLF_TEST_TMPDIR ?? "/dev/shm";

const claudeBash = {
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  session_id: "provider-session",
  tool_input: { command: "pnpm test" },
};

const codexBash = {
  ...claudeBash,
  turn_id: "turn-18",
  model: "gpt-5",
};

function tmpProject(): string {
  const root = fs.mkdtempSync(path.join(TEST_TMPDIR, "openwolf-provider-hook-"));
  fs.mkdirSync(path.join(root, ".wolf", "hooks"), { recursive: true });
  return root;
}

function installHooks(root: string): string {
  const hooksDir = path.join(root, ".wolf", "hooks");
  for (const file of fs.readdirSync(DIST_HOOKS)) {
    if (file.endsWith(".js")) fs.copyFileSync(path.join(DIST_HOOKS, file), path.join(hooksDir, file));
  }
  fs.writeFileSync(path.join(hooksDir, "package.json"), JSON.stringify({ type: "module" }));
  return hooksDir;
}

function runHook(root: string, payload: string, provider: "claude" | "codex") {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_PROJECT_ROOT;
  env[provider === "claude" ? "CLAUDE_PROJECT_DIR" : "CODEX_PROJECT_ROOT"] = root;
  return spawnSync(process.execPath, [path.join(root, ".wolf", "hooks", "pre-bash.js")], {
    encoding: "utf-8",
    env,
    input: payload,
  });
}

function heartbeat(root: string, hook = "pre-bash"): Record<string, { consecutive_failures: number; last_ok?: string; last_error?: string }> {
  return JSON.parse(fs.readFileSync(path.join(root, ".wolf", "hooks", "_heartbeat.json"), "utf-8"))[hook];
}

describe("provider Bash boundary", () => {
  test("normalizes Claude and Codex Bash fixtures before the shared policy", async () => {
    const { decodeProviderHook } = await import("../src/hooks/provider-boundary.ts");
    const root = tmpProject();
    try {
      const claude = decodeProviderHook("claude", JSON.stringify(claudeBash), root);
      const codex = decodeProviderHook("codex", JSON.stringify(codexBash), root);
      assert.ok(claude);
      assert.ok(codex);

      const policyCalls: Array<{ command: string }> = [];
      const policy = (event: { command: string }) => {
        policyCalls.push({ command: event.command });
        return shouldSuggestFilter(event.command);
      };
      assert.strictEqual(policy(claude), true);
      assert.strictEqual(policy(codex), true);
      assert.deepStrictEqual(policyCalls, [{ command: "pnpm test" }, { command: "pnpm test" }]);
      assert.deepStrictEqual(
        { command: claude.command, projectRoot: claude.projectRoot },
        { command: codex.command, projectRoot: codex.projectRoot },
      );
      assert.strictEqual(claude.provider, "claude");
      assert.strictEqual(codex.provider, "codex");
      assert.ok(!("turnId" in claude));
      assert.ok(!("turnId" in codex));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("compiled hook gives equivalent one-object advisory output for Claude and Codex", () => {
    assert.ok(fs.existsSync(path.join(DIST_HOOKS, "pre-bash.js")), "run pnpm build:hooks before this test");
    const claudeRoot = tmpProject();
    const codexRoot = tmpProject();
    try {
      installHooks(claudeRoot);
      installHooks(codexRoot);
      const claude = runHook(claudeRoot, JSON.stringify(claudeBash), "claude");
      const codex = runHook(codexRoot, JSON.stringify(codexBash), "codex");
      assert.strictEqual(claude.status, 0);
      assert.strictEqual(codex.status, 0);
      assert.strictEqual(claude.stderr, "");
      assert.strictEqual(codex.stderr, "");
      assert.strictEqual(claude.stdout, codex.stdout);
      assert.strictEqual((claude.stdout.match(/\{/g) ?? []).length, 2, "stdout is one JSON object");
      const output = JSON.parse(claude.stdout);
      assert.strictEqual(output.hookSpecificOutput.hookEventName, "PreToolUse");
      assert.match(output.hookSpecificOutput.additionalContext, /OpenWolf:/);
    } finally {
      fs.rmSync(claudeRoot, { recursive: true, force: true });
      fs.rmSync(codexRoot, { recursive: true, force: true });
    }
  });

  for (const [name, payload] of [
    ["malformed JSON", "{"],
    ["unknown event", JSON.stringify({ ...claudeBash, hook_event_name: "PostToolUse" })],
    ["non-object input", "null"],
    ["non-string command", JSON.stringify({ ...claudeBash, tool_input: { command: 7 } })],
  ]) {
    test(`compiled hook passes through ${name} with a success heartbeat`, () => {
      const root = tmpProject();
      try {
        installHooks(root);
        const result = runHook(root, payload, "codex");
        assert.strictEqual(result.status, 0);
        assert.strictEqual(result.stdout, "");
        assert.strictEqual(result.stderr, "");
        const beat = heartbeat(root);
        assert.ok(beat.last_ok);
        assert.strictEqual(beat.consecutive_failures, 0);
        assert.strictEqual(beat.last_error, undefined);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("a genuine hook throw remains an advisory failure with bounded heartbeat evidence", () => {
    const root = tmpProject();
    try {
      const hooksDir = installHooks(root);
      fs.writeFileSync(
        path.join(hooksDir, "thrower.js"),
        'import { hookMain } from "./shared.js"; hookMain("thrower", () => { throw new Error("expected fixture failure"); });',
      );
      const result = spawnSync(process.execPath, [path.join(hooksDir, "thrower.js")], { encoding: "utf-8", env: { ...process.env, CODEX_PROJECT_ROOT: root } });
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, "");
      assert.strictEqual(result.stderr, "");
      const beat = heartbeat(root, "thrower");
      assert.strictEqual(beat.consecutive_failures, 1);
      assert.ok(beat.last_error);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
