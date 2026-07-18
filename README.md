# agentic-core

Foundation for an agentic AI system — goal-driven, multi-agent, orchestrated, observable, reliable. TypeScript, Anthropic-first, zero framework lock-in. Built as the backend brain for a Next.js frontend.

## Architecture → code map

| Diagram layer | Where it lives |
|---|---|
| 1. User/Client | `src/server.ts` — HTTP API (`POST /tasks`, `GET /tasks/:id`, …) |
| 2. Orchestration | `src/orchestration/` — orchestrator, planner (task decomposition), state manager, guardrails |
| 3. Agents | `src/agents/` — BaseAgent + research, reasoning, action, data, communication |
| 4. Tools | `src/tools/` — zod-validated registry + built-ins (calculator, http_get, current_time) |
| 5. Memory | `src/memory/` — short-term (per-run window), long-term (VectorStore interface), episodic (run history) |
| 6. Observability | `src/observability/` — event bus, structured logs, metrics (`GET /metrics`) |
| 7. Reliability | `src/reliability/` — retry w/ backoff, circuit breaker, fallback agents (in registry/orchestrator) |
| 8. Governance | `src/orchestration/guardrails.ts` — input/output guardrail pipeline (PII check included) |
| 9. Foundation | `src/foundation/` — model gateway (provider abstraction, token budgets), Anthropic provider |

## Quick start

Two ways to power the LLM calls:

**A. Claude Code CLI (no API key — works with a Claude Pro/Max subscription).** This is the default when no `ANTHROPIC_API_KEY` is set. The gateway shells out to `claude -p` in headless JSON mode, authenticated by your CLI login.

```bash
npm install -g @anthropic-ai/claude-code   # if not already installed
claude                                     # sign in once with your Pro account, then exit
npm install
cp .env.example .env                       # LLM_PROVIDER=claude-cli is the default
npm run demo
```

**B. Anthropic API** — set `ANTHROPIC_API_KEY` and `LLM_PROVIDER=anthropic` in `.env`.

Then:

```bash
npm run demo           # run a goal end-to-end from the CLI
npm run dev            # start the HTTP API on :3100
```

CLI-provider trade-offs: each LLM call spawns a `claude` process, so latency is higher and calls count against your Pro plan's usage limits — fine for development, switch to the API for production. Model names in `.env` work for both (the CLI also accepts aliases like `sonnet`/`haiku`).

```bash
curl -X POST localhost:3100/tasks \
  -H 'Content-Type: application/json' \
  -d '{"goal": "Compare REST vs GraphQL for a fintech API and recommend one"}'
```

## How a run works

1. `POST /tasks` → input guardrails check the goal.
2. Planner LLM decomposes the goal into a validated DAG of steps, each assigned an agent type.
3. Steps execute — in parallel where dependencies allow. Agents call tools via the registry and read prior-step outputs.
4. Failed steps retry (3×), then route to a fallback agent. Token budgets are enforced per run.
5. Output guardrails check the result; a summary lands in long-term memory; the run is archived in the episodic store.

Every stage emits typed events onto the bus (`src/observability/events.ts`) — logging and metrics are just listeners, so wiring in OTel/Datadog later means adding a listener, not touching business logic.

## Connecting your Next.js app

Option A (recommended to start): run this server and call it from Next.js API routes / server actions:

```ts
// app/api/agent/route.ts
export async function POST(req: Request) {
  const { goal } = await req.json();
  const res = await fetch("http://localhost:3100/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ goal }),
  });
  return Response.json(await res.json());
}
```

Option B: import `agentic-core` directly into Next.js server code (monorepo) — everything is exported from `src/index.ts`.

For long tasks use `POST /tasks/async` → `{runId}` → poll `GET /tasks/:id`.

## Extending

- **New tool**: `toolRegistry.register({ name, description, inputSchema: z.object({...}), execute })` — agents discover it automatically.
- **New agent**: extend `BaseAgent`, register in `src/agents/registry.ts`, add the kind to `AgentKind` and the planner enum.
- **New LLM provider**: implement `LLMProvider`, call `modelGateway.registerProvider(...)`.
- **Real vector DB**: implement `VectorStore` (pgvector/Pinecone/Weaviate) and pass it to `LongTermMemory`.
- **New guardrail**: add a `Guardrail` to the pipeline in `src/orchestration/guardrails.ts`.

## Production hardening checklist (deliberately stubbed for v1)

- Auth on the HTTP API (Layer 8) — add bearer-token middleware before exposing beyond localhost.
- Durable state: swap in Redis/Postgres for `StateManager` + `EpisodicStore`.
- Real embeddings for long-term memory (current dev store uses keyword overlap).
- Queue/event bus (Kafka/SQS) if you need multi-instance orchestration.
- Native Anthropic tool-use blocks in `BaseAgent` (current protocol is provider-agnostic text).
- Human-in-the-loop approval step for high-risk actions (hook into the orchestrator before `action` steps).
