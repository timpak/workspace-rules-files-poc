import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "sonnet";
const JUDGE_TIMEOUT_MS = 120_000;

export type CriterionResult = {
  id: string;
  passed: boolean;
  reasoning: string;
};

export type RubricResult = {
  key: string;
  rubricSha256: string;
  criteria: CriterionResult[];
};

export function loadRubric(rubricPath: string): { content: string; sha256: string } {
  const content = readFileSync(rubricPath, "utf8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  return { content, sha256 };
}

type JudgeOutput = { criteria: CriterionResult[] };

function parseJudgeText(text: string, expectedIds: string[]): JudgeOutput {
  const tryParse = (s: string): JudgeOutput | null => {
    let obj: unknown;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
    if (!obj || typeof obj !== "object") return null;
    const arr = (obj as { criteria?: unknown }).criteria;
    if (!Array.isArray(arr)) return null;
    const criteria: CriterionResult[] = [];
    for (const entry of arr) {
      if (!entry || typeof entry !== "object") return null;
      const e = entry as { id?: unknown; passed?: unknown; reasoning?: unknown };
      if (typeof e.id !== "string" || typeof e.passed !== "boolean" || typeof e.reasoning !== "string") {
        return null;
      }
      criteria.push({ id: e.id, passed: e.passed, reasoning: e.reasoning });
    }
    return { criteria };
  };

  const direct = tryParse(text.trim());
  const match = direct ?? (() => {
    const m = text.match(/\{[\s\S]*\}/);
    return m ? tryParse(m[0]) : null;
  })();
  if (!match) {
    throw new Error(`Could not parse judge response as JSON: ${text.slice(0, 500)}`);
  }

  const returnedIds = new Set(match.criteria.map((c) => c.id));
  const missing = expectedIds.filter((id) => !returnedIds.has(id));
  if (missing.length > 0) {
    throw new Error(`Judge response missing expected criterion IDs: ${missing.join(", ")}`);
  }
  return match;
}

async function runJudge(judgePrompt: string, expectedIds: string[]): Promise<JudgeOutput> {
  return await new Promise<JudgeOutput>((resolvePromise, rejectPromise) => {
    const args = [
      "-p",
      judgePrompt,
      "--model",
      JUDGE_MODEL,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];
    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectPromise(new Error(`Judge timed out after ${JUDGE_TIMEOUT_MS}ms`));
    }, JUDGE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectPromise(
          new Error(`Judge exited ${code}. stderr tail: ${stderr.slice(-500)}`)
        );
        return;
      }
      try {
        let resultText = stdout;
        const events: unknown[] = [];
        for (const line of stdout.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            events.push(JSON.parse(trimmed));
          } catch {
            // ignore malformed lines
          }
        }
        const resultEvent = [...events].reverse().find(
          (e) => e && typeof e === "object" && (e as { type?: string }).type === "result"
        );
        if (resultEvent && typeof (resultEvent as { result?: unknown }).result === "string") {
          resultText = (resultEvent as { result: string }).result;
        }
        resolvePromise(parseJudgeText(resultText, expectedIds));
      } catch (err) {
        rejectPromise(
          new Error(
            `Failed to parse judge output: ${err instanceof Error ? err.message : String(err)}\nstdout tail: ${stdout.slice(-500)}`
          )
        );
      }
    });
  });
}

export async function gradeRubric(params: {
  key: string;
  prompt: string;
  rubricPath: string;
  criterionIds: string[];
  transcript: string;
  savePromptTo?: string;
}): Promise<RubricResult> {
  const { key, prompt, rubricPath, criterionIds, transcript, savePromptTo } = params;
  const { content: rubricContent, sha256 } = loadRubric(rubricPath);

  const judgePrompt = `You are evaluating whether an AI coding agent satisfied a rubric on a Liferay-related task. Score the agent's transcript against each criterion in the rubric below.

<original_user_prompt>
${prompt}
</original_user_prompt>

<agent_transcript>
${transcript}
</agent_transcript>

<rubric>
${rubricContent}
</rubric>

Evaluate each criterion independently. A criterion passes ONLY if the transcript clearly satisfies it; if it is ambiguous or unverifiable, mark it as failed. The rubric may include anchored pass/borderline/fail examples — use them to calibrate.

Reply with ONLY a single JSON object on one line, no markdown, no code fences, no commentary. Schema:
{"criteria": [{"id": "<criterion id>", "passed": <true|false>, "reasoning": "<one sentence>"}, ...]}

The "id" values must be exactly: ${criterionIds.map((id) => `"${id}"`).join(", ")}. Return one entry per criterion, in that order.`;

  if (savePromptTo) {
    try { writeFileSync(savePromptTo, judgePrompt); } catch { /* best effort */ }
  }

  const { criteria } = await runJudge(judgePrompt, criterionIds);

  return { key, rubricSha256: sha256, criteria };
}
