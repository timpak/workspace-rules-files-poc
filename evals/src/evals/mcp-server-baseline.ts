import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "../driver.js";
import { categorize, type CriterionOutcome } from "../graders/bucket.js";
import { standardCleanupHooks } from "./shared.js";
import type { EvalCase, EvalResult } from "./types.js";

const ID = "mcp-server-baseline";

const PROMPT = `Set up the Liferay MCP server for Claude Code in this workspace. I want to be able to use MCP to call our Liferay APIs.`;

const RUBRIC_PATH = resolve(REPO_ROOT, "evals/rubrics/mcp-server-baseline.md");
const MCP_JSON_PATH = resolve(REPO_ROOT, ".mcp.json");
const GRADLE_PROPERTIES_PATH = resolve(REPO_ROOT, "gradle.properties");

type Version = "2025.Q4" | "2026.Q1+" | "unknown";

function readWorkspaceProduct(): string | null {
  if (!existsSync(GRADLE_PROPERTIES_PATH)) return null;
  for (const line of readFileSync(GRADLE_PROPERTIES_PATH, "utf8").split("\n")) {
    const m = line.match(/^\s*liferay\.workspace\.product\s*=\s*(.+?)\s*$/);
    if (m) return m[1];
  }
  return null;
}

function classifyVersion(product: string | null): Version {
  if (!product) return "unknown";
  // e.g. dxp-2026.q1.6-lts, dxp-2025.q4.3, portal-2026.q1.5
  const m = product.match(/(\d{4})\.q(\d)/i);
  if (!m) return "unknown";
  const year = Number.parseInt(m[1], 10);
  const quarter = Number.parseInt(m[2], 10);
  if (year < 2026 || (year === 2026 && quarter < 1)) {
    return year === 2025 && quarter === 4 ? "2025.Q4" : "2025.Q4";
  }
  return "2026.Q1+";
}

type ParsedServer = {
  type: string | null;
  url: string | null;
  authHeader: string | null;
};

