import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    env: {
      // Isolate persistent stores from ./data during tests.
      DATA_DIR: "./.test-data",
      // Never hit a real provider from tests.
      LLM_PROVIDER: "claude-cli",
      LOG_LEVEL: "error",
    },
  },
});
