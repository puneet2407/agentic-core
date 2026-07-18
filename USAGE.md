# agentic-core — Usage Guide

Deep-dive scenarios for running, integrating, and extending the agentic system. Read `README.md` first for the architecture-to-code map.

---

## 1. Setup recap

```bash
npm install               # always run on the machine that will run the code
cp .env.example .env
```

Two LLM backends, selected by `LLM_PROVIDER` in `.env`:

| | `claude-cli` (default) | `anthropic` |
|---|---|---|
| Auth | Your Claude Pro/Max login via `claude` CLI | `ANTHROPIC_API_KEY` |
| Cost | Counts against plan usage limits | Pay per token |
| Latency | +2–15s per call (process spawn + agent runtime) | Fastest |
| Best for | Development, prototyping | Production |

Entry points:

```bash
npm run demo -- "your goal here"   # one-shot CLI run
npm run dev                        # HTTP API on :3100 (hot reload)
npm run build && npm start         # compiled production server
```

---

## 2. Scenario: one-shot goal from the CLI

```bash
npm run demo -- "Compare PostgreSQL and MongoDB for a multi-tenant SaaS and recommend one"
```

What happens internally:

1. Input guardrails validate the goal (length checks; add your own in `src/orchestration/guardrails.ts`).
2. The planner LLM returns a JSON DAG — e.g. `s1: research` → `s2: reasoning` → `s3: communication`. Malformed plans are retried up to 3× with zod validation and cycle detection.
3. Steps execute in dependency order; independent steps run in parallel via `Promise.all`.
4. The last completed step's output (usually the communication agent's synthesis) becomes the result.
5. A summary is written to long-term memory; the full run is archived in the episodic store.

Reading the logs: every line is JSON. The interesting events are `plan.created` (see what the planner decided), `llm.call` (latency + tokens per call), `step.completed` / `step.failed`, and `guardrail.blocked`.

---

## 3. Scenario: HTTP API (sync)

Start the server (`npm run dev`), then:

```bash
curl -X POST localhost:3100/tasks \
  -H 'Content-Type: application/json' \
  -d '{"goal": "Summarize the trade-offs of monorepo vs polyrepo for a 5-person team"}'
```

Response is the full `TaskRun` — status, plan with per-step outputs, token usage, timing:

```json
{
  "id": "…", "status": "completed",
  "plan": { "steps": [ { "id": "s1", "agent": "reasoning", "status": "completed", "output": "…" } ] },
  "result": "…",
  "usage": { "inputTokens": 0, "outputTokens": 0, "llmCalls": 0 }
}
```

HTTP status codes: `200` completed, `422` failed or rejected by guardrails, `400` bad body.

Use sync when: goals are simple (1–3 steps) and the caller can wait 30–120s. With the `claude-cli` provider, prefer async for anything non-trivial.

---

## 4. Scenario: HTTP API (async, long-running goals)

```bash
# 1. Kick off
curl -X POST localhost:3100/tasks/async \
  -H 'Content-Type: application/json' \
  -d '{"goal": "Research three CI/CD platforms, compare pricing models, recommend one for a startup"}'
# → 202 {"runId": "abc-123", "status": "planning"}

# 2. Poll
curl localhost:3100/tasks/abc-123
# status: planning → running → completed | failed | rejected
```

Poll every 2–5s. The `plan` field appears once planning finishes, and step statuses update live — you can render a progress UI from a single poll endpoint (see §6).

Other endpoints:

```bash
curl localhost:3100/tasks      # active + 20 most recent runs
curl localhost:3100/health     # liveness + active run count
curl localhost:3100/metrics    # aggregate counters (see §10)
curl localhost:3100/catalog    # registered agents & tools
```

---

## 5. Scenario: calling from Next.js

**Pattern A — API route proxy (recommended to start).** Keeps the agent system as a separate process you can restart/scale independently.

```ts
// app/api/agent/route.ts
const AGENT_URL = process.env.AGENT_URL ?? "http://localhost:3100";

export async function POST(req: Request) {
  const { goal } = await req.json();
  const res = await fetch(`${AGENT_URL}/tasks/async`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal }),
  });
  return Response.json(await res.json(), { status: res.status });
}
```

