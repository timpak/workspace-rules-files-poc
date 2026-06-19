import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "../driver.js";
import { categorize, type CriterionOutcome } from "../graders/bucket.js";
import { standardCleanupHooks } from "./shared.js";
import type { EvalCase, EvalResult } from "./types.js";

const ID = "setup-oauth-baseline";

const PROMPT = `The objectAction CET at \`client-extensions/promo-discount-action/\` needs OAuth wiring so it can call Liferay's headless APIs to update related Object entries. Add the OAuth companion entry to its \`client-extension.yaml\`.`;

const RUBRIC_PATH = resolve(REPO_ROOT, "evals/rubrics/setup-oauth-baseline.md");
const FIXTURE_PATH = resolve(
  REPO_ROOT,
  "evals/fixtures/setup-oauth-baseline/client-extension.yaml"
);
const CET_DIR = resolve(REPO_ROOT, "client-extensions/promo-discount-action");
const CET_YAML = resolve(CET_DIR, "client-extension.yaml");

const OBJECT_CRUD_SCOPES = new Set([
  "Liferay.Headless.Object.everything",
  "Liferay.Object.Admin.REST.everything",
  "Liferay.Headless.Admin.User.everything",
]);

type Block = {
  key: string;
  fields: Map<string, string>;
  listFields: Map<string, string[]>;
};

/**
 * Minimal YAML parser tuned to the client-extension.yaml shape:
 *
 *   top-level-key:
 *     scalar-field: value
 *     list-field:
 *       - item-1
 *       - item-2
 *
 * Skips comments and blank lines. Strips matching surrounding quotes
 * from scalar values. List-field items are collected as strings.
 */
