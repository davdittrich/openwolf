#!/usr/bin/env node
/**
 * openwolf-check — standalone, zero-dependency, read-only.
 *
 * Run from a project root (or pass a path) to see whether OpenWolf is
 * installed there, which agents are wired, when it was last used, and what
 * it did. Works without OpenWolf installed — it only reads files.
 *
 *   node openwolf-check.mjs [projectDir] [--json] [--selfcheck]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseCodexHooksFeature, renderCodexHookCommand } from "../dist/src/agents/codex-config.js";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const selfcheckRequested = args.includes("--selfcheck");
const root = path.resolve(args.find((a) => !a.startsWith("--")) ?? ".");
const wolfDir = path.join(root, ".wolf");

const read = (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; } };
const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } };
const exists = (p) => fs.existsSync(p);

function ago(ms) {
  if (ms == null) return "never";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ── Installed? ───────────────────────────────────────────────────────────────
const report = { root, installed: exists(wolfDir) };
if (!report.installed) {
  if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(1); }
  console.log(`\n  openwolf-check — ${root}`);
  console.log(`  ✗ No .wolf/ directory: OpenWolf is not initialized here.\n`);
  process.exit(1);
}

// ── Generation + hooks ──────────────────────────────────────────────────────
const hookFiles = (() => { try { return fs.readdirSync(path.join(wolfDir, "hooks")).filter((f) => f.endsWith(".js")); } catch { return []; } })();
report.hooks = hookFiles;
report.generation = hookFiles.includes("precompact.js") ? "2.x" : hookFiles.length > 0 ? "1.x" : "unknown";

// ── Which agents are wired ──────────────────────────────────────────────────
const cfg = readJson(path.join(wolfDir, "config.json"));
const settings = read(path.join(root, ".claude", "settings.json")) ?? "";
const agents = {
  claude: settings.includes(".wolf/hooks/"),
  codex: exists(path.join(root, ".codex", "hooks.json")),
  opencode: exists(path.join(root, ".opencode", "plugin", "openwolf.ts")),
  gemini: (read(path.join(root, "GEMINI.md")) ?? "").includes("openwolf:begin"),
  cursor: exists(path.join(root, ".cursor", "rules", "openwolf.mdc")),
};
report.agentsWired = Object.entries(agents).filter(([, v]) => v).map(([k]) => k);
report.agentsInConfig = cfg?.openwolf?.agents ?? null;
report.skills = ["security-audit", "reframe"].filter((s) => exists(path.join(root, ".claude", "commands", `${s}.md`)));

function configuredClaude() {
  const parsed = readJson(path.join(root, ".claude", "settings.json"));
  return hasGeneratedHookSurface(parsed, claudeHookSurface);
}

const claudeHookSurface = [
  ["SessionStart", "", "session-start.js"],
  ["UserPromptSubmit", "", "user-prompt-submit.js"],
  ["PreToolUse", "Read", "pre-read.js"],
  ["PreToolUse", "Write|Edit|MultiEdit", "pre-write.js"],
  ["PreToolUse", "Bash", "pre-bash.js"],
  ["PostToolUse", "Read", "post-read.js"],
  ["PostToolUse", "Write|Edit|MultiEdit", "post-write.js"],
  ["PostToolUse", "Bash", "post-bash.js"],
  ["PostToolBatch", "", "post-batch.js"],
  ["PreCompact", "", "precompact.js"],
  ["Stop", "", "stop.js"],
  ["SessionEnd", "", "session-end.js"],
];

const codexHookSurface = [
  ["SessionStart", "startup|resume|clear|compact", "session-start.js"],
  ["PreToolUse", "Read", "pre-read.js"],
  ["PreToolUse", "Edit|Write|MultiEdit|apply_patch", "pre-write.js"],
  ["PreToolUse", "Bash", "pre-bash.js"],
  ["PostToolUse", "Read", "post-read.js"],
  ["PostToolUse", "Edit|Write|MultiEdit|apply_patch", "post-write.js"],
  ["PostToolUse", "Bash", "post-bash.js"],
  ["PreCompact", "", "precompact.js"],
  ["Stop", "", "stop.js"],
];

function configuredCodex() {
  const parsed = readJson(path.join(root, ".codex", "hooks.json"));
  const configPath = path.join(root, ".codex", "config.toml");
  const config = read(configPath);
  if (exists(configPath) && config === null) return false;
  return parseCodexHooksFeature(config) === "enabled" && hasGeneratedHookSurface(parsed, codexHookSurface);
}

function hasGeneratedHookSurface(parsed, surface) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
    parsed.hooks === null || typeof parsed.hooks !== "object" || Array.isArray(parsed.hooks)) return false;
  return surface.every(([event, matcher, script]) =>
    Array.isArray(parsed.hooks[event]) && parsed.hooks[event].some((entry) =>
      entry && typeof entry === "object" && entry.matcher === matcher && Array.isArray(entry.hooks) &&
      entry.hooks.some((handler) => handler && typeof handler === "object" &&
        handler.type === "command" && handler.command === renderCodexHookCommand(root, script))));
}

function selfcheck(hooks, diagnostic) {
  if (hooks.length === 0) return { ran: false, ok: false, diagnostic: null, observedAt: null };
  const results = hooks.map((hook) => spawnSync(process.execPath, [path.join(wolfDir, "hooks", hook), "--selfcheck"], {
    cwd: root,
    env: { ...process.env, OPENWOLF_PROJECT_ROOT: root },
    encoding: "utf-8",
    timeout: 5_000,
  }));
  const observedAt = new Date().toISOString();
  if (results.every((result) => result.status === 0)) return { ran: true, ok: true, diagnostic: null, observedAt };
  return { ran: true, ok: false, diagnostic, observedAt };
}

function observedAt(value) {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function latestObservation(current, next) {
  if (!current) return next;
  if (next.at > current.at) return next;
  if (next.at < current.at) return current;
  return next.status === "failed" ? next : current;
}

function receiptStatus(evidence, provider) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null;
  const whole = (value) => Number.isSafeInteger(value) && value >= 0;
  const counters = ["hooks_fired", "hooks_failed", "injections_delivered", "injection_tokens_delivered"];
  if (!counters.every((key) => whole(evidence[key])) ||
    evidence.hooks_fired === 0 || evidence.hooks_failed > evidence.hooks_fired ||
    evidence.injections_delivered > evidence.hooks_fired ||
    !evidence.per_hook || typeof evidence.per_hook !== "object" || Array.isArray(evidence.per_hook)) return null;
  if ((evidence.injections_delivered === 0) !== (evidence.injection_tokens_delivered === 0)) return null;
  const perHook = Object.entries(evidence.per_hook);
  if (perHook.length === 0 || !perHook.every(([, entry]) => entry && typeof entry === "object" &&
    whole(entry.fired) && entry.fired > 0 && whole(entry.failed) && whole(entry.last_exit) &&
    entry.failed <= entry.fired && (entry.last_exit === 0 || entry.failed > 0))) return null;
  const totals = perHook.reduce((sum, [, entry]) => ({ fired: sum.fired + entry.fired, failed: sum.failed + entry.failed }), { fired: 0, failed: 0 });
  if (totals.fired !== evidence.hooks_fired || totals.failed !== evidence.hooks_failed) return null;
  const hasLastFailure = "last_failure" in evidence;
  if ((evidence.hooks_failed > 0) !== hasLastFailure) return null;
  if (hasLastFailure) {
    const failure = evidence.last_failure;
    const failedHook = failure && typeof failure === "object" && !Array.isArray(failure) ? evidence.per_hook[failure.hook] : null;
    if (!failedHook || failedHook.failed === 0 || typeof failure.stderr_head !== "string" || failure.stderr_head.length > 200) return null;
  }

  const hasProvider = "provider" in evidence;
  const hasStatus = "status" in evidence;
  const hasVariant = "variant" in evidence;
  if (!hasProvider && !hasStatus && !hasVariant) {
    return provider === "claude" ? (evidence.hooks_failed > 0 ? "failed" : "confirmed") : null;
  }
  if (provider !== "claude" || evidence.provider !== "claude" || evidence.variant !== "claude_attachment" ||
    (evidence.status !== "confirmed" && evidence.status !== "failed")) return null;
  if ((evidence.status === "confirmed" && evidence.hooks_failed !== 0) ||
    (evidence.status === "failed" && evidence.hooks_failed === 0)) return null;
  return evidence.status;
}

function receipt(provider, ledger) {
  let latest = null;
  for (const session of ledger?.sessions ?? []) {
    const evidence = session?.verified;
    const at = observedAt(session.ended);
    if (at === null) continue;
    const status = receiptStatus(evidence, provider);
    if (status) latest = latestObservation(latest, { status, at });
  }
  return latest;
}

function providerReport(provider, configured, selfTest, ledger) {
  const receiptObservation = receipt(provider, ledger);
  const selfTestAt = selfTest.ran ? observedAt(selfTest.observedAt) : null;
  const selfTestObservation = selfTestAt === null ? null : {
    status: selfTest.ok ? "self-tested" : "failed",
    at: selfTestAt,
    diagnostic: selfTest.diagnostic,
  };
  const latest = selfTestObservation?.status === "self-tested" && receiptObservation?.status === "confirmed"
    ? receiptObservation
    : selfTestObservation
      ? latestObservation(receiptObservation, selfTestObservation)
      : receiptObservation;
  const health = latest?.status ?? "unknown";
  return {
    configured,
    self_tested: selfTest.ran && selfTest.ok,
    receipt: receiptObservation?.status ?? "unknown",
    health: health === "confirmed" ? "active" : health,
    ...(health === "failed" ? { diagnostic: latest?.diagnostic ?? "provider receipt failed" } : {}),
  };
}

// ── Recency: newest activity across the state files ─────────────────────────
const activityFiles = ["memory.md", "token-ledger.json", "buglog.json", "anatomy.md", "anatomy-index.json", path.join("hooks", "_session.json")];
const newest = activityFiles
  .map((f) => ({ f, t: mtime(path.join(wolfDir, f)) }))
  .filter((x) => x.t != null)
  .sort((a, b) => b.t - a.t)[0] ?? null;
report.lastActivity = newest ? { file: newest.f, at: new Date(newest.t).toISOString(), ago: ago(newest.t) } : null;

// ── What it did: ledger sessions ────────────────────────────────────────────
const ledger = readJson(path.join(wolfDir, "token-ledger.json"));
const lt = ledger?.lifetime ?? {};
const claudeConfigured = configuredClaude();
const codexConfigured = configuredCodex();
const claudeHook = hookFiles.includes("session-start.js") ? "session-start.js" : hookFiles[0];
const claudeSelfTest = selfcheckRequested && claudeConfigured
  ? selfcheck(claudeHook ? [claudeHook] : [], "installed hook selfcheck failed")
  : { ran: false, ok: false, diagnostic: null, observedAt: null };
const codexSelfTest = selfcheckRequested && codexConfigured
  ? selfcheck(codexHookSurface.map(([, , script]) => script), "Codex hook selfcheck failed")
  : { ran: false, ok: false, diagnostic: null, observedAt: null };
report.providers = {
  claude: providerReport("claude", claudeConfigured, claudeSelfTest, ledger),
  codex: providerReport("codex", codexConfigured, codexSelfTest, ledger),
};
report.lifetime = {
  sessions: lt.total_sessions ?? 0,
  reads: lt.total_reads ?? 0,
  writes: lt.total_writes ?? 0,
  repeated_reads_blocked: lt.repeated_reads_blocked ?? 0,
  estimated_tokens: lt.total_tokens_estimated ?? 0,
  estimated_saved: lt.estimated_savings_vs_bare_cli ?? 0,
  measured_tokens: (lt.real_input_tokens ?? 0) + (lt.real_output_tokens ?? 0) || null,
};
report.recentSessions = (ledger?.sessions ?? []).slice(-3).map((s) => ({
  ended: s.ended, agent: s.agent ?? "claude",
  reads: s.totals?.reads_count ?? 0, writes: s.totals?.writes_count ?? 0,
  est_tokens: (s.totals?.input_tokens_estimated ?? 0) + (s.totals?.output_tokens_estimated ?? 0),
  measured_tokens: s.real_usage ? s.real_usage.input_tokens + s.real_usage.output_tokens : null,
}));

// ── What it did: last actions from memory.md ────────────────────────────────
const memory = read(path.join(wolfDir, "memory.md")) ?? "";
report.recentActions = memory.split("\n")
  .filter((l) => /^\|\s*[\d:]+/.test(l))
  .slice(-6)
  .map((l) => l.split("|").map((c) => c.trim()).filter(Boolean).slice(0, 3).join(" — "));

const bugs = readJson(path.join(wolfDir, "buglog.json"));
report.bugsLogged = bugs?.bugs?.length ?? 0;

// ── Output ───────────────────────────────────────────────────────────────────
if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

const line = (k, v) => console.log(`  ${k.padEnd(24)} ${v}`);
console.log(`\n  openwolf-check — ${root}\n`);
line("installed", `yes (hooks generation ${report.generation}, ${hookFiles.length} hook scripts)`);
line("agents wired", report.agentsWired.length ? report.agentsWired.join(", ") : "none detected");
for (const [provider, evidence] of Object.entries(report.providers)) {
  line(`${provider} hook evidence`, `configured ${evidence.configured ? "yes" : "no"} · ${evidence.health}`);
}
if (report.agentsInConfig) line("agents in config", report.agentsInConfig.join(", "));
line("bundled skills", report.skills.length ? report.skills.map((s) => `/${s}`).join(", ") : "none (pre-2.0 install)");
line("last activity", report.lastActivity ? `${report.lastActivity.ago}  (${report.lastActivity.file})` : "never");
console.log("");
line("sessions", String(report.lifetime.sessions));
line("reads / writes", `${report.lifetime.reads} / ${report.lifetime.writes}`);
line("re-reads blocked", String(report.lifetime.repeated_reads_blocked));
line("est. tokens / saved", `${report.lifetime.estimated_tokens.toLocaleString()} / ${report.lifetime.estimated_saved.toLocaleString()}`);
line("measured tokens", report.lifetime.measured_tokens ? report.lifetime.measured_tokens.toLocaleString() : "none recorded (pre-2.0 or no sessions ended)");
line("bugs logged", String(report.bugsLogged));

if (report.recentSessions.length) {
  console.log("\n  recent sessions");
  for (const s of report.recentSessions) {
    line(`  ${s.ended?.slice(0, 16) ?? "?"}`, `${s.agent} · ${s.reads}r/${s.writes}w · est ${s.est_tokens.toLocaleString()}${s.measured_tokens ? ` · measured ${s.measured_tokens.toLocaleString()}` : ""}`);
  }
}
if (report.recentActions.length) {
  console.log("\n  last actions (memory.md)");
  for (const a of report.recentActions) console.log(`    ${a}`);
}
console.log("");
