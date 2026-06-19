import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evals } from "./evals/index.js";
import { runAgent, getAgentVersion } from "./driver.js";
import { healthCheck, BASE_URL } from "./portal.js";
import { checkRequiredFlags } from "./preflight.js";
import { recoverOrphanStash, stashWorkspace, unstashWorkspace } from "./evals/shared.js";
import { loadRubric } from "./graders/rubric.js";
import type {
  EvalCase,
  EvalResult,
  FailureBucket,
  GradeContext,
} from "./evals/types.js";
import type { CriterionOutcome } from "./graders/bucket.js";

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

type ParsedArgs = {
  evalIds: string[];
  all: boolean;
  iterations: number;
  model: string | null;
  release: string;
  engine: "claude" | "gemini";
};

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let model: string | null = null;
  let iterations = 1;
  let release: string | null = null;
  let all = false;
  let engine: "claude" | "gemini" | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--model") {
      model = argv[i + 1] ?? null;
      i += 1;
    } else if (a.startsWith("--model=")) {
      model = a.slice("--model=".length);
    } else if (a === "--iters" || a === "-n") {
      iterations = Number.parseInt(argv[i + 1] ?? "", 10);
      i += 1;
    } else if (a.startsWith("--iters=")) {
      iterations = Number.parseInt(a.slice("--iters=".length), 10);
    } else if (a === "--release") {
      release = argv[i + 1] ?? null;
      i += 1;
    } else if (a.startsWith("--release=")) {
      release = a.slice("--release=".length);
    } else if (a === "--all") {
      all = true;
    } else if (a === "--engine") {
      const parsedEngine = argv[i + 1];
      if (parsedEngine === "claude" || parsedEngine === "gemini") {
        engine = parsedEngine;
      } else {
        console.error(`Invalid engine: ${parsedEngine}. Must be 'claude' or 'gemini'.`);
        process.exit(2);
      }
      i += 1;
    } else if (a.startsWith("--engine=")) {
      const parsedEngine = a.slice("--engine=".length);
      if (parsedEngine === "claude" || parsedEngine === "gemini") {
        engine = parsedEngine;
      } else {
        console.error(`Invalid engine: ${parsedEngine}. Must be 'claude' or 'gemini'.`);
        process.exit(2);
      }
    } else {
      positional.push(a);
    }
  }

  // Fallback to process.env.EVALS_ENGINE or default to claude
  const resolvedEngine: "claude" | "gemini" =
    engine ??
    ((process.env.EVALS_ENGINE === "claude" || process.env.EVALS_ENGINE === "gemini")
      ? process.env.EVALS_ENGINE
      : "claude");

  if (!release) {
    console.error("--release <tag> is required (e.g. --release 2026.q1)");
    process.exit(2);
  }
  if (!all && positional.length < 1) {
    console.error(
      "Usage: tsx src/runner.ts (--all | <EVAL_ID> [<EVAL_ID> ...]) --release <tag> [--iters N] [--model <alias>] [--engine claude|gemini]"
    );
    process.exit(2);
  }
  if (!Number.isFinite(iterations) || iterations < 1) {
    console.error(`Invalid iterations: ${iterations}`);
    process.exit(2);
  }
  return {
    evalIds: positional.map((s) => s.toUpperCase()),
    all,
    iterations,
    model,
    release,
    engine: resolvedEngine,
  };
}

