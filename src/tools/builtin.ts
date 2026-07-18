import { z } from "zod";
import { toolRegistry } from "./registry.js";
import { config } from "../config/index.js";

// Workspace (multi-repo) tools register only when WORKSPACE_ROOT is configured.
if (config.workspaceRoot) await import("./workspace.js");

/**
 * Built-in starter tools. Add real integrations (CRM, ERP, ticketing, DBs)
 * by registering more ToolDefinitions — agents pick them up automatically
 * via the registry catalog.
 */

// --- calculator: safe arithmetic evaluation ---
toolRegistry.register({
  name: "calculator",
  description: "Evaluate an arithmetic expression, e.g. '(2+3)*4/1.5'. Supports + - * / % ** and parentheses.",
  inputSchema: z.object({ expression: z.string().max(500) }),
  async execute({ expression }) {
    if (!/^[\d\s+\-*/%().eE]+$/.test(expression)) {
      throw new Error("Expression contains disallowed characters");
    }
    // eslint-disable-next-line no-new-func
    const result = new Function(`"use strict"; return (${expression});`)();
    if (typeof result !== "number" || !Number.isFinite(result)) {
      throw new Error("Expression did not evaluate to a finite number");
    }
    return String(result);
  },
});

// --- http_get: fetch JSON/text from an allowlisted URL ---
const HTTP_ALLOWLIST: RegExp[] = [
  /^https:\/\/api\.github\.com\//,
  /^https:\/\/[a-z0-9.-]+\.wikipedia\.org\//,
  // Add your own APIs here.
];

toolRegistry.register({
  name: "http_get",
  description: "HTTP GET a URL (allowlisted domains only) and return the response body (truncated to 10KB).",
  inputSchema: z.object({ url: z.string().url() }),
  async execute({ url }) {
    if (!HTTP_ALLOWLIST.some((re) => re.test(url))) {
      throw new Error(`URL not in allowlist: ${url}`);
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const text = await res.text();
    return text.slice(0, 10_000);
  },
});

// --- current_time ---
toolRegistry.register({
  name: "current_time",
  description: "Get the current date and time (ISO 8601, UTC).",
  inputSchema: z.object({}),
  async execute() {
    return new Date().toISOString();
  },
});
