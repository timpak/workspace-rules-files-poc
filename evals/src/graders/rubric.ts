import { spawn } from "node:child_process";

const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "sonnet";
const JUDGE_TIMEOUT_MS = 120_000;

export type RubricResult = {
  key: string;
  score: number;
  comment: string;
  passed: boolean;
};

type JudgeOutput = { score: number; reasoning: string };

function parseJudgeText(text: string): JudgeOutput {
  const tryParse = (s: string): JudgeOutput | null => {
    try {
      const obj = JSON.parse(s);
      if (typeof obj?.score === "number" && typeof obj?.reasoning === "string") {
        return { score: obj.score, reasoning: obj.reasoning };
      }
    } catch {
      // fall through
    }
    return null;
  };

  const direct = tryParse(text.trim());
  if (direct) return direct;

  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    const parsed = tryParse(match[0]);
    if (parsed) return parsed;
  }

  throw new Error(`Could not parse judge response as JSON: ${text.slice(0, 500)}`);
}

async function runJudge(judgePrompt: string): Promise<JudgeOutput> {
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
        resolvePromise(parseJudgeText(resultText));
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
  rubricCriteria: string[];
  transcript: string;
  passThreshold?: number;
}): Promise<RubricResult> {
  const { key, prompt, rubricCriteria, transcript, passThreshold = 0.75 } = params;

  const judgePrompt = `You are evaluating whether an AI coding agent satisfied a rubric on a Liferay-related task. You are scoring the agent's transcript against specific criteria.

<original_user_prompt>
${prompt}
</original_user_prompt>

<agent_transcript>
${transcript}
</agent_transcript>

<rubric>
${rubricCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}
</rubric>

Score the agent on a 0.0–1.0 scale equal to the fraction of rubric items clearly satisfied by the transcript. Be strict: if a criterion is ambiguous or unverifiable from the transcript, do not count it as satisfied.

Reply with ONLY a single JSON object on one line, no markdown, no code fences, no commentary. Schema:
{"score": <number between 0 and 1>, "reasoning": "<one paragraph listing each rubric item with satisfied/not-satisfied/unclear and a one-sentence justification>"}`;

  const { score, reasoning } = await runJudge(judgePrompt);

  return {
    key,
    score,
    comment: reasoning,
    passed: score >= passThreshold,
  };
}
