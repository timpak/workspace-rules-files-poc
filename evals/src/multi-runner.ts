import { mkdirSync, writeFileSync } from "node:fs";
import type { FailureBucket, GradeContext } from "./evals/types.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { evals } from "./evals/index.js";
import { runClaude, getClaudeVersion } from "./driver.js";
import { healthCheck, BASE_URL } from "./portal.js";
import { loadRubric } from "./graders/rubric.js";
import type { EvalCase, EvalResult } from "./evals/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_ROOT = resolve(__dirname, "..", "results");

type IterRecord = {
  iter: number;
  startedAt: string;
  passed: boolean;
  comment: string;
  durationMs: number;
  failureBucket?: FailureBucket;
  agentExit: number | null;
  agentTimedOut: boolean;
  agentModel: string | null;
  agentStderrTail?: string;
  agentStdoutTail?: string;
  detail?: unknown;
};

function tail(s: string, n = 2000): string {
  return s.length <= n ? s : s.slice(-n);
}

function parseArgs(argv: string[]): { evalId: string; iterations: number; model: string | null } {
  const positional: string[] = [];
  let model: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--model") {
      model = argv[i + 1] ?? null;
      i += 1;
    } else if (a.startsWith("--model=")) {
      model = a.slice("--model=".length);
    } else {
      positional.push(a);
    }
  }
  if (positional.length < 2) {
    console.error("Usage: tsx src/multi-runner.ts <EVAL_ID> <ITERATIONS> [--model <alias>]");
    process.exit(2);
  }
  const evalId = positional[0].toUpperCase();
  const iterations = Number.parseInt(positional[1], 10);
  if (!Number.isFinite(iterations) || iterations < 1) {
    console.error(`Invalid iterations: ${positional[1]}`);
    process.exit(2);
  }
  return { evalId, iterations, model };
}

