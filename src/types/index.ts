/**
 * Core shared types for the agentic system.
 * Every layer (orchestration, agents, tools, memory) speaks these types.
 */

// ---------- Messages / LLM ----------

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface LLMRequest {
  model?: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** JSON schema hint — providers that support it enforce structured output */
  jsonMode?: boolean;
}

export interface LLMResponse {
  text: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string | null;
  latencyMs: number;
}

// ---------- Tasks & Plans ----------

export type AgentKind =
  | "research"
  | "reasoning"
  | "action"
  | "data"
  | "communication";

export interface TaskStep {
  id: string;
  description: string;
  agent: AgentKind;
  /** Step ids that must complete before this one runs */
  dependsOn: string[];
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  output?: string;
  error?: string;
  attempts: number;
}

export interface Plan {
  goal: string;
  steps: TaskStep[];
  createdAt: string;
}

export type RunStatus =
  | "planning"
  | "running"
  | "completed"
  | "failed"
  | "rejected"; // blocked by guardrails

export interface TaskRun {
  id: string;
  goal: string;
  status: RunStatus;
  plan?: Plan;
  result?: string;
  error?: string;
  context: Record<string, unknown>;
  usage: { inputTokens: number; outputTokens: number; llmCalls: number };
  startedAt: string;
  finishedAt?: string;
  traceId: string;
}

// ---------- Agents ----------

export interface AgentContext {
  runId: string;
  traceId: string;
  goal: string;
  step: TaskStep;
  /** Outputs of completed dependency steps, keyed by step id */
  priorOutputs: Record<string, string>;
}

export interface AgentResult {
  output: string;
  toolCalls?: { tool: string; input: unknown; output: string }[];
}

export interface Agent {
  kind: AgentKind;
  description: string;
  execute(ctx: AgentContext): Promise<AgentResult>;
}

// ---------- Tools ----------

export interface ToolDefinition<I = unknown> {
  name: string;
  description: string;
  /** zod schema for input validation */
  inputSchema: import("zod").ZodType<I>;
  execute(input: I): Promise<string>;
}

// ---------- Memory ----------

export interface MemoryRecord {
  id: string;
  content: string;
  metadata: Record<string, string>;
  createdAt: string;
  embedding?: number[];
}

export interface VectorStore {
  upsert(records: MemoryRecord[]): Promise<void>;
  query(text: string, topK?: number): Promise<MemoryRecord[]>;
}

// ---------- Guardrails ----------

export interface GuardrailVerdict {
  allowed: boolean;
  reason?: string;
}

export interface Guardrail {
  name: string;
  checkInput?(goal: string): Promise<GuardrailVerdict>;
  checkOutput?(output: string): Promise<GuardrailVerdict>;
}

// ---------- Events (observability) ----------

export type SystemEvent =
  | { type: "run.started"; runId: string; goal: string }
  | { type: "run.completed"; runId: string; result: string }
  | { type: "run.failed"; runId: string; error: string }
  | { type: "plan.created"; runId: string; plan: Plan }
  | { type: "step.started"; runId: string; stepId: string; agent: AgentKind }
  | { type: "step.completed"; runId: string; stepId: string }
  | { type: "step.failed"; runId: string; stepId: string; error: string }
  | { type: "guardrail.blocked"; runId: string; reason: string }
  | { type: "llm.call"; runId: string; model: string; latencyMs: number; inputTokens: number; outputTokens: number }
  | { type: "tool.call"; runId: string; tool: string; ok: boolean; latencyMs: number };

export type EventListener = (event: SystemEvent) => void;
