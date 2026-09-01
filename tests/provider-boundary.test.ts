import { describe, test } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openwolf-provider-boundary-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  return root;
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
      }), root);

      assert.deepStrictEqual(
        claudeRead,
        {
          provider: "claude",
          eventName: "PreToolUse",
          toolName: "Read",
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
        ].join("\n"), root),
        ["src/a.ts"],
      );
      for (const command of [
        "*** Begin Patch\n*** Update File: src/a.ts\n*** Update File:\n*** End Patch",
        "*** Begin Patch\n*** Update File: ../outside.ts\n*** End Patch",
        "*** Begin Patch\n*** Rename File: src/a.ts\n*** End Patch",
        "*** Begin Patch\n*** End Patch",
        "*** Begin Patch\n*** Update File: src/a.ts",
      ]) {
        assert.strictEqual(extractAffectedPatchPaths(command, root), null, command);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
