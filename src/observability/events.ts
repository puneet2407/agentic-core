import type { EventListener, SystemEvent } from "../types/index.js";
import { logger } from "./logger.js";

/**
 * Central event bus (Layer 6 — Monitoring & Observability).
 * Every layer emits here; listeners fan out to logs, metrics, alerts.
 * Swap listeners for OpenTelemetry/Datadog exporters later without touching emitters.
 */
class EventBus {
  private listeners: EventListener[] = [];

  on(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  emit(event: SystemEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        logger.error("event listener threw", { error: String(err) });
      }
    }
  }
}

export const events = new EventBus();

// Default listener: structured logging of every system event.
events.on((e) => logger.info(e.type, e as unknown as Record<string, unknown>));
