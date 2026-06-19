import { resolve } from "node:path";
import { REPO_ROOT } from "../driver.js";
import { categorize, type CriterionOutcome } from "../graders/bucket.js";
import {
  createObjectDefinition,
  deleteObjectByName,
  liferayFetch,
  listMyUserNotifications,
  listObjectActions,
  publishObjectDefinition,
  type ObjectActionSummary,
  type ObjectDefinition,
} from "../portal.js";
import { standardCleanupHooks } from "./shared.js";
import type { EvalCase, EvalResult } from "./types.js";

const ID = "manage-object-logic-baseline";

const PROMPT = `I have an existing object, CustomerSupportTicket. Whenever a new customer support ticket is created, I want the creator of the ticket to receive an in-app Liferay notification to confirm it was received.`;

const RUBRIC_PATH = resolve(REPO_ROOT, "evals/rubrics/manage-object-logic-baseline.md");

const TICKET_OBJECT_NAME = "CustomerSupportTicket";
const TICKET_PLURAL_PATH = "customer-support-tickets";

const TICKET_DEF_PAYLOAD: Record<string, unknown> = {
  name: TICKET_OBJECT_NAME,
  label: { en_US: "Customer Support Ticket" },
  pluralLabel: { en_US: "Customer Support Tickets" },
  scope: "company",
  active: true,
  objectFields: [
    {
      name: "subject",
      label: { en_US: "Subject" },
      type: "String",
      businessType: "Text",
      indexed: true,
      required: false,
    },
    {
      name: "description",
      label: { en_US: "Description" },
      type: "String",
      businessType: "LongText",
      indexed: false,
      required: false,
    },
  ],
};

type SetupState = {
  ticketDef: ObjectDefinition | null;
  preActionIds: Set<number>;
  preNotificationIds: Set<number>;
};

const state: SetupState = {
  ticketDef: null,
  preActionIds: new Set(),
  preNotificationIds: new Set(),
};

const hooks = standardCleanupHooks();

