import * as path from "node:path";
import { parse } from "smol-toml";

export type CodexHooksFeatureState = "enabled" | "disabled" | "ambiguous";

const MAX_CONFIG_BYTES = 1024 * 1024;

/** Render the provider command once so installation and inspection cannot drift. */
export function renderCodexHookCommand(projectRoot: string, script: string): string {
  return `node "${path.join(projectRoot, ".wolf", "hooks", script).replace(/\\/g, "/")}"`;
}

/** Read the effective [features] hooks fact without changing user-owned TOML. */
export function parseCodexHooksFeature(config: string | null): CodexHooksFeatureState {
  if (config === null) return "enabled";
  if (Buffer.byteLength(config, "utf-8") > MAX_CONFIG_BYTES) return "ambiguous";

  let document: Record<string, unknown>;
  try {
    document = parse(config);
  } catch {
    return "ambiguous";
  }
  const features = document.features;
  if (features === undefined) return "enabled";
  if (features === null || typeof features !== "object" || Array.isArray(features)) return "ambiguous";

  const { hooks: canonical, codex_hooks: alias } = features as Record<string, unknown>;
  if ((canonical !== undefined && typeof canonical !== "boolean") ||
      (alias !== undefined && typeof alias !== "boolean") ||
      (typeof canonical === "boolean" && typeof alias === "boolean" && canonical !== alias)) return "ambiguous";
  return (canonical ?? alias ?? true) ? "enabled" : "disabled";
}
