import { evals } from "./evals/index.js";
import { runClaude } from "./driver.js";
import { healthCheck, BASE_URL } from "./portal.js";
import type { EvalCase } from "./evals/types.js";
import type { EvalResult } from "./evals/types.js";

function pickEvals(ids: string[]): EvalCase[] {
  if (ids.length === 0) return evals;
  const set = new Set(ids.map((s) => s.toUpperCase()));
  return evals.filter((e) => set.has(e.id.toUpperCase()));
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function runOne(evalCase: EvalCase): Promise<EvalResult> {
  console.log(`\n=== ${evalCase.id} ===`);
  console.log(`prompt: ${evalCase.prompt}`);

  if (evalCase.setup) {
    console.log("setup...");
    await evalCase.setup();
  }

  let result: EvalResult;
  try {
    console.log("invoking claude -p ...");
    const driver = await runClaude(evalCase.prompt);
    console.log(`  agent exit=${driver.exitCode} duration=${fmtMs(driver.durationMs)} timedOut=${driver.timedOut}`);
    if (driver.timedOut) {
      result = {
        id: evalCase.id,
        passed: false,
        comment: "Agent timed out before completing the task.",
        durationMs: driver.durationMs,
        failureBucket: "stalled",
      };
    } else {
      console.log("grading...");
      result = await evalCase.grade(driver);
    }
  } catch (err) {
    result = {
      id: evalCase.id,
      passed: false,
      comment: `Eval threw: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: 0,
      failureBucket: "unknown",
    };
  } finally {
    if (evalCase.teardown) {
      try {
        await evalCase.teardown();
      } catch (err) {
        console.warn(`  teardown failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  console.log(`  result: ${result.passed ? "PASS" : "FAIL"}${result.failureBucket ? ` bucket=${result.failureBucket}` : ""}`);
  console.log(`  ${result.comment}`);
  return result;
}

async function main(): Promise<void> {
  const ids = process.argv.slice(2);
  const cases = pickEvals(ids);
  if (cases.length === 0) {
    console.error(`No evals match: ${ids.join(", ")}. Known: ${evals.map((e) => e.id).join(", ")}`);
    process.exit(2);
  }

  console.log(`Liferay: ${BASE_URL}`);
  console.log("health check...");
  try {
    await healthCheck();
    console.log("  ok");
  } catch (err) {
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const results: EvalResult[] = [];
  for (const c of cases) {
    results.push(await runOne(c));
  }

  console.log("\n=== Summary ===");
  for (const r of results) {
    console.log(
      `${r.passed ? "PASS" : "FAIL"}  ${r.id}  ${fmtMs(r.durationMs)}${r.failureBucket ? `  bucket=${r.failureBucket}` : ""}`
    );
  }

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
