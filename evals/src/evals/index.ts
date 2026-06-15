import { featureFlagsDiagnostic } from "./feature-flags-diagnostic.js";
import { scaffoldFragmentStandard } from "./scaffold-fragment-standard.js";
import type { EvalCase } from "./types.js";

export const evals: EvalCase[] = [
  scaffoldFragmentStandard,
  featureFlagsDiagnostic,
];
