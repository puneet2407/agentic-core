import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { orchestrator } from "./orchestration/orchestrator.js";
import { stateManager } from "./orchestration/state-manager.js";
import { episodicStore } from "./memory/episodic.js";
import { getMetrics } from "./observability/metrics.js";
import { readRunEvents } from "./observability/audit.js";
import { toolRegistry } from "./tools/registry.js";
import { agentRegistry } from "./agents/registry.js";
import { config } from "./config/index.js";
import { logger } from "./observability/logger.js";
import { seedMemory } from "./memory/seed.js";
import { rateLimiter } from "./server/rate-limit.js";
import "./tools/builtin.js";
import "./observability/audit.js";

/**
 * HTTP API (Layer 1 — User/Client Layer interface).
 * Zero-dependency node:http server; your Next.js app calls these endpoints.
 *
 *   POST /tasks               {"goal": "...", "approvePlan"?: true} → run a goal (sync)
 *   POST /tasks/async         same body → returns {runId} immediately; poll status
 *   POST /tasks/:id/approve                → approve a run awaiting plan approval
 *   POST /tasks/:id/cancel                 → cancel a run (honored at step boundary)
 *   GET  /tasks/:id                        → run status/result
 *   GET  /tasks/:id/events                 → full audit trail for a run
 *   GET  /tasks/:id/usage                  → token usage, broken down by step & model
 *   GET  /tasks                            → recent runs
 *   GET  /health, /metrics, /catalog       → ops & discovery
 *
 * Security (Layer 8): optional bearer auth (API_TOKEN), per-IP rate limiting
 * (RATE_LIMIT_RPM), configurable CORS origin (CORS_ORIGIN).
 */

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": config.server.corsOrigin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error("Request body exceeds 1MB");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/** Constant-time token comparison — avoids timing side channels. */
function tokenMatches(header: string, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const provided = Buffer.from(header);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${config.server.port}`);
  const path = url.pathname;

  try {
    if (req.method === "OPTIONS") return json(res, 204, {});

    // Rate limiting (Layer 8) — per client IP.
    const clientIp = req.socket.remoteAddress ?? "unknown";
    if (!rateLimiter.allow(clientIp)) {
      return json(res, 429, { error: "Rate limit exceeded — slow down" });
    }

    // Auth (Layer 8): when API_TOKEN is set, every route except the console
    // shell and /health requires "Authorization: Bearer <token>".
    const apiToken = process.env.API_TOKEN;
    const openPaths = ["/", "/console", "/health"];
    if (apiToken && !openPaths.includes(path)) {
      const header = req.headers.authorization ?? "";
      if (!tokenMatches(header, apiToken)) {
        return json(res, 401, { error: "Unauthorized — send Authorization: Bearer <API_TOKEN>" });
      }
    }

    // Web console UI
    if (req.method === "GET" && (path === "/" || path === "/console")) {
      const html = await readFile(new URL("../public/console.html", import.meta.url), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    if (req.method === "GET" && path === "/health") {
      return json(res, 200, { ok: true, activeRuns: stateManager.listActive().length });
    }
    if (req.method === "GET" && path === "/metrics") {
      return json(res, 200, getMetrics());
    }
    if (req.method === "GET" && path === "/catalog") {
      return json(res, 200, {
        agents: agentRegistry.catalogText().split("\n"),
        tools: toolRegistry.list(),
      });
    }
    if (req.method === "POST" && (path === "/tasks" || path === "/tasks/async")) {
      const body = (await readBody(req)) as { goal?: string; approvePlan?: boolean };
      if (!body.goal || typeof body.goal !== "string") {
        return json(res, 400, { error: "Body must be {\"goal\": \"...\"}" });
      }
      const opts = { approvePlan: body.approvePlan === true };
      if (path === "/tasks/async" || opts.approvePlan) {
        // Fire and poll — required for approval flows, suitable for long goals.
        const before = new Set(stateManager.listActive().map((r) => r.id));
        const promise = orchestrator.run(body.goal, opts);
        promise.catch(() => {}); // result surfaced via GET /tasks/:id
        // orchestrator.run registers the run synchronously; yield once to find it.
        await new Promise((r) => setImmediate(r));
        const run = stateManager.listActive().find((r) => !before.has(r.id));
        return json(res, 202, { runId: run?.id ?? null, status: run?.status ?? "running" });
      }
      const run = await orchestrator.run(body.goal, opts);
      return json(res, run.status === "completed" ? 200 : 422, run);
    }
    if (req.method === "POST" && /^\/tasks\/[^/]+\/approve$/.test(path)) {
      const id = path.split("/")[2]!;
      const ok = orchestrator.approve(id);
      return ok
        ? json(res, 200, { runId: id, approved: true })
        : json(res, 409, { error: "Run is not awaiting approval" });
    }
    if (req.method === "POST" && /^\/tasks\/[^/]+\/cancel$/.test(path)) {
      const id = path.split("/")[2]!;
      const ok = orchestrator.cancel(id);
      return ok
        ? json(res, 202, { runId: id, cancelling: true })
        : json(res, 404, { error: "No active run with that id" });
    }
    if (req.method === "GET" && /^\/tasks\/[^/]+\/usage$/.test(path)) {
      const { getRunUsage } = await import("./observability/usage.js");
      return json(res, 200, getRunUsage(path.split("/")[2]!));
    }
    if (req.method === "GET" && /^\/tasks\/[^/]+\/events$/.test(path)) {
      const id = path.split("/")[2]!;
      return json(res, 200, { runId: id, events: readRunEvents(id) });
    }
    if (req.method === "GET" && path.startsWith("/tasks/")) {
      const id = path.slice("/tasks/".length);
      const run = stateManager.get(id);
      return run ? json(res, 200, run) : json(res, 404, { error: "Run not found" });
    }
    if (req.method === "GET" && path === "/tasks") {
      return json(res, 200, {
        active: stateManager.listActive(),
        recent: episodicStore.list(20),
      });
    }

    // --- Code-change proposals (human-in-the-loop write path) ---
    if (path === "/proposals" || path.startsWith("/proposals/")) {
      const { proposals } = await import("./workspace/proposals.js");
      if (req.method === "GET" && path === "/proposals") {
        const status = url.searchParams.get("status") as "proposed" | "applied" | "rejected" | null;
        return json(res, 200, proposals().list(status ?? undefined));
      }
      const applyMatch = path.match(/^\/proposals\/([^/]+)\/apply$/);
      if (req.method === "POST" && applyMatch) {
        return json(res, 200, await proposals().apply(applyMatch[1]!));
      }
      const rejectMatch = path.match(/^\/proposals\/([^/]+)\/reject$/);
      if (req.method === "POST" && rejectMatch) {
        return json(res, 200, proposals().reject(rejectMatch[1]!));
      }
      const patchMatch = path.match(/^\/proposals\/([^/]+)\.patch$/);
      if (req.method === "GET" && patchMatch) {
        const { unifiedDiff } = await import("./workspace/proposals.js");
        const p = proposals().get(patchMatch[1]!);
        if (!p) return json(res, 404, { error: "Proposal not found" });
        res.writeHead(200, { "Content-Type": "text/x-patch; charset=utf-8" });
        return res.end(unifiedDiff(p.oldContent, p.newContent, p.path));
      }
      const getMatch = path.match(/^\/proposals\/([^/]+)$/);
      if (req.method === "GET" && getMatch) {
        const p = proposals().get(getMatch[1]!);
        return p ? json(res, 200, p) : json(res, 404, { error: "Proposal not found" });
      }
    }

    // --- Direct semantic search (used by the MCP adapter and curl) ---
    if (req.method === "GET" && path === "/workspace/search") {
      const q = url.searchParams.get("q");
      if (!q) return json(res, 400, { error: "Missing query param: q" });
      const { codeIndex } = await import("./workspace/code-index.js");
      const results = await codeIndex().search(q, {
        repo: url.searchParams.get("repo") ?? undefined,
        topK: Math.min(15, parseInt(url.searchParams.get("topK") ?? "5", 10) || 5),
      });
      return json(res, 200, { query: q, results });
    }

    // --- Semantic code index ---
    if (req.method === "POST" && path === "/workspace/index") {
      const body = (await readBody(req)) as { repo?: string };
      const { codeIndex } = await import("./workspace/code-index.js");
      return json(res, 200, await codeIndex().indexRepo(body.repo));
    }

    return json(res, 404, { error: `No route: ${req.method} ${path}` });
  } catch (err) {
    logger.error("request failed", { path, error: String(err) });
    return json(res, 500, { error: String(err) });
  }
});

await seedMemory();

server.listen(config.server.port, () => {
  logger.info("agentic-core listening", {
    port: config.server.port,
    auth: process.env.API_TOKEN ? "bearer-token" : "OPEN (set API_TOKEN before sharing)",
    rateLimitRpm: config.server.rateLimitRpm,
    corsOrigin: config.server.corsOrigin,
    dataDir: config.dataDir,
  });
});
