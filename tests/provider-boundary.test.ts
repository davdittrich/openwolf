import { describe, test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const DIST_HOOKS = path.resolve(import.meta.dirname, "..", "dist", "hooks");
const TEST_TMPDIR = process.env.OPENWOLF_TEST_TMPDIR ?? "/dev/shm";

const patchCommand = [
  "*** Begin Patch",
  "*** Update File: src/a.ts",
  "@@",
  "-old",
  "+new",
  "*** Add File: src/b.ts",
  "+created",
  "*** Delete File: src/c.ts",
  "*** End Patch",
].join("\n");

function projectRoot(): string {
  const root = fs.mkdtempSync(path.join(TEST_TMPDIR, "openwolf-provider-boundary-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  return root;
}

function relativePath(root: string, target: string): string | null {
  const relative = path.relative(root, path.resolve(root, target)).replace(/\\/g, "/");
  return relative === "" || relative === ".." || relative.startsWith("../") ? null : relative;
}

function installCompiledHooks(root: string): void {
  const hooksDir = path.join(root, ".wolf", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const file of fs.readdirSync(DIST_HOOKS)) {
    if (file.endsWith(".js")) fs.copyFileSync(path.join(DIST_HOOKS, file), path.join(hooksDir, file));
  }
  fs.writeFileSync(path.join(hooksDir, "package.json"), JSON.stringify({ type: "module" }));
}

describe("provider hook boundary", () => {
  test("normalizes only documented provider fields and preserves tri-state authority", async () => {
    const { decodeProviderHook } = await import("../src/hooks/provider-boundary.ts");
    const root = projectRoot();
    try {
      const claudeRead = decodeProviderHook("claude", JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        session_id: "session-1",
        agent_id: "subagent-1",
        tool_input: { file_path: "src/a.ts" },
      }), root);
      const codexPatch = decodeProviderHook("codex", JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "apply_patch",
        session_id: "session-1",
        turn_id: "turn-1",
        tool_input: { command: patchCommand },
      }), root, relativePath);

      assert.deepStrictEqual(
        claudeRead,
        {
          provider: "claude",
          eventName: "PreToolUse",
          toolName: "Read",
          command: "",
          filePath: "src/a.ts",
          sessionId: "session-1",
          projectRoot: root,
          isSubagent: true,
          variant: {},
        },
      );
      assert.deepStrictEqual(
        codexPatch,
        {
          provider: "codex",
          eventName: "PostToolUse",
          toolName: "apply_patch",
          command: patchCommand,
          affectedPaths: ["src/a.ts", "src/b.ts", "src/c.ts"],
          sessionId: "session-1",
          projectRoot: root,
          isSubagent: "unknown",
          variant: { turnId: "turn-1" },
        },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects the whole patch set for malformed, unsupported, duplicate-normalized, or external paths", async () => {
    const { extractAffectedPatchPaths } = await import("../src/hooks/provider-boundary.ts");
    const root = projectRoot();
    try {
      assert.deepStrictEqual(
        extractAffectedPatchPaths([
          "*** Begin Patch",
          "*** Update File: src/a.ts",
          "*** Update File: ./src/a.ts",
          "*** End Patch",
        ].join("\n"), root, relativePath),
        ["src/a.ts"],
      );
      for (const command of [
        "*** Begin Patch\n*** Update File: src/a.ts\n*** Update File:\n*** End Patch",
        "*** Begin Patch\n*** Update File: ../outside.ts\n*** End Patch",
        "*** Begin Patch\n*** Rename File: src/a.ts\n*** End Patch",
        "*** Begin Patch\n*** End Patch",
        "*** Begin Patch\n*** Update File: src/a.ts",
      ]) {
        assert.strictEqual(extractAffectedPatchPaths(command, root, relativePath), null, command);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps malformed Codex patches out of compiled post-write bookkeeping", () => {
    assert.ok(fs.existsSync(path.join(DIST_HOOKS, "post-write.js")), "run pnpm build:hooks before this test");
    for (const command of [
      "*** Begin Patch\n*** Update File: src/a.ts\n*** Update File:\n*** End Patch",
      "*** Begin Patch\n*** Update File: ../outside.ts\n*** End Patch",
      "*** Begin Patch\n*** Rename File: src/a.ts\n*** End Patch",
      "*** Begin Patch\n*** End Patch",
      "*** Begin Patch\n*** Update File: src/a.ts",
    ]) {
      const root = projectRoot();
      try {
        installCompiledHooks(root);
        const result = spawnSync(process.execPath, [path.join(root, ".wolf", "hooks", "post-write.js")], {
          input: JSON.stringify({
            hook_event_name: "PostToolUse",
            tool_name: "apply_patch",
            session_id: "malformed-patch",
            tool_input: { command },
          }),
          encoding: "utf-8",
          env: { ...process.env, CODEX_PROJECT_ROOT: root },
        });
        assert.strictEqual(result.status, 0, command);
        assert.strictEqual(result.stdout, "", command);
        assert.strictEqual(result.stderr, "", command);
        const heartbeat = JSON.parse(fs.readFileSync(path.join(root, ".wolf", "hooks", "_heartbeat.json"), "utf-8"));
        assert.ok(heartbeat["post-write"].last_ok, command);
        assert.ok(!fs.existsSync(path.join(root, ".wolf", "anatomy.md")), command);
        assert.ok(!fs.existsSync(path.join(root, ".wolf", "memory.md")), command);
        assert.ok(!fs.existsSync(path.join(root, ".wolf", "hooks", "sessions", "malformed-patch.json")), command);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("drives every accepted Codex patch path through the compiled post-write bookkeeping once", () => {
    assert.ok(fs.existsSync(path.join(DIST_HOOKS, "post-write.js")), "run pnpm build:hooks before this test");
    const root = projectRoot();
    try {
      installCompiledHooks(root);
      for (const file of ["src/a.ts", "src/b.ts", "src/c.ts"]) {
        fs.writeFileSync(path.join(root, file), "export {};\n");
      }
      const result = spawnSync(process.execPath, [path.join(root, ".wolf", "hooks", "post-write.js")], {
        input: JSON.stringify({
          hook_event_name: "PostToolUse",
          tool_name: "apply_patch",
          session_id: "session-1",
          tool_input: { command: patchCommand },
        }),
        encoding: "utf-8",
        env: { ...process.env, CODEX_PROJECT_ROOT: root },
      });
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, "");
      assert.strictEqual(result.stderr, "");
      const session = JSON.parse(fs.readFileSync(path.join(root, ".wolf", "hooks", "sessions", "session-1.json"), "utf-8"));
      assert.deepStrictEqual(session.files_written.map((entry: { file: string }) => entry.file), ["src/a.ts", "src/b.ts", "src/c.ts"]);
      assert.deepStrictEqual(Object.keys(session.edit_counts), ["src/a.ts", "src/b.ts", "src/c.ts"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("removes deleted and moved sources from anatomy while retaining post-write bookkeeping", () => {
    assert.ok(fs.existsSync(path.join(DIST_HOOKS, "post-write.js")), "run pnpm build:hooks before this test");
    const root = projectRoot();
    const source = path.join(root, "src", "moved.ts");
    const deleted = path.join(root, "src", "deleted.ts");
    const destination = path.join(root, "src", "destination.ts");
    const run = (command: string) => spawnSync(process.execPath, [path.join(root, ".wolf", "hooks", "post-write.js")], {
      input: JSON.stringify({
        hook_event_name: "PostToolUse",
        tool_name: "apply_patch",
        session_id: "delete-move",
        tool_input: { command },
      }),
      encoding: "utf-8",
      env: { ...process.env, CODEX_PROJECT_ROOT: root },
    });
    try {
      installCompiledHooks(root);
      fs.writeFileSync(source, "export const source = true;\n");
      fs.writeFileSync(deleted, "export const deleted = true;\n");
      const initial = run([
        "*** Begin Patch",
        "*** Update File: src/moved.ts",
        "*** Update File: src/deleted.ts",
        "*** End Patch",
      ].join("\n"));
      assert.strictEqual(initial.status, 0);

      fs.renameSync(source, destination);
      fs.unlinkSync(deleted);
      const result = run([
        "*** Begin Patch",
        "*** Delete File: src/deleted.ts",
        "*** Update File: src/moved.ts",
        "*** Move to: src/destination.ts",
        "*** End Patch",
      ].join("\n"));
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stdout, "");
      assert.strictEqual(result.stderr, "");

      const store = JSON.parse(fs.readFileSync(path.join(root, ".wolf", "anatomy-index.json"), "utf-8"));
      assert.deepStrictEqual(Object.keys(store.files), ["src/destination.ts"]);
      const session = JSON.parse(fs.readFileSync(path.join(root, ".wolf", "hooks", "sessions", "delete-move.json"), "utf-8"));
      assert.deepStrictEqual(session.files_written.map((entry: { file: string }) => entry.file), [
        "src/moved.ts", "src/deleted.ts", "src/deleted.ts", "src/moved.ts", "src/destination.ts",
      ]);
      assert.deepStrictEqual(session.edit_counts, {
        "src/moved.ts": 2,
        "src/deleted.ts": 2,
        "src/destination.ts": 1,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
