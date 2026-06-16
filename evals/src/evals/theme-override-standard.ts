import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../driver.js";
import {
  bladeDeploy,
  logSizeBytes,
  waitForLogPattern,
} from "../deploy.js";
import { BASE_URL, liferayFetch } from "../portal.js";
import { categorize, type CriterionOutcome } from "../graders/bucket.js";
import { standardCleanupHooks } from "./shared.js";
import type { EvalCase, EvalResult } from "./types.js";

const ID = "theme-override-standard";

const PROMPT = `Make all primary buttons on our site use brand color #FF6B35. It should apply on every page.`;

const RUBRIC_PATH = resolve(REPO_ROOT, "evals/rubrics/theme-override-standard.md");
const CLIENT_EXTENSIONS = resolve(REPO_ROOT, "client-extensions");
const COLOR_LITERAL = /#FF6B35/i;
const DEPLOY_TIMEOUT_MS = 5 * 60 * 1000;
const INIT_WAIT_MS = 90_000;

type ThemeKind = "globalCSS" | "themeCSS";

type CetInfo = {
  cetDir: string;
  cetDirName: string;
  cetKey: string;
  kind: ThemeKind;
  url: string | null;        // globalCSS
  mainCssPath: string | null; // themeCSS
  clayVersion: string | null;
  assetFile: string | null;   // absolute path to the CSS file on disk
};

type Block = {
  key: string;
  fields: Map<string, string>;
};