async function pollForNotificationDelta(
  preIds: Set<number>,
  timeoutMs: number
): Promise<{ found: boolean; newIds: number[] }> {
  const deadline = Date.now() + timeoutMs;
  let latest: number[] = [];
  while (Date.now() < deadline) {
    try {
      const current = await listMyUserNotifications();
      latest = current.map((n) => n.id).filter((id) => !preIds.has(id));
      if (latest.length > 0) return { found: true, newIds: latest };
    } catch {
      // ignore — bundle hiccup
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { found: false, newIds: latest };
}

async function findPluralRestPath(def: ObjectDefinition): Promise<string | null> {
  // Liferay derives the REST path from the object definition's
  // restContextPath; fall back to known shape `/o/c/<plural>`.
  const restContextPath = (def as { restContextPath?: unknown }).restContextPath;
  if (typeof restContextPath === "string" && restContextPath.startsWith("/")) {
    return restContextPath;
  }
  return `/o/c/${TICKET_PLURAL_PATH}`;
}

export const manageObjectLogicBaseline: EvalCase = {
  id: ID,
  description:
    "STRICT baseline for the manage-object-logic skill (active onAfterAdd action + delivered notification on ticket create).",
  prompt: PROMPT,
  tier: "baseline",
  passRule: "strict",
  rubricPath: RUBRIC_PATH,
  agentTimeoutMs: 8 * 60 * 1000,
  setup: async () => {
    await hooks.setup();
    state.ticketDef = null;
    state.preActionIds = new Set();
    state.preNotificationIds = new Set();

    // Create and publish the Ticket object so the agent has something to
    // attach an action to.
    let def: ObjectDefinition;
    try {
      def = await createObjectDefinition(TICKET_DEF_PAYLOAD);
    } catch (err) {
      throw new Error(
        `manage-object-logic-baseline setup: createObjectDefinition failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    try {
      await publishObjectDefinition(def.id);
    } catch (err) {
      throw new Error(
        `manage-object-logic-baseline setup: publishObjectDefinition failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    state.ticketDef = def;

    // Pre-run baselines for delta detection.
    try {
      const actions = await listObjectActions(def.id);
      state.preActionIds = new Set(actions.map((a) => a.id));
    } catch {
      state.preActionIds = new Set();
    }
    try {
      const notifications = await listMyUserNotifications();
      state.preNotificationIds = new Set(notifications.map((n) => n.id));
    } catch {
      state.preNotificationIds = new Set();
    }
  },
  teardown: async () => {
    try {
      await deleteObjectByName(TICKET_OBJECT_NAME);
    } catch {
      // ignore — portal cleanup will catch it
    }
    await hooks.teardown();
  },
  grade: async (driver): Promise<EvalResult> => {
    const criteria: CriterionOutcome[] = [];
    const def = state.ticketDef;

    if (!def) {
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
        comment: "Setup did not create the Ticket object.",
        durationMs: driver.durationMs,
        failureBucket,
        detail: { criteria },
      };
    }

    // C1 — active onAfterAdd action exists, new since pre-snapshot.
    let actions: ObjectActionSummary[] = [];
    try {
      actions = await listObjectActions(def.id);
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
        comment: `listObjectActions failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: driver.durationMs,
        failureBucket,
        detail: { criteria },
      };
    }

    const newActions = actions.filter((a) => !state.preActionIds.has(a.id));
    const matchingAction = newActions.find(
      (a) => a.objectActionTriggerKey === "onAfterAdd" && a.active === true
    );
    const someNewAction = newActions[0];

    let c1Bucket: CriterionOutcome["bucketOnFail"] = "skill-not-invoked";
    if (someNewAction && !matchingAction) {
      c1Bucket = "rule-misapplied"; // action exists, wrong trigger or inactive
    }
    const c1Pass = matchingAction !== undefined;
    criteria.push({ id: "C1", passed: c1Pass, bucketOnFail: c1Bucket });

    if (!c1Pass) {
      const failureBucket = categorize({
        passed: false,
        agentTimedOut: driver.timedOut,
        criteria,
      });
      return {
        id: ID,
        passed: false,
        comment:
          newActions.length === 0
            ? "No new object action created."
            : `Action created but no active onAfterAdd entry (trigger=${someNewAction?.objectActionTriggerKey}, active=${someNewAction?.active}).`,
        durationMs: driver.durationMs,
        failureBucket,
        detail: { criteria, newActions },
      };
    }

    // C2 — POST a test entry, then look for a new notification.
    const restPath = await findPluralRestPath(def);
    const restUrl = restPath ?? `/o/c/${TICKET_PLURAL_PATH}/`;
    const payload = {
      subject: "Eval-harness probe ticket",
      description: "Created by the manage-object-logic-baseline harness.",
    };

    let postOk = false;
    let postStatus = -1;
    let postBody = "";
    try {
      const res = await liferayFetch(
        restUrl.endsWith("/") ? restUrl : `${restUrl}/`,
        { method: "POST", body: JSON.stringify(payload) }
      );
      postStatus = res.status;
      postOk = res.ok;
      if (!res.ok) postBody = (await res.text()).slice(0, 300);
    } catch (err) {
      postBody = err instanceof Error ? err.message : String(err);
    }

    if (!postOk) {
      criteria.push({ id: "C2", passed: false, bucketOnFail: "rule-misapplied" });
      const failureBucket = categorize({
        passed: false,
        agentTimedOut: driver.timedOut,
        criteria,
      });
      return {
        id: ID,
        passed: false,
        comment: `C2: harness POST ${restUrl} returned ${postStatus} — ${postBody}`,
        durationMs: driver.durationMs,
        failureBucket,
        detail: { criteria, restUrl },
      };
    }

    const delta = await pollForNotificationDelta(state.preNotificationIds, 10_000);
    const c2Pass = delta.found;
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
        ? `C1+C2 passed: ${delta.newIds.length} new notification(s) after harness POST.`
        : `C2 failed: no new user-notification within 10s after harness POST to ${restUrl}.`,
      durationMs: driver.durationMs,
      failureBucket,
      detail: { criteria, newActions, restUrl, newNotificationIds: delta.newIds },
    };
  },
};
