import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { orchestrator } from "./orchestration/orchestrator.js";
import { stateManager } from "./orchestration/state-manager.js";
import { episodicStore } from "./memory/episodic.js";
import { getMetrics } from "./observability/metrics.js";
import { toolRegistry } from "./tools/registry.js";
import { agentRegistry } from "./agents/registry.js";
import { config } from "./config/index.js";
import { logger } from "./observability/logger.js";
import "./tools/builtin.js";

/**
 * HTTP API (Layer 1 — User/Client Layer interface).
 * Zero-dependency node:http server; your Next.js app calls these endpoints.
 *
 *   POST /tasks          {"goal": "..."}      → run a goal (sync; returns full TaskRun)
 *   POST /tasks/async    {"goal": "..."}      → returns {runId} immediately; poll status
 *   GET  /tasks/:id                            → run status/result
 *   GET  /tasks                                → recent runs
 *   GET  /health, /metrics, /catalog           → ops & discovery
 */

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${config.server.port}`);
  const path = url.pathname;

  try {
    if (req.method === "OPTIONS") return json(res, 204, {});

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
      const body = (await readBody(req)) as { goal?: string };
      if (!body.goal || typeof body.goal !== "string") {
        return json(res, 400, { error: "Body must be {\"goal\": \"...\"}" });
      }
      if (path === "/tasks/async") {
        // Fire and poll — suitable for long-running goals.
        const before = new Set(stateManager.listActive().map((r) => r.id));
        const promise = orchestrator.run(body.goal);
        promise.catch(() => {}); // result surfaced via GET /tasks/:id
        // orchestrator.run registers the run synchronously; yield once to find it.
        await new Promise((r) => setImmediate(r));
        const run = stateManager.listActive().find((r) => !before.has(r.id));
        return json(res, 202, { runId: run?.id ?? null, status: run?.status ?? "running" });
      }
      const run = await orchestrator.run(body.goal);
      return json(res, run.status === "completed" ? 200 : 422, run);
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

    return json(res, 404, { error: `No route: ${req.method} ${path}` });
  } catch (err) {
    logger.error("request failed", { path, error: String(err) });
    return json(res, 500, { error: String(err) });
  }
});

server.listen(config.server.port, () => {
  logger.info("agentic-core listening", { port: config.server.port });
});
