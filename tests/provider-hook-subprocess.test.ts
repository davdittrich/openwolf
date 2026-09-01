import { test, describe } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { shouldSuggestFilter } from "../src/hooks/bash-filter.ts";

const DIST_HOOKS = path.resolve(import.meta.dirname, "..", "dist", "hooks");
const DIST_AGENTS = path.resolve(import.meta.dirname, "..", "dist", "src", "agents", "index.js");
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

function runPostBash(root: string, payload: string, provider: "claude" | "codex") {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_PROJECT_ROOT;
  env[provider === "claude" ? "CLAUDE_PROJECT_DIR" : "CODEX_PROJECT_ROOT"] = root;
  return spawnSync(process.execPath, [path.join(root, ".wolf", "hooks", "post-bash.js")], {
    encoding: "utf-8",
    env,
    input: payload,
  });
}

function runPreRead(root: string, payload: string, provider: "claude" | "codex") {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CODEX_PROJECT_ROOT;
  env[provider === "claude" ? "CLAUDE_PROJECT_DIR" : "CODEX_PROJECT_ROOT"] = root;
  return spawnSync(process.execPath, [path.join(root, ".wolf", "hooks", "pre-read.js")], {
    cwd: root,
    encoding: "utf-8",
    env,
    input: payload,
  });
}

function runCompiledDenialEncoder(provider: "claude" | "codex") {
  const boundaryUrl = pathToFileURL(path.join(DIST_HOOKS, "provider-boundary.js")).href;
  const script = `import { encodeProviderResponse } from ${JSON.stringify(boundaryUrl)}; process.stdout.write(encodeProviderResponse(${JSON.stringify(provider)}, { kind: "deny", reason: "blocked" }));`;
  return spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf-8" });
}

function duplicateReadFixture(root: string): string {
  const filePath = path.join(root, "src", "a.ts");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "export const answer = 42;\n");
  fs.mkdirSync(path.join(root, ".wolf", "hooks", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(root, ".wolf", "config.json"), JSON.stringify({ openwolf: { reads: { duplicate_mode: "deny" } } }));
  fs.writeFileSync(path.join(root, ".wolf", "hooks", "sessions", "provider-session.json"), JSON.stringify({
    session_id: "provider-session",
    files_read: { "src/a.ts": { count: 1, tokens: 5, first_read: "2026-09-01T00:00:00.000Z", read_mtime: fs.statSync(filePath).mtimeMs } },
    anatomy_hits: 0,
    anatomy_misses: 0,
    repeated_reads_warned: 0,
  }));
  return JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    session_id: "provider-session",
    tool_input: { file_path: "src/a.ts" },
  });
}

async function codexAdapter(): Promise<{ install: (ctx: unknown) => unknown }> {
  assert.ok(fs.existsSync(DIST_AGENTS), "run pnpm exec tsc before this test");
  const { resolveAgents } = await import(DIST_AGENTS);
  const [adapter] = resolveAgents(["codex"]);
  return adapter;
}

function heartbeat(root: string, hook = "pre-bash"): Record<string, { consecutive_failures: number; last_ok?: string; last_error?: string }> {
  return JSON.parse(fs.readFileSync(path.join(root, ".wolf", "hooks", "_heartbeat.json"), "utf-8"))[hook];
}

