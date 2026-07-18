import { readFile } from "node:fs/promises";
import { longTermMemory } from "./long-term.js";
import { logger } from "../observability/logger.js";

/**
 * Memory seeding — loads durable org/workspace knowledge into long-term memory
 * at process start (the in-memory vector store resets on restart, so seeds
 * live in a file and are re-loaded every boot).
 *
 * File format (default ./memory-seed.md, override with MEMORY_SEED_FILE):
 * facts separated by lines containing only "---". Each fact becomes one
 * memory record, recalled automatically when goals mention related terms.
 */
export async function seedMemory(): Promise<number> {
  const file = process.env.MEMORY_SEED_FILE ?? "memory-seed.md";
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    logger.debug("no memory seed file found", { file });
    return 0;
  }

  const facts = raw
    .split(/^---$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 10 && !s.startsWith("#example"));

  for (const fact of facts) {
    await longTermMemory.remember(fact, { kind: "seed", source: file });
  }
  logger.info("memory seeded", { file, facts: facts.length });
  return facts.length;
}
