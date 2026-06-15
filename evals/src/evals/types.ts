import type { DriverResult } from "../driver.js";

export type EvalResult = {
  id: string;
  passed: boolean;
  score: number;
  comment: string;
  durationMs: number;
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
  setup?: () => Promise<void>;
  teardown?: () => Promise<void>;
  grade: (driver: DriverResult, ctx?: GradeContext) => Promise<EvalResult>;
};