```ts
// app/api/agent/[runId]/route.ts
export async function GET(_: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const res = await fetch(`${process.env.AGENT_URL ?? "http://localhost:3100"}/tasks/${runId}`);
  return Response.json(await res.json(), { status: res.status });
}
```

Client component with polling:

```tsx
"use client";
import { useState, useEffect } from "react";

export function AgentRunner() {
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<any>(null);

  useEffect(() => {
    if (!runId || ["completed", "failed", "rejected"].includes(run?.status)) return;
    const t = setInterval(async () => {
      setRun(await (await fetch(`/api/agent/${runId}`)).json());
    }, 3000);
    return () => clearInterval(t);
  }, [runId, run?.status]);

  async function start(goal: string) {
    const res = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ goal }),
    });
    setRunId((await res.json()).runId);
  }

  return (
    <div>
      <button onClick={() => start("Analyze my onboarding funnel copy")}>Run</button>
      {run?.plan?.steps.map((s: any) => (
        <div key={s.id}>{s.id} · {s.agent} · {s.status}</div>
      ))}
      {run?.result && <pre>{run.result}</pre>}
    </div>
  );
}
```

**Pattern B — direct import (monorepo).** Import `orchestrator` from this package inside a Next.js server action. Only do this if Next.js and agentic-core deploy together; a hung agent run then ties up your web server's resources.

```ts
"use server";
import { orchestrator } from "agentic-core";

export async function runGoal(goal: string) {
  return await orchestrator.run(goal);
}
```

---

## 6. Scenario: adding a custom tool (your own API/database)

Tools are how agents touch the outside world. Example — a product-lookup tool against your own backend:

