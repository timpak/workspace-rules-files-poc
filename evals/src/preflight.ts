import { existsSync, readFileSync } from "node:fs";
import { workspacePath } from "./workspace.js";

const PORTAL_EXT_PATH = workspacePath("bundles/portal-ext.properties");

/**
 * Returns the set of feature flags currently enabled in
 * `bundles/portal-ext.properties`. Only reads the properties file —
 * OSGi-config overrides under `bundles/osgi/configs/` are not consulted.
 * If a flag is set there but not in `portal-ext.properties`, the preflight
 * will report it as missing; set it in the properties file too.
 */
export function readEnabledFlags(): Set<string> {
  const enabled = new Set<string>();
  if (!existsSync(PORTAL_EXT_PATH)) return enabled;
  const content = readFileSync(PORTAL_EXT_PATH, "utf8");
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^feature\.flag\.([A-Za-z0-9-]+)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    if (m[2].toLowerCase() === "true") {
      enabled.add(m[1]);
    }
  }
  return enabled;
}

export function checkRequiredFlags(required: string[]): {
  ok: boolean;
  missing: string[];
  enabled: Set<string>;
} {
  const enabled = readEnabledFlags();
  const missing = required.filter((f) => !enabled.has(f));
  return { ok: missing.length === 0, missing, enabled };
}
