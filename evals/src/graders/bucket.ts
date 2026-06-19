import type { FailureBucket } from "../evals/types.js";

export type CriterionOutcome = {
  id: string;
  passed: boolean;
  bucketOnFail: FailureBucket;
  graderType?: "harness" | "llm-judge";
  reasoning?: string;
};

export type BucketInputs = {
  passed: boolean;
  agentTimedOut?: boolean;
  deployFailed?: boolean;
  runtimeFailed?: boolean;
  criteria?: CriterionOutcome[];
};

// Higher index = lower precedence. `stalled` wins outright (the agent
// never produced an artifact). Otherwise upstream causes beat downstream
// effects: a structural defect (artifact-malformed) or a documented-rule
// violation (rule-misapplied) is the upstream cause of any consequent
// deploy or runtime failure, so it should win the bucket.
const PRECEDENCE: FailureBucket[] = [
  "stalled",
  "skill-not-invoked",
  "wrong-skill-invoked",
  "artifact-malformed",
  "rule-misapplied",
  "deploy-failed",
  "runtime-error",
  "unknown",
];

export function categorize(inputs: BucketInputs): FailureBucket | undefined {
  if (inputs.passed) return undefined;

  if (inputs.agentTimedOut) return "stalled";

  const failedBuckets = new Set<FailureBucket>();
  for (const c of inputs.criteria ?? []) {
    if (!c.passed) failedBuckets.add(c.bucketOnFail);
  }
  if (inputs.deployFailed) failedBuckets.add("deploy-failed");
  if (inputs.runtimeFailed) failedBuckets.add("runtime-error");

  for (const bucket of PRECEDENCE) {
    if (failedBuckets.has(bucket)) return bucket;
  }

  return "unknown";
}
