import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { AppendLog, JsonlStore } from "../src/persistence/jsonl-store.js";

interface Rec {
  id: string;
  value: string;
}

describe("JsonlStore", () => {
  it("persists records across instances (restart survival)", () => {
    const name = `store-${randomUUID()}`;
    const a = new JsonlStore<Rec>(name);
    a.put({ id: "1", value: "one" });
    a.put({ id: "2", value: "two" });
    a.put({ id: "1", value: "one-updated" });

    const b = new JsonlStore<Rec>(name); // fresh process simulation
    expect(b.size).toBe(2);
    expect(b.get("1")?.value).toBe("one-updated");
    expect(b.get("2")?.value).toBe("two");
  });

  it("persists deletes", () => {
    const name = `store-${randomUUID()}`;
    const a = new JsonlStore<Rec>(name);
    a.put({ id: "1", value: "x" });
    a.delete("1");
    const b = new JsonlStore<Rec>(name);
    expect(b.get("1")).toBeUndefined();
    expect(b.size).toBe(0);
  });

  it("compaction preserves live records", () => {
    const name = `store-${randomUUID()}`;
    const a = new JsonlStore<Rec>(name);
    for (let i = 0; i < 20; i++) a.put({ id: "1", value: `v${i}` });
    a.compact();
    const b = new JsonlStore<Rec>(name);
    expect(b.size).toBe(1);
    expect(b.get("1")?.value).toBe("v19");
  });
});

describe("AppendLog", () => {
  it("appends and reads back with filters and limits", () => {
    const name = `log-${randomUUID()}`;
    const log = new AppendLog<{ runId: string; n: number }>(name);
    for (let i = 0; i < 10; i++) log.append({ runId: i % 2 === 0 ? "a" : "b", n: i });

    const all = log.read();
    expect(all).toHaveLength(10);
    expect(all[0]!.n).toBe(0); // chronological order

    const onlyA = log.read((e) => e.runId === "a");
    expect(onlyA).toHaveLength(5);

    const limited = log.read(undefined, 3);
    expect(limited.map((e) => e.n)).toEqual([7, 8, 9]); // most recent 3, in order
  });
});
