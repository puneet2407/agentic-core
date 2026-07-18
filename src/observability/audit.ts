import type { SystemEvent } from "../types/index.js";
import { events } from "./events.js";
import { AppendLog } from "../persistence/jsonl-store.js";

/**
 * Audit & Compliance trail (Layer 6 / Layer 8).
 * Every system event is appended to a durable JSONL log with a timestamp,
 * so runs remain fully reconstructable after restarts.
 * Query per run via readRunEvents (exposed at GET /tasks/:id/events).
 */
export interface AuditEntry {
  ts: string;
  event: SystemEvent;
}

const auditLog = new AppendLog<AuditEntry>("audit");

events.on((event) => {
  auditLog.append({ ts: new Date().toISOString(), event });
});

export function readRunEvents(runId: string, limit = 500): AuditEntry[] {
  return auditLog.read((e) => e.event.runId === runId, limit);
}

export function readRecentEvents(limit = 200): AuditEntry[] {
  return auditLog.read(undefined, limit);
}
