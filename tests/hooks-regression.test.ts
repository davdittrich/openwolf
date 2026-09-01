import { test, describe } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { countSemanticEntries } from "../src/hooks/shared.ts";

const tmpWolfDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "wolf-hooks-"));

function writeMemory(wolfDir: string, lines: string[]): void {
  fs.writeFileSync(path.join(wolfDir, "memory.md"), lines.join("\n"), "utf-8");
}

describe("countSemanticEntries (#62, #68)", () => {
  test("counts documented HH:MM semantic rows under the session heading", () => {
    const dir = tmpWolfDir();
    writeMemory(dir, [
      "# memory.md",
      "",
      "## Session: 2026-07-24 15:02",
      "",
      "| Time | Action | File(s) | Outcome | ~Tokens |",
      "|------|--------|---------|---------|--------|",
      "| 15:10 | Edited src/a.ts | inline fix | ~200 |",
      "| 15:40 | did the thing | a.ts, b.ts | done | ~2k |",
    ]);
    assert.strictEqual(countSemanticEntries(dir), 1);
  });

  test("mechanical-only rows count as zero", () => {
    const dir = tmpWolfDir();
    writeMemory(dir, [
      "## Session: 2026-07-24 15:02",
      "",
      "| Time | Action | File(s) | Outcome | ~Tokens |",
      "|------|--------|---------|---------|--------|",
      "| 15:10 | Created src/a.ts | — | ~200 |",
      "| 15:12 | Multi-edited src/b.ts | — | ~90 |",
      "| 15:50 | Session end: 2 writes across 2 files (a.ts, b.ts) | 3 reads | ~1200 tok |",
    ]);
    assert.strictEqual(countSemanticEntries(dir), 0);
  });

  test("a session crossing midnight still counts its own entries", () => {
    const dir = tmpWolfDir();
    writeMemory(dir, [
      "## Session: 2026-01-01 09:00",
      "",
      "| 09:15 | old session summary | x.ts | done | ~1k |",
      "",
      "## Session: 2026-08-05 22:58",
      "",
      "| Time | Action | File(s) | Outcome | ~Tokens |",
      "|------|--------|---------|---------|--------|",
      "| 23:59 | Edited src/a.ts | inline fix | ~200 |",
      "| 00:05 | fixed the hook loading order | a.ts | done | ~800 |",
    ]);
    assert.strictEqual(countSemanticEntries(dir), 1);
  });

  test("older sessions' semantic rows are not counted for the current session", () => {
    const dir = tmpWolfDir();
    writeMemory(dir, [
      "## Session: 2026-08-01 09:00",
      "",
      "| 09:15 | wrote a great summary | x.ts | done | ~1k |",
      "",
      "## Session: 2026-08-05 10:00",
      "",
      "| Time | Action | File(s) | Outcome | ~Tokens |",
      "|------|--------|---------|---------|--------|",
      "| 10:10 | Edited src/a.ts | inline fix | ~200 |",
    ]);
    assert.strictEqual(countSemanticEntries(dir), 0);
  });

  test("file with no session heading falls back to counting all semantic rows", () => {
    const dir = tmpWolfDir();
    writeMemory(dir, [
      "| 15:10 | Edited src/a.ts | inline fix | ~200 |",
      "| 15:40 | refactored the parser | a.ts | done | ~2k |",
    ]);
    assert.strictEqual(countSemanticEntries(dir), 1);
  });

  test("missing memory.md returns zero", () => {
    assert.strictEqual(countSemanticEntries(tmpWolfDir()), 0);
  });
});

