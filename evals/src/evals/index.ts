import { buildSiteStandard } from "./build-site-standard.js";
import { commerceCatalogsBaseline } from "./commerce-catalogs-baseline.js";
import { guidedClientExtensionRouting } from "./guided-client-extension-routing.js";
import { manageObjectLogicBaseline } from "./manage-object-logic-baseline.js";
import { manageObjectsBaseline } from "./manage-objects-baseline.js";
import { managePagesBaseline } from "./manage-pages-baseline.js";
import { mcpServerBaseline } from "./mcp-server-baseline.js";
import { scaffoldFragmentStandard } from "./scaffold-fragment-standard.js";
import { setupOauthBaseline } from "./setup-oauth-baseline.js";
import { themeOverrideStandard } from "./theme-override-standard.js";
import type { EvalCase } from "./types.js";

// `feature-flags-diagnostic` is intentionally unregistered. Its premise
// (LPD-35443 OFF so the agent has a broken endpoint to diagnose) conflicts
// with the new preflight model where required flags are assumed ON for the
// rest of the bank. Source file is retained at
// `./feature-flags-diagnostic.ts` for when we revisit the diagnostic
// approach.
export const evals: EvalCase[] = [
  scaffoldFragmentStandard,
  buildSiteStandard,
  mcpServerBaseline,
  setupOauthBaseline,
  manageObjectsBaseline,
  manageObjectLogicBaseline,
  managePagesBaseline,
  commerceCatalogsBaseline,
  guidedClientExtensionRouting,
  themeOverrideStandard,
];
