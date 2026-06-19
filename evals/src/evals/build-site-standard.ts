import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { REPO_ROOT } from "../driver.js";
import { bladeDeploy, findCatalinaLog, logSizeBytes, readLogSince, waitForLogPattern } from "../deploy.js";
import { deleteSiteByErc, getSiteByErc, liferayFetch } from "../portal.js";
import { categorize, type CriterionOutcome } from "../graders/bucket.js";
import { standardCleanupHooks } from "./shared.js";
import type { EvalCase, EvalResult } from "./types.js";

const ID = "build-site-standard";

const PROMPT = `Hey, we're doing a spring promo launch site and need a quick page on it to point ads at. Just needs to say something punchy at the top — I want our team to be able to update that text ourselves once it's up.`;

const RUBRIC_PATH = resolve(REPO_ROOT, "evals/rubrics/build-site-standard.md");
const CLIENT_EXTENSIONS = resolve(REPO_ROOT, "client-extensions");
const DEPLOY_TIMEOUT_MS = 5 * 60 * 1000;
const INIT_WAIT_MS = 90_000;

type CetInfo = {
  cetDir: string;
  cetKey: string;
  siteInitializerKey: string;
  siteErc: string;
  siteName: string;
};

type FragmentInfo = {
  dir: string;
  key: string;
  wrapperClass: string | null;
};

type LayoutInfo = {
  dir: string;
  friendlyUrl: string | null;
  referencedFragmentKeys: string[];
};

function walkDirs(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  const SKIP = new Set(["node_modules", "build", "dist", ".gradle"]);
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      out.push(full);
      stack.push(full);
    }
  }
  return out;
}

/**
 * Parse just enough of client-extension.yaml to find the siteInitializer
 * block. The format is shallow YAML — each top-level key is a CET
 * declaration with `type:` and a handful of scalar fields. We tokenize
 * by indentation level rather than pulling in a YAML dep.
 */
function parseSiteInitializerYaml(yamlText: string): {
  cetKey: string;
  siteErc: string;
  siteName: string;
} | null {
  const lines = yamlText.split("\n");
  let currentKey: string | null = null;
  let currentFields: Map<string, string> = new Map();
  const blocks: Array<{ key: string; fields: Map<string, string> }> = [];

  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    if (!raw.startsWith(" ") && !raw.startsWith("\t")) {
      // Top-level key
      if (currentKey !== null) {
        blocks.push({ key: currentKey, fields: currentFields });
      }
      const match = raw.match(/^([A-Za-z0-9_.\-]+):\s*$/);
      if (match) {
        currentKey = match[1];
        currentFields = new Map();
      } else {
        currentKey = null;
        currentFields = new Map();
      }
    } else if (currentKey !== null) {
      // Indented scalar
      const m = raw.match(/^\s+([A-Za-z0-9_.\-]+):\s*(.*)$/);
      if (m && !m[2].includes("[") && !m[2].startsWith("-")) {
        currentFields.set(m[1], stripQuotes(m[2]));
      }
    }
  }
  if (currentKey !== null) {
    blocks.push({ key: currentKey, fields: currentFields });
  }

  for (const b of blocks) {
    if (b.fields.get("type") === "siteInitializer") {
      const erc = b.fields.get("siteExternalReferenceCode") ?? "";
      const name = b.fields.get("siteName") ?? "";
      return { cetKey: b.key, siteErc: erc, siteName: name };
    }
  }
  return null;
}

