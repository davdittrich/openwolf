import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { HookProvider } from "./provider-boundary.js";
import type { LegacyDeliveryEvidence, ProviderDeliveryEvidence } from "./ledger-math.js";

export type { ProviderDeliveryEvidence } from "./ledger-math.js";

// ─────────────────────────────────────────────────────────────────────────────
// Hook delivery verification (2.2). Claude Code writes every hook invocation
// into the session transcript as a `type:"attachment"` line whose attachment
// carries { type: "hook_success" | "hook_non_blocking_error", hookName,
// hookEvent, command, exitCode, stdout, stderr }. That record is ground truth
// for three questions OpenWolf used to answer with self-reports that drifted
// up to ~20x from reality: did our hooks fire, did they fail, and did our
// injected context actually enter the conversation.
//
// The transcript JSONL format is OFFICIALLY unstable ("scripts that parse
// these files directly can break on any release"), so this module probes the
// schema before trusting a parse and returns null (verification unavailable)
// rather than wrong numbers when the format has drifted.
//
// Dependency-free (node builtins only): ships in the hook bundle and loads
// from source in tests.
// ─────────────────────────────────────────────────────────────────────────────

export interface HookVerification extends LegacyDeliveryEvidence {
  /** OpenWolf hook invocations recorded by the harness. */
}

/** Map the existing shared attribution labels into the hook transport contract. */
export function hookProviderFromAgent(agent: string): HookProvider {
  return agent === "claude" || agent === "codex" ? agent : "unknown";
}

function unavailable(provider: HookProvider): ProviderDeliveryEvidence {
  return { provider, status: "unknown", variant: "unavailable" };
}

interface AttachmentRecord {
  type?: string;
  hookName?: string;
  hookEvent?: string;
  command?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

const HOOK_ENTRY_FILES = new Set([
  "session-start.js", "user-prompt-submit.js", "pre-read.js", "pre-write.js", "pre-bash.js",
  "post-read.js", "post-write.js", "post-bash.js", "post-batch.js", "precompact.js", "stop.js", "session-end.js",
]);

function projectDirFromScriptLocation(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, "..", "..");
  return path.basename(here) === "hooks" && path.basename(path.dirname(here)) === ".wolf" && fs.existsSync(path.join(root, ".wolf")) ? root : null;
}

function currentProjectDir(): string {
  return process.env.CLAUDE_PROJECT_DIR || process.env.CODEX_PROJECT_ROOT || process.env.OPENWOLF_PROJECT_ROOT || projectDirFromScriptLocation() || process.cwd();
}

/** Return the allowed current-project hook file named by an attachment command. */
function hookFileOf(command: string | undefined): string | null {
  const match = typeof command === "string" ? command.match(/^node\s+(?:"([^"]+)"|'([^']+)'|(\S+))$/) : null;
  const candidate = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!candidate || candidate.split(/[\\/]+/).includes("..")) return null;

  const root = path.resolve(currentProjectDir());
  const hookDir = path.join(root, ".wolf", "hooks");
  const resolved = candidate.startsWith("$CLAUDE_PROJECT_DIR/")
    ? path.resolve(root, candidate.slice("$CLAUDE_PROJECT_DIR/".length))
    : path.resolve(candidate);
  const file = path.basename(resolved);
  return HOOK_ENTRY_FILES.has(file) && resolved === path.join(hookDir, file) ? file : null;
}

/**
 * Parse the transcript and reconcile OpenWolf hook activity. Returns null
 * when the transcript is unreadable or the line format fails the schema
 * probe — callers must then present self-reported numbers as estimates.
 */
export function verifyHookDelivery(transcriptPath: string): HookVerification | null;
export function verifyHookDelivery(provider: HookProvider, transcriptPath: string): ProviderDeliveryEvidence;
export function verifyHookDelivery(providerOrTranscriptPath: string, transcriptPath?: string): HookVerification | ProviderDeliveryEvidence | null {
  if (transcriptPath === undefined) return readHookDelivery(providerOrTranscriptPath);
  const provider = providerOrTranscriptPath as HookProvider;
  // Codex documents hook transport, not a stable receipt artifact. Never parse
  // Claude's private transcript shape for it.
  if (provider !== "claude") return unavailable(provider);
  const verified = readHookDelivery(transcriptPath);
  if (!verified || verified.hooks_fired === 0) return unavailable(provider);
  return {
    ...verified,
    provider,
    status: verified.hooks_failed > 0 ? "failed" : "confirmed",
    variant: "claude_attachment",
  };
}

function readHookDelivery(transcriptPath: string): HookVerification | null {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf-8");
  } catch {
    return null;
  }

  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;

  // Schema probe: the format is declared unstable, so verify the envelope
  // still looks like what we expect before trusting any counts.
  let parsed = 0;
  let probed = 0;
  const records: AttachmentRecord[] = [];
  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
      parsed++;
    } catch {
      continue;
    }
    if (probed < 20) {
      probed++;
      if (typeof entry !== "object" || entry === null || typeof entry.type !== "string") {
        return null;
      }
    }
    if (entry.type === "attachment" && entry.attachment && typeof entry.attachment === "object") {
      records.push(entry.attachment as AttachmentRecord);
    }
  }
  if (parsed < lines.length * 0.5) return null;

  const result: HookVerification = {
    hooks_fired: 0,
    hooks_failed: 0,
    injections_delivered: 0,
    injection_tokens_delivered: 0,
    per_hook: {},
  };

  for (const att of records) {
    const isHookRecord = att.type === "hook_success" || att.type === "hook_non_blocking_error" || att.type === "hook_failure";
    const hook = isHookRecord ? hookFileOf(att.command) : null;
    if (!hook) continue;

    const entry = result.per_hook[hook] ?? (result.per_hook[hook] = { fired: 0, failed: 0, last_exit: 0 });
    result.hooks_fired++;
    entry.fired++;
    const exit = typeof att.exitCode === "number" ? att.exitCode : 0;
    entry.last_exit = exit;
    if (exit !== 0 || att.type !== "hook_success") {
      result.hooks_failed++;
      entry.failed++;
      result.last_failure = { hook, stderr_head: (att.stderr ?? "").slice(0, 200) };
    }

    // Delivered injection: the harness recorded our stdout, and it carried
    // an additionalContext payload (which the harness inserts into context).
    if (typeof att.stdout === "string" && att.stdout.includes("additionalContext")) {
      try {
        const out = JSON.parse(att.stdout);
        const ctx = out?.hookSpecificOutput?.additionalContext;
        if (typeof ctx === "string" && ctx.length > 0) {
          result.injections_delivered++;
          result.injection_tokens_delivered += Math.ceil(ctx.length / 4);
        }
      } catch {}
    }
  }

  return result;
}
