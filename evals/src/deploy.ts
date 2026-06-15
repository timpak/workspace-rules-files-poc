import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { workspacePath } from "./workspace.js";

export function findCatalinaLog(): string | null {
  const bundles = workspacePath("bundles");
  if (!existsSync(bundles)) return null;
  for (const name of readdirSync(bundles)) {
    if (!name.startsWith("tomcat")) continue;
    const candidate = join(bundles, name, "logs", "catalina.out");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function logSizeBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function readLogSince(path: string, fromByte: number): string {
  if (!existsSync(path)) return "";
  const size = statSync(path).size;
  if (size <= fromByte) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(size - fromByte);
    readSync(fd, buf, 0, buf.length, fromByte);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export type DeployResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
  timedOut: boolean;
};

function tail(s: string, n = 1500): string {
  return s.length <= n ? s : s.slice(-n);
}

export async function bladeDeploy(
  cwd: string,
  timeoutMs = 5 * 60 * 1000
): Promise<DeployResult> {
  const start = Date.now();
  return await new Promise<DeployResult>((resolvePromise, rejectPromise) => {
    const child = spawn("blade", ["gw", "deploy"], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: code,
        stdout,
        stderr,
        stdoutTail: tail(stdout),
        stderrTail: tail(stderr),
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

export async function waitForLogPattern(
  path: string,
  fromByte: number,
  pattern: RegExp,
  timeoutMs: number
): Promise<{ found: boolean; text: string }> {
  const deadline = Date.now() + timeoutMs;
  let text = "";
  while (Date.now() < deadline) {
    text = readLogSince(path, fromByte);
    if (pattern.test(text)) return { found: true, text };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  return { found: false, text };
}
