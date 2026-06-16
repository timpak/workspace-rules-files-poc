import { resolve } from "node:path";
import { REPO_ROOT } from "../driver.js";
import { categorize, type CriterionOutcome } from "../graders/bucket.js";
import {
  listObjectDefinitions,
  listObjectFields,
  snapshotPortal,
  type ObjectDefinition,
} from "../portal.js";
import { standardCleanupHooks } from "./shared.js";
import type { EvalCase, EvalResult } from "./types.js";

const ID = "manage-objects-baseline";

const PROMPT = `Our support team needs to track tickets. Each ticket has a Subject, a Description, and a Status that can be Open, In Progress, or Closed. Set it up so they can start using it.`;

const RUBRIC_PATH = resolve(REPO_ROOT, "evals/rubrics/manage-objects-baseline.md");

const TICKET_NAME_RE = /ticket/i;

function isApproved(def: ObjectDefinition): boolean {
  const status = def.status as { code?: number; label?: string } | undefined;
  if (!status) return false;
  if (typeof status.label === "string" && status.label.toLowerCase() === "approved") return true;
  // Liferay object status code for "approved" is 0.
  if (typeof status.code === "number" && status.code === 0) return true;
  return false;
}

function looksLikeTicket(def: ObjectDefinition): boolean {
  if (typeof def.name === "string" && TICKET_NAME_RE.test(def.name)) return true;
  const label = def.label as Record<string, unknown> | undefined;
  if (label && typeof label === "object") {
    for (const v of Object.values(label)) {
      if (typeof v === "string" && TICKET_NAME_RE.test(v)) return true;
    }
  }
  const erc = (def as { externalReferenceCode?: unknown }).externalReferenceCode;
  if (typeof erc === "string" && TICKET_NAME_RE.test(erc)) return true;
  return false;
}

const hooks = standardCleanupHooks();

export const manageObjectsBaseline: EvalCase = {
  id: ID,
  description:
    "HARD GATE baseline for the manage-objects skill (Ticket object created + published via API; picklist for Status).",
  prompt: PROMPT,
  tier: "baseline",
  passRule: "hard-gate",
  rubricPath: RUBRIC_PATH,
  setup: hooks.setup,
  teardown: hooks.teardown,
  grade: async (driver): Promise<EvalResult> => {
    const criteria: CriterionOutcome[] = [];

    // We need the pre-run snapshot to identify the NEW object. The
    // standardCleanupHooks portal snapshot has the ids set; re-snapshot
    // here is post-run. Compare against the SAVED set instead.
    //
    // We can't reach into the hooks closure, so we re-snapshot and
    // identify "ticket-shaped approved object" without needing the diff.
    // The teardown will still clean up by snapshot.
    let allDefs: ObjectDefinition[];
    try {
      allDefs = await listObjectDefinitions();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      criteria.push({ id: "C1", passed: false, bucketOnFail: "runtime-error" });
      const failureBucket = categorize({
        passed: false,
        agentTimedOut: driver.timedOut,
        criteria,
      });
      return {
        id: ID,
        passed: false,
        comment: `Portal query failed: ${reason}`,
        durationMs: driver.durationMs,
        failureBucket,
        detail: { criteria },
      };
    }

    const ticketShaped = allDefs.filter(looksLikeTicket);
    const approvedTickets = ticketShaped.filter(isApproved);
    const draftTickets = ticketShaped.filter((d) => !isApproved(d));

    const c1Pass = approvedTickets.length >= 1;
    let c1Bucket: CriterionOutcome["bucketOnFail"] = "skill-not-invoked";
    if (ticketShaped.length === 0 && allDefs.length > 0) {
      // Agent might have created a non-ticket object — wrong-skill or wrong-shape.
      // Without a real diff we can't tell. Default to skill-not-invoked.
      c1Bucket = "skill-not-invoked";
    }
    if (draftTickets.length > 0 && approvedTickets.length === 0) {
      c1Bucket = "rule-misapplied"; // exists but draft → publish step missed
    }
    criteria.push({ id: "C1", passed: c1Pass, bucketOnFail: c1Bucket });

    // C2 — ≥3 fields. C3 — picklist field.
    let c2Pass = false;
    let c3Pass = false;
    let fieldDetail: unknown = null;
    const target = approvedTickets[0] ?? ticketShaped[0] ?? null;
    if (target && typeof target.id === "number") {
      try {
        const fields = await listObjectFields(target.id);
        c2Pass = fields.length >= 3;
        c3Pass = fields.some(
          (f) =>
            (typeof f.businessType === "string" && f.businessType.toLowerCase() === "picklist") ||
            (typeof f.listTypeDefinitionId === "number" && f.listTypeDefinitionId > 0)
        );
        fieldDetail = fields.map((f) => ({
          name: f.name,
          businessType: f.businessType,
          listTypeDefinitionId: f.listTypeDefinitionId,
          required: f.required,
        }));
      } catch {
        // leave c2/c3 false
      }
    }
    criteria.push({ id: "C2", passed: c2Pass, bucketOnFail: "rule-misapplied" });
    criteria.push({ id: "C3", passed: c3Pass, bucketOnFail: "rule-misapplied" });

    // HARD GATE: only C1 gates.
    const passed = c1Pass;
    const failureBucket = categorize({
      passed,
      agentTimedOut: driver.timedOut,
      criteria: passed ? [] : [criteria[0]!],
    });

    return {
      id: ID,
      passed,
      comment: passed
        ? `Approved ticket object found (name=${target?.name}, id=${target?.id}); fields=${c2Pass ? "ok" : "fewer than 3"}, picklist=${c3Pass ? "present" : "absent"}.`
        : ticketShaped.length === 0
          ? `No ticket-shaped object definition found.`
          : draftTickets.length > 0
            ? `Ticket object exists but is in draft (publish step missed).`
            : `Ticket object exists but status is not approved.`,
      durationMs: driver.durationMs,
      failureBucket,
      detail: {
        criteria,
        ticketShaped: ticketShaped.map((d) => ({
          id: d.id,
          name: d.name,
          status: d.status,
        })),
        fields: fieldDetail,
      },
    };
  },
};
