#!/usr/bin/env node
import { createInterface } from "node:readline";

/**
 * MCP (Model Context Protocol) stdio adapter for agentic-core.
 * Lets Claude Code, Cursor, Windsurf, and VS Code Copilot use the platform
 * as tools from inside the IDE. Zero dependencies — hand-rolled JSON-RPC 2.0
 * over newline-delimited stdio, thin client over the running HTTP server
 * (so runs, memory, proposals all live in ONE place).
 *
 * Register (Claude Code):
 *   claude mcp add agentic-core -- node /path/to/agentic-core/dist/mcp-server.js
 * Cursor / others: add a stdio server with the same command in mcp.json.
 *
 * Env: AGENTIC_URL (default http://localhost:3100), API_TOKEN (if set on the server).
 */

const BASE = process.env.AGENTIC_URL ?? "http://localhost:3100";
const TOKEN = process.env.API_TOKEN;

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`agentic-core API ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

async function apiText(path: string): Promise<string> {
  const res = await fetch(BASE + path, {
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`agentic-core API ${res.status}: ${text.slice(0, 400)}`);
  return text;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- tool implementations ----------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>): Promise<string>;
}

const TOOLS: ToolDef[] = [
  {
    name: "run_goal",
    description:
      "Run a goal through the agentic-core multi-agent orchestrator (planner → specialized agents → tools → guardrails). Use for multi-step work: analyzing the indexed codebase, research, or proposing code changes. Waits for completion (up to wait_seconds), otherwise returns the runId to poll with get_run.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The goal to accomplish" },
        wait_seconds: { type: "number", description: "Max seconds to wait (default 240)" },
      },
      required: ["goal"],
    },
    async run(args) {
      const started = (await api("POST", "/tasks/async", { goal: args.goal })) as {
        runId: string | null;
      };
      if (!started.runId) throw new Error("Server did not return a runId");
      const deadline = Date.now() + (Number(args.wait_seconds) || 240) * 1000;
      while (Date.now() < deadline) {
        await sleep(2000);
        const run = (await api("GET", `/tasks/${started.runId}`)) as {
          status: string;
          result?: string;
          error?: string;
        };
        if (["completed", "failed", "rejected", "cancelled"].includes(run.status)) {
          const header = `Run ${started.runId} ${run.status}.`;
          return run.status === "completed"
            ? `${header}\n\n${run.result}`
            : `${header}\n${run.error ?? ""}\nIf code changes were proposed, check list_proposals.`;
        }
      }
      return `Run ${started.runId} is still running — call get_run with this id to check later.`;
    },
  },
  {
    name: "get_run",
    description: "Get the status/result of a previous agentic-core run by runId.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
    },
    async run(args) {
      return JSON.stringify(await api("GET", `/tasks/${args.run_id}`), null, 2);
    },
  },
  {
    name: "semantic_search",
    description:
      "Search the indexed workspace codebase by MEANING (local embeddings), not literal text. Great for 'where is the retry logic', 'code that computes position sizing'. Fast — no LLM involved.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        repo: { type: "string", description: "limit to one repo folder" },
        top_k: { type: "number", description: "default 5, max 15" },
      },
      required: ["query"],
    },
    async run(args) {
      const params = new URLSearchParams({ q: String(args.query) });
      if (args.repo) params.set("repo", String(args.repo));
      if (args.top_k) params.set("topK", String(args.top_k));
      const out = (await api("GET", `/workspace/search?${params}`)) as { results: string };
      return out.results;
    },
  },
  {
    name: "reindex_workspace",
    description:
      "Refresh the semantic code index (incremental — only changed files re-embed). Run after significant code changes.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string", description: "one repo folder, or omit for all" } },
    },
    async run(args) {
      return JSON.stringify(await api("POST", "/workspace/index", { repo: args.repo }), null, 2);
    },
  },
  {
    name: "list_proposals",
    description:
      "List code-change proposals created by agentic-core agents (status: proposed/applied/rejected). Proposals are diffs awaiting human review — nothing is applied automatically.",
    inputSchema: {
      type: "object",
      properties: { status: { type: "string", enum: ["proposed", "applied", "rejected"] } },
    },
    async run(args) {
      const suffix = args.status ? `?status=${args.status}` : "";
      const list = (await api("GET", `/proposals${suffix}`)) as {
        id: string;
        path: string;
        description: string;
        status: string;
        createdAt: string;
      }[];
      if (list.length === 0) return "No proposals.";
      return list
        .map((p) => `${p.id} [${p.status}] ${p.path} — ${p.description} (${p.createdAt})`)
        .join("\n");
    },
  },
  {
    name: "get_proposal_diff",
    description:
      "Get a proposal's unified diff (git-apply compatible). Review before applying.",
    inputSchema: {
      type: "object",
      properties: { proposal_id: { type: "string" } },
      required: ["proposal_id"],
    },
    async run(args) {
      return apiText(`/proposals/${args.proposal_id}.patch`);
    },
  },
  {
    name: "apply_proposal",
    description:
      "Apply a reviewed proposal to the workspace (refuses if the file changed on disk since it was proposed). Only call after the human has seen the diff and confirmed.",
    inputSchema: {
      type: "object",
      properties: { proposal_id: { type: "string" } },
      required: ["proposal_id"],
    },
    async run(args) {
      const p = (await api("POST", `/proposals/${args.proposal_id}/apply`)) as { path: string };
      return `Applied to ${p.path}.`;
    },
  },
  {
    name: "reject_proposal",
    description: "Reject a proposal.",
    inputSchema: {
      type: "object",
      properties: { proposal_id: { type: "string" } },
      required: ["proposal_id"],
    },
    async run(args) {
      await api("POST", `/proposals/${args.proposal_id}/reject`);
      return "Rejected.";
    },
  },
];

// ---------- JSON-RPC 2.0 over newline-delimited stdio ----------

function send(msg: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function reply(id: unknown, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function replyError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  void (async () => {
    if (!line.trim()) return;
    let msg: { id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      return; // ignore garbage
    }
    const { id, method, params } = msg;
    try {
      switch (method) {
        case "initialize":
          return reply(id, {
            protocolVersion: (params?.protocolVersion as string) ?? "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "agentic-core", version: "0.1.0" },
          });
        case "ping":
          return reply(id, {});
        case "tools/list":
          return reply(id, {
            tools: TOOLS.map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            })),
          });
        case "tools/call": {
          const name = params?.name as string;
          const args = (params?.arguments ?? {}) as Record<string, unknown>;
          const tool = TOOLS.find((t) => t.name === name);
          if (!tool) return replyError(id, -32602, `Unknown tool: ${name}`);
          try {
            const text = await tool.run(args);
            return reply(id, { content: [{ type: "text", text }], isError: false });
          } catch (err) {
            return reply(id, {
              content: [{ type: "text", text: `Error: ${String(err)}` }],
              isError: true,
            });
          }
        }
        case "resources/list":
          return reply(id, { resources: [] });
        case "prompts/list":
          return reply(id, { prompts: [] });
        default:
          // Notifications (no id) are silently accepted.
          if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      if (id !== undefined) replyError(id, -32603, String(err));
    }
  })();
});

rl.on("close", () => process.exit(0));