function findEval(id: string): EvalCase {
  const match = evals.find((e) => e.id.toUpperCase() === id);
  if (!match) {
    console.error(`Unknown eval: ${id}. Known: ${evals.map((e) => e.id).join(", ")}`);
    process.exit(2);
  }
  return match;
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function summarize(records: IterRecord[]): {
  passRate: number;
  passCount: number;
  failureBuckets: Record<string, number>;
  meanDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  stdDevDurationMs: number;
} {
  const n = records.length;
  const passCount = records.filter((r) => r.passed).length;
  const passRate = passCount / n;
  const failureBuckets: Record<string, number> = {};
  for (const r of records) {
    if (!r.passed && r.failureBucket) {
      failureBuckets[r.failureBucket] = (failureBuckets[r.failureBucket] ?? 0) + 1;
    }
  }
  const durations = records.map((r) => r.durationMs);
  const meanDur = durations.reduce((a, d) => a + d, 0) / n;
  const variance =
    durations.reduce((a, d) => a + (d - meanDur) ** 2, 0) / n;
  return {
    passRate,
    passCount,
    failureBuckets,
    meanDurationMs: meanDur,
    minDurationMs: Math.min(...durations),
    maxDurationMs: Math.max(...durations),
    stdDevDurationMs: Math.sqrt(variance),
  };
}

async function runIteration(
  evalCase: EvalCase,
  iter: number,
  model: string | null,
  runDir: string
): Promise<IterRecord> {
  const startedAt = new Date().toISOString();
  const iterStem = `iter-${String(iter).padStart(2, "0")}`;

  if (evalCase.setup) {
    await evalCase.setup();
  }

  let result: EvalResult;
  let agentExit: number | null = null;
  let agentTimedOut = false;
  let agentModel: string | null = null;
  let agentStderrTail: string | undefined;
  let agentStdoutTail: string | undefined;

  try {
    const driverOpts: { timeoutMs?: number; model?: string } = {};
    if (model) driverOpts.model = model;
    if (evalCase.agentTimeoutMs) driverOpts.timeoutMs = evalCase.agentTimeoutMs;
    const driver = await runClaude(evalCase.prompt, driverOpts);
    agentExit = driver.exitCode;
    agentTimedOut = driver.timedOut;
    agentModel = driver.model;
    agentStderrTail = tail(driver.stderr);
    agentStdoutTail = tail(driver.transcript);
    writeFileSync(resolve(runDir, `${iterStem}.agent.stdout.log`), driver.transcript);
    writeFileSync(resolve(runDir, `${iterStem}.agent.stderr.log`), driver.stderr);
    const ctx: GradeContext = { runDir, iter };
    if (driver.timedOut) {
      result = {
        id: evalCase.id,
        passed: false,
        comment: "Agent timed out before completing the task.",
        durationMs: driver.durationMs,
        failureBucket: "stalled",
      };
    } else {
      result = await evalCase.grade(driver, ctx);
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
        console.warn(`  iter ${iter} teardown failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return {
    iter,
    startedAt,
    passed: result.passed,
    comment: result.comment,
    durationMs: result.durationMs,
    failureBucket: result.failureBucket,
    agentExit,
    agentTimedOut,
    agentModel,
    agentStderrTail,
    agentStdoutTail,
    detail: result.detail,
  };
}

async function main(): Promise<void> {
  const { evalId, iterations, model } = parseArgs(process.argv.slice(2));
  const evalCase = findEval(evalId);

  const claudeVersion = await getClaudeVersion();

  console.log(`Liferay: ${BASE_URL}`);
  console.log(`Claude CLI: ${claudeVersion}`);
  console.log(`Model: ${model ?? "(default — not pinned)"}`);
  console.log("health check...");
  await healthCheck();
  console.log("  ok\n");

  const modelTag = model ? `-${model.replace(/[^a-zA-Z0-9._-]/g, "_")}` : "";
  const runId = `${evalCase.id}${modelTag}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const runDir = resolve(RESULTS_ROOT, runId);
  mkdirSync(runDir, { recursive: true });
  let rubricSha256: string | null = null;
  if (evalCase.rubricPath) {
    rubricSha256 = loadRubric(evalCase.rubricPath).sha256;
  }

  console.log(`Run dir: ${runDir}`);
  console.log(`Eval: ${evalCase.id} — ${evalCase.description}`);
  console.log(`Tier: ${evalCase.tier} | Pass rule: ${evalCase.passRule}`);
  if (evalCase.rubricPath) {
    console.log(`Rubric: ${evalCase.rubricPath} (sha256=${rubricSha256?.slice(0, 12)})`);
  }
  console.log(`Prompt: ${evalCase.prompt}`);
  console.log(`Iterations: ${iterations}\n`);

  const records: IterRecord[] = [];
  for (let i = 1; i <= iterations; i += 1) {
    process.stdout.write(`iter ${i}/${iterations} ... `);
    const rec = await runIteration(evalCase, i, model, runDir);
    records.push(rec);
    const flag = rec.passed ? "PASS" : "FAIL";
    console.log(
      `${flag} dur=${fmtMs(rec.durationMs)} exit=${rec.agentExit}${rec.agentTimedOut ? " TIMEOUT" : ""}${rec.failureBucket ? ` bucket=${rec.failureBucket}` : ""}`
    );
    if (!rec.passed) console.log(`  ${rec.comment}`);
    writeFileSync(resolve(runDir, `iter-${String(i).padStart(2, "0")}.json`), JSON.stringify(rec, null, 2));
  }

  const summary = summarize(records);
  const summaryPayload = {
    evalId: evalCase.id,
    tier: evalCase.tier,
    passRule: evalCase.passRule,
    prompt: evalCase.prompt,
    iterations,
    provenance: {
      claudeVersion,
      modelRequested: model,
      claudeCwd: process.cwd(),
      rubricPath: evalCase.rubricPath ?? null,
      rubricSha256,
      startedAt: records[0]?.startedAt,
      finishedAt: new Date().toISOString(),
    },
    summary,
    records,
  };
  writeFileSync(resolve(runDir, "summary.json"), JSON.stringify(summaryPayload, null, 2));

  const bucketLine = Object.entries(summary.failureBuckets)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");

  console.log("\n=== Summary ===");
  console.log(`Pass rate:       ${summary.passCount}/${iterations} (${(summary.passRate * 100).toFixed(1)}%)`);
  console.log(`Tier:            ${evalCase.tier} (target ${evalCase.tier === "baseline" ? "≥95%" : "≥70%"})`);
  console.log(`Pass rule:       ${evalCase.passRule}`);
  if (bucketLine) {
    console.log(`Failure buckets: ${bucketLine}`);
  }
  console.log(`Duration:        mean=${fmtMs(summary.meanDurationMs)} min=${fmtMs(summary.minDurationMs)} max=${fmtMs(summary.maxDurationMs)} stddev=${fmtMs(summary.stdDevDurationMs)}`);
  console.log(`Results dir:     ${runDir}`);

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