function pickEvals(args: ParsedArgs): EvalCase[] {
  if (args.all) return [...evals];
  const wanted = new Set(args.evalIds);
  const found = evals.filter((e) => wanted.has(e.id.toUpperCase()));
  const missing = args.evalIds.filter(
    (id) => !evals.some((e) => e.id.toUpperCase() === id)
  );
  if (missing.length) {
    console.error(`Unknown eval(s): ${missing.join(", ")}`);
    console.error(`Known: ${evals.map((e) => e.id).join(", ")}`);
    process.exit(2);
  }
  return found;
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function tail(s: string, n = 2000): string {
  return s.length <= n ? s : s.slice(-n);
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
  const variance = durations.reduce((a, d) => a + (d - meanDur) ** 2, 0) / n;
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

function renderAuditSection(
  evalCase: EvalCase,
  records: IterRecord[],
  evalRelDir: string
): string {
  const overall = records.every((r) => r.passed) ? "PASS" : "FAIL";
  const lines: string[] = [];

  lines.push(`## ${evalCase.id} — ${overall}`);
  lines.push("");
  lines.push(`**Tier:** ${evalCase.tier} | **Pass rule:** ${evalCase.passRule}`);
  lines.push(`**Prompt:** \`${evalCase.prompt}\``);
  lines.push("");

  for (const rec of records) {
    const flag = rec.passed ? "PASS" : "FAIL";
    lines.push(`### Iter ${rec.iter} — ${flag}`);
    lines.push("");
    lines.push(`**Duration:** ${fmtMs(rec.durationMs)} | **Exit:** ${rec.agentExit ?? "—"}${rec.agentTimedOut ? " (TIMEOUT)" : ""}`);
    if (!rec.passed) {
      lines.push(`**Comment:** ${rec.comment}`);
    }
    lines.push("");

    const detail = rec.detail as Record<string, unknown> | undefined;
    const criteria = detail?.criteria as CriterionOutcome[] | undefined;

    if (criteria && criteria.length > 0) {
      lines.push("| Criterion | Grader | Passed | Detail |");
      lines.push("|-----------|--------|--------|--------|");
      for (const c of criteria) {
        const grader = c.graderType === "llm-judge" ? "[llm-judge]" : "[harness]";
        const passed = c.passed ? "✓" : "✗";
        const detail = c.reasoning ?? (c.passed ? "—" : `bucket: ${c.bucketOnFail}`);
        lines.push(`| ${c.id} | ${grader} | ${passed} | ${detail} |`);
      }
      lines.push("");
    }

    const iterStem = `iter-${String(rec.iter).padStart(2, "0")}`;
    const logLinks: string[] = [
      `[stdout](${evalRelDir}/${iterStem}.agent.stdout.log)`,
    ];
    const hasJudgePrompt = criteria?.some((c) => c.graderType === "llm-judge");
    if (hasJudgePrompt) {
      logLinks.push(`[judge prompt](${evalRelDir}/${iterStem}.judge-prompt.txt)`);
    }
    lines.push(`_Logs: ${logLinks.join(" · ")}_`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

async function runIteration(
  evalCase: EvalCase,
  iter: number,
  model: string | null,
  evalDir: string
): Promise<IterRecord> {
  const startedAt = new Date().toISOString();
  const iterStem = `iter-${String(iter).padStart(2, "0")}`;
  const judgePromptPath = resolve(evalDir, `${iterStem}.judge-prompt.txt`);

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
    const transcriptFile = resolve(evalDir, `${iterStem}.agent.stdout.log`);
    const driverOpts: { timeoutMs?: number; model?: string; transcriptFile: string } = { transcriptFile };
    if (model) driverOpts.model = model;
    if (evalCase.agentTimeoutMs) driverOpts.timeoutMs = evalCase.agentTimeoutMs;
    const driver = await runAgent(evalCase.prompt, driverOpts);
    agentExit = driver.exitCode;
    agentTimedOut = driver.timedOut;
    agentModel = driver.model;
    agentStderrTail = tail(driver.stderr);
    agentStdoutTail = tail(readFileSync(driver.transcriptPath, "utf8"));
    writeFileSync(resolve(evalDir, `${iterStem}.agent.stderr.log`), driver.stderr);
    const ctx: GradeContext = { runDir: evalDir, iter, judgePromptPath };
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
        console.warn(
          `  iter ${iter} teardown failed: ${err instanceof Error ? err.message : String(err)}`
        );
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

type EvalSummaryEntry = {
  evalId: string;
  tier: string;
  passRule: string;
  passed: boolean;
  passCount: number;
  iterations: number;
  comment: string;
  durationMs: number;
  failureBucket: FailureBucket | undefined;
};

async function runEval(
  evalCase: EvalCase,
  iterations: number,
  model: string | null,
  agentVersion: string,
  runRoot: string,
  auditPath: string
): Promise<EvalSummaryEntry> {
  const evalDir = resolve(runRoot, evalCase.id);
  mkdirSync(evalDir, { recursive: true });
  let rubricSha256: string | null = null;
  if (evalCase.rubricPath) {
    rubricSha256 = loadRubric(evalCase.rubricPath).sha256;
  }

  console.log(`\n=== ${evalCase.id} ===`);
  console.log(`Tier: ${evalCase.tier} | Pass rule: ${evalCase.passRule}`);
  if (evalCase.rubricPath) {
    console.log(`Rubric: ${evalCase.rubricPath} (sha256=${rubricSha256?.slice(0, 12)})`);
  }
  console.log(`Prompt: ${evalCase.prompt}`);
  console.log(`Iterations: ${iterations}`);
  console.log(`Eval dir: ${evalDir}`);

  const records: IterRecord[] = [];
  for (let i = 1; i <= iterations; i += 1) {
    process.stdout.write(`iter ${i}/${iterations} ... `);
    const rec = await runIteration(evalCase, i, model, evalDir);
    records.push(rec);
    const flag = rec.passed ? "PASS" : "FAIL";
    console.log(
      `${flag} dur=${fmtMs(rec.durationMs)} exit=${rec.agentExit}${rec.agentTimedOut ? " TIMEOUT" : ""}${rec.failureBucket ? ` bucket=${rec.failureBucket}` : ""}`
    );
    if (!rec.passed) console.log(`  ${rec.comment}`);
    writeFileSync(
      resolve(evalDir, `iter-${String(i).padStart(2, "0")}.json`),
      JSON.stringify(rec, null, 2)
    );
  }

  const summary = summarize(records);
  const summaryPayload = {
    evalId: evalCase.id,
    tier: evalCase.tier,
    passRule: evalCase.passRule,
    prompt: evalCase.prompt,
    iterations,
    provenance: {
      agentVersion,
      engine: process.env.EVALS_ENGINE,
      modelRequested: model,
      agentCwd: process.cwd(),
      rubricPath: evalCase.rubricPath ?? null,
      rubricSha256,
      startedAt: records[0]?.startedAt,
      finishedAt: new Date().toISOString(),
    },
    summary,
    records,
  };
  writeFileSync(resolve(evalDir, "summary.json"), JSON.stringify(summaryPayload, null, 2));

  if (iterations > 1) {
    const bucketLine = Object.entries(summary.failureBuckets)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    console.log(`  pass rate: ${summary.passCount}/${iterations} (${(summary.passRate * 100).toFixed(1)}%)`);
    if (bucketLine) console.log(`  failure buckets: ${bucketLine}`);
    console.log(
      `  duration: mean=${fmtMs(summary.meanDurationMs)} min=${fmtMs(summary.minDurationMs)} max=${fmtMs(summary.maxDurationMs)} stddev=${fmtMs(summary.stdDevDurationMs)}`
    );
  }

  // Append this eval's section to the run audit doc (relative path for log links).
  const auditSection = renderAuditSection(evalCase, records, evalCase.id);
  appendFileSync(auditPath, auditSection);

  const lastRecord = records[records.length - 1]!;
  return {
    evalId: evalCase.id,
    tier: evalCase.tier,
    passRule: evalCase.passRule,
    passed: summary.passCount === iterations,
    passCount: summary.passCount,
    iterations,
    comment: lastRecord.comment,
    durationMs: summary.meanDurationMs,
    failureBucket: lastRecord.failureBucket,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  
  // Set environment variable immediately for driver routing
  process.env.EVALS_ENGINE = args.engine;

  const cases = pickEvals(args);
  const { iterations, model, release } = args;

  const agentVersion = await getAgentVersion();
  const engineLabel = args.engine === "gemini" ? "Gemini CLI" : "Claude CLI";

  console.log(`Release: ${release}`);
  console.log(`Liferay: ${BASE_URL}`);
  console.log(`${engineLabel}: ${agentVersion}`);
  console.log(`Model: ${model ?? "(default — not pinned)"}`);
  console.log("health check...");
  await healthCheck();
  console.log("  ok");

  const requiredFlags = new Set<string>();
  for (const c of cases) {
    for (const f of c.requiredFeatureFlags ?? []) requiredFlags.add(f);
  }
  if (requiredFlags.size > 0) {
    const flagList = [...requiredFlags].sort();
    console.log(`feature flag preflight: ${flagList.join(", ")}`);
    const { ok, missing } = checkRequiredFlags(flagList);
    if (!ok) {
      console.error("");
      console.error(
        `Pre-flight failed — required feature flag(s) not enabled in bundles/portal-ext.properties:`
      );
      for (const f of missing) console.error(`  - ${f}`);
      console.error("");
      console.error("Add the following line(s) to bundles/portal-ext.properties, then restart the bundle:");
      for (const f of missing) console.error(`  feature.flag.${f}=true`);
      process.exit(2);
    }
    console.log("  ok");
  }

  const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runId = `run-${runTimestamp}`;
  const runRoot = resolve(RESULTS_ROOT, release, runId);
  mkdirSync(runRoot, { recursive: true });

  const auditPath = resolve(runRoot, "run-audit.md");
  const modelTag = model ? ` · model: ${model}` : "";
  writeFileSync(
    auditPath,
    `# Run Audit: ${release} — ${runId}\n\n` +
    `**${engineLabel}:** ${agentVersion}${modelTag}  \n` +
    `**Evals:** ${cases.map((c) => c.id).join(", ")}  \n` +
    `**Started:** ${new Date().toISOString()}\n\n` +
    `---\n\n`
  );

  console.log(`\nRun root: ${runRoot}`);

  recoverOrphanStash();
  stashWorkspace();

  const startedAt = new Date().toISOString();
  const evalEntries: EvalSummaryEntry[] = [];

  try {
    for (const c of cases) {
      const entry = await runEval(c, iterations, model, agentVersion, runRoot, auditPath);
      evalEntries.push(entry);
    }
  } finally {
    unstashWorkspace();
  }

  const totalPassed = evalEntries.filter((e) => e.passed).length;
  const totalFailed = evalEntries.length - totalPassed;

  const runSummary = {
    release,
    runId,
    engine: args.engine,
    agentVersion,
    modelRequested: model,
    startedAt,
    finishedAt: new Date().toISOString(),
    totalEvals: evalEntries.length,
    passed: totalPassed,
    failed: totalFailed,
    passRate: totalPassed / evalEntries.length,
    evals: evalEntries,
  };
  writeFileSync(resolve(runRoot, "run-summary.json"), JSON.stringify(runSummary, null, 2));

  console.log(`\n${totalPassed}/${evalEntries.length} passed across ${cases.length} eval(s)`);
  console.log(`Run summary: ${resolve(runRoot, "run-summary.json")}`);
  console.log(`Run audit:   ${auditPath}`);
  process.exit(totalFailed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(2);
});
