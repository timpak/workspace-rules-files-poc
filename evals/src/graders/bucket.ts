import type { FailureBucket } from "../evals/types.js";

export type CriterionOutcome = {
  id: string;
  passed: boolean;
  bucketOnFail: FailureBucket;
};

export type BucketInputs = {
  passed: boolean;
  agentTimedOut?: boolean;
  deployFailed?: boolean;
  runtimeFailed?: boolean;
  criteria?: CriterionOutcome[];
};

// Higher index = lower precedence. Driver/deploy/runtime signals are
// checked before criterion tags because they describe failures that
// happen outside the rubric (the agent never got far enough for
// criteria to be meaningful).
const PRECEDENCE: FailureBucket[] = [
  "stalled",
  "deploy-failed",
  "runtime-error",
  "skill-not-invoked",
  "wrong-skill-invoked",
  "artifact-malformed",
  "rule-misapplied",
  "unknown",
];

export function categorize(inputs: BucketInputs): FailureBucket | undefined {
  if (inputs.passed) return undefined;

  if (inputs.agentTimedOut) return "stalled";
  if (inputs.deployFailed) return "deploy-failed";
  if (inputs.runtimeFailed) return "runtime-error";

  const failedBuckets = new Set<FailureBucket>();
  for (const c of inputs.criteria ?? []) {
    if (!c.passed) failedBuckets.add(c.bucketOnFail);
  }

  for (const bucket of PRECEDENCE) {
    if (failedBuckets.has(bucket)) return bucket;
  }

  return "unknown";
}
