import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * A skill is a markdown document that teaches the agent how to perform a
 * class of tasks with plain shell commands: which commands to run, how to
 * read their output, and what needs approval. Skills carry no code — the
 * only execution primitive is shell_exec.
 */
export interface Skill {
  /** Skill name — derived from the file name (e.g. pm2.md → 'pm2'). */
  name: string;
  /** One-line summary from frontmatter. */
  description: string;
  /**
   * Command prefixes this skill vouches for as safe reads. Merged into the
   * shell allowlist on every host, so these run without approval.
   */
  allow: string[];
  /** Markdown body appended to the system prompt. */
  body: string;
  /** Absolute path the skill was loaded from, or 'builtin:<name>.md'. */
  source: string;
}

const frontmatterSchema = z
  .object({
    description: z.string().min(1),
    allow: z.array(z.string().min(1)).optional().default([]),
  })
  .strict();

/**
 * Resolve and load the named skills. Each name resolves to a markdown file:
 *   1. <skillsDir>/<name>.md   (operator skills — SHERLOCK_SKILLS_DIR,
 *      default ./sherlock-skills; also lets operators override a built-in)
 *   2. bundled skills/builtin/<name>.md
 *
 * An unresolvable name is a boot error — the operator asked for a skill
 * that doesn't exist, so fail loudly instead of silently running without it.
 */
export function loadSkills(names: string[]): Skill[] {
  assertUnique(names);
  const skillsDir = operatorSkillsDir();
  const builtinDir = builtinSkillsDir();

  return names.map((name) => {
    if (!/^[a-z][a-z0-9_-]*$/i.test(name)) {
      throw new Error(`invalid skill name '${name}' — expected a simple identifier`);
    }
    const operatorPath = resolve(skillsDir, `${name}.md`);
    const operatorRaw = tryRead(operatorPath);
    if (operatorRaw !== undefined) {
      return parseSkillFile(name, operatorRaw, operatorPath);
    }
    const builtinPath = resolve(builtinDir, `${name}.md`);
    const builtinRaw = tryRead(builtinPath);
    if (builtinRaw !== undefined) {
      return parseSkillFile(name, builtinRaw, `builtin:${name}.md`);
    }
    throw new Error(
      `skill '${name}' not found — looked for ${operatorPath} and builtin ${name}.md`,
    );
  });
}

/**
 * Compose the final system prompt: base prompt plus one section per skill.
 * With no skills enabled the base prompt is used untouched.
 */
export function composeSystemPrompt(base: string, skills: Skill[]): string {
  if (skills.length === 0) return base;
  const sections = skills.map(
    (s) => `## Skill: ${s.name}\n\n${s.body.trim()}`,
  );
  return [
    base.trim(),
    "# Skills",
    "The sections below teach you how to handle specific systems and tasks. Follow them — they tell you which commands to run, how to read the output, and what requires approval.",
    ...sections,
  ].join("\n\n");
}

/** Parse and validate a skill file's raw content. Exported for the skills CLI. */
export function parseSkillFile(name: string, raw: string, source: string): Skill {
  const { frontmatter, body } = splitFrontmatter(raw, source);
  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(frontmatter);
  } catch (err) {
    throw new Error(
      `skill '${name}' (${source}): invalid YAML frontmatter: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const fm = frontmatterSchema.safeParse(parsedYaml);
  if (!fm.success) {
    throw new Error(`skill '${name}' (${source}): ${fm.error.message}`);
  }
  if (body.trim().length === 0) {
    throw new Error(`skill '${name}' (${source}): empty body — nothing to teach`);
  }
  return { name, description: fm.data.description, allow: fm.data.allow, body, source };
}

/**
 * Frontmatter is the block between the leading '---' line and the next
 * '---' line. Required — a skill without a description is a config error.
 */
function splitFrontmatter(
  raw: string,
  source: string,
): { frontmatter: string; body: string } {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") {
    throw new Error(`skill file ${source} must start with '---' YAML frontmatter`);
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) {
    throw new Error(`skill file ${source}: unterminated frontmatter (missing closing '---')`);
  }
  return {
    frontmatter: lines.slice(1, end).join("\n"),
    body: lines.slice(end + 1).join("\n"),
  };
}

export function operatorSkillsDir(): string {
  return resolve(process.cwd(), process.env.SHERLOCK_SKILLS_DIR ?? "sherlock-skills");
}

export function builtinSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/skills/loader.ts  -> src/skills/builtin
  // dist/skills/loader.js -> dist/skills/builtin (after postbuild copy)
  return resolve(here, "builtin");
}

function tryRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function assertUnique(names: string[]): void {
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) throw new Error(`duplicate skill '${n}' in config`);
    seen.add(n);
  }
}
