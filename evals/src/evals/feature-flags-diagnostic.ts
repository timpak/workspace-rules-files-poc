import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT, extractFinalResponse } from "../driver.js";
import { categorize, type CriterionOutcome } from "../graders/bucket.js";
import { gradeRubric } from "../graders/rubric.js";
import { standardCleanupHooks } from "./shared.js";
import type { EvalCase, EvalResult } from "./types.js";

const PROMPT = `I'm trying to create a content page via \`POST http://localhost:8080/o/headless-admin-site/v1.0/sites/MY_SITE_ERC/site-pages\` and the response is \`400 UnsupportedOperationException\`. The site exists — \`GET /sites/MY_SITE_ERC\` returns 200. My OAuth token has \`Liferay.Headless.Admin.Site.everything\`. BasicAuth works on other endpoints (\`GET /o/c/users/\` returns 200). Why is this POST failing?`;

const RUBRIC_PATH = resolve(REPO_ROOT, "evals/rubrics/feature-flags-diagnostic.md");
const ID = "feature-flags-diagnostic";

const hooks = standardCleanupHooks();

export const featureFlagsDiagnostic: EvalCase = {
  id: ID,
  description: "HARD GATE diagnostic eval for the feature-flags skill (silent 400 → identify LPD-35443).",
  prompt: PROMPT,
  tier: "standard",
  passRule: "hard-gate",
  rubricPath: RUBRIC_PATH,
  setup: hooks.setup,
  teardown: hooks.teardown,
  grade: async (driver): Promise<EvalResult> => {
    const response = extractFinalResponse(readFileSync(driver.transcriptPath, "utf8")).trim();

    if (!response) {
      const criteria: CriterionOutcome[] = [
        { id: "C1", passed: false, bucketOnFail: "stalled" },
      ];
      return {
        id: ID,
        passed: false,
        comment: "Agent produced no final response.",
        durationMs: driver.durationMs,
        failureBucket: categorize({
          passed: false,
          agentTimedOut: driver.timedOut,
          criteria,
        }),
        detail: { criteria },
      };
    }

    let judgeResult;
    try {
      judgeResult = await gradeRubric({
        key: ID,
        prompt: PROMPT,
        rubricPath: RUBRIC_PATH,
        criterionIds: ["C1"],
        transcript: response,
      });
    } catch (err) {
      return {
        id: ID,
        passed: false,
        comment: `Judge error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: driver.durationMs,
        failureBucket: "unknown",
      };
    }

    const c1 = judgeResult.criteria.find((c) => c.id === "C1");
    const c1Passed = c1?.passed === true;
    const criteria: CriterionOutcome[] = [
      { id: "C1", passed: c1Passed, bucketOnFail: "rule-misapplied" },
    ];

    const passed = c1Passed;
    const failureBucket = categorize({
      passed,
      agentTimedOut: driver.timedOut,
      criteria,
    });

    return {
      id: ID,
      passed,
      comment: c1?.reasoning ?? "Judge returned no reasoning for C1.",
      durationMs: driver.durationMs,
      failureBucket,
      detail: { criteria, judgeResult },
    };
  },
};
