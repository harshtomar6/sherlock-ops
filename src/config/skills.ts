import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Reads the enabled-skills list from sherlock-config.json:
 *
 *   { "skills": ["pm2"] }
 *
 * Nothing is enabled by default — a missing file or missing key means the
 * bot boots with no skills and only the bare shell_exec primitive.
 * Malformed JSON throws; silent failures here would hide misconfiguration.
 */
export function loadEnabledSkillNames(): string[] {
  const path = process.env.SHERLOCK_CONFIG_FILE ?? "sherlock-config.json";
  const absolute = resolve(process.cwd(), path);

  let raw: string;
  try {
    raw = readFileSync(absolute, "utf8");
  } catch {
    return [];
  }

  let parsed: { skills?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `failed to parse ${absolute}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (parsed.skills === undefined) return [];
  if (
    !Array.isArray(parsed.skills) ||
    parsed.skills.some((s) => typeof s !== "string" || s.trim() === "")
  ) {
    throw new Error(`${absolute}: 'skills' must be an array of skill names`);
  }
  return parsed.skills.map((s: string) => s.trim());
}
