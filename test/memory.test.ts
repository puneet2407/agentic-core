import { describe, expect, it } from "vitest";
import {
  InMemoryVectorStore,
  LongTermMemory,
  contentHashId,
} from "../src/memory/long-term.js";

describe("LongTermMemory", () => {
  it("recalls by keyword overlap", async () => {
    const mem = new LongTermMemory(new InMemoryVectorStore());
    await mem.remember("The billing service uses Stripe webhooks");
    await mem.remember("The auth service issues JWT tokens");
    const hits = await mem.recall("how does billing work with stripe");
    expect(hits[0]!.content).toContain("Stripe");
  });

  it("defaults provenance to 'derived' (least trusted)", async () => {
    const mem = new LongTermMemory(new InMemoryVectorStore());
    await mem.remember("some run summary");
    const [hit] = await mem.recall("run summary");
    expect(hit!.metadata["provenance"]).toBe("derived");
  });

  it("records explicit seed provenance", async () => {
    const mem = new LongTermMemory(new InMemoryVectorStore());
    await mem.remember("org fact", {}, { provenance: "seed" });
    const [hit] = await mem.recall("org fact");
    expect(hit!.metadata["provenance"]).toBe("seed");
  });

  it("content-hash ids make seeding idempotent (no duplicates on re-boot)", async () => {
    const mem = new LongTermMemory(new InMemoryVectorStore());
    const fact = "deploys happen from the main branch";
    await mem.remember(fact, {}, { provenance: "seed", id: contentHashId(fact) });
    await mem.remember(fact, {}, { provenance: "seed", id: contentHashId(fact) });
    const hits = await mem.recall("deploys main branch", 10);
    expect(hits).toHaveLength(1);
  });
});