function stripQuotes(s: string): string {
  const trimmed = s.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function findSiteInitializerCet(): CetInfo | null {
  if (!existsSync(CLIENT_EXTENSIONS)) return null;
  for (const entry of readdirSync(CLIENT_EXTENSIONS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cetDir = join(CLIENT_EXTENSIONS, entry.name);
    const yamlPath = join(cetDir, "client-extension.yaml");
    if (!existsSync(yamlPath)) continue;
    try {
      const parsed = parseSiteInitializerYaml(readFileSync(yamlPath, "utf8"));
      if (!parsed) continue;
      return {
        cetDir,
        cetKey: entry.name,
        siteInitializerKey: parsed.cetKey,
        siteErc: parsed.siteErc,
        siteName: parsed.siteName,
      };
    } catch {
      continue;
    }
  }
  return null;
}

function findFragments(cetDir: string): FragmentInfo[] {
  const out: FragmentInfo[] = [];
  const fragmentsRoot = join(cetDir, "site-initializer", "fragments", "group");
  if (!existsSync(fragmentsRoot)) return out;
  for (const dir of walkDirs(fragmentsRoot)) {
    const rel = relative(fragmentsRoot, dir);
    // Match <collection>/fragments/<fragment-name>
    if (!/^[^/]+\/fragments\/[^/]+$/.test(rel)) continue;
    const fragmentJsonPath = join(dir, "fragment.json");
    if (!existsSync(fragmentJsonPath)) continue;
    let key = basename(dir);
    try {
      const parsed = JSON.parse(readFileSync(fragmentJsonPath, "utf8")) as Record<string, unknown>;
      if (typeof parsed.fragmentEntryKey === "string" && parsed.fragmentEntryKey.length > 0) {
        key = parsed.fragmentEntryKey;
      }
    } catch {
      // ignore
    }
    let wrapperClass: string | null = null;
    const indexHtml = join(dir, "index.html");
    if (existsSync(indexHtml)) {
      try {
        const html = readFileSync(indexHtml, "utf8");
        const m = html.match(/<\w+[^>]*\bclass="([^"]+)"/);
        if (m) wrapperClass = m[1].split(/\s+/)[0] ?? null;
      } catch {
        // ignore
      }
    }
    out.push({ dir, key, wrapperClass });
  }
  return out;
}

function fragmentHasAllCanonicalFiles(dir: string): boolean {
  return ["fragment.json", "index.html", "index.css", "index.js"].every((f) =>
    existsSync(join(dir, f))
  );
}

function findLayouts(cetDir: string): LayoutInfo[] {
  const out: LayoutInfo[] = [];
  const layoutsRoot = join(cetDir, "site-initializer", "layouts");
  if (!existsSync(layoutsRoot)) return out;
  for (const entry of readdirSync(layoutsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(layoutsRoot, entry.name);
    out.push({
      dir,
      friendlyUrl: readFriendlyUrl(join(dir, "page.json")),
      referencedFragmentKeys: readReferencedFragmentKeys(join(dir, "page-definition.json")),
    });
  }
  return out;
}

function readFriendlyUrl(pageJsonPath: string): string | null {
  if (!existsSync(pageJsonPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pageJsonPath, "utf8")) as Record<string, unknown>;
    if (typeof parsed.friendlyURL === "string") return parsed.friendlyURL;
    if (typeof parsed.friendlyUrl === "string") return parsed.friendlyUrl;
  } catch {
    // ignore
  }
  return null;
}

function readReferencedFragmentKeys(pageDefinitionPath: string): string[] {
  if (!existsSync(pageDefinitionPath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pageDefinitionPath, "utf8"));
  } catch {
    return [];
  }
  const keys: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj.type === "Fragment") {
      const def = obj.definition as Record<string, unknown> | undefined;
      const frag = def?.fragment as Record<string, unknown> | undefined;
      if (frag && typeof frag.key === "string") keys.push(frag.key);
    }
    for (const v of Object.values(obj)) visit(v);
  };
  visit(parsed);
  return keys;
}

function layoutHasBothFiles(dir: string): boolean {
  return existsSync(join(dir, "page.json")) && existsSync(join(dir, "page-definition.json"));
}

function noErrorBetween(text: string, start: string, end: string): boolean {
  const startIdx = text.indexOf(start);
  if (startIdx < 0) return false;
  const endIdx = text.indexOf(end, startIdx);
  if (endIdx < 0) return false;
  const slice = text.slice(startIdx, endIdx);
  return !/\bERROR\b/.test(slice);
}

const hooks = standardCleanupHooks({
  stashDirs: ["client-extensions", "modules", "themes"],
});

type SetupState = {
  logOffset: number;
};

const state: SetupState = {
  logOffset: 0,
};

