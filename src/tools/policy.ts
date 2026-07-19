import type { AgentKind } from "../types/index.js";

/**
 * Tool authorization policy (Layer 8 — Policy Enforcement).
 * Least privilege: each agent kind may only call the tools its role needs.
 * "*" grants everything; prefix "workspace_" is matched as a family.
 *
 * Enforcement happens in ToolRegistry.execute (deny) AND in the catalog each
 * agent sees (don't advertise tools an agent can't call).
 */
/** Read-only codebase exploration tools (registered when WORKSPACE_ROOT is set). */
const WORKSPACE_READ = [
  "workspace_repos",
  "workspace_semantic_search",
  "code_search",
  "read_repo_file",
  "find_files",
  "git_recent",
];

const POLICY: Record<AgentKind, string[]> = {
  // Research gathers information — read-only tools.
  research: ["http_get", "current_time", ...WORKSPACE_READ],
  // Reasoning works purely over context — no tools.
  reasoning: [],
  // Action executes things — full tool access.
  action: ["*"],
  // Data transforms/aggregates — compute + read-only workspace access.
  data: ["calculator", "current_time", ...WORKSPACE_READ],
  // Code explores the codebase and PROPOSES changes (applied only via human
  // approval on /proposals) — read tools + indexing + the proposal tool.
  code: ["current_time", "calculator", "workspace_index", "propose_code_change", ...WORKSPACE_READ],
  // Communication only formats the final answer — no tools.
  communication: [],
};

export function isToolAllowed(agent: AgentKind | undefined, tool: string): boolean {
  if (!agent) return true; // direct/internal calls (no agent context) are unrestricted
  const allowed = POLICY[agent] ?? [];
  return allowed.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.endsWith("*")) return tool.startsWith(pattern.slice(0, -1));
    return pattern === tool;
  });
}

/** For tests / customization. */
export function setPolicy(agent: AgentKind, tools: string[]): void {
  POLICY[agent] = tools;
}

export function getPolicy(agent: AgentKind): string[] {
  return [...(POLICY[agent] ?? [])];
}
