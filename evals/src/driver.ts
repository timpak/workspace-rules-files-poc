import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export type DriverResult = {
  transcript: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  model: string | null;
};

export async function runClaude(
  prompt: string,
  opts: { timeoutMs?: number; model?: string } = {}
): Promise<DriverResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = Date.now();
  const model = opts.model ?? null;

  return await new Promise((resolvePromise, rejectPromise) => {
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];
    if (model) {
      args.push("--model", model);
    }
    const child = spawn("claude", args, {
      cwd: REPO_ROOT,
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
        transcript: stdout,
        stderr,
        exitCode: code,
        durationMs: Date.now() - start,
        timedOut,
        model,
      });
    });
  });
}

export async function getClaudeVersion(): Promise<string> {
  return await new Promise((resolvePromise) => {
    const child = spawn("claude", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("close", () => resolvePromise(out.trim() || "unknown"));
    child.on("error", () => resolvePromise("unknown"));
  });
}

function parseStream(transcript: string): unknown[] | null {
  const events: unknown[] = [];
  let parsedAny = false;
  for (const line of transcript.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
      parsedAny = true;
    } catch {
      // ignore malformed lines (e.g. partial final line on SIGTERM)
    }
  }
  if (parsedAny) return events;

  try {
    const parsed = JSON.parse(transcript);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
};

function summarizeContent(input: unknown, maxLen = 600): string {
  let s: string;
  try {
    s = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  return s.length > maxLen ? `${s.slice(0, maxLen)}…[truncated]` : s;
}

export function summarizeAgentTrace(transcript: string): string {
  const events = parseStream(transcript);
  if (!events) return extractFinalResponse(transcript);

  const lines: string[] = [];
  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;
    const type = (ev as { type?: string }).type;
    if (type === "assistant") {
      const message = (ev as { message?: { content?: ContentBlock[] } }).message;
      const blocks = message?.content ?? [];
      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          lines.push(`[assistant text] ${summarizeContent(block.text, 400)}`);
        } else if (block.type === "tool_use") {
          lines.push(`[tool_use] ${block.name ?? "?"} input=${summarizeContent(block.input)}`);
        }
      }
    } else if (type === "user") {
      const message = (ev as { message?: { content?: ContentBlock[] } }).message;
      const blocks = message?.content ?? [];
      for (const block of blocks) {
        if (block.type === "tool_result") {
          lines.push(`[tool_result] ${summarizeContent(block.content, 400)}`);
        }
      }
    } else if (type === "result") {
      const text = (ev as { result?: unknown }).result;
      if (typeof text === "string") lines.push(`[final] ${text}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : extractFinalResponse(transcript);
}

export function extractFinalResponse(transcript: string): string {
  const events = parseStream(transcript);
  if (events) {
    const resultEvent = [...events].reverse().find(
      (e) => e && typeof e === "object" && (e as { type?: string }).type === "result"
    ) as { result?: unknown } | undefined;
    if (resultEvent && typeof resultEvent.result === "string") {
      return resultEvent.result;
    }
  }
  return transcript;
}

export { REPO_ROOT };