function parseClientExtensionYaml(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let current: Block | null = null;
  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!raw.startsWith(" ") && !raw.startsWith("\t")) {
      if (current) blocks.push(current);
      const m = raw.match(/^([A-Za-z0-9_.\-]+):\s*$/);
      current = m ? { key: m[1], fields: new Map() } : null;
      continue;
    }
    if (!current) continue;
    const m = raw.trimStart().match(/^([A-Za-z0-9_.\-]+):\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim();
    if (!value || value.startsWith("-") || value.startsWith("[")) continue;
    current.fields.set(m[1], stripQuotes(value));
  }
  if (current) blocks.push(current);
  return blocks;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function findThemeCet(): CetInfo | null {
  if (!existsSync(CLIENT_EXTENSIONS)) return null;
  for (const entry of readdirSync(CLIENT_EXTENSIONS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cetDir = join(CLIENT_EXTENSIONS, entry.name);
    const yamlPath = join(cetDir, "client-extension.yaml");
    if (!existsSync(yamlPath)) continue;
    let blocks: Block[];
    try {
      blocks = parseClientExtensionYaml(readFileSync(yamlPath, "utf8"));
    } catch {
      continue;
    }
    for (const block of blocks) {
      const type = block.fields.get("type");
      if (type !== "globalCSS" && type !== "themeCSS") continue;
      const url = block.fields.get("url") ?? null;
      const mainCssPath = block.fields.get("mainCssPath") ?? block.fields.get("mainUrl") ?? null;
      const clayVersion = block.fields.get("clayVersion") ?? null;
      const assetFile = resolveAssetFile(cetDir, type === "globalCSS" ? url : mainCssPath);
      return {
        cetDir,
        cetDirName: entry.name,
        cetKey: block.key,
        kind: type,
        url,
        mainCssPath,
        clayVersion,
        assetFile,
      };
    }
  }
  return null;
}

function resolveAssetFile(cetDir: string, urlOrPath: string | null): string | null {
  if (!urlOrPath) return null;
  const stripped = urlOrPath.replace(/^\//, "");
  // Search for a CSS file with the same basename anywhere in the CET dir.
  const basename = stripped.split("/").pop() ?? stripped;
  const candidates: string[] = [];
  for (const f of walkFiles(cetDir)) {
    if (f.endsWith(`/${basename}`)) candidates.push(f);
    if (f.endsWith(".css")) candidates.push(f);
  }
  // Prefer exact basename match.
  const exact = candidates.find((c) => c.endsWith(`/${basename}`));
  if (exact) return exact;
  return candidates.find((c) => c.endsWith(".css")) ?? null;
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  const SKIP = new Set(["node_modules", "build", "dist", ".gradle"]);
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out;
}

function findLiferayLogPath(): string | null {
  const dir = resolve(REPO_ROOT, "bundles", "logs");
  if (!existsSync(dir)) return null;
  const dateStr = new Date().toISOString().slice(0, 10);
  const direct = join(dir, `liferay.${dateStr}.log`);
  if (existsSync(direct)) return direct;
  // Fall back to newest liferay.*.log
  let newest: { path: string; mtime: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!/^liferay\.\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
    const full = join(dir, name);
    try {
      const m = statSync(full).mtimeMs;
      if (!newest || m > newest.mtime) newest = { path: full, mtime: m };
    } catch {
      // ignore
    }
  }
  return newest?.path ?? null;
}

type DeployedConfig = {
  webContextPath: string;
  url: string;
  type: string;
  configPath: string;
};

/**
 * Find the most-recently-modified client-extension-config.json under
 * `bundles/tomcat/temp/clientextension*` whose filename includes the CET
 * key. The CETConfiguration entry inside provides webContextPath and
 * (in typeSettings) the url segment for the asset.
 */
function findDeployedConfig(cetKey: string, cetDirName: string): DeployedConfig | null {
  const tempRoot = resolve(REPO_ROOT, "bundles", "tomcat", "temp");
  if (!existsSync(tempRoot)) return null;

  const candidates: Array<{ path: string; mtime: number }> = [];
  for (const top of readdirSync(tempRoot, { withFileTypes: true })) {
    if (!top.isDirectory() || !top.name.startsWith("clientextension")) continue;
    const configDir = join(tempRoot, top.name, "META-INF", "client-extension-config");
    if (!existsSync(configDir)) continue;
    for (const f of readdirSync(configDir)) {
      if (!f.endsWith(".client-extension-config.json")) continue;
      const matchesCet = f.includes(cetKey) || f.includes(cetDirName);
      if (!matchesCet) continue;
      const full = join(configDir, f);
      try {
        candidates.push({ path: full, mtime: statSync(full).mtimeMs });
      } catch {
        // ignore
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const cand of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(cand.path, "utf8")) as Record<string, unknown>;
      for (const [, entry] of Object.entries(parsed)) {
        if (!entry || typeof entry !== "object") continue;
        const e = entry as Record<string, unknown>;
        const webContextPath = typeof e.webContextPath === "string" ? e.webContextPath : null;
        const type = typeof e.type === "string" ? e.type : "";
        const typeSettings = e.typeSettings;
        let url: string | null = null;
        if (Array.isArray(typeSettings)) {
          for (const s of typeSettings) {
            if (typeof s === "string" && s.startsWith("url=")) {
              url = s.slice("url=".length);
              break;
            }
          }
        }
        if (webContextPath && url) {
          return { webContextPath, url, type, configPath: cand.path };
        }
      }
    } catch {
      // ignore malformed
    }
  }
  return null;
}

function normalizeBsn(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

const hooks = standardCleanupHooks({
  stashDirs: ["client-extensions", "modules", "themes"],
});

export const themeOverrideStandard: EvalCase = {
  id: ID,
  description:
    "STRICT end-to-end eval for scaffold-client-extension + theme-and-design + deploy-and-verify (globalCSS override visible at runtime).",
  prompt: PROMPT,
  tier: "standard",
  passRule: "strict",
  rubricPath: RUBRIC_PATH,
  agentTimeoutMs: 10 * 60 * 1000,
  setup: hooks.setup,
  teardown: hooks.teardown,
  grade: async (driver): Promise<EvalResult> => {
    const criteria: CriterionOutcome[] = [];
    const cet = findThemeCet();
    const anyCetExists =
      existsSync(CLIENT_EXTENSIONS) &&
      readdirSync(CLIENT_EXTENSIONS, { withFileTypes: true }).some(
        (e) =>
          e.isDirectory() && existsSync(join(CLIENT_EXTENSIONS, e.name, "client-extension.yaml"))
      );

    // C1 — CET artifact with globalCSS or themeCSS
    criteria.push({
      id: "C1",
      passed: cet !== null,
      bucketOnFail: anyCetExists ? "wrong-skill-invoked" : "skill-not-invoked",
    });

    // C2 — Shape correct for chosen type
    let c2Pass = false;
    if (cet) {
      if (cet.kind === "globalCSS") {
        c2Pass = cet.url !== null && cet.assetFile !== null && existsSync(cet.assetFile);
      } else {
        c2Pass =
          cet.clayVersion !== null &&
          cet.mainCssPath !== null &&
          cet.assetFile !== null &&
          existsSync(cet.assetFile);
      }
    }
    criteria.push({ id: "C2", passed: c2Pass, bucketOnFail: "rule-misapplied" });

    const structuralPassed = criteria.every((c) => c.passed);

    let c3Pass = false;
    let c4Pass = false;
    let c5Pass = false;
    let comment = "";

    if (structuralPassed && cet) {
      const logPath = findLiferayLogPath();
      const logOffset = logPath ? logSizeBytes(logPath) : 0;

      // C3 — blade gw deploy
      const deployResult = await bladeDeploy(cet.cetDir, DEPLOY_TIMEOUT_MS);
      c3Pass = deployResult.exitCode === 0 && !deployResult.timedOut;
      if (!c3Pass) {
        comment = `blade gw deploy failed (exit=${deployResult.exitCode}, timedOut=${deployResult.timedOut}). stderr tail: ${deployResult.stderrTail.slice(-200)}`;
      }

      // C4 — STARTED in log
      if (c3Pass && logPath) {
        const bsnNeedle = normalizeBsn(cet.cetDirName);
        const pattern = new RegExp(`STARTED\\s+\\S*${bsnNeedle}\\S*`, "i");
        const result = await waitForLogPattern(logPath, logOffset, pattern, INIT_WAIT_MS);
        c4Pass = result.found;
        if (!c4Pass) {
          comment = `did not see STARTED for bundle matching "${bsnNeedle}" within ${INIT_WAIT_MS / 1000}s`;
        }
      } else if (c3Pass && !logPath) {
        comment = "no liferay log file found to verify STARTED";
      }

      // C5 — Runtime asset reachable and contains color literal
      if (c4Pass) {
        const config = findDeployedConfig(cet.cetKey, cet.cetDirName);
        if (!config) {
          comment = `no deployed client-extension-config.json found for ${cet.cetKey}`;
        } else {
          const urlPath = `/o${config.webContextPath}${config.url.startsWith("/") ? config.url : `/${config.url}`}`;
          try {
            const res = await liferayFetch(urlPath);
            if (res.status !== 200) {
              comment = `runtime asset ${BASE_URL}${urlPath} returned HTTP ${res.status}`;
            } else {
              const body = await res.text();
              if (COLOR_LITERAL.test(body)) {
                c5Pass = true;
              } else {
                comment = `runtime asset 200 but color literal #FF6B35 not present (body length ${body.length})`;
              }
            }
          } catch (err) {
            comment = `runtime asset GET threw: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }
    } else {
      comment = `skipping deploy: structural criteria failed (${criteria
        .filter((c) => !c.passed)
        .map((c) => c.id)
        .join(", ")})`;
    }

    criteria.push({
      id: "C3",
      passed: c3Pass,
      bucketOnFail: !structuralPassed ? "artifact-malformed" : "deploy-failed",
    });
    criteria.push({
      id: "C4",
      passed: c4Pass,
      bucketOnFail: !structuralPassed ? "artifact-malformed" : "deploy-failed",
    });
    criteria.push({
      id: "C5",
      passed: c5Pass,
      bucketOnFail: !structuralPassed ? "artifact-malformed" : "rule-misapplied",
    });

    const passed = criteria.every((c) => c.passed);
    const failureBucket = categorize({
      passed,
      agentTimedOut: driver.timedOut,
      criteria,
    });

    const failedIds = criteria.filter((c) => !c.passed).map((c) => c.id).join(", ");

    return {
      id: ID,
      passed,
      comment: passed
        ? `All 5 criteria passed (CET=${cet?.cetDirName}, kind=${cet?.kind}).`
        : `Failed: ${failedIds}${comment ? ` — ${comment}` : ""}`,
      durationMs: driver.durationMs,
      failureBucket,
      detail: { criteria, cet },
    };
  },
};
