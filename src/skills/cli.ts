/**
 * Skill management CLI — the write-side counterpart of the skill loader.
 * Invoked by the bot itself (via the skill-author skill) or by operators:
 *
 *   node dist/skills/cli.js list
 *   node dist/skills/cli.js show <name>
 *   node dist/skills/cli.js write <name>     (skill markdown on stdin; auto-enables)
 *   node dist/skills/cli.js enable <name>
 *   node dist/skills/cli.js disable <name>
 *
 * Respects SHERLOCK_SKILLS_DIR and SHERLOCK_CONFIG_FILE like the loader.
 * `write` validates the skill and rejects `allow` entries that would
 * silently remove the approval gate from dangerous commands.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { tokenize } from "../tools/shell.js";
import {
  builtinSkillsDir,
  operatorSkillsDir,
  parseSkillFile,
  type Skill,
} from "./loader.js";

/**
 * Commands that must never be allowlisted: interpreters, file mutators,
 * privilege escalation, package managers — anything that would let a skill
 * bypass the approval flow for state-changing or arbitrary-code execution.
 * Operators editing skill files by hand bypass this; the CLI does not.
 */
const DENIED_ALLOW_BINARIES = new Set([
  "rm", "rmdir", "dd", "mkfs", "shred", "truncate",
  "sudo", "su", "doas",
  "bash", "sh", "zsh", "dash", "ksh", "env", "xargs", "eval", "exec",
  "python", "python3", "node", "deno", "bun", "perl", "ruby", "php",
  "nc", "ncat", "netcat", "socat", "curl", "wget", "ssh", "scp", "rsync",
  "chmod", "chown", "chgrp", "mv", "cp", "ln", "tee", "install",
  "kill", "pkill", "killall", "reboot", "shutdown", "halt", "poweroff", "init",
  "apt", "apt-get", "dnf", "yum", "pacman", "npm", "npx", "pip", "pip3",
  "docker", "podman", "crontab", "at", "git",
]);

const READONLY_SYSTEMCTL = new Set([
  "status", "show", "cat", "is-active", "is-enabled", "is-failed",
  "list-units", "list-unit-files", "list-timers",
]);

function checkAllowEntry(entry: string): string | undefined {
  const tokens = tokenize(entry);
  const bin = basename(tokens[0] ?? "");
  if (!bin) return "empty allow entry";
  if (DENIED_ALLOW_BINARIES.has(bin)) {
    return `'${bin}' must not be allowlisted — it would bypass the approval flow`;
  }
  if (bin === "systemctl" && !READONLY_SYSTEMCTL.has(tokens[1] ?? "")) {
    return `'systemctl' may only be allowlisted with a read-only subcommand (${[...READONLY_SYSTEMCTL].join(", ")})`;
  }
  return undefined;
}

function configPath(): string {
  return resolve(process.cwd(), process.env.SHERLOCK_CONFIG_FILE ?? "sherlock-config.json");
}

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

function enabledSkills(cfg: Record<string, unknown>): string[] {
  return Array.isArray(cfg.skills) ? cfg.skills.filter((s): s is string => typeof s === "string") : [];
}

function setEnabled(names: string[]): void {
  const cfg = readConfig();
  cfg.skills = names;
  writeAtomic(configPath(), `${JSON.stringify(cfg, null, 2)}\n`);
}

function skillFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

function resolveSkillPath(name: string): { path: string; source: string } | undefined {
  const operator = resolve(operatorSkillsDir(), `${name}.md`);
  if (existsSync(operator)) return { path: operator, source: operator };
  const builtin = resolve(builtinSkillsDir(), `${name}.md`);
  if (existsSync(builtin)) return { path: builtin, source: `builtin:${name}.md` };
  return undefined;
}

function assertValidName(name: string): void {
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    throw new Error(`invalid skill name '${name}' — use kebab-case (e.g. nginx-health)`);
  }
}

/* ─── commands ────────────────────────────────────────────────────────── */

function cmdList(): void {
  console.log(JSON.stringify({
    enabled: enabledSkills(readConfig()),
    operator: skillFiles(operatorSkillsDir()),
    builtin: skillFiles(builtinSkillsDir()),
    skillsDir: operatorSkillsDir(),
    config: configPath(),
  }, null, 2));
}

function cmdShow(name: string): void {
  assertValidName(name);
  const found = resolveSkillPath(name);
  if (!found) throw new Error(`skill '${name}' not found`);
  process.stdout.write(readFileSync(found.path, "utf8"));
}

function cmdWrite(name: string): void {
  assertValidName(name);
  const raw = readFileSync(0, "utf8"); // stdin
  if (raw.trim().length === 0) throw new Error("no skill content on stdin");

  const dir = operatorSkillsDir();
  const path = resolve(dir, `${name}.md`);
  const skill: Skill = parseSkillFile(name, raw, path);

  const problems = skill.allow.map(checkAllowEntry).filter((p): p is string => p !== undefined);
  if (problems.length > 0) {
    throw new Error(`rejected allow entries:\n- ${problems.join("\n- ")}`);
  }

  mkdirSync(dir, { recursive: true });
  const existed = existsSync(path);
  writeAtomic(path, raw.endsWith("\n") ? raw : `${raw}\n`);

  const enabled = enabledSkills(readConfig());
  if (!enabled.includes(name)) setEnabled([...enabled, name]);

  console.log(JSON.stringify({
    ok: true,
    action: existed ? "updated" : "created",
    name,
    path,
    description: skill.description,
    allow: skill.allow,
    enabled: true,
    note: "active from the next message",
  }, null, 2));
}

function cmdEnable(name: string): void {
  assertValidName(name);
  if (!resolveSkillPath(name)) throw new Error(`skill '${name}' not found — nothing to enable`);
  const enabled = enabledSkills(readConfig());
  if (!enabled.includes(name)) setEnabled([...enabled, name]);
  console.log(JSON.stringify({ ok: true, enabled: [...new Set([...enabled, name])] }));
}

function cmdDisable(name: string): void {
  assertValidName(name);
  const enabled = enabledSkills(readConfig());
  if (!enabled.includes(name)) throw new Error(`skill '${name}' is not enabled`);
  setEnabled(enabled.filter((n) => n !== name));
  console.log(JSON.stringify({ ok: true, enabled: enabled.filter((n) => n !== name) }));
}

function main(): void {
  const [cmd, name] = process.argv.slice(2);
  switch (cmd) {
    case "list": cmdList(); break;
    case "show": requireName(name); cmdShow(name!); break;
    case "write": requireName(name); cmdWrite(name!); break;
    case "enable": requireName(name); cmdEnable(name!); break;
    case "disable": requireName(name); cmdDisable(name!); break;
    default:
      console.error("usage: cli.js <list | show <name> | write <name> | enable <name> | disable <name>>");
      process.exit(2);
  }
}

function requireName(name: string | undefined): void {
  if (!name) throw new Error("missing skill name");
}

try {
  main();
} catch (err) {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