export const buildSiteStandard: EvalCase = {
  id: ID,
  description:
    "STRICT artifact+deploy+render eval bridging scaffold-client-extension, scaffold-fragment, and manage-pages (build-site orchestrator).",
  prompt: PROMPT,
  tier: "standard",
  passRule: "strict",
  rubricPath: RUBRIC_PATH,
  agentTimeoutMs: 10 * 60 * 1000,
  setup: async () => {
    await hooks.setup();
    const logPath = findCatalinaLog();
    const liferayLogDir = resolve(REPO_ROOT, "bundles", "logs");
    const dateStr = new Date().toISOString().slice(0, 10);
    const liferayLogPath = join(liferayLogDir, `liferay.${dateStr}.log`);
    const logForGrep = existsSync(liferayLogPath) ? liferayLogPath : logPath;
    state.logOffset = logForGrep ? logSizeBytes(logForGrep) : 0;
  },
  teardown: async () => {
    // Try to delete whatever site we provisioned BEFORE filesystem restore.
    // The CET dir is still on disk at this point so we can recover the ERC.
    try {
      const cet = findSiteInitializerCet();
      if (cet && cet.siteErc) {
        try {
          await deleteSiteByErc(cet.siteErc);
        } catch {
          // best effort
        }
      }
    } catch {
      // ignore
    }
    await hooks.teardown();
  },
  grade: async (driver): Promise<EvalResult> => {
    const criteria: CriterionOutcome[] = [];

    // C1 — siteInitializer CET present
    const cet = findSiteInitializerCet();
    const anyCetExists =
      existsSync(CLIENT_EXTENSIONS) &&
      readdirSync(CLIENT_EXTENSIONS, { withFileTypes: true }).some(
        (e) => e.isDirectory() && existsSync(join(CLIENT_EXTENSIONS, e.name, "client-extension.yaml"))
      );
    criteria.push({
      id: "C1",
      passed: cet !== null,
      bucketOnFail: anyCetExists ? "wrong-skill-invoked" : "skill-not-invoked",
    });

    // C2 — yaml site fields present
    criteria.push({
      id: "C2",
      passed: cet !== null && cet.siteErc.length > 0 && cet.siteName.length > 0,
      bucketOnFail: "artifact-malformed",
    });

    // C3 — fragment canonical
    const fragments = cet ? findFragments(cet.cetDir) : [];
    const validFragments = fragments.filter((f) => fragmentHasAllCanonicalFiles(f.dir));
    criteria.push({
      id: "C3",
      passed: validFragments.length >= 1,
      bucketOnFail: fragments.length === 0 ? "rule-misapplied" : "artifact-malformed",
    });

    // C4 — layout with both files
    const layouts = cet ? findLayouts(cet.cetDir) : [];
    const validLayouts = layouts.filter((l) => layoutHasBothFiles(l.dir));
    criteria.push({
      id: "C4",
      passed: validLayouts.length >= 1,
      bucketOnFail: layouts.length === 0 ? "rule-misapplied" : "artifact-malformed",
    });

    // C5 — layout references one of the fragment keys
    const fragmentKeys = new Set(validFragments.map((f) => f.key));
    const layoutReferencingFragment = validLayouts.find((l) =>
      l.referencedFragmentKeys.some((k) => fragmentKeys.has(k))
    );
    criteria.push({
      id: "C5",
      passed: layoutReferencingFragment !== undefined,
      bucketOnFail: "rule-misapplied",
    });

    // If structure is broken, don't bother trying to deploy.
    const structuralPassed = criteria.every((c) => c.passed);

    const deployOk = driver.transcript.includes("BUILD SUCCESSFUL");
    let initOk = false;
    let siteOk = false;
    let renderOk = false;
    let comment = "";

    if (structuralPassed && cet) {
      if (!deployOk) {
        comment = "Agent transcript does not contain a successful Gradle build log ('BUILD SUCCESSFUL').";
      } else {
        const logPath = findCatalinaLog();
        const liferayLogDir = resolve(REPO_ROOT, "bundles", "logs");
        // The Liferay log we observed lives at bundles/logs/liferay.<date>.log
        const dateStr = new Date().toISOString().slice(0, 10);
        const liferayLogPath = join(liferayLogDir, `liferay.${dateStr}.log`);
        const logForGrep = existsSync(liferayLogPath) ? liferayLogPath : logPath;

        const logOffset = state.logOffset;

        if (!logForGrep) {
          comment = "no liferay log file found to verify initialization";
        } else {
          // C6.b — wait for "Initialized <siteName> ... in N ms"
          const initializedPattern = new RegExp(
            `Initialized ${escapeRegex(cet.siteName)} for group \\d+ in \\d+ ms`
          );
          const initWait = await waitForLogPattern(
            logForGrep,
            logOffset,
            initializedPattern,
            INIT_WAIT_MS
          );
          initOk = initWait.found;

        if (initOk) {
          // verify the no-ERROR-between phase invariants
          const initText = initWait.text;
          const initializingMarker = `Initializing ${cet.siteName} for group`;
          const fragMarker = "Invoking addFragmentEntries";
          const layoutMarker = "Invoking addOrUpdateLayouts";
          const fragClean = noErrorBetween(initText, initializingMarker, fragMarker);
          const layoutClean = noErrorBetween(initText, fragMarker, layoutMarker);
          if (!fragClean || !layoutClean) {
            initOk = false;
            comment = "initializer log contains ERROR between phase markers";
          }
        } else {
          comment = `did not find Initialized log line for siteName="${cet.siteName}" within ${INIT_WAIT_MS / 1000}s`;
        }

        if (initOk) {
          // C7.a — site exists
          try {
            const site = await getSiteByErc(cet.siteErc);
            if (site && typeof site.id === "number") {
              siteOk = true;
              // C7.b — page renders with markers
              const layout = layoutReferencingFragment!;
              const friendlyUrl = layout.friendlyUrl ?? "/";
              const referencedKey = layout.referencedFragmentKeys.find((k) =>
                fragmentKeys.has(k)
              )!;
              const fragment = validFragments.find((f) => f.key === referencedKey)!;
              const url = `/web/group-${site.id}${friendlyUrl}`;
              const res = await liferayFetch(url);
              if (res.status === 200) {
                const body = await res.text();
                const structureMarker = `lfr-layout-structure-item-${referencedKey}`;
                const hasStructure = body.includes(structureMarker);
                const hasWrapper =
                  fragment.wrapperClass !== null && body.includes(fragment.wrapperClass);
                renderOk = hasStructure && hasWrapper;
                if (!renderOk) {
                  comment = `page rendered 200 but missing markers: structure=${hasStructure} wrapper=${hasWrapper} (looked for "${structureMarker}", "${fragment.wrapperClass}")`;
                }
              } else {
                comment = `page render ${url} returned HTTP ${res.status}`;
              }
            } else {
              comment = `site lookup for ERC="${cet.siteErc}" returned no id`;
            }
          } catch (err) {
            comment = `site/page verification threw: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }
    }
    } else {
      comment = `skipping deploy: structural criteria failed (${criteria
        .filter((c) => !c.passed)
        .map((c) => c.id)
        .join(", ")})`;
    }

    // C6 — deploy + init log assertions. If structural failed we never tried
    // to deploy; attribute the bucket to the upstream cause rather than
    // mislabeling as "deploy-failed".
    criteria.push({
      id: "C6",
      passed: deployOk && initOk,
      bucketOnFail: !structuralPassed
        ? "artifact-malformed"
        : !deployOk
          ? "deploy-failed"
          : "runtime-error",
    });
    // C7 — site + render. Same skip rule.
    criteria.push({
      id: "C7",
      passed: siteOk && renderOk,
      bucketOnFail: !structuralPassed ? "artifact-malformed" : "runtime-error",
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
        ? `All 7 criteria passed (CET=${cet?.cetKey}, ERC=${cet?.siteErc}).`
        : `Failed: ${failedIds}${comment ? ` — ${comment}` : ""}`,
      durationMs: driver.durationMs,
      failureBucket,
      detail: {
        criteria,
        cet,
        fragments: validFragments.map((f) => ({ dir: relative(REPO_ROOT, f.dir), key: f.key, wrapperClass: f.wrapperClass })),
        layouts: validLayouts.map((l) => ({ dir: relative(REPO_ROOT, l.dir), friendlyUrl: l.friendlyUrl, referencedFragmentKeys: l.referencedFragmentKeys })),
      },
    };
  },
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