function parseClientExtensionYaml(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];

  let current: Block | null = null;
  let currentListKey: string | null = null;
  let currentList: string[] | null = null;

  const flushList = (): void => {
    if (current && currentListKey && currentList) {
      current.listFields.set(currentListKey, currentList);
    }
    currentListKey = null;
    currentList = null;
  };

  const flushBlock = (): void => {
    flushList();
    if (current) blocks.push(current);
    current = null;
  };

  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!raw.startsWith(" ") && !raw.startsWith("\t")) {
      flushBlock();
      const m = raw.match(/^([A-Za-z0-9_.\-]+):\s*$/);
      if (m) {
        current = { key: m[1], fields: new Map(), listFields: new Map() };
      }
      continue;
    }
    if (!current) continue;

    const trimmed = raw.trimStart();
    if (trimmed.startsWith("- ")) {
      if (currentList === null) currentList = [];
      currentList.push(stripQuotes(trimmed.slice(2).trim()));
      continue;
    }

    flushList();

    const m = trimmed.match(/^([A-Za-z0-9_.\-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const value = m[2];
    if (value === "" || value === undefined) {
      // List-field header or nested map header — assume list for our use case.
      currentListKey = key;
      currentList = [];
    } else {
      current.fields.set(key, stripQuotes(value.trim()));
    }
  }
  flushBlock();

  return blocks;
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

const hooks = standardCleanupHooks();

export const setupOauthBaseline: EvalCase = {
  id: ID,
  description:
    "STRICT-on-2 baseline for the setup-oauth skill (OAuth entry exists; ERC references top-level key, not name).",
  prompt: PROMPT,
  tier: "baseline",
  passRule: "strict",
  rubricPath: RUBRIC_PATH,
  setup: async () => {
    await hooks.setup();
    mkdirSync(CET_DIR, { recursive: true });
    copyFileSync(FIXTURE_PATH, CET_YAML);
  },
  teardown: async () => {
    try {
      if (existsSync(CET_DIR)) rmSync(CET_DIR, { recursive: true, force: true });
    } catch {
      // ignore — hooks.teardown will also try
    }
    await hooks.teardown();
  },
  grade: async (driver): Promise<EvalResult> => {
    const criteria: CriterionOutcome[] = [];

    if (!existsSync(CET_YAML)) {
      criteria.push({ id: "C1", passed: false, bucketOnFail: "skill-not-invoked" });
      criteria.push({ id: "C2", passed: false, bucketOnFail: "skill-not-invoked" });
      criteria.push({ id: "C3", passed: false, bucketOnFail: "skill-not-invoked" });
      const failureBucket = categorize({
        passed: false,
        agentTimedOut: driver.timedOut,
        criteria,
      });
      return {
        id: ID,
        passed: false,
        comment: `client-extension.yaml missing from ${CET_DIR} — agent removed it or never wrote.`,
        durationMs: driver.durationMs,
        failureBucket,
        detail: { criteria },
      };
    }

    const yamlText = readFileSync(CET_YAML, "utf8");
    let blocks: Block[];
    try {
      blocks = parseClientExtensionYaml(yamlText);
    } catch (err) {
      criteria.push({ id: "C1", passed: false, bucketOnFail: "artifact-malformed" });
      criteria.push({ id: "C2", passed: false, bucketOnFail: "artifact-malformed" });
      criteria.push({ id: "C3", passed: false, bucketOnFail: "artifact-malformed" });
      const failureBucket = categorize({
        passed: false,
        agentTimedOut: driver.timedOut,
        criteria,
      });
      return {
        id: ID,
        passed: false,
        comment: `yaml parse error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: driver.durationMs,
        failureBucket,
        detail: { criteria },
      };
    }

    const oauthBlocks = blocks.filter(
      (b) => b.fields.get("type") === "oAuthApplicationUserAgent"
    );
    const objectActionBlocks = blocks.filter((b) => b.fields.get("type") === "objectAction");

    // C1 — OAuth entry exists
    const c1Pass = oauthBlocks.length >= 1;
    criteria.push({ id: "C1", passed: c1Pass, bucketOnFail: "skill-not-invoked" });

    // C2 — ERC references top-level YAML key of the OAuth entry, not its `name` field.
    let c2Pass = false;
    let c2Detail = "";
    const action = objectActionBlocks[0] ?? null;
    const erc = action?.fields.get("oAuth2ApplicationExternalReferenceCode") ?? null;
    if (!c1Pass) {
      c2Detail = "no OAuth entry to reference";
    } else if (!action) {
      c2Detail = "objectAction entry missing";
    } else if (!erc) {
      c2Detail = "objectAction entry has no oAuth2ApplicationExternalReferenceCode field";
    } else {
      const oauthKeys = new Set(oauthBlocks.map((b) => b.key));
      const oauthNames = new Set(
        oauthBlocks.map((b) => b.fields.get("name")).filter((n): n is string => Boolean(n))
      );
      if (oauthKeys.has(erc)) {
        c2Pass = true;
      } else if (oauthNames.has(erc)) {
        c2Detail = `ERC="${erc}" matches OAuth entry's name field but NOT its top-level YAML key`;
      } else {
        c2Detail = `ERC="${erc}" matches neither top-level key (${[...oauthKeys].join(",")}) nor name`;
      }
    }
    criteria.push({ id: "C2", passed: c2Pass, bucketOnFail: "rule-misapplied" });

    // C3 — supporting: Object-CRUD scope present
    let c3Pass = false;
    if (c1Pass) {
      for (const b of oauthBlocks) {
        const scopes = b.listFields.get("scopes") ?? [];
        if (scopes.some((s) => OBJECT_CRUD_SCOPES.has(s))) {
          c3Pass = true;
          break;
        }
      }
    }
    criteria.push({ id: "C3", passed: c3Pass, bucketOnFail: "rule-misapplied" });

    // Pass rule: STRICT on C1+C2.
    const passed = c1Pass && c2Pass;
    const failureBucket = categorize({
      passed,
      agentTimedOut: driver.timedOut,
      criteria: criteria.filter((c) => c.id !== "C3" || !c.passed),
    });

    return {
      id: ID,
      passed,
      comment: passed
        ? `C1+C2 passed (oauth=${oauthBlocks.map((b) => b.key).join(",")}, action=${action?.key}, ERC=${erc})${c3Pass ? "" : "; C3 (object-CRUD scope) absent"}.`
        : `Failed: ${c2Detail || "see criteria"}`,
      durationMs: driver.durationMs,
      failureBucket,
      detail: {
        criteria,
        blocks: blocks.map((b) => ({
          key: b.key,
          fields: Object.fromEntries(b.fields),
          listFields: Object.fromEntries(b.listFields),
        })),
      },
    };
  },
};
