import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { parseToolsFile, type ToolDeclaration } from "../tools/declarative.js";

export interface CustomToolsCfg {
  /** Empty when no file present. */
  declarations: ToolDeclaration[];
  /** Either the loaded path or 'none' when no file was found. */
  source: string;
}

/**
 * Loads YAML tool declarations from SHERLOCK_TOOLS_FILE (override) or
 * sherlock-tools.yaml in cwd. Missing file is fine — declarations is [].
 * Malformed YAML or schema errors fail loudly at boot.
 */
export function loadCustomTools(): CustomToolsCfg {
  const path = process.env.SHERLOCK_TOOLS_FILE ?? "sherlock-tools.yaml";
  const absolute = resolve(process.cwd(), path);

  let raw: string;
  try {
    raw = readFileSync(absolute, "utf8");
  } catch {
    return { declarations: [], source: "none" };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `failed to parse ${absolute}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const file = parseToolsFile(parsed);
    assertUniqueNames(file.tools, absolute);
    return { declarations: file.tools, source: absolute };
  } catch (err) {
    throw new Error(
      `invalid tool declarations in ${absolute}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

function assertUniqueNames(decls: ToolDeclaration[], path: string): void {
  const seen = new Set<string>();
  for (const d of decls) {
    if (seen.has(d.name)) {
      throw new Error(`${path}: duplicate tool name '${d.name}'`);
    }
    seen.add(d.name);
  }
}
