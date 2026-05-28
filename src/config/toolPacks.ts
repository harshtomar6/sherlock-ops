import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Each known built-in tool pack maps to a boolean. Unknown keys in the
 * config file are ignored on read — that way operators can keep stale
 * keys around through a downgrade without breaking boot.
 */
export interface ToolPacksCfg {
  pm2: boolean;
  shell: boolean;
}

const DEFAULTS: ToolPacksCfg = { pm2: true, shell: true };

/**
 * Loads {@link ToolPacksCfg} from sherlock-config.json. Missing file is
 * treated as "use defaults" so existing single-host deployments work
 * unchanged. Malformed JSON throws — silent failures here would hide
 * misconfiguration.
 */
export function loadToolPacks(): ToolPacksCfg {
  const path = process.env.SHERLOCK_CONFIG_FILE ?? "sherlock-config.json";
  const absolute = resolve(process.cwd(), path);

  let raw: string;
  try {
    raw = readFileSync(absolute, "utf8");
  } catch {
    return { ...DEFAULTS };
  }

  let parsed: { toolPacks?: Partial<Record<keyof ToolPacksCfg, boolean>> };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `failed to parse ${absolute}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const packs = parsed.toolPacks ?? {};
  return {
    pm2: typeof packs.pm2 === "boolean" ? packs.pm2 : DEFAULTS.pm2,
    shell: typeof packs.shell === "boolean" ? packs.shell : DEFAULTS.shell,
  };
}

export function enabledPackNames(cfg: ToolPacksCfg): string[] {
  return (Object.keys(cfg) as (keyof ToolPacksCfg)[]).filter((k) => cfg[k]);
}
