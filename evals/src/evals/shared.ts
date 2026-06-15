import { cleanupNewArtifacts, snapshotPortal, type PortalSnapshot } from "../portal.js";
import {
  restoreWorkspace,
  snapshotWorkspace,
  type WorkspaceSnapshot,
} from "../workspace.js";

export type CleanupHooks = {
  setup: () => Promise<void>;
  teardown: () => Promise<void>;
};

/**
 * Standard snapshot-and-cleanup hooks. At setup, captures the workspace
 * tree (whole repo minus `bundles/`, `evals/`, and common build outputs)
 * and the portal's object definitions + picklists. At teardown, restores
 * both — including reverting modified files and recreating deleted ones.
 * Uses git when present (memory-light), falls back to full in-memory
 * content snapshot when not.
 *
 * Does NOT cover: commerce catalogs, products, B2B accounts, OAuth
 * applications registered via deploy.
 */
export function standardCleanupHooks(): CleanupHooks {
  let workspaceBaseline: WorkspaceSnapshot | null = null;
  let portalBaseline: PortalSnapshot | null = null;

  return {
    setup: async () => {
      workspaceBaseline = snapshotWorkspace();
      portalBaseline = await snapshotPortal();
    },
    teardown: async () => {
      if (workspaceBaseline) {
        const report = restoreWorkspace(workspaceBaseline);
        const changes =
          report.removedUntracked + report.restoredContent + (report.resetTracked ? 1 : 0);
        if (changes > 0) {
          console.log(
            `  cleanup [${report.backend}]: removed ${report.removedUntracked} new path(s), ` +
              `restored ${report.restoredContent} captured file(s)` +
              (report.resetTracked ? ", reset tracked files" : "")
          );
        }
        workspaceBaseline = null;
      }
      if (portalBaseline) {
        const report = await cleanupNewArtifacts(portalBaseline);
        const total =
          report.deletedObjectDefinitions.length + report.deletedPicklists.length;
        if (total > 0) {
          console.log(
            `  cleanup: removed ${report.deletedObjectDefinitions.length} object def(s), ` +
              `${report.deletedPicklists.length} picklist(s)`
          );
        }
        portalBaseline = null;
      }
    },
  };
}
