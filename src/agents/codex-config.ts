export type CodexHooksFeatureState = "enabled" | "disabled" | "ambiguous";

/** Read the effective [features] hooks fact without changing user-owned TOML. */
export function parseCodexHooksFeature(config: string | null): CodexHooksFeatureState {
  if (config === null) return "enabled";

  let section = "";
  let malformed = false;
  const values = new Map<string, boolean>();

  for (const rawLine of config.split(/\r?\n/)) {
    const trimmed = rawLine.replace(/\s+#.*$/, "").trim();
    if (!trimmed) continue;
    const header = trimmed.match(/^\[([A-Za-z0-9_-]+)\]$/);
    if (header) {
      section = header[1];
      continue;
    }
    if (trimmed.startsWith("[")) {
      malformed = true;
      continue;
    }
    if (section !== "features") continue;
    const assignment = trimmed.match(/^(hooks|codex_hooks)\s*=\s*(.*?)$/);
    if (!assignment) continue;
    if (assignment[2] !== "true" && assignment[2] !== "false") {
      malformed = true;
      continue;
    }
    if (values.has(assignment[1])) {
      malformed = true;
      continue;
    }
    values.set(assignment[1], assignment[2] === "true");
  }

  const canonical = values.get("hooks");
  const alias = values.get("codex_hooks");
  if (malformed || (canonical !== undefined && alias !== undefined && canonical !== alias)) return "ambiguous";
  return (canonical ?? alias ?? true) ? "enabled" : "disabled";
}
