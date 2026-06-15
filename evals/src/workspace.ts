import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "..", "..");

/**
 * Directories never walked, snapshotted, or restored. `evals/` is excluded
 * because the harness itself writes per-iteration artifacts under
 * `evals/results/` and reverting that would destroy the run we're observing.
 * `bundles/` is excluded because the Tomcat install lives there and is
 * gigabytes of files git already ignores. The remaining entries are common
 * build outputs and VCS internals.
 */
const SKIP_DIRS = new Set([
  "bundles",
  "evals",
  "node_modules",
  "build",
  "dist",
  ".gradle",
  ".git",
]);

const GIT_EXCLUDE_PATHSPECS = [...SKIP_DIRS].map((d) => `:(exclude)${d}`);

export function workspacePath(...parts: string[]): string {
  return resolve(REPO_ROOT, ...parts);
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    out.push(full);
    if (entry.isDirectory()) walk(full, out);
  }
  return out;
}

function walkFiles(dir: string): string[] {
  return walk(dir).filter((p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

export function hasGit(): boolean {
  return existsSync(workspacePath(".git"));
}

export type WorkspaceSnapshot = {
  backend: "git" | "memory";
  /** files whose pre-run content we recorded. Path keys are workspace-relative. */
  capturedContent: Map<string, Buffer>;
  /** repo-relative paths that were untracked at snapshot time. Git backend only. */
  untrackedAtSnapshot: Set<string>;
};

function gitCmd(args: string[]): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitListUntracked(): string[] {
  return gitCmd([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    ".",
    ...GIT_EXCLUDE_PATHSPECS,
  ])
    .split("\n")
    .filter(Boolean);
}

/**
 * Snapshot the workspace so it can be restored at teardown. Covers the
 * whole repo except for `SKIP_DIRS` entries (notably `evals/` and
 * `bundles/`). When git is available, only modified and untracked files
 * have their content captured (tracked-clean files restore via
 * `git restore`). Without git, every file's content is captured.
 */
export function snapshotWorkspace(): WorkspaceSnapshot {
  const captured = new Map<string, Buffer>();

  if (hasGit()) {
    let modified: string[] = [];
    let staged: string[] = [];
    let untracked: string[] = [];
    try {
      modified = gitCmd([
        "diff",
        "--name-only",
        "--",
        ".",
        ...GIT_EXCLUDE_PATHSPECS,
      ])
        .split("\n")
        .filter(Boolean);
      staged = gitCmd([
        "diff",
        "--cached",
        "--name-only",
        "--",
        ".",
        ...GIT_EXCLUDE_PATHSPECS,
      ])
        .split("\n")
        .filter(Boolean);
      untracked = gitListUntracked();
    } catch {
      return memorySnapshot();
    }

    const dirty = new Set([...modified, ...staged, ...untracked]);
    for (const rel of dirty) {
      const abs = workspacePath(rel);
      if (existsSync(abs)) {
        try {
          captured.set(rel, readFileSync(abs));
        } catch {
          // ignore unreadable files
        }
      }
    }
    return {
      backend: "git",
      capturedContent: captured,
      untrackedAtSnapshot: new Set(untracked),
    };
  }

  return memorySnapshot();
}

function memorySnapshot(): WorkspaceSnapshot {
  const captured = new Map<string, Buffer>();
  for (const abs of walkFiles(REPO_ROOT)) {
    const rel = relative(REPO_ROOT, abs);
    try {
      captured.set(rel, readFileSync(abs));
    } catch {
      // ignore
    }
  }
  return {
    backend: "memory",
    capturedContent: captured,
    untrackedAtSnapshot: new Set(),
  };
}

export type RestoreReport = {
  backend: "git" | "memory";
  resetTracked: boolean;
  removedUntracked: number;
  restoredContent: number;
};

/**
 * Restore the workspace to its state at snapshot time. Files the agent
 * created during the run get deleted; files the agent modified get
 * reverted; files the user already had untracked before the run are left
 * alone unless the agent touched them.
 *
 * The git backend is precise: it only deletes untracked files that were
 * NOT in the snapshot's untracked set, then `git restore`s tracked
 * modifications, then writes captured content back. Pre-existing
 * untracked WIP is never nuked.
 */
export function restoreWorkspace(snap: WorkspaceSnapshot): RestoreReport {
  const { backend, capturedContent, untrackedAtSnapshot } = snap;
  const report: RestoreReport = {
    backend,
    resetTracked: false,
    removedUntracked: 0,
    restoredContent: 0,
  };

  if (backend === "git") {
    // Delete only untracked files the agent created during the run.
    try {
      const currentUntracked = gitListUntracked();
      for (const rel of currentUntracked) {
        if (untrackedAtSnapshot.has(rel)) continue;
        try {
          rmSync(workspacePath(rel), { force: true });
          report.removedUntracked += 1;
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore — best-effort
    }

    // Revert tracked modifications across the scoped paths.
    try {
      gitCmd(["restore", "--", ".", ...GIT_EXCLUDE_PATHSPECS]);
      report.resetTracked = true;
    } catch {
      // ignore
    }

    // Rewrite captured content (covers pre-existing untracked WIP and any
    // file the agent modified after we captured it).
    for (const [rel, content] of capturedContent) {
      const abs = workspacePath(rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      report.restoredContent += 1;
    }

    pruneEmptyDirs(REPO_ROOT);
    return report;
  }

  // memory backend: walk current, reconcile against snapshot
  const currentAbs = walkFiles(REPO_ROOT);
  const currentRel = new Set(currentAbs.map((p) => relative(REPO_ROOT, p)));

  for (const rel of currentRel) {
    if (!capturedContent.has(rel)) {
      try {
        rmSync(workspacePath(rel), { force: true });
        report.removedUntracked += 1;
      } catch {
        // ignore
      }
    }
  }

  pruneEmptyDirs(REPO_ROOT);

  for (const [rel, content] of capturedContent) {
    const abs = workspacePath(rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    report.restoredContent += 1;
  }

  return report;
}

function pruneEmptyDirs(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    if (entry.isDirectory()) {
      pruneEmptyDirs(join(dir, entry.name));
    }
  }
  if (dir === REPO_ROOT) return;
  try {
    if (readdirSync(dir).length === 0) {
      rmSync(dir, { recursive: false, force: false });
    }
  } catch {
    // ignore
  }
}

export function findDirectory(
  rootRelative: string,
  predicate: (relPath: string) => boolean
): string | null {
  const root = workspacePath(rootRelative);
  if (!existsSync(root)) return null;
  for (const full of walk(root)) {
    const rel = relative(root, full);
    try {
      if (statSync(full).isDirectory() && predicate(rel)) return rel;
    } catch {
      // skip
    }
  }
  return null;
}
