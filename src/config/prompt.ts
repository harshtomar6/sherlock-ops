import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PromptCfg {
  text: string;
  /** Either an absolute path (override) or 'builtin:default.md'. */
  source: string;
}

/**
 * Resolve the system prompt at boot. Priority:
 *   1. SHERLOCK_SYSTEM_PROMPT_FILE env var (absolute or cwd-relative path)
 *   2. bundled src/prompts/default.md
 *
 * Missing override file is a fatal error — fail fast at boot, never
 * silently fall through to the default after an operator asked for a
 * specific prompt.
 */
export function loadSystemPrompt(): PromptCfg {
  const override = process.env.SHERLOCK_SYSTEM_PROMPT_FILE?.trim();
  if (override) {
    const absolute = resolve(process.cwd(), override);
    try {
      const text = readFileSync(absolute, "utf8");
      return { text, source: absolute };
    } catch (err) {
      throw new Error(
        `SHERLOCK_SYSTEM_PROMPT_FILE=${absolute} could not be read: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const here = dirname(fileURLToPath(import.meta.url));
  // src/config/prompt.ts -> src/prompts/default.md
  // dist/config/prompt.js -> dist/prompts/default.md (after postbuild copy)
  const builtin = resolve(here, "..", "prompts", "default.md");
  const text = readFileSync(builtin, "utf8");
  return { text, source: "builtin:default.md" };
}
