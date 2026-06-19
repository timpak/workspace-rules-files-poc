import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupNewArtifacts, snapshotPortal, type PortalSnapshot } from "../portal.js";
import {
  restoreWorkspace,
  snapshotWorkspace,
  workspacePath,
  type WorkspaceSnapshot,
} from "../workspace.js";

export type CleanupHooks = {
  setup: () => Promise<void>;
  teardown: () => Promise<void>;
};

/**
 * Stash lives OUTSIDE the workspace so the agent can't see or read it
 * via its tools. We keep a small manifest file inside the workspace
 * (gitignored) that points to the stash location so a crashed run can
 * be recovered on next setup.
 */
const STASH_ROOT = join(tmpdir(), "workspace-rules-eval-stash");
const MANIFEST_PATH = workspacePath(".eval-stash-manifest");

/**
 * Move existing user-authored top-level directories out of the agent's view
 * so it cannot crib patterns from them. Each named dir under REPO_ROOT is
 * renamed into the stash; an empty placeholder is created in its place so
 * the agent's writes still land at the expected path. Restore reverses the
 * move. Stash lives inside the workspace at `.eval-stash/` (gitignored) so
 * a crashed run leaves a recoverable marker for the next setup.
 */
function stashDirs(dirs: string[], stashId: string): void {
  const stashDest = join(STASH_ROOT, stashId);
  mkdirSync(stashDest, { recursive: true });
  const stashed: string[] = [];
  for (const dir of dirs) {
    const src = workspacePath(dir);
    if (!existsSync(src)) continue;
    renameSync(src, join(stashDest, dir));
    mkdirSync(src, { recursive: true });
    stashed.push(dir);
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify({ stashId, dirs: stashed }), "utf8");
}

function unstashDirs(stashId: string): void {
  const stashDest = join(STASH_ROOT, stashId);
  if (!existsSync(stashDest)) {
    if (existsSync(MANIFEST_PATH)) rmSync(MANIFEST_PATH, { force: true });
    return;
  }
  let dirs: string[] = [];
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { dirs?: string[] };
    dirs = manifest.dirs ?? [];
  } catch {
    dirs = readdirSync(stashDest);
  }
  for (const dir of dirs) {
    const stashed = join(stashDest, dir);
    if (!existsSync(stashed)) continue;
    const dest = workspacePath(dir);
    if (existsSync(dest)) {
      try {
        rmSync(dest, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    renameSync(stashed, dest);
  }
  try {
    rmSync(stashDest, { recursive: true, force: true });
  } catch {
    // ignore
  }
  if (existsSync(MANIFEST_PATH)) {
    rmSync(MANIFEST_PATH, { force: true });
  }
}

export function recoverOrphanStash(): void {
  if (!existsSync(MANIFEST_PATH)) return;
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { stashId?: string };
    if (manifest.stashId) {
      console.warn(`  [stash recovery] restoring orphan stash ${manifest.stashId}`);
      unstashDirs(manifest.stashId);
    } else {
      rmSync(MANIFEST_PATH, { force: true });
    }
  } catch {
    rmSync(MANIFEST_PATH, { force: true });
  }
}

const DEFAULT_STASH_DIRS = ["client-extensions", "modules", "themes"];

export function stashWorkspace(dirs: string[] = DEFAULT_STASH_DIRS): void {
  const stashId = `${process.pid}-${Date.now()}`;
  stashDirs(dirs, stashId);
}

export function unstashWorkspace(): void {
  if (!existsSync(MANIFEST_PATH)) return;
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { stashId?: string };
    if (manifest.stashId) {
      unstashDirs(manifest.stashId);
    } else {
      rmSync(MANIFEST_PATH, { force: true });
    }
  } catch {
    rmSync(MANIFEST_PATH, { force: true });
  }
}

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
