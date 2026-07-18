/**
 * Demo: run a goal end-to-end from the CLI.
 *   npm run demo -- "Compare the pros and cons of REST vs GraphQL for a fintech API and recommend one"
 * Requires ANTHROPIC_API_KEY in .env.
 */
import { orchestrator } from "./orchestration/orchestrator.js";
import { seedMemory } from "./memory/seed.js";
import "./tools/builtin.js";

await seedMemory();

const goal =
  process.argv.slice(2).join(" ") ||
  "What is (12345 * 678) / 9? Use the calculator tool, then explain the result in one sentence.";

console.log(`\n🎯 Goal: ${goal}\n`);
const run = await orchestrator.run(goal);

console.log("\n" + "=".repeat(60));
console.log(`Status:  ${run.status}`);
console.log(`Steps:   ${run.plan?.steps.map((s) => `${s.id}:${s.agent}(${s.status})`).join(" → ") ?? "-"}`);
console.log("=".repeat(60));
console.log(`\n${run.result ?? run.error}\n`);