describe("provider Bash boundary", () => {
  test("compiled encoder writes exact shared denial bytes for Claude and Codex", () => {
    const expected = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked"}}';
    for (const provider of ["claude", "codex"] as const) {
      const result = runCompiledDenialEncoder(provider);
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stderr, "");
      assert.strictEqual(result.stdout, expected);
    }
  });

  test("compiled Claude pre-read denies while Codex identity preserves proven/unknown authority", () => {
    const claudeRoot = tmpProject();
    const codexRoot = tmpProject();
    const codexSubagentRoot = tmpProject();
    const expectedReason = "OpenWolf: a.ts was already read this session (~5 tok) and is unchanged on disk. Reuse your earlier read, or use offset/limit for the exact lines you need. If you do need the full file again, a second attempt will pass through.";
    try {
      installHooks(claudeRoot);
      installHooks(codexRoot);
      installHooks(codexSubagentRoot);
      const claude = runPreRead(claudeRoot, duplicateReadFixture(claudeRoot), "claude");
      const codexPayload = duplicateReadFixture(codexRoot);
      const codexSession = path.join(codexRoot, ".wolf", "hooks", "sessions", "provider-session.json");
      const codexBefore = fs.readFileSync(codexSession, "utf-8");
      const codex = runPreRead(codexRoot, codexPayload, "codex");
      const codexSubagentPayload = JSON.parse(duplicateReadFixture(codexSubagentRoot));
      codexSubagentPayload.agent_id = "agent-1";
      const codexSubagent = runPreRead(codexSubagentRoot, JSON.stringify(codexSubagentPayload), "codex");
      assert.strictEqual(claude.status, 0);
      assert.strictEqual(claude.stderr, "");
      assert.deepStrictEqual(JSON.parse(claude.stdout), {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: expectedReason,
        },
      });
      assert.strictEqual(codex.status, 0);
      assert.strictEqual(codex.stdout, "");
      assert.strictEqual(codex.stderr, "");
      assert.ok(heartbeat(codexRoot, "pre-read").last_ok);
      assert.strictEqual(fs.readFileSync(codexSession, "utf-8"), codexBefore);
      assert.strictEqual(codexSubagent.status, 0);
      assert.strictEqual(codexSubagent.stderr, "");
      assert.doesNotMatch(codexSubagent.stdout, /permissionDecision/);
      assert.ok(heartbeat(codexSubagentRoot, "pre-read").last_ok);
    } finally {
      fs.rmSync(claudeRoot, { recursive: true, force: true });
      fs.rmSync(codexRoot, { recursive: true, force: true });
      fs.rmSync(codexSubagentRoot, { recursive: true, force: true });
    }
  });

  test("encodes exact denial bytes and permits Claude-only PostToolUse replacement", async () => {
    const { encodeProviderResponse } = await import("../src/hooks/provider-boundary.ts");
    const expected = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked"}}';
    assert.strictEqual(encodeProviderResponse("claude", { kind: "deny", reason: "blocked" }), expected);
    assert.strictEqual(encodeProviderResponse("codex", { kind: "deny", reason: "blocked" }), expected);

    const response = { stdout: "short", stderr: "", exitCode: 0 };
    assert.deepStrictEqual(
      JSON.parse(encodeProviderResponse("claude", { kind: "replace", toolResponse: response })),
      { hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: response } },
    );
    assert.strictEqual(encodeProviderResponse("codex", { kind: "replace", toolResponse: response }), "");
  });

  test("compiled PostToolUse preserves Claude result shape and keeps Codex replacement-only pass-through", () => {
    const claudeRoot = tmpProject();
    const codexRoot = tmpProject();
    const stdout = Array.from({ length: 600 }, (_, index) => `line ${index}`).join("\n");
    const payload = JSON.stringify({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      session_id: "provider-session",
      tool_use_id: "bash-1",
      tool_input: { command: "pnpm test" },
      tool_response: { stdout, stderr: "", exitCode: 0 },
    });
    const config = JSON.stringify({ openwolf: { bash: { governor: { mode: "replace", threshold_tokens: 1, families: { test: "replace" } } } } });
    try {
      installHooks(claudeRoot);
      installHooks(codexRoot);
      fs.writeFileSync(path.join(claudeRoot, ".wolf", "config.json"), config);
      fs.writeFileSync(path.join(codexRoot, ".wolf", "config.json"), config);
      const claude = runPostBash(claudeRoot, payload, "claude");
      const codex = runPostBash(codexRoot, payload, "codex");
      assert.strictEqual(claude.status, 0);
      assert.strictEqual(codex.status, 0);
      assert.strictEqual(claude.stderr, "");
      assert.strictEqual(codex.stderr, "");
      const claudeOutput = JSON.parse(claude.stdout);
      assert.deepStrictEqual(Object.keys(claudeOutput.hookSpecificOutput.updatedToolOutput), ["stdout", "stderr", "exitCode"]);
      assert.notStrictEqual(claudeOutput.hookSpecificOutput.updatedToolOutput.stdout, stdout);
      assert.strictEqual(codex.stdout, "");
      const claudeRecord = JSON.parse(fs.readFileSync(path.join(claudeRoot, ".wolf", "hooks", "sessions", "provider-session.json"), "utf-8")).bash_governed.at(-1);
      const codexRecord = JSON.parse(fs.readFileSync(path.join(codexRoot, ".wolf", "hooks", "sessions", "provider-session.json"), "utf-8")).bash_governed.at(-1);
      assert.strictEqual(claudeRecord.action, "replaced");
      assert.ok(claudeRecord.entered_tokens < claudeRecord.original_tokens);
      assert.strictEqual(codexRecord.action, "suggested");
      assert.strictEqual(codexRecord.entered_tokens, codexRecord.original_tokens);
    } finally {
      fs.rmSync(claudeRoot, { recursive: true, force: true });
      fs.rmSync(codexRoot, { recursive: true, force: true });
    }
  });


  test("compiled Codex apply_patch sends its normalized command through existing pre-write policy", () => {
    const root = tmpProject();
    const command = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "+// patch-signature",
      "*** End Patch",
    ].join("\n");
    try {
      installHooks(root);
      fs.writeFileSync(path.join(root, ".wolf", "cerebrum.md"), "## Do-Not-Repeat\n\n- never use \`patch-signature\`\n");
      const env = { ...process.env, CODEX_PROJECT_ROOT: root };
      const result = spawnSync(process.execPath, [path.join(root, ".wolf", "hooks", "pre-write.js")], {
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "apply_patch",
          session_id: "patch-policy",
          tool_input: { command },
        }),
        encoding: "utf-8",
        env,
      });
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stderr, "");
      const output = JSON.parse(result.stdout);
      assert.match(output.hookSpecificOutput.additionalContext, /patch-signature/);
      const session = JSON.parse(fs.readFileSync(path.join(root, ".wolf", "hooks", "sessions", "patch-policy.json"), "utf-8"));
      assert.strictEqual(session.injections.filter((entry: { type: string }) => entry.type === "cerebrum_buglog").length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("installs one Codex Bash PostToolUse hook", async () => {
    const adapter = await codexAdapter();
    const root = tmpProject();
    const templatesDir = path.join(root, "templates");
    fs.mkdirSync(templatesDir);
    try {
      adapter.install({ projectRoot: root, templatesDir });
      adapter.install({ projectRoot: root, templatesDir });
      const installed = JSON.parse(fs.readFileSync(path.join(root, ".codex", "hooks.json"), "utf-8"));
      const bashEntries = installed.hooks.PostToolUse.filter((entry: { matcher?: string }) => entry.matcher === "Bash");
      assert.strictEqual(bashEntries.length, 1);
      assert.match(bashEntries[0].hooks[0].command, /\.wolf\/hooks\/post-bash\.js/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("the production pre-Bash runner decodes, filters, and encodes each provider exactly once", async () => {
    const { runPreBash } = await import(pathToFileURL(path.join(DIST_HOOKS, "pre-bash.js")).href);
    const { decodeProviderHook, encodeProviderResponse } = await import("../src/hooks/provider-boundary.ts");
    for (const [provider, payload] of [["claude", claudeBash], ["codex", codexBash]] as const) {
      const root = tmpProject();
      const calls: Array<{ stage: string; provider?: string; command?: string; projectRoot?: string }> = [];
      try {
        const output = runPreBash(JSON.stringify(payload), provider, root, path.join(root, ".wolf"), "suggest", {
          decodeProviderHook(actualProvider, raw, projectRoot) {
            calls.push({ stage: "decoder", provider: actualProvider, projectRoot });
            return decodeProviderHook(actualProvider, raw, projectRoot);
          },
          shouldSuggestFilter(command) {
            calls.push({ stage: "policy", command });
            return shouldSuggestFilter(command);
          },
          encodeProviderResponse(actualProvider, intent) {
            calls.push({ stage: "encoder", provider: actualProvider });
            return encodeProviderResponse(actualProvider, intent);
          },
        });
        assert.deepStrictEqual(calls, [
          { stage: "decoder", provider, projectRoot: root },
          { stage: "policy", command: "pnpm test" },
          { stage: "encoder", provider },
        ]);
        assert.strictEqual(JSON.parse(output).hookSpecificOutput.hookEventName, "PreToolUse");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("the production pre-Bash runner stops malformed input after its decoder", async () => {
    const { runPreBash } = await import(pathToFileURL(path.join(DIST_HOOKS, "pre-bash.js")).href);
    const root = tmpProject();
    const calls: string[] = [];
    try {
      assert.strictEqual(runPreBash("{", "claude", root, path.join(root, ".wolf"), "suggest", {
        decodeProviderHook() { calls.push("decoder"); return null; },
        shouldSuggestFilter() { calls.push("policy"); return true; },
        encodeProviderResponse() { calls.push("encoder"); return "unexpected"; },
      }), "");
      assert.deepStrictEqual(calls, ["decoder"]);
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