function parseMcpJson(): { servers: ParsedServer[]; parseError?: string } | null {
  if (!existsSync(MCP_JSON_PATH)) return null;
  let raw: string;
  try {
    raw = readFileSync(MCP_JSON_PATH, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      servers: [],
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const serversField = (obj.mcpServers ?? obj.servers) as Record<string, unknown> | undefined;
  if (!serversField || typeof serversField !== "object") return { servers: [] };

  const out: ParsedServer[] = [];
  for (const [, entry] of Object.entries(serversField)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const type = typeof e.type === "string" ? e.type.toLowerCase() : null;
    const url = typeof e.url === "string" ? e.url : null;
    let authHeader: string | null = null;
    const headers = e.headers as Record<string, unknown> | undefined;
    if (headers && typeof headers === "object") {
      const auth = headers.Authorization ?? headers.authorization;
      if (typeof auth === "string") authHeader = auth;
    }
    out.push({ type, url, authHeader });
  }
  return { servers: out };
}

function findLiferayServer(parsed: { servers: ParsedServer[] }): ParsedServer | null {
  for (const s of parsed.servers) {
    if (s.url && /\/o\/mcp(\b|\/|$)/.test(s.url)) return s;
  }
  return parsed.servers[0] ?? null;
}

const hooks = standardCleanupHooks();

export const mcpServerBaseline: EvalCase = {
  id: ID,
  description:
    "STRICT-on-2 baseline for the mcp-server skill (.mcp.json transport + URL must match the workspace DXP version).",
  prompt: PROMPT,
  tier: "baseline",
  passRule: "strict",
  rubricPath: RUBRIC_PATH,
  requiredFeatureFlags: ["LPD-63311"],
  setup: hooks.setup,
  teardown: hooks.teardown,
  grade: async (driver): Promise<EvalResult> => {
    const product = readWorkspaceProduct();
    const version = classifyVersion(product);

    const parsed = parseMcpJson();
    const criteria: CriterionOutcome[] = [];

    if (!parsed) {
      criteria.push({ id: "C1", passed: false, bucketOnFail: "skill-not-invoked" });
      criteria.push({ id: "C2", passed: false, bucketOnFail: "skill-not-invoked" });
      criteria.push({ id: "C3", passed: false, bucketOnFail: "skill-not-invoked" });
      const failureBucket = categorize({
        passed: false,
        agentTimedOut: driver.timedOut,
        criteria,
      });
      return {
        id: ID,
        passed: false,
        comment: `No .mcp.json found at repo root.`,
        durationMs: driver.durationMs,
        failureBucket,
        detail: { criteria, version, product },
      };
    }

    if (parsed.parseError) {
      criteria.push({ id: "C1", passed: false, bucketOnFail: "artifact-malformed" });
      criteria.push({ id: "C2", passed: false, bucketOnFail: "artifact-malformed" });
      criteria.push({ id: "C3", passed: false, bucketOnFail: "artifact-malformed" });
      const failureBucket = categorize({
        passed: false,
        agentTimedOut: driver.timedOut,
        criteria,
      });
      return {
        id: ID,
        passed: false,
        comment: `.mcp.json failed to parse: ${parsed.parseError}`,
        durationMs: driver.durationMs,
        failureBucket,
        detail: { criteria, version, product },
      };
    }

    const server = findLiferayServer(parsed);
    if (!server) {
      criteria.push({ id: "C1", passed: false, bucketOnFail: "skill-not-invoked" });
      criteria.push({ id: "C2", passed: false, bucketOnFail: "skill-not-invoked" });
      criteria.push({ id: "C3", passed: false, bucketOnFail: "skill-not-invoked" });
      const failureBucket = categorize({
        passed: false,
        agentTimedOut: driver.timedOut,
        criteria,
      });
      return {
        id: ID,
        passed: false,
        comment: `.mcp.json present but no Liferay MCP server entry found.`,
        durationMs: driver.durationMs,
        failureBucket,
        detail: { criteria, version, product, parsed },
      };
    }

    let c1Pass = false;
    let c2Pass = false;
    let comment = "";

    if (version === "2025.Q4") {
      c1Pass = server.type === "sse";
      c2Pass = server.url !== null && server.url.endsWith("/o/mcp/sse");
      if (!c1Pass) comment += `C1: expected type=sse for 2025.Q4, got type=${server.type}. `;
      if (!c2Pass) comment += `C2: expected url ending /o/mcp/sse, got url=${server.url}. `;
    } else if (version === "2026.Q1+") {
      c1Pass = server.type === "http" || server.type === "streamable-http";
      c2Pass =
        server.url !== null &&
        /\/o\/mcp\/?$/.test(server.url) &&
        !server.url.endsWith("/o/mcp/sse");
      if (!c1Pass) comment += `C1: expected type=http for 2026.Q1+, got type=${server.type}. `;
      if (!c2Pass) comment += `C2: expected url ending /o/mcp (no /sse), got url=${server.url}. `;
    } else {
      // Unknown version — can't grade against the version-conditional map.
      // Fail closed and tag as unknown so we don't quietly pass on bad fixture.
      comment += `Could not classify DXP version from product=${product ?? "(missing)"}. `;
    }

    const c3Pass = server.authHeader !== null && /^Basic\s+/i.test(server.authHeader);

    criteria.push({ id: "C1", passed: c1Pass, bucketOnFail: "rule-misapplied" });
    criteria.push({ id: "C2", passed: c2Pass, bucketOnFail: "rule-misapplied" });
    criteria.push({ id: "C3", passed: c3Pass, bucketOnFail: "rule-misapplied" });

    // Pass rule: STRICT on C1+C2 (C3 supporting).
    const passed = c1Pass && c2Pass;
    const failureBucket = categorize({
      passed,
      agentTimedOut: driver.timedOut,
      criteria: criteria.filter((c) => c.id !== "C3" || !c.passed),
    });

    return {
      id: ID,
      passed,
      comment:
        passed && c3Pass
          ? `All criteria passed (version=${version}, type=${server.type}, url=${server.url}).`
          : passed
            ? `C1+C2 passed; C3 (auth) failed but supporting only. ${comment}`.trim()
            : `Failed: ${comment.trim()}`,
      durationMs: driver.durationMs,
      failureBucket,
      detail: { criteria, version, product, server },
    };
  },
};
