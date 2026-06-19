import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT, extractFinalResponse } from "../driver.js";
import { categorize, type CriterionOutcome } from "../graders/bucket.js";
import { gradeRubric } from "../graders/rubric.js";
import { standardCleanupHooks } from "./shared.js";
import type { EvalCase, EvalResult, GradeContext } from "./types.js";

const ID = "guided-client-extension-routing";

const PROMPT = `I just set up Liferay for the first time. How do I start building stuff for my site?`;

const RUBRIC_PATH = resolve(REPO_ROOT, "evals/rubrics/guided-client-extension-routing.md");

const SCAFFOLD_DIRS = ["client-extensions", "modules", "themes"];

type SetupState = {
  preFiles: Set<string>;
};

const state: SetupState = { preFiles: new Set() };

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === "build" || e.name === ".gradle") continue;
      const full = join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else {
        try {
          if (statSync(full).isFile()) out.push(full);
        } catch {
          // ignore
        }
      }
    }
  }
  return out;
}

function snapshotScaffoldFiles(): Set<string> {
  const seen = new Set<string>();
  for (const sub of SCAFFOLD_DIRS) {
    for (const f of listFiles(resolve(REPO_ROOT, sub))) {
      seen.add(f);
    }
  }
  return seen;
}

const hooks = standardCleanupHooks();

export const guidedClientExtensionRouting: EvalCase = {
  id: ID,
  description:
    "HARD GATE routing eval for the guided-client-extension skill (no scaffolding artifacts on beginner cue; LLM-judged guidance offer).",
  prompt: PROMPT,
  tier: "standard",
  passRule: "hard-gate",
  rubricPath: RUBRIC_PATH,
  setup: async () => {
    await hooks.setup();
    state.preFiles = snapshotScaffoldFiles();
  },
  teardown: hooks.teardown,
  grade: async (driver, ctx?: GradeContext): Promise<EvalResult> => {
    const criteria: CriterionOutcome[] = [];

    // C1 — no new files under scaffold dirs.
    const postFiles = snapshotScaffoldFiles();
    const newFiles: string[] = [];
    for (const f of postFiles) {
      if (!state.preFiles.has(f)) newFiles.push(f);
    }
    const c1Pass = newFiles.length === 0;
    criteria.push({ id: "C1", passed: c1Pass, bucketOnFail: "wrong-skill-invoked", graderType: "harness" });

    // C2 — LLM-judged guidance offer (supporting only).
    const response = extractFinalResponse(driver.transcript).trim();

    if (!response) {
      criteria.push({ id: "C2", passed: false, bucketOnFail: "stalled" });
      const failureBucket = categorize({
        passed: c1Pass,
        agentTimedOut: driver.timedOut,
        criteria: c1Pass ? [criteria[1]!] : [criteria[0]!],
      });
      return {
        id: ID,
        passed: c1Pass,
        comment: c1Pass
          ? "C1 passed (no scaffolds), but the agent produced no final response."
          : `C1 failed: agent created ${newFiles.length} file(s) under scaffold dirs and also produced no response.`,
        durationMs: driver.durationMs,
        failureBucket,
        detail: { criteria, newFiles },
      };
    }

    let c2Pass = false;
    let c2Reason = "";
    try {
      const judge = await gradeRubric({
        key: ID,
        prompt: PROMPT,
        rubricPath: RUBRIC_PATH,
        criterionIds: ["C2"],
        transcript: response,
        savePromptTo: ctx?.judgePromptPath,
      });
      const c2 = judge.criteria.find((c) => c.id === "C2");
      c2Pass = c2?.passed === true;
      c2Reason = c2?.reasoning ?? "";
    } catch (err) {
      c2Reason = `judge error: ${err instanceof Error ? err.message : String(err)}`;
    }
    criteria.push({ id: "C2", passed: c2Pass, bucketOnFail: "rule-misapplied", graderType: "llm-judge", reasoning: c2Reason });

    // HARD GATE on C1; C2 supporting (bucket disambiguation).
    const passed = c1Pass;
    const failureBucket = categorize({
      passed,
      agentTimedOut: driver.timedOut,
      criteria: passed ? [] : criteria,
    });

    return {
      id: ID,
      passed,
      comment: passed
        ? c2Pass
          ? `C1 passed (no scaffolds) and judge confirmed guidance offer: ${c2Reason}`
          : `C1 passed (no scaffolds); judge did NOT confirm guidance offer: ${c2Reason}`
        : `C1 failed: agent created ${newFiles.length} file(s) under scaffold dirs (${newFiles.slice(0, 3).join(", ")}${newFiles.length > 3 ? "…" : ""}).`,
      durationMs: driver.durationMs,
      failureBucket,
      detail: { criteria, newFiles, c2Reason },
    };
  },
};
