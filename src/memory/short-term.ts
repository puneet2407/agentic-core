import type { ChatMessage } from "../types/index.js";

/**
 * Short-term memory (Layer 5) — per-run working context.
 * Bounded message window; oldest messages are evicted first.
 */
export class ShortTermMemory {
  private byRun = new Map<string, ChatMessage[]>();

  constructor(private readonly maxMessages = 40) {}

  append(runId: string, message: ChatMessage): void {
    const list = this.byRun.get(runId) ?? [];
    list.push(message);
    while (list.length > this.maxMessages) list.shift();
    this.byRun.set(runId, list);
  }

  get(runId: string): ChatMessage[] {
    return [...(this.byRun.get(runId) ?? [])];
  }

  clear(runId: string): void {
    this.byRun.delete(runId);
  }
}

export const shortTermMemory = new ShortTermMemory();
