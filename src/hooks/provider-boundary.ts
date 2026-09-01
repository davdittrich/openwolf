import * as path from "node:path";

export type HookProvider = "claude" | "codex" | "unknown";
export type SubagentAuthority = true | false | "unknown";
export type ProjectPathResolver = (root: string, target: string) => string | null;

export interface NormalizedHookEvent {
  provider: "claude" | "codex";
  eventName: "PreToolUse" | "PostToolUse";
  toolName: "Bash" | "Read" | "apply_patch";
  /** Empty only for Read, whose provider payload has no command. */
  command: string;
  filePath?: string;
  affectedPaths?: string[];
  sessionId?: string;
  projectRoot: string;
  isSubagent: SubagentAuthority;
  variant: { turnId?: string };
}

export type ProviderResponseIntent =
  | { kind: "pass" }
  | { kind: "advisory"; text: string; eventName?: "PreToolUse" | "PostToolUse" }
  | { kind: "deny"; reason: string }
  | { kind: "replace"; toolResponse: Record<string, unknown>; additionalContext?: string };

const MAX_PATCH_BYTES = 1024 * 1024;
const PATCH_START = "*** Begin Patch";
const PATCH_END = "*** End Patch";
const PATCH_HEADER = /^\*\*\* (Add|Update|Delete) File: ([^\r\n]+)$/;
const PATCH_MOVE = /^\*\*\* Move to: ([^\r\n]+)$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function claudeAuthority(event: Record<string, unknown>): SubagentAuthority {
  if (!("agent_id" in event)) return false;
  return typeof event.agent_id === "string" && event.agent_id.length > 0 ? true : "unknown";
}

function codexAuthority(event: Record<string, unknown>): SubagentAuthority {
  return typeof event.agent_id === "string" && event.agent_id.trim().length > 0 ? true : "unknown";
}

function normalizePatchPath(rawPath: string, projectRoot: string, resolvePath: ProjectPathResolver): string | null {
  if (!rawPath || rawPath.includes("\0") || path.isAbsolute(rawPath)) return null;
  const parts = rawPath.replace(/\\/g, "/").split("/");
  if (parts.some((part) => part === ".." || part === "")) return null;
  const normalized = resolvePath(projectRoot, rawPath);
  return normalized === null || normalized === "" ? null : normalized;
}

/** Extract a complete, containment-checked path set or nothing. */
export function extractAffectedPatchPaths(
  command: string,
  projectRoot: string,
  resolvePath?: ProjectPathResolver,
): string[] | null {
  if (!resolvePath || !projectRoot || command.length === 0 || Buffer.byteLength(command, "utf8") > MAX_PATCH_BYTES) return null;
  const lines = command.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "").replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== PATCH_START || lines.at(-1) !== PATCH_END) return null;

  const paths: string[] = [];
  let pendingMove = false;
  for (const line of lines.slice(1, -1)) {
    const header = line.match(PATCH_HEADER);
    if (header) {
      const normalized = normalizePatchPath(header[2], projectRoot, resolvePath);
      if (normalized === null) return null;
      paths.push(normalized);
      pendingMove = header[1] === "Update";
      continue;
    }
    const move = line.match(PATCH_MOVE);
    if (move) {
      if (!pendingMove) return null;
      const normalized = normalizePatchPath(move[1], projectRoot, resolvePath);
      if (normalized === null) return null;
      paths.push(normalized);
      pendingMove = false;
      continue;
    }
    if (line.startsWith("*** ")) return null;
    pendingMove = false;
  }
  if (paths.length === 0) return null;
  return [...new Set(paths)];
}

/** Decode only documented provider fields into the one shared transport seam. */
export function decodeProviderHook(
  provider: HookProvider,
  raw: string,
  projectRoot: string,
  resolvePath?: ProjectPathResolver,
): NormalizedHookEvent | null {
  if (provider === "unknown" || !projectRoot) return null;

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }
  const event = record(input);
  if (event === null) return null;
  const toolInput = record(event?.tool_input);
  const toolName = event?.tool_name;
  const eventName = event?.hook_event_name;
  if (
    (eventName !== "PreToolUse" && eventName !== "PostToolUse") ||
    (toolName !== "Bash" && toolName !== "Read" && toolName !== "apply_patch")
  ) return null;
  if (toolName !== "apply_patch" && eventName !== "PreToolUse") return null;

  const base = {
    provider,
    eventName,
    toolName,
    sessionId: typeof event.session_id === "string" ? event.session_id : undefined,
    projectRoot,
    isSubagent: provider === "claude" ? claudeAuthority(event) : codexAuthority(event),
    variant: provider === "codex" && typeof event.turn_id === "string" ? { turnId: event.turn_id } : {},
  } as const;

  if (toolName === "Read") {
    const filePath = typeof toolInput?.file_path === "string"
      ? toolInput.file_path
      : typeof toolInput?.path === "string" ? toolInput.path : null;
    return filePath === null ? null : { ...base, command: "", filePath };
  }

  if (typeof toolInput?.command !== "string") return null;
  if (toolName === "apply_patch") {
    if (provider !== "codex") return null;
    const affectedPaths = extractAffectedPatchPaths(toolInput.command, projectRoot, resolvePath);
    return affectedPaths === null ? null : { ...base, command: toolInput.command, affectedPaths };
  }
  return { ...base, command: toolInput.command };
}

/** Encode only the PreToolUse responses both providers currently support. */
export function encodeProviderResponse(provider: HookProvider, intent: ProviderResponseIntent): string {
  if (provider === "unknown" || intent.kind === "pass") return "";
  if (intent.kind === "replace") {
    if (provider === "claude") {
      const hookSpecificOutput: Record<string, unknown> = { hookEventName: "PostToolUse" };
      if (intent.additionalContext) hookSpecificOutput.additionalContext = intent.additionalContext;
      hookSpecificOutput.updatedToolOutput = intent.toolResponse;
      return JSON.stringify({ hookSpecificOutput });
    }
    return intent.additionalContext
      ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: intent.additionalContext } })
      : "";
  }
  const hookSpecificOutput = intent.kind === "deny"
    ? { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: intent.reason }
    : { hookEventName: intent.eventName ?? "PreToolUse", additionalContext: intent.text };
  return JSON.stringify({ hookSpecificOutput });
}
