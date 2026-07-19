import "dotenv/config";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "./config/index.js";

/**
 * `npm run doctor` — diagnose LLM provider auth/config without the orchestrator.
 * Answers: does the server see my token, and does the CLI actually accept it?
 */

function mask(v: string | undefined): string {
  if (!v) return "(not set)";
  const t = v.trim();
  if (t.length === 0) return "(set but EMPTY)";
  const quoted = /^["'].*["']$/.test(t);
  return `${t.slice(0, 6)}…${t.slice(-4)} (len ${t.length}${quoted ? ", WRAPPED IN QUOTES — remove them" : ""})`;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((res) => {
    const child = spawn(cmd, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => res({ code: null, out, err: String(e) }));
    child.on("close", (code) => res({ code, out, err }));
    child.stdin.write("Reply with exactly: OK");
    child.stdin.end();
  });
}

const cliPath = process.env.CLAUDE_CLI_PATH ?? "claude";
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const apiKey = process.env.ANTHROPIC_API_KEY;

console.log("=== agentic-core doctor ===\n");
console.log(`LLM_PROVIDER            : ${config.llmProvider}`);
console.log(`CLAUDE_CLI_PATH         : ${cliPath}`);
console.log(`CLAUDE_CODE_OAUTH_TOKEN : ${mask(token)}`);
console.log(`ANTHROPIC_API_KEY       : ${mask(apiKey)}`);
console.log(`WORKSPACE_ROOT          : ${config.workspaceRoot || "(not set — workspace tools disabled)"}`);
console.log(`DATA_DIR                : ${resolve(config.dataDir)}\n`);

if (config.llmProvider === "anthropic") {
  console.log(apiKey?.trim() ? "Using the Anthropic API. Key is present." : "ERROR: LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty.");
  process.exit(apiKey?.trim() ? 0 : 1);
}

const scratch = resolve(join(config.dataDir, "cli-scratch"));
mkdirSync(scratch, { recursive: true });

const version = await run(cliPath, ["--version"], process.env, scratch);
console.log(`claude --version        : ${version.code === 0 ? version.out.trim() : `FAILED (${version.err.trim() || version.code})`}`);
if (version.code !== 0) {
  console.log("\n→ The CLI isn't installed or isn't on PATH. npm install -g @anthropic-ai/claude-code");
  process.exit(1);
}

// Probe 1: minimal call with the env as the server sees it.
const probeArgs = ["-p", "--output-format", "json", "--model", config.models.fast];
console.log("\nProbe 1: minimal `claude -p` with server env …");
const p1 = await run(cliPath, probeArgs, process.env, scratch);
const authFailed = /not logged in|please run \/login/i.test(p1.out + p1.err);
console.log(`  exit ${p1.code} — ${authFailed ? "NOT AUTHENTICATED" : p1.code === 0 ? "OK" : "failed"}`);
if (!authFailed && p1.code !== 0) console.log(`  ${(p1.err.trim() || p1.out.trim()).slice(0, 300)}`);

if (authFailed) {
  console.log("\n→ The CLI rejected the credentials the server is passing.");
  if (!token?.trim()) {
    console.log("  CLAUDE_CODE_OAUTH_TOKEN is empty in this process. Either:");
    console.log("    a) run `claude` once interactively to sign in, or");
    console.log("    b) run `claude setup-token`, paste the value into .env, restart.");
  } else {
    console.log("  A token IS set but was rejected — it may be expired, truncated, or wrapped in quotes.");
    console.log("  Regenerate: claude setup-token   → paste into .env (no quotes) → restart.");
    console.log("  Compare with an interactive login: run `claude` then `claude -p \"hi\"` in a terminal.");
  }
  console.log("  Or switch providers: set ANTHROPIC_API_KEY and LLM_PROVIDER=anthropic in .env.");
  process.exit(1);
}

// Probe 2: full lockdown flags — isolates flag incompatibility from auth.
// Mirrors LOCKDOWN_LADDER level 0 in the provider (no --bare — see note there).
const FULL_LOCKDOWN = [
  "--tools", "",
  "--disallowedTools", "*",
  "--strict-mcp-config",
  "--no-session-persistence",
  "--system-prompt", "You are a test.",
];
console.log("\nProbe 2: with the provider's lockdown flags …");
const p2 = await run(cliPath, [...probeArgs, ...FULL_LOCKDOWN], process.env, scratch);
console.log(`  exit ${p2.code} — ${p2.code === 0 ? "OK (full isolation supported)" : "failed"}`);

if (p2.code !== 0) {
  console.log(`  ${(p2.err.trim() || p2.out.trim()).slice(0, 200)}`);

  // Probe 3: bisect — add each flag to the working baseline, one at a time.
  console.log("\nProbe 3: bisecting which flag breaks it …");
  const candidates: { label: string; args: string[] }[] = [
    { label: '--tools ""', args: ["--tools", ""] },
    { label: '--disallowedTools "*"', args: ["--disallowedTools", "*"] },
    { label: "--strict-mcp-config", args: ["--strict-mcp-config"] },
    { label: "--bare", args: ["--bare"] },
    { label: "--no-session-persistence", args: ["--no-session-persistence"] },
    { label: "--system-prompt", args: ["--system-prompt", "You are a test."] },
  ];
  const broken: string[] = [];
  for (const c of candidates) {
    const r = await run(cliPath, [...probeArgs, ...c.args], process.env, scratch);
    const bad = r.code !== 0;
    if (bad) broken.push(c.label);
    const why = /not logged in|please run \/login/i.test(r.out + r.err)
      ? "breaks auth"
      : bad
        ? "rejected"
        : "ok";
    console.log(`  ${bad ? "✗" : "✓"} ${c.label.padEnd(24)} ${why}`);
  }
  console.log(
    broken.length > 0
      ? `\n  → Incompatible on this CLI (${version.out.trim()}): ${broken.join(", ")}`
      : "\n  → No single flag fails; the combination is the problem.",
  );
  console.log("  The provider auto-steps-down to the strongest working set, so runs still work");
  console.log("  (slightly weaker subprocess isolation). `claude update` may restore full isolation.");
}

console.log(`\n${p1.code === 0 ? "Auth is working — you're good to run goals." : ""}`);
