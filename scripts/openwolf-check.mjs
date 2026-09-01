#!/usr/bin/env node
/**
 * openwolf-check — standalone, zero-dependency, read-only.
 *
 * Run from a project root (or pass a path) to see whether OpenWolf is
 * installed there, which agents are wired, when it was last used, and what
 * it did. Works without OpenWolf installed — it only reads files.
 *
 *   node openwolf-check.mjs [projectDir] [--json]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
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
  return parsed !== null && typeof parsed === "object" && JSON.stringify(parsed).includes(".wolf/hooks/");
}

function configuredCodex() {
  const parsed = readJson(path.join(root, ".codex", "hooks.json"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
    parsed.hooks === null || typeof parsed.hooks !== "object" || Array.isArray(parsed.hooks)) return false;

  const config = read(path.join(root, ".codex", "config.toml"));
  if (config === null) return false;
  let section = "";
  let enabled = false;
  for (const line of config.split(/\r?\n/)) {
    const source = line.replace(/\s+#.*$/, "");
    const heading = source.match(/^\s*\[([\w-]+)\]\s*$/);
    if (heading) {
      section = heading[1];
      continue;
    }
    if (section === "features" && /^\s*hooks\s*=\s*true\s*$/.test(source)) enabled = true;
  }
  if (!enabled) return false;

  const commands = [];
  const collectCommands = (value) => {
    if (Array.isArray(value)) return value.forEach(collectCommands);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "command" && typeof child === "string") commands.push(child);
      else collectCommands(child);
    }
  };
  collectCommands(parsed.hooks);
  return ["session-start.js", "pre-read.js", "pre-write.js", "post-read.js", "post-write.js", "precompact.js", "stop.js"].every(
    (script) => commands.some((command) => command.includes(`.wolf/hooks/${script}`) || command.includes(`.wolf\\hooks\\${script}`)),
  );
}

function selfcheck() {
  const hook = hookFiles.includes("session-start.js") ? "session-start.js" : hookFiles[0];
  if (!hook) return { ran: false, ok: false, diagnostic: null, observedAt: null };
  const result = spawnSync(process.execPath, [path.join(wolfDir, "hooks", hook), "--selfcheck"], {
    cwd: root,
    env: { ...process.env, OPENWOLF_PROJECT_ROOT: root },
    encoding: "utf-8",
    timeout: 5_000,
  });
  const observedAt = new Date().toISOString();
  if (result.status === 0) return { ran: true, ok: true, diagnostic: null, observedAt };
  return { ran: true, ok: false, diagnostic: "installed hook selfcheck failed", observedAt };
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

function receipt(provider, ledger) {
  let latest = null;
  for (const session of ledger?.sessions ?? []) {
    const evidence = session?.verified;
    if (!evidence || typeof evidence !== "object") continue;
    const evidenceProvider = evidence.provider ?? "claude";
    if (evidenceProvider !== provider) continue;
    const at = observedAt(session.ended);
    if (at === null) continue;
    const status = evidence.status === "failed" || (!evidence.status && evidence.hooks_failed > 0)
      ? "failed"
      : evidence.status === "confirmed" || (!evidence.status && evidence.hooks_fired > 0)
        ? "confirmed"
        : null;
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
const installedSelfTest = claudeConfigured || codexConfigured
  ? selfcheck()
  : { ran: false, ok: false, diagnostic: null, observedAt: null };
report.providers = {
  claude: providerReport("claude", claudeConfigured, claudeConfigured ? installedSelfTest : { ran: false, ok: false, diagnostic: null, observedAt: null }, ledger),
  codex: providerReport("codex", codexConfigured, codexConfigured ? installedSelfTest : { ran: false, ok: false, diagnostic: null, observedAt: null }, ledger),
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
