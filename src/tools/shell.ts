import { z } from "zod";
import type { HostResolver } from "../executor/hostResolver.js";
import { defineTool, type Tool, type ToolScope } from "./types.js";

export function buildShellTools(resolver: HostResolver): Tool[] {
  const multi = resolver.isMultiHost();
  const known = resolver.knownHosts();
  const hostSchema = multi
    ? z.enum(known as [string, ...string[]]).describe(`Target host. One of: ${known.join(", ")}`)
    : z.string().optional().describe("Host (ignored in single-host mode)");

  return [
    defineTool({
      name: "shell_exec",
      description: [
        "Run an arbitrary shell command on the target host. Argv-style — quote args.",
        "Allowlisted commands run without approval; everything else requires human approval.",
        "Use for diagnostics like 'df -h', 'free -m', 'uptime', 'journalctl', 'top -bn1', etc.",
        "Do NOT use this for destructive operations (rm, dd, mkfs) — those will be denied even with approval unless an admin has explicitly approved.",
      ].join(" "),
      scope: "dangerous", // default; evaluateScope downgrades for allowlisted
      schema: z.object({
        host: hostSchema,
        command: z.string().describe("Full command line including arguments, e.g. 'df -h /var'"),
        timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
      }).strict(),
      evaluateScope: (args): ToolScope => {
        const a = args as { host?: string; command: string };
        const allowlist = resolver.shellAllowlistFor(a.host);
        return isAllowlisted(tokenize(a.command), allowlist) ? "read" : "dangerous";
      },
      run: async ({ host, command, timeoutMs }) => {
        const argv = tokenize(command);
        if (argv.length === 0) throw new Error("empty command");
        const [bin, ...args] = argv;
        const r = await resolver.resolve(host as string | undefined).exec({
          command: bin!,
          args,
          timeoutMs,
        });
        return {
          command,
          exitCode: r.exitCode,
          stdout: r.stdout,
          stderr: r.stderr,
          durationMs: r.durationMs,
          truncated: r.truncated,
        };
      },
    }),
  ];
}

/**
 * Tokenize a shell-style command line into argv. Supports single and double
 * quotes. Does *not* expand variables, globs, or perform escape processing —
 * we deliberately stay simple because tokenized argv is what gets passed
 * straight to spawn (no shell layer).
 */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;

    const ch = s[i]!;
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      const start = i;
      while (i < s.length && s[i] !== quote) i++;
      out.push(s.slice(start, i));
      if (i < s.length) i++; // skip closing quote
    } else {
      const start = i;
      while (i < s.length && !/\s/.test(s[i]!) && s[i] !== '"' && s[i] !== "'") i++;
      out.push(s.slice(start, i));
    }
  }
  return out;
}

/**
 * Allowlist matching: each allowlist entry is treated as a sequence of tokens
 * that must appear at the start of the input argv. Example:
 *   allowlist: ["df -h", "journalctl -u nginx"]
 *   input "df -h /var"        → allowed (df -h is a prefix)
 *   input "journalctl -u app" → denied  (different unit)
 *   input "rm -rf /"          → denied
 */
export function isAllowlisted(input: string[], allowlist: string[]): boolean {
  if (input.length === 0) return false;
  for (const entry of allowlist) {
    const allowed = tokenize(entry);
    if (allowed.length === 0) continue;
    if (input.length < allowed.length) continue;
    let match = true;
    for (let i = 0; i < allowed.length; i++) {
      if (allowed[i] !== input[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}
