import { z } from "zod";
import type { HostResolver } from "../executor/hostResolver.js";
import { defineTool, type Tool } from "./types.js";

export function buildPm2Tools(resolver: HostResolver): Tool[] {
  const multi = resolver.isMultiHost();
  const known = resolver.knownHosts();
  const hostSchema = multi
    ? z.enum(known as [string, ...string[]]).describe(`Target host. One of: ${known.join(", ")}`)
    : z.string().optional().describe("Host (ignored in single-host mode)");
  const hostNote = multi ? " On host {host}." : "";

  return [
    /* ─── read tools ─────────────────────────────────────────────────── */

    defineTool({
      name: "pm2_list",
      description: `List all PM2 processes with status, restart count, uptime, CPU, and memory.${hostNote} Use this first to see what is running and which processes are restarting.`,
      scope: "read",
      schema: z.object({ host: hostSchema }).strict(),
      run: async ({ host }) => {
        const r = await resolver.resolve(host as string | undefined).exec({ command: "pm2", args: ["jlist"] });
        if (r.exitCode !== 0) throw new Error(`pm2 jlist failed (${r.exitCode}): ${r.stderr || r.stdout}`);
        const start = r.stdout.indexOf("[");
        const raw = JSON.parse(start >= 0 ? r.stdout.slice(start) : r.stdout) as Pm2RawProc[];
        return { host: host ?? "local", processes: raw.map(summarize) };
      },
    }),

    defineTool({
      name: "pm2_describe",
      description: `Get detailed info about a single PM2 process: log paths, exit code, env, restart history.${hostNote} Use after pm2_list to dig into a specific process.`,
      scope: "read",
      schema: z.object({ host: hostSchema, process: z.string().describe("Process name or pm_id") }).strict(),
      run: async ({ host, process }) => {
        const r = await resolver.resolve(host as string | undefined).exec({ command: "pm2", args: ["jlist"] });
        if (r.exitCode !== 0) throw new Error(`pm2 jlist failed: ${r.stderr}`);
        const start = r.stdout.indexOf("[");
        const raw = JSON.parse(start >= 0 ? r.stdout.slice(start) : r.stdout) as Pm2RawProc[];
        const proc = raw.find((p) => p.name === process || String(p.pm_id) === process);
        if (!proc) throw new Error(`process not found: ${process}`);
        return describe(proc);
      },
    }),

    defineTool({
      name: "pm2_logs",
      description: `Read the last N lines of a PM2 process's logs (stdout, stderr, or both).${hostNote} Use stream='err' when investigating crashes.`,
      scope: "read",
      schema: z.object({
        host: hostSchema,
        process: z.string().describe("Process name or pm_id, or 'all'"),
        lines: z.number().int().min(1).max(2000).default(200),
        stream: z.enum(["out", "err", "both"]).default("both"),
      }).strict(),
      run: async ({ host, process, lines, stream }) => {
        const args = ["logs", process, "--lines", String(lines), "--nostream", "--raw"];
        if (stream === "err") args.push("--err");
        if (stream === "out") args.push("--out");
        const r = await resolver.resolve(host as string | undefined).exec({ command: "pm2", args, timeoutMs: 15_000 });
        if (r.exitCode !== 0 && !r.stdout) throw new Error(`pm2 logs failed: ${r.stderr || "unknown error"}`);
        return { logs: r.stdout, truncated: r.truncated };
      },
    }),

    /* ─── mutating tools (require approval) ──────────────────────────── */

    defineTool({
      name: "pm2_restart",
      description: `Restart a PM2 process. Requires approval.${hostNote}`,
      scope: "mutate",
      schema: z.object({ host: hostSchema, process: z.string().describe("Process name or pm_id, or 'all'") }).strict(),
      run: async ({ host, process }) => runPm2(resolver, host as string | undefined, ["restart", process]),
    }),

    defineTool({
      name: "pm2_stop",
      description: `Stop a PM2 process. Requires approval.${hostNote}`,
      scope: "mutate",
      schema: z.object({ host: hostSchema, process: z.string() }).strict(),
      run: async ({ host, process }) => runPm2(resolver, host as string | undefined, ["stop", process]),
    }),

    defineTool({
      name: "pm2_start",
      description: `Start a stopped PM2 process. Requires approval.${hostNote}`,
      scope: "mutate",
      schema: z.object({ host: hostSchema, process: z.string() }).strict(),
      run: async ({ host, process }) => runPm2(resolver, host as string | undefined, ["start", process]),
    }),

    defineTool({
      name: "pm2_reload",
      description: `Gracefully reload (zero-downtime) a PM2 process in cluster mode. Requires approval.${hostNote}`,
      scope: "mutate",
      schema: z.object({ host: hostSchema, process: z.string() }).strict(),
      run: async ({ host, process }) => runPm2(resolver, host as string | undefined, ["reload", process]),
    }),

    defineTool({
      name: "pm2_delete",
      description: `Delete a PM2 process (removes it from the process list entirely). Requires approval.${hostNote}`,
      scope: "dangerous",
      schema: z.object({ host: hostSchema, process: z.string() }).strict(),
      run: async ({ host, process }) => runPm2(resolver, host as string | undefined, ["delete", process]),
    }),
  ];
}

async function runPm2(
  resolver: HostResolver,
  host: string | undefined,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const r = await resolver.resolve(host).exec({ command: "pm2", args });
  if (r.exitCode !== 0) throw new Error(`pm2 ${args.join(" ")} failed (${r.exitCode}): ${r.stderr || r.stdout}`);
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

interface ProcSummary {
  name: string; pmId: number; pid: number; status: string;
  restarts: number; unstableRestarts: number; uptimeMs: number;
  cpu: number; memoryMb: number; execMode: string; instances: number;
}

function summarize(p: Pm2RawProc): ProcSummary {
  return {
    name: p.name, pmId: p.pm_id, pid: p.pid, status: p.pm2_env.status,
    restarts: p.pm2_env.restart_time ?? 0,
    unstableRestarts: p.pm2_env.unstable_restarts ?? 0,
    uptimeMs: p.pm2_env.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
    cpu: p.monit?.cpu ?? 0,
    memoryMb: Math.round((p.monit?.memory ?? 0) / 1024 / 1024),
    execMode: p.pm2_env.exec_mode, instances: p.pm2_env.instances ?? 1,
  };
}

function describe(p: Pm2RawProc): Record<string, unknown> {
  return {
    name: p.name, pmId: p.pm_id, pid: p.pid, status: p.pm2_env.status,
    restarts: p.pm2_env.restart_time,
    unstableRestarts: p.pm2_env.unstable_restarts,
    exitCode: p.pm2_env.exit_code,
    execMode: p.pm2_env.exec_mode,
    instances: p.pm2_env.instances,
    nodeVersion: p.pm2_env.node_version,
    script: p.pm2_env.pm_exec_path,
    cwd: p.pm2_env.pm_cwd,
    outLog: p.pm2_env.pm_out_log_path,
    errLog: p.pm2_env.pm_err_log_path,
    createdAt: p.pm2_env.created_at,
    uptimeMs: p.pm2_env.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
  };
}

interface Pm2RawProc {
  name: string; pm_id: number; pid: number;
  pm2_env: {
    status: string;
    restart_time?: number;
    unstable_restarts?: number;
    exit_code?: number;
    pm_uptime?: number;
    exec_mode: string;
    instances?: number;
    node_version?: string;
    pm_exec_path?: string;
    pm_cwd?: string;
    pm_out_log_path?: string;
    pm_err_log_path?: string;
    created_at?: number;
  };
  monit?: { cpu?: number; memory?: number };
}
