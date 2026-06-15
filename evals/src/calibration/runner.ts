import { readFileSync } from "node:fs";
import { resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { evals } from "../evals/index.js";
import { gradeRubric, loadRubric } from "../graders/rubric.js";
import { cohensKappa, kappaVerdict } from "./kappa.js";

type HumanScore = { id: string; passed: boolean };

type CalibrationItem = {
  transcriptPath: string;
  humanScores: HumanScore[];
};

type CalibrationFile = {
  evalId: string;
  rubricPath: string;
  items: CalibrationItem[];
};

function parseArgs(argv: string[]): { calibrationPath: string; threshold: number } {
  let calibrationPath: string | null = null;
  let threshold = 0.7;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--threshold") {
      threshold = Number.parseFloat(argv[i + 1] ?? "");
      i += 1;
    } else if (a.startsWith("--threshold=")) {
      threshold = Number.parseFloat(a.slice("--threshold=".length));
    } else if (!calibrationPath) {
      calibrationPath = a;
    }
  }
  if (!calibrationPath) {
    console.error("Usage: tsx src/calibration/runner.ts <calibration-file.json> [--threshold 0.7]");
    process.exit(2);
  }
  if (!Number.isFinite(threshold)) {
    console.error(`Invalid threshold`);
    process.exit(2);
  }
  return { calibrationPath, threshold };
}

function loadCalibration(path: string): { file: CalibrationFile; baseDir: string } {
  const absPath = isAbsolute(path) ? path : resolve(process.cwd(), path);
  const raw = readFileSync(absPath, "utf8");
  const file = JSON.parse(raw) as CalibrationFile;
  if (!file.evalId || !file.rubricPath || !Array.isArray(file.items)) {
    throw new Error(`Calibration file missing required fields: ${absPath}`);
  }
  return { file, baseDir: dirname(absPath) };
}

function resolveRelative(baseDir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(baseDir, p);
}

async function main(): Promise<void> {
  const { calibrationPath, threshold } = parseArgs(process.argv.slice(2));
  const { file, baseDir } = loadCalibration(calibrationPath);

  const evalCase = evals.find((e) => e.id === file.evalId);
  if (!evalCase) {
    console.error(
      `Eval not registered: ${file.evalId}. Known: ${evals.map((e) => e.id).join(", ") || "(none)"}`
    );
    process.exit(2);
  }

  const rubricPath = resolveRelative(baseDir, file.rubricPath);
  const rubricSha = loadRubric(rubricPath).sha256;

  console.log(`Calibration: ${file.evalId}`);
  console.log(`Rubric: ${rubricPath} (sha256=${rubricSha.slice(0, 12)})`);
  console.log(`Items: ${file.items.length}`);
  console.log(`Threshold: kappa >= ${threshold}\n`);

  // criterionId -> array of [human, judge] pairs across calibration items
  const pairsByCriterion = new Map<string, Array<[boolean, boolean]>>();

  for (let i = 0; i < file.items.length; i += 1) {
    const item = file.items[i];
    const transcriptPath = resolveRelative(baseDir, item.transcriptPath);
    const transcript = readFileSync(transcriptPath, "utf8");
    const criterionIds = item.humanScores.map((s) => s.id);

    process.stdout.write(`item ${i + 1}/${file.items.length} ${item.transcriptPath} ... `);
    let judgeResult;
    try {
      judgeResult = await gradeRubric({
        key: file.evalId,
        prompt: evalCase.prompt,
        rubricPath,
        criterionIds,
        transcript,
      });
    } catch (err) {
      console.log(`JUDGE ERROR: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    const judgeById = new Map(judgeResult.criteria.map((c) => [c.id, c.passed]));
    for (const human of item.humanScores) {
      const judgePassed = judgeById.get(human.id);
      if (judgePassed === undefined) continue;
      const pairs = pairsByCriterion.get(human.id) ?? [];
      pairs.push([human.passed, judgePassed]);
      pairsByCriterion.set(human.id, pairs);
    }

    const agreeCount = item.humanScores.filter(
      (h) => judgeById.get(h.id) === h.passed
    ).length;
    console.log(`agree ${agreeCount}/${item.humanScores.length}`);
  }

  console.log("\n=== Per-criterion kappa ===");
  const header = "  id     n   observed  human-pass  judge-pass  kappa   verdict";
  console.log(header);
  const sortedIds = [...pairsByCriterion.keys()].sort();
  for (const id of sortedIds) {
    const pairs = pairsByCriterion.get(id)!;
    const r = cohensKappa(pairs);
    const kappaStr = r.kappa === null ? "  n/a " : r.kappa.toFixed(3).padStart(6);
    const verdict = kappaVerdict(r.kappa, threshold);
    console.log(
      `  ${id.padEnd(6)} ${String(r.n).padStart(3)}   ` +
        `${r.observedAgreement.toFixed(2).padStart(6)}    ` +
        `${r.humanPassRate.toFixed(2).padStart(6)}      ` +
        `${r.judgePassRate.toFixed(2).padStart(6)}    ` +
        `${kappaStr}  ${verdict}`
    );
  }

  const verdicts = sortedIds.map((id) =>
    kappaVerdict(cohensKappa(pairsByCriterion.get(id)!).kappa, threshold)
  );
  const anyRefine = verdicts.includes("REFINE");
  console.log(
    `\nOverall: ${verdicts.filter((v) => v === "SHIP").length}/${verdicts.length} criteria SHIP` +
      (anyRefine ? " — refine rubric or swap to assertion for REFINE rows." : "")
  );
}

const isCli = process.argv[1] === fileURLToPath(import.meta.url);
if (isCli) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(2);
  });
}
