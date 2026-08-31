export type HookProvider = "claude" | "codex" | "unknown";

export interface NormalizedHookEvent {
  provider: "claude" | "codex";
  eventName: "PreToolUse";
  toolName: "Bash";
  command: string;
  sessionId?: string;
  projectRoot: string;
  variant: { turnId?: string };
}

export type ProviderResponseIntent =
  | { kind: "pass" }
  | { kind: "advisory"; text: string }
  | { kind: "deny"; reason: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Decode only the documented PreToolUse[Bash] overlap into trusted local data. */
export function decodeProviderHook(
  provider: HookProvider,
  raw: string,
  projectRoot: string,
): NormalizedHookEvent | null {
  if (provider === "unknown" || !projectRoot) return null;

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }
  const event = record(input);
  const toolInput = record(event?.tool_input);
  if (
    event?.hook_event_name !== "PreToolUse" ||
    event.tool_name !== "Bash" ||
    typeof toolInput?.command !== "string"
  ) return null;

  return {
    provider,
    eventName: "PreToolUse",
    toolName: "Bash",
    command: toolInput.command,
    sessionId: typeof event.session_id === "string" ? event.session_id : undefined,
    projectRoot,
    variant: provider === "codex" && typeof event.turn_id === "string" ? { turnId: event.turn_id } : {},
  };
}

/** Encode only the PreToolUse responses both providers currently support. */
export function encodeProviderResponse(provider: HookProvider, intent: ProviderResponseIntent): string {
  if (provider === "unknown" || intent.kind === "pass") return "";
  const hookSpecificOutput = intent.kind === "deny"
    ? {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: intent.reason,
      }
    : { hookEventName: "PreToolUse", additionalContext: intent.text };
  return JSON.stringify({ hookSpecificOutput });
}
