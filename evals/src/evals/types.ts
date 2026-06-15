import type { DriverResult } from "../driver.js";

export type Tier = "baseline" | "standard";

export type PassRule = "hard-gate" | "strict" | "threshold";

export type FailureBucket =
  | "skill-not-invoked"
  | "wrong-skill-invoked"
  | "artifact-malformed"
  | "rule-misapplied"
  | "deploy-failed"
  | "runtime-error"
  | "stalled"
  | "unknown";

export type EvalResult = {
  id: string;
  passed: boolean;
  comment: string;
  durationMs: number;
  failureBucket?: FailureBucket;
  detail?: unknown;
};

export type GradeContext = {
  runDir: string;
  iter: number;
};

export type EvalCase = {
  id: string;
  description: string;
  prompt: string;
  tier: Tier;
  passRule: PassRule;
  setup?: () => Promise<void>;
  teardown?: () => Promise<void>;
  grade: (driver: DriverResult, ctx?: GradeContext) => Promise<EvalResult>;
};
