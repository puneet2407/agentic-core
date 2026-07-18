import { rm } from "node:fs/promises";

/** Wipe test data before and after the suite. */
export default async function setup(): Promise<() => Promise<void>> {
  await rm("./.test-data", { recursive: true, force: true });
  return async () => {
    await rm("./.test-data", { recursive: true, force: true });
  };
}
