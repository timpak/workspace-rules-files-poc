import { resolve } from "node:path";
import { REPO_ROOT } from "../driver.js";
import { categorize, type CriterionOutcome } from "../graders/bucket.js";
import {
  BASE_URL,
  deleteSitePage,
  liferayFetch,
  listSitePages,
  type SitePageSummary,
} from "../portal.js";
import { standardCleanupHooks } from "./shared.js";
import type { EvalCase, EvalResult } from "./types.js";

const ID = "manage-pages-baseline";

const PROMPT = `Add an "About Us" page to our site at /about so people can find our company info.`;

const RUBRIC_PATH = resolve(REPO_ROOT, "evals/rubrics/manage-pages-baseline.md");
const SITE_ERC = "L_GUEST";
const SITE_FRIENDLY = "/guest";

const ABOUT_RE = /about/i;

type SetupState = {
  prePageIds: Set<number>;
};

const state: SetupState = { prePageIds: new Set() };

function friendlyUrlMatchesAbout(p: SitePageSummary): boolean {
  if (typeof p.friendlyUrlPath === "string" && ABOUT_RE.test(p.friendlyUrlPath)) return true;
  if (p.friendlyUrlPath_i18n && typeof p.friendlyUrlPath_i18n === "object") {
    for (const v of Object.values(p.friendlyUrlPath_i18n)) {
      if (typeof v === "string" && ABOUT_RE.test(v)) return true;
    }
  }
  if (typeof p.name === "string" && ABOUT_RE.test(p.name)) return true;
  return false;
}

function resolveFriendlyUrl(p: SitePageSummary): string {
  if (typeof p.friendlyUrlPath === "string") return p.friendlyUrlPath;
  if (p.friendlyUrlPath_i18n && typeof p.friendlyUrlPath_i18n === "object") {
    for (const v of Object.values(p.friendlyUrlPath_i18n)) {
      if (typeof v === "string" && v.length > 0) return v;
    }
  }
  return "/about";
}

const hooks = standardCleanupHooks();

export const managePagesBaseline: EvalCase = {
  id: ID,
  description:
    "STRICT baseline for the manage-pages skill (page created via Headless Admin Site API + renders).",
  prompt: PROMPT,
  tier: "baseline",
  passRule: "strict",
  rubricPath: RUBRIC_PATH,
  setup: async () => {
    await hooks.setup();
    state.prePageIds = new Set();
    try {
      const existing = await listSitePages(SITE_ERC);
      state.prePageIds = new Set(existing.map((p) => p.id));
    } catch {
      state.prePageIds = new Set();
    }
  },
  teardown: async () => {
    // Diff-delete any new pages the agent created before the workspace restore.
    try {
      const current = await listSitePages(SITE_ERC);
      for (const p of current) {
        if (!state.prePageIds.has(p.id)) {
          try {
            await deleteSitePage(p.id);
          } catch {
            // best effort
          }
        }
      }
    } catch {
      // ignore
    }
    await hooks.teardown();
  },
  grade: async (driver): Promise<EvalResult> => {
    const criteria: CriterionOutcome[] = [];

    let pages: SitePageSummary[];
    try {
      pages = await listSitePages(SITE_ERC);
    } catch (err) {
      criteria.push({ id: "C1", passed: false, bucketOnFail: "runtime-error" });
      criteria.push({ id: "C2", passed: false, bucketOnFail: "runtime-error" });
      const failureBucket = categorize({
        passed: false,
        agentTimedOut: driver.timedOut,
        criteria,
      });
      return {
        id: ID,
        passed: false,
        comment: `listSitePages failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: driver.durationMs,
        failureBucket,
        detail: { criteria },
      };
    }

    const newPages = pages.filter((p) => !state.prePageIds.has(p.id));
    const aboutPage = newPages.find(friendlyUrlMatchesAbout);

    const c1Pass = aboutPage !== undefined;
    const c1Bucket: CriterionOutcome["bucketOnFail"] = newPages.length === 0 ? "skill-not-invoked" : "rule-misapplied";
    criteria.push({ id: "C1", passed: c1Pass, bucketOnFail: c1Bucket });

    if (!c1Pass) {
      const failureBucket = categorize({
        passed: false,
        agentTimedOut: driver.timedOut,
        criteria: [{ id: "C2", passed: false, bucketOnFail: "rule-misapplied" }, ...criteria],
      });
      return {
        id: ID,
        passed: false,
        comment:
          newPages.length === 0
            ? "No new pages created on the Guest site."
            : `New page(s) created but none with an "about"-ish friendly URL (${newPages.map((p) => p.friendlyUrlPath).join(", ")}).`,
        durationMs: driver.durationMs,
        failureBucket,
        detail: { criteria, newPages },
      };
    }

    const friendlyUrl = resolveFriendlyUrl(aboutPage);
    const renderPath = `/web${SITE_FRIENDLY}${friendlyUrl.startsWith("/") ? friendlyUrl : `/${friendlyUrl}`}`;

    let renderStatus = -1;
    let renderError = "";
    try {
      const res = await liferayFetch(renderPath);
      renderStatus = res.status;
    } catch (err) {
      renderError = err instanceof Error ? err.message : String(err);
    }

    const c2Pass = renderStatus === 200;
    criteria.push({ id: "C2", passed: c2Pass, bucketOnFail: "rule-misapplied" });

    const passed = criteria.every((c) => c.passed);
    const failureBucket = categorize({
      passed,
      agentTimedOut: driver.timedOut,
      criteria,
    });

    return {
      id: ID,
      passed,
      comment: passed
        ? `New page "${aboutPage.name}" at ${friendlyUrl} renders 200 at ${BASE_URL}${renderPath}.`
        : `Page exists but render failed: ${BASE_URL}${renderPath} → ${renderStatus}${renderError ? ` (${renderError})` : ""}`,
      durationMs: driver.durationMs,
      failureBucket,
      detail: {
        criteria,
        aboutPage,
        renderPath,
        renderStatus,
      },
    };
  },
};
