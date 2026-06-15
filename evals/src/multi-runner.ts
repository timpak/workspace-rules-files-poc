import { mkdirSync, writeFileSync } from "node:fs";
import type { GradeContext } from "./evals/types.js";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { evals } from "./evals/index.js";
import { runClaude, getClaudeVersion } from "./driver.js";
import { healthCheck, BASE_URL } from "./portal.js";
import type { EvalCase, EvalResult } from "./evals/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_ROOT = resolve(__dirname, "..", "results");

type IterRecord = {
  iter: number;
  startedAt: string;
  passed: boolean;
  score: number;
  comment: string;
  durationMs: number;
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
  meanScore: number;
  meanDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  stdDevDurationMs: number;
} {
  const n = records.length;
  const passCount = records.filter((r) => r.passed).length;
  const passRate = passCount / n;
  const meanScore = records.reduce((a, r) => a + r.score, 0) / n;
  const durations = records.map((r) => r.durationMs);
  const meanDur = durations.reduce((a, d) => a + d, 0) / n;
  const variance =
    durations.reduce((a, d) => a + (d - meanDur) ** 2, 0) / n;
  return {
    passRate,
    passCount,
    meanScore,
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
    const driver = await runClaude(evalCase.prompt, model ? { model } : {});
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
        score: 0,
        comment: "Agent timed out before completing the task.",
        durationMs: driver.durationMs,
      };
    } else {
      result = await evalCase.grade(driver, ctx);
    }
  } catch (err) {
    result = {
      id: evalCase.id,
      passed: false,
      score: 0,
      comment: `Eval threw: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: 0,
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
    score: result.score,
    comment: result.comment,
    durationMs: result.durationMs,
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
  console.log(`Run dir: ${runDir}`);
  console.log(`Eval: ${evalCase.id} — ${evalCase.description}`);
  console.log(`Prompt: ${evalCase.prompt}`);
  console.log(`Iterations: ${iterations}\n`);

  const records: IterRecord[] = [];
  for (let i = 1; i <= iterations; i += 1) {
    process.stdout.write(`iter ${i}/${iterations} ... `);
    const rec = await runIteration(evalCase, i, model, runDir);
    records.push(rec);
    const flag = rec.passed ? "PASS" : "FAIL";
    console.log(
      `${flag} score=${rec.score.toFixed(2)} dur=${fmtMs(rec.durationMs)} exit=${rec.agentExit}${rec.agentTimedOut ? " TIMEOUT" : ""}`
    );
    if (!rec.passed) console.log(`  ${rec.comment}`);
    writeFileSync(resolve(runDir, `iter-${String(i).padStart(2, "0")}.json`), JSON.stringify(rec, null, 2));
  }

  const summary = summarize(records);
  const summaryPayload = {
    evalId: evalCase.id,
    prompt: evalCase.prompt,
    iterations,
    provenance: {
      claudeVersion,
      modelRequested: model,
      claudeCwd: process.cwd(),
      startedAt: records[0]?.startedAt,
      finishedAt: new Date().toISOString(),
    },
    summary,
    records,
  };
  writeFileSync(resolve(runDir, "summary.json"), JSON.stringify(summaryPayload, null, 2));

  console.log("\n=== Summary ===");
  console.log(`Pass rate:       ${summary.passCount}/${iterations} (${(summary.passRate * 100).toFixed(1)}%)`);
  console.log(`Mean score:      ${summary.meanScore.toFixed(3)}`);
  console.log(`Duration:        mean=${fmtMs(summary.meanDurationMs)} min=${fmtMs(summary.minDurationMs)} max=${fmtMs(summary.maxDurationMs)} stddev=${fmtMs(summary.stdDevDurationMs)}`);
  console.log(`Results dir:     ${runDir}`);

  process.exit(summary.passCount === iterations ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
