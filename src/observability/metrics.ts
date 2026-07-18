import { events } from "./events.js";

/**
 * In-process metrics aggregation. Exposed via GET /metrics.
 * Replace with Prometheus/OTel exporter in production.
 */
export interface Metrics {
  runsStarted: number;
  runsCompleted: number;
  runsFailed: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  toolFailures: number;
  avgLlmLatencyMs: number;
}

const m: Metrics = {
  runsStarted: 0,
  runsCompleted: 0,
  runsFailed: 0,
  llmCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  toolCalls: 0,
  toolFailures: 0,
  avgLlmLatencyMs: 0,
};

events.on((e) => {
  switch (e.type) {
    case "run.started":
      m.runsStarted++;
      break;
    case "run.completed":
      m.runsCompleted++;
      break;
    case "run.failed":
      m.runsFailed++;
      break;
    case "llm.call":
      m.avgLlmLatencyMs =
        (m.avgLlmLatencyMs * m.llmCalls + e.latencyMs) / (m.llmCalls + 1);
      m.llmCalls++;
      m.inputTokens += e.inputTokens;
      m.outputTokens += e.outputTokens;
      break;
    case "tool.call":
      m.toolCalls++;
      if (!e.ok) m.toolFailures++;
      break;
  }
});

export function getMetrics(): Metrics {
  return { ...m };
}