describe("hook install completeness (#68)", () => {
  const hooksSrcDir = path.join(import.meta.dirname, "..", "src", "hooks");

  function extractHookFileLists(cliFile: string): string[][] {
    const source = fs.readFileSync(
      path.join(import.meta.dirname, "..", "src", "cli", cliFile),
      "utf-8"
    );
    const lists: string[][] = [];
    for (const m of source.matchAll(/const (?:hookFiles|HOOK_FILES) = \[([\s\S]*?)\]/g)) {
      const names = [...m[1].matchAll(/"([^"]+\.js)"/g)].map((x) => x[1]);
      if (names.length > 0) lists.push(names);
    }
    return lists;
  }

  function relativeImportsOf(hookTsFile: string): string[] {
    const source = fs.readFileSync(path.join(hooksSrcDir, hookTsFile), "utf-8");
    return [...source.matchAll(/from\s+"\.\/([\w-]+)\.js"/g)].map((m) => `${m[1]}.js`);
  }

  // init.ts, update.ts, and status.ts all consume the shared manifest;
  // hook-manifest.ts is the single list that must stay complete.
  for (const cliFile of ["hook-manifest.ts"]) {
    test(`every file imported by an installed hook is listed in ${cliFile}`, () => {
      const lists = extractHookFileLists(cliFile);
      assert.ok(lists.length > 0, `no hookFiles list found in ${cliFile}`);
      for (const list of lists) {
        for (const hookJs of list) {
          const hookTs = hookJs.replace(/\.js$/, ".ts");
          const srcPath = path.join(hooksSrcDir, hookTs);
          assert.ok(fs.existsSync(srcPath), `${hookTs} missing from src/hooks/`);
          for (const imported of relativeImportsOf(hookTs)) {
            assert.ok(
              list.includes(imported),
              `${hookJs} imports ${imported}, which is missing from the hookFiles list in ${cliFile}`
            );
          }
        }
      }
    });
  }

  for (const cliFile of ["init.ts", "update.ts", "status.ts"]) {
    test(`${cliFile} consumes the shared hook manifest`, () => {
      const source = fs.readFileSync(
        path.join(import.meta.dirname, "..", "src", "cli", cliFile),
        "utf-8"
      );
      assert.ok(
        source.includes('from "./hook-manifest.js"'),
        `${cliFile} must import HOOK_SETTINGS/HOOK_FILES from hook-manifest.ts`
      );
      assert.ok(
        !/const hookFiles = \[/.test(source),
        `${cliFile} must not carry its own hookFiles list`
      );
    });
  }
});

describe("Codex installed hook documentation (#18)", () => {
  const root = path.join(import.meta.dirname, "..");
  const codexAdapter = fs.readFileSync(path.join(root, "src", "agents", "codex.ts"), "utf-8");
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf-8");
  const codexDocs = readme.match(/## Codex hook coverage[\s\S]*?(?=\n## |$)/)?.[0] ?? "";

  test("README names the lifecycle surface buildCodexHooks installs", () => {
    for (const [event, matcher, script] of [
      ["SessionStart", "startup|resume|clear|compact", "session-start.js"],
      ["PreToolUse", "Read", "pre-read.js"],
      ["PreToolUse", "Edit|Write|MultiEdit|apply_patch", "pre-write.js"],
      ["PreToolUse", "Bash", "pre-bash.js"],
      ["PostToolUse", "Read", "post-read.js"],
      ["PostToolUse", "Edit|Write|MultiEdit|apply_patch", "post-write.js"],
      ["PostToolUse", "Bash", "post-bash.js"],
      ["PreCompact", "", "precompact.js"],
      ["Stop", "", "stop.js"],
    ]) {
      assert.ok(codexAdapter.includes(`matcher: "${matcher}"`) && codexAdapter.includes(`"${script}"`), `${event} ${matcher} must install ${script}`);
    }
    assert.match(codexDocs, /Codex hook coverage/i);
    assert.match(codexDocs, /SessionStart.*Read.*apply_patch.*Bash.*PreCompact.*Stop/is);
  });

  test("README preserves Codex Bash and receipt authority limits", () => {
    assert.match(codexDocs, /Codex.*PostToolUse.*Bash.*advisory.*pass-through/is);
    assert.doesNotMatch(codexDocs, /Codex.*Bash.*replacement/is);
    assert.doesNotMatch(codexDocs, /Codex.*Bash.*savings authority/is);
    assert.match(codexDocs, /no documented Codex delivery receipt/i);
    assert.match(codexDocs, /selfcheck.*self-tested.*not.*active/is);
  });
});