```ts
// src/tools/products.ts
import { z } from "zod";
import { toolRegistry } from "./registry.js";

toolRegistry.register({
  name: "product_lookup",
  description: "Look up a product by SKU. Returns name, price, and stock level as JSON.",
  inputSchema: z.object({ sku: z.string().regex(/^[A-Z0-9-]{4,20}$/) }),
  async execute({ sku }) {
    const res = await fetch(`${process.env.BACKEND_URL}/api/products/${sku}`, {
      headers: { Authorization: `Bearer ${process.env.BACKEND_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Product API returned ${res.status}`);
    return JSON.stringify(await res.json());
  },
});
```

Then import it once in `src/tools/builtin.ts` (or `src/index.ts`): `import "./products.js";`

Rules of thumb:

- **Description is prompt engineering.** Agents choose tools by reading the description — say what it returns and when to use it.
- **Validate hard.** The zod schema is your security boundary; the LLM authors the input.
- **Return strings** (JSON-stringify structured data). Truncate large payloads — everything you return lands in the model's context.
- **Throw on failure.** The agent sees `TOOL_ERROR: …` and can retry or work around it.

Test a tool directly without any LLM calls:

```ts
import { toolRegistry } from "./src/tools/registry.js";
import "./src/tools/products.js";
console.log(await toolRegistry.execute("product_lookup", { sku: "AB-1234" }));
```

---

## 7. Scenario: adding a new agent type

Say you need a dedicated **code agent**. Four touch points:

```ts
// 1. src/types/index.ts — extend the union
export type AgentKind = "research" | "reasoning" | "action" | "data" | "communication" | "code";
```

```ts
// 2. src/agents/code-agent.ts
import { BaseAgent } from "./base-agent.js";
import type { AgentKind } from "../types/index.js";

export class CodeAgent extends BaseAgent {
  kind: AgentKind = "code";
  description = "Writes, reviews, and explains code. Produces complete, runnable snippets.";
  protected systemPrompt(): string {
    return `You are a Code Agent in a multi-agent system.
Write clean, complete, runnable code for the assigned step.
Include brief comments. State assumptions. Never invent APIs.`;
  }
}
```

```ts
// 3. src/agents/registry.ts — register it
agentRegistry.register(new CodeAgent());
```

```ts
// 4. src/orchestration/planner.ts — let the planner assign it
agent: z.enum(["research", "reasoning", "action", "data", "communication", "code"]),
```

The planner reads agent descriptions from the registry at plan time, so a good `description` is what routes work to your new agent. Override `model()` to pin an agent to a cheaper/faster model, and `maxToolIterations` to bound its tool loop.

---

## 8. Scenario: guardrails and policy

Add a topic-block guardrail:

```ts
// in src/orchestration/guardrails.ts
export const topicGuardrail: Guardrail = {
  name: "topic-policy",
  async checkInput(goal) {
    const banned = [/medical diagnosis/i, /legal advice/i];
    if (banned.some((re) => re.test(goal)))
      return { allowed: false, reason: "Topic requires a licensed professional" };
    return { allowed: true };
  },
};

export const defaultGuardrails = new GuardrailPipeline([
  inputLengthGuardrail,
  topicGuardrail,      // ← add
  piiOutputGuardrail,
]);
```

Blocked runs finish with `status: "rejected"` and the reason in `error` — they never reach the planner (input) or the user (output). A `guardrail.blocked` event fires either way, so rejections are visible in logs and metrics.

**LLM-as-judge guardrail:** for nuanced policies, call `modelGateway.complete()` inside a guardrail with the fast model and a yes/no rubric. Costs one extra call per run; use for high-stakes surfaces.

**Human-in-the-loop:** intercept before `action` steps in `Orchestrator.executeStep` — persist the run as `awaiting-approval`, expose an approve endpoint, resume on approval. The state manager already tolerates long-lived runs.

---

## 9. Scenario: memory in practice

Three stores, three jobs:

- **Short-term** (`shortTermMemory`) — per-run message window, cleared when the run ends. Used inside agents' conversations.
- **Long-term** (`longTermMemory`) — cross-run facts. The orchestrator auto-saves a summary of every completed run; the data agent auto-recalls relevant memories into its context.
- **Episodic** (`episodicStore`) — full `TaskRun` history, powering `GET /tasks` and audits.

Seed long-term memory with domain knowledge at startup:

```ts
import { longTermMemory } from "agentic-core";

await longTermMemory.remember(
  "Our production stack: Next.js 15 on Vercel, Postgres on Neon, Stripe for billing.",
  { kind: "org-context" },
);
```

Now any data-agent step whose goal mentions your stack pulls this in automatically.

**Upgrading to a real vector DB:** implement the 2-method `VectorStore` interface with pgvector/Pinecone and inject it:

```ts
import { LongTermMemory } from "agentic-core";
const longTerm = new LongTermMemory(new PgVectorStore(connectionString));
```

The dev store (keyword overlap) is fine until you have hundreds of memories or need semantic matching.

---

## 10. Scenario: observability

Everything is an event on one bus. Subscribe for custom sinks:

```ts
import { events } from "agentic-core";

events.on((e) => {
  if (e.type === "run.failed") notifySlack(`Run ${e.runId} failed: ${e.error}`);
  if (e.type === "llm.call" && e.latencyMs > 30_000) console.warn("slow LLM call", e);
});
```

`GET /metrics` gives you run counts, token totals, tool failure counts, and average LLM latency — enough for a dashboard tile or an uptime check. For real tracing, add an OpenTelemetry listener; emitters never change.

Debug a bad run:

1. `curl localhost:3100/tasks/<runId>` — the plan shows each step's status, output, error, and attempt count.
2. Grep logs by `runId` — every event carries it.
3. `LOG_LEVEL=debug` surfaces each agent tool call.

---

## 11. Scenario: reliability behavior (what happens when things break)

| Failure | Behavior |
|---|---|
| LLM call fails (429/5xx/network) | Retried 3× with exponential backoff + jitter |
| Provider keeps failing | Circuit opens after 5 consecutive failures; calls fail fast for 30s, then one probe |
| Step fails after retries | Fallback agent tried (action/research/data → reasoning); output tagged `[via fallback:…]` |
| Fallback also fails | Step → `failed`, run → `failed` with the step error |
| Run exceeds token budget | `BudgetExceededError`; run fails (tune `MAX_TOKENS_PER_TASK`) |
| Planner emits invalid JSON / cyclic DAG | Re-planned up to 3× |
| Guardrail blocks | Run → `rejected` with reason; no partial output leaks |

Tunables in `.env` / `src/config/index.ts`: `MAX_STEPS_PER_TASK`, `MAX_TOKENS_PER_TASK`, `REQUEST_TIMEOUT_MS`, `maxStepAttempts`.

---

## 12. Troubleshooting

**esbuild "installed for another platform"** — `node_modules` was installed on a different OS/arch. `rm -rf node_modules && npm install` on the machine that runs the code. Never copy `node_modules` between machines.

**`Failed to spawn claude CLI … ENOENT`** — the CLI isn't on PATH for the Node process. `npm install -g @anthropic-ai/claude-code`, or set `CLAUDE_CLI_PATH=$(which claude)` in `.env`. GUI-launched processes on macOS get a minimal PATH; setting `CLAUDE_CLI_PATH` explicitly is the robust fix.

**`claude CLI exited 1: … login`** — run `claude` interactively once and sign in with your Pro account.

**Every call is slow with claude-cli** — expected; each call spawns a full CLI session. Reduce steps (`MAX_STEPS_PER_TASK=5`), pin more agents to the fast model, or batch related questions into one goal. Switch to the API provider when speed matters.

**Run stuck in `running`** — a step is inside a long LLM call or retry loop. Check the newest `llm.call`/`step.*` event for its `runId`. Timeouts (`REQUEST_TIMEOUT_MS`) bound every call, so runs always terminate.

**`tokens: 10` on huge prompts (claude-cli)** — CLI usage numbers reflect the CLI's own accounting and can undercount cached tokens; treat them as indicative, not billing-grade.

**`npm audit` vulnerabilities** — dev-dependency chains (tsx/esbuild) trigger most of these; they don't ship to production (`npm run build` output has zero runtime deps beyond the SDK, dotenv, zod). Review with `npm audit --omit=dev` for the signal that matters.

**Port already in use** — another instance is on 3100; change `PORT` in `.env`.

---

## 13. Scenario: multi-repo workspace assistant (microservices)

Point agentic-core at the folder containing all your repos and it becomes a cross-repo dev assistant:

```bash
# .env
WORKSPACE_ROOT=/Users/you/work/my-company   # folder containing all 20+ repos
```

That one line registers five read-only workspace tools:

| Tool | What agents use it for |
|---|---|
| `workspace_repos` | Discover every service + its stack (auto-detects angular / node / nestjs / nextjs / java maven / java gradle from package.json, pom.xml, build.gradle) |
| `code_search` | Grep across all repos or one repo — "which services call the auth API?", "where is `PAYMENT_TIMEOUT` used?" |
| `read_repo_file` | Read a file or line range after a search hit |
| `find_files` | Locate files by name glob — `*.controller.ts`, `pom.xml`, `*routes*` |
| `git_recent` | Recent commits + changed files per repo — "what changed in billing-svc this week?" |

Example goals that now work from the console:

- "List all our services by tech stack and flag any that look unmaintained (no recent commits)."
- "Which services make HTTP calls to the user service? Search for its URL/env var and list the call sites."
- "Trace how an order flows through the system: find which services reference 'order' APIs and describe the chain."
- "Find every place we read `DATABASE_URL` and check which repos are missing it in their README."
- "Summarize what changed in gateway-svc in the last 20 commits."

Safety model (enforced in `src/tools/workspace.ts`): all paths are sandboxed inside `WORKSPACE_ROOT` (escape attempts rejected), secret-like files (`.env*`, keys, certs, credentials) are unreadable, outputs are size-capped, and every tool is read-only — agents can analyze your code but never modify or execute it.

Tips for 20+ repos:

- Cross-repo questions are research-agent territory; the planner routes them automatically. Give goals that name concrete strings (URLs, env vars, function names) — grep quality drives answer quality.
- Seed long-term memory with your service map once (§9) — e.g. "auth-svc issues JWTs consumed by all Node services; gateway-svc is the only public entry point" — and every future run gets that context free.
- The `claude-cli` provider is fine here: code questions tolerate latency, and exploration runs stay within Pro limits if goals are focused.
- Java repos: search/read/git work fully; only stack detection is name-based (pom/gradle), not semantic.

## 14. Recommended path to production

1. Develop against `claude-cli` (free with your plan) with `MAX_STEPS_PER_TASK=5`.
2. Add your real tools (§6) and org guardrails (§8); test tools directly before involving agents.
3. Build the Next.js UI against the async API (§4–5).
4. Switch to `LLM_PROVIDER=anthropic` and load-test; tune budgets.
5. Harden per the checklist in `README.md` (auth, durable state, real embeddings, native tool-use).
