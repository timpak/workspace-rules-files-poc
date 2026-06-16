import { buildSiteStandard } from "./build-site-standard.js";
import { commerceCatalogsBaseline } from "./commerce-catalogs-baseline.js";
import { featureFlagsDiagnostic } from "./feature-flags-diagnostic.js";
import { guidedClientExtensionRouting } from "./guided-client-extension-routing.js";
import { manageObjectLogicBaseline } from "./manage-object-logic-baseline.js";
import { manageObjectsBaseline } from "./manage-objects-baseline.js";
import { managePagesBaseline } from "./manage-pages-baseline.js";
import { mcpServerBaseline } from "./mcp-server-baseline.js";
import { scaffoldFragmentStandard } from "./scaffold-fragment-standard.js";
import { setupOauthBaseline } from "./setup-oauth-baseline.js";
import { themeOverrideStandard } from "./theme-override-standard.js";
import type { EvalCase } from "./types.js";

export const evals: EvalCase[] = [
  scaffoldFragmentStandard,
  featureFlagsDiagnostic,
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
