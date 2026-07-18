import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { toolRegistry } from "./registry.js";
import { config } from "../config/index.js";

const exec = promisify(execFile);

/**
 * Workspace tools (multi-repo dev assistant).
 * Enabled when WORKSPACE_ROOT points at the folder containing your repos.
 *
 * Safety model:
 *  - every path is resolved and must stay inside WORKSPACE_ROOT
 *  - secret-looking files (.env, keys, certs) are never readable
 *  - all outputs are size-capped so results fit in model context
 *  - read-only: no tool writes, deletes, or executes repo code
 */

const EXCLUDED_DIRS = ["node_modules", "dist", "build", "target", ".git", ".next", "coverage", ".angular"];
const SECRET_PATTERNS = [/^\.env/i, /\.(pem|key|p12|pfx|jks)$/i, /id_rsa/i, /credentials/i, /secrets?\./i];
const MAX_OUTPUT = 12_000;

function root(): string {
  if (!config.workspaceRoot) {
    throw new Error("WORKSPACE_ROOT is not set in .env — point it at the folder containing your repos");
  }
  return resolve(config.workspaceRoot);
}

/** Resolve a path and enforce the sandbox + secret rules. */
function safePath(...segments: string[]): string {
  const p = resolve(root(), ...segments);
  if (p !== root() && !p.startsWith(root() + "/")) {
    throw new Error(`Path escapes workspace root: ${segments.join("/")}`);
  }
  const base = p.split("/").pop() ?? "";
  if (SECRET_PATTERNS.some((re) => re.test(base))) {
    throw new Error(`Access to secret-like file denied: ${base}`);
  }
  return p;
}

function cap(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n…[truncated at ${MAX_OUTPUT} chars]` : s;
}

async function detectStack(repoPath: string): Promise<string> {
  try {
    const pkgRaw = await readFile(join(repoPath, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps["@angular/core"]) return "angular";
    if (deps["@nestjs/core"]) return "nestjs";
    if (deps["next"]) return "nextjs";
    return "node";
  } catch { /* not a JS repo */ }
  try {
    await stat(join(repoPath, "pom.xml"));
    return "java (maven)";
  } catch { /* no pom */ }
  try {
    await stat(join(repoPath, "build.gradle"));
    return "java (gradle)";
  } catch { /* no gradle */ }
  return "unknown";
}

// --- workspace_repos: discover repos + tech stack ---
toolRegistry.register({
  name: "workspace_repos",
  description:
    "List all repos/microservices in the workspace with their detected tech stack (angular, node, nestjs, java). Use this FIRST to learn what services exist and their exact folder names.",
  inputSchema: z.object({}),
  async execute() {
    const entries = await readdir(root(), { withFileTypes: true });
    const repos: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || EXCLUDED_DIRS.includes(e.name)) continue;
      const stack = await detectStack(join(root(), e.name));
      repos.push(`${e.name} — ${stack}`);
    }
    return repos.length ? cap(repos.join("\n")) : "No repos found under WORKSPACE_ROOT.";
  },
});

// --- code_search: grep across one repo or all repos ---
toolRegistry.register({
  name: "code_search",
  description:
    "Search code across the workspace (or one repo) for a string or extended-regex pattern. Returns matching lines as file:line:text. Use for questions like 'which services call the auth API', 'where is env var X used', 'find usages of function Y'. Keep patterns specific to avoid huge result sets.",
  inputSchema: z.object({
    pattern: z.string().min(2).max(300),
    repo: z.string().optional().describe("limit search to this repo folder name"),
    filePattern: z.string().optional().describe("glob for filenames, e.g. *.ts or *.java"),
    caseInsensitive: z.boolean().optional(),
  }),
  async execute({ pattern, repo, filePattern, caseInsensitive }) {
    const searchRoot = repo ? safePath(repo) : root();
    const args = ["-rnE", ...(caseInsensitive ? ["-i"] : [])];
    for (const d of EXCLUDED_DIRS) args.push(`--exclude-dir=${d}`);
    if (filePattern) args.push(`--include=${filePattern}`);
    args.push("--", pattern, searchRoot);
    try {
      const { stdout } = await exec("grep", args, { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 });
      const relOutput = stdout
        .split("\n")
        .slice(0, 200)
        .map((line) => line.replace(root() + "/", ""))
        .join("\n");
      return cap(relOutput || "No matches.");
    } catch (err) {
      const e = err as { code?: number };
      if (e.code === 1) return "No matches.";
      throw err;
    }
  },
});

// --- read_repo_file: read a file (or line range) from a repo ---
toolRegistry.register({
  name: "read_repo_file",
  description:
    "Read a file from a workspace repo, optionally a line range. Path is relative to the workspace root, e.g. 'auth-service/src/app.ts'. Use after code_search to see full context.",
  inputSchema: z.object({
    path: z.string().min(1),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  }),
  async execute({ path, startLine, endLine }) {
    const p = safePath(path);
    const info = await stat(p);
    if (info.size > 2 * 1024 * 1024) throw new Error("File exceeds 2MB limit");
    const content = await readFile(p, "utf8");
    const lines = content.split("\n");
    const from = (startLine ?? 1) - 1;
    const to = endLine ?? Math.min(lines.length, from + 400);
    const slice = lines.slice(from, to).map((l, i) => `${from + i + 1}: ${l}`);
    return cap(slice.join("\n"));
  },
});

// --- find_files: locate files by name pattern ---
toolRegistry.register({
  name: "find_files",
  description:
    "Find files by name pattern (shell glob, e.g. '*.controller.ts', 'pom.xml', '*routes*') across the workspace or one repo. Returns relative paths.",
  inputSchema: z.object({
    namePattern: z.string().min(1).max(100),
    repo: z.string().optional(),
  }),
  async execute({ namePattern, repo }) {
    const searchRoot = repo ? safePath(repo) : root();
    const pruneArgs = EXCLUDED_DIRS.flatMap((d) => ["-name", d, "-prune", "-o"]);
    const { stdout } = await exec(
      "find",
      [searchRoot, "(", ...pruneArgs.slice(0, -1), ")", "-prune", "-o", "-type", "f", "-name", namePattern, "-print"],
      { maxBuffer: 5 * 1024 * 1024, timeout: 30_000 },
    );
    const out = stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, 300)
      .map((l) => relative(root(), l))
      .join("\n");
    return cap(out || "No files found.");
  },
});

// --- git_recent: recent commit history for a repo ---
toolRegistry.register({
  name: "git_recent",
  description:
    "Show recent git commits for a repo (author, date, message, files changed). Useful for 'what changed recently in service X'.",
  inputSchema: z.object({
    repo: z.string().min(1),
    count: z.number().int().min(1).max(50).default(10),
  }),
  async execute({ repo, count }) {
    const p = safePath(repo);
    const { stdout } = await exec(
      "git",
      ["-C", p, "log", `--max-count=${count}`, "--stat", "--pretty=format:%h %an %ad %s", "--date=short"],
      { maxBuffer: 5 * 1024 * 1024, timeout: 20_000 },
    );
    return cap(stdout || "No commits found (is this a git repo?).");
  },
});
