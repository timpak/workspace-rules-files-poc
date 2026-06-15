import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { REPO_ROOT } from "../driver.js";
import { categorize, type CriterionOutcome } from "../graders/bucket.js";
import { standardCleanupHooks } from "./shared.js";
import type { EvalCase, EvalResult } from "./types.js";

const PROMPT = `Build a fragment called \`product-card\` for the marketing collection. It should have an editable product title (text) and an editable product image. Give it some basic padding and a subtle border via CSS so it works in a card layout. Drop it under a collection called \`marketing\` so the team can find it in the page editor.`;

const RUBRIC_PATH = resolve(REPO_ROOT, "evals/rubrics/scaffold-fragment-standard.md");
const CLIENT_EXTENSIONS = resolve(REPO_ROOT, "client-extensions");
const SKIP_DIRS = new Set(["node_modules", "build", "dist", ".gradle"]);

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = resolve(dir, name);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function findFragmentDir(): string | null {
  for (const path of walk(CLIENT_EXTENSIONS)) {
    if (path.endsWith("/product-card/fragment.json")) {
      return dirname(path);
    }
  }
  return null;
}

function isNestedUnderFragmentsGroup(fragmentDir: string): boolean {
  // Expect tail to match site-initializer/fragments/group/<collection>/fragments/product-card
  const rel = relative(REPO_ROOT, fragmentDir);
  return /[/\\]site-initializer[/\\]fragments[/\\]group[/\\][^/\\]+[/\\]fragments[/\\]product-card$/.test(
    rel
  );
}

function readJsonSafe(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function htmlHasEditableType(html: string, type: string | RegExp): boolean {
  const pattern =
    type instanceof RegExp
      ? type
      : new RegExp(`data-lfr-editable-type\\s*=\\s*["']${type}["']`);
  return pattern.test(html);
}

function cssIsScoped(css: string): { passed: boolean; offending?: string } {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const selectorRegex = /([^{};]+)\{/g;
  let match: RegExpExecArray | null;
  while ((match = selectorRegex.exec(stripped)) !== null) {
    const block = match[1].trim();
    if (!block) continue;
    if (block.startsWith("@")) continue;
    for (const sel of block.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (!/^[#.\[:&]/.test(sel)) {
        return { passed: false, offending: sel };
      }
    }
  }
  return { passed: true };
}

const hooks = standardCleanupHooks();

export const scaffoldFragmentStandard: EvalCase = {
  id: "scaffold-fragment-standard",
  description: "STRICT artifact eval for the scaffold-fragment skill (product-card fragment under marketing collection).",
  prompt: PROMPT,
  tier: "standard",
  passRule: "strict",
  rubricPath: RUBRIC_PATH,
  setup: hooks.setup,
  teardown: hooks.teardown,
  grade: async (driver): Promise<EvalResult> => {
    const fragmentDir = findFragmentDir();
    const criteria: CriterionOutcome[] = [];

    // C1 — directory nested correctly
    const c1Pass = fragmentDir !== null && isNestedUnderFragmentsGroup(fragmentDir);
    criteria.push({
      id: "C1",
      passed: c1Pass,
      bucketOnFail: fragmentDir === null ? "skill-not-invoked" : "artifact-malformed",
    });

    // C2 — four canonical files present
    const c2Pass =
      fragmentDir !== null &&
      ["fragment.json", "index.html", "index.css", "index.js"].every(
        (f) => readSafe(resolve(fragmentDir, f)) !== null
      );
    criteria.push({ id: "C2", passed: c2Pass, bucketOnFail: "artifact-malformed" });

    const fragmentJson = fragmentDir
      ? (readJsonSafe(resolve(fragmentDir, "fragment.json")) as Record<string, unknown> | null)
      : null;
    const html = fragmentDir ? readSafe(resolve(fragmentDir, "index.html")) : null;
    const css = fragmentDir ? readSafe(resolve(fragmentDir, "index.css")) : null;

    // C3 — htmlPath key present
    criteria.push({
      id: "C3",
      passed: fragmentJson !== null && typeof fragmentJson.htmlPath === "string",
      bucketOnFail: "rule-misapplied",
    });

    // C4 — cssPath key present
    criteria.push({
      id: "C4",
      passed: fragmentJson !== null && typeof fragmentJson.cssPath === "string",
      bucketOnFail: "rule-misapplied",
    });

    // C5 — editable text (or rich-text, which the skill treats as equivalent)
    criteria.push({
      id: "C5",
      passed:
        html !== null &&
        (htmlHasEditableType(html, "text") || htmlHasEditableType(html, "rich-text")),
      bucketOnFail: "rule-misapplied",
    });

    // C6 — editable image
    criteria.push({
      id: "C6",
      passed: html !== null && htmlHasEditableType(html, "image"),
      bucketOnFail: "rule-misapplied",
    });

    // C7 — CSS scoped under wrapper
    const scoped = css === null ? { passed: false, offending: "(no index.css)" } : cssIsScoped(css);
    criteria.push({ id: "C7", passed: scoped.passed, bucketOnFail: "rule-misapplied" });

    const passed = criteria.every((c) => c.passed);
    const failureBucket = categorize({
      passed,
      agentTimedOut: driver.timedOut,
      criteria,
    });

    const failedDescriptions = criteria
      .filter((c) => !c.passed)
      .map((c) => c.id)
      .join(", ");
    const comment = passed
      ? `All 7 criteria passed (${fragmentDir ? relative(REPO_ROOT, fragmentDir) : "?"}).`
      : `Failed: ${failedDescriptions}${scoped.offending && !scoped.passed ? ` (offending selector: ${scoped.offending})` : ""}`;

    return {
      id: "scaffold-fragment-standard",
      passed,
      comment,
      durationMs: driver.durationMs,
      failureBucket,
      detail: { criteria, fragmentDir: fragmentDir ? relative(REPO_ROOT, fragmentDir) : null },
    };
  },
};
