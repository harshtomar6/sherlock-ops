import { z } from "zod";
import type { Executor } from "../executor/types.js";
import { defineTool, type Tool } from "./types.js";

export function buildPm2Tools(executor: Executor): Tool[] {
  return [pm2List(executor), pm2Describe(executor), pm2Logs(executor)];
}

/* ─── pm2.list ────────────────────────────────────────────────────────── */

function pm2List(executor: Executor): Tool {
  return defineTool({
    name: "pm2_list",
    description:
      "List all PM2 processes on the host with status, restart count, uptime, CPU, and memory. Use this first to see what is running and which processes are restarting.",
    scope: "read",
    schema: z.object({}).strict(),
    run: async () => {
      const r = await executor.exec({ command: "pm2", args: ["jlist"] });
      if (r.exitCode !== 0) {
        throw new Error(`pm2 jlist failed (${r.exitCode}): ${r.stderr || r.stdout}`);
      }
      const start = r.stdout.indexOf("[");
      const json = start >= 0 ? r.stdout.slice(start) : r.stdout;
      const raw = JSON.parse(json) as Pm2RawProc[];
      return {
        processes: raw.map((p) => ({
          name: p.name,
          pmId: p.pm_id,
          pid: p.pid,
          status: p.pm2_env.status,
          restarts: p.pm2_env.restart_time ?? 0,
          unstableRestarts: p.pm2_env.unstable_restarts ?? 0,
          uptimeMs: p.pm2_env.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
          cpu: p.monit?.cpu ?? 0,
          memoryMb: Math.round((p.monit?.memory ?? 0) / 1024 / 1024),
          execMode: p.pm2_env.exec_mode,
          instances: p.pm2_env.instances ?? 1,
        })),
      };
    },
  });
}

/* ─── pm2.describe ────────────────────────────────────────────────────── */

function pm2Describe(executor: Executor): Tool {
  return defineTool({
    name: "pm2_describe",
    description:
      "Get detailed info about a single PM2 process: log file paths, exit code of last crash, env, script path, restart history. Use after pm2_list to dig into a specific process.",
    scope: "read",
    schema: z.object({
      process: z.string().describe("Process name or pm_id"),
    }).strict(),
    run: async ({ process }) => {
      const r = await executor.exec({ command: "pm2", args: ["jlist"] });
      if (r.exitCode !== 0) throw new Error(`pm2 jlist failed: ${r.stderr}`);
      const start = r.stdout.indexOf("[");
      const raw = JSON.parse(start >= 0 ? r.stdout.slice(start) : r.stdout) as Pm2RawProc[];
      const proc = raw.find(
        (p) => p.name === process || String(p.pm_id) === process,
      );
      if (!proc) throw new Error(`process not found: ${process}`);
      return {
        name: proc.name,
        pmId: proc.pm_id,
        pid: proc.pid,
        status: proc.pm2_env.status,
        restarts: proc.pm2_env.restart_time,
        unstableRestarts: proc.pm2_env.unstable_restarts,
        exitCode: proc.pm2_env.exit_code,
        execMode: proc.pm2_env.exec_mode,
        instances: proc.pm2_env.instances,
        nodeVersion: proc.pm2_env.node_version,
        script: proc.pm2_env.pm_exec_path,
        cwd: proc.pm2_env.pm_cwd,
        outLog: proc.pm2_env.pm_out_log_path,
        errLog: proc.pm2_env.pm_err_log_path,
        createdAt: proc.pm2_env.created_at,
        uptimeMs: proc.pm2_env.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : 0,
      };
    },
  });
}

/* ─── pm2.logs ────────────────────────────────────────────────────────── */

function pm2Logs(executor: Executor): Tool {
  return defineTool({
    name: "pm2_logs",
    description:
      "Read the last N lines of a PM2 process's logs (stdout, stderr, or both). Use stream='err' when investigating crashes or restarts.",
    scope: "read",
    schema: z.object({
      process: z.string().describe("Process name or pm_id, or 'all' for all processes"),
      lines: z.number().int().min(1).max(2000).default(200),
      stream: z.enum(["out", "err", "both"]).default("both"),
    }).strict(),
    run: async ({ process, lines, stream }) => {
      const args = ["logs", process, "--lines", String(lines), "--nostream", "--raw"];
      if (stream === "err") args.push("--err");
      if (stream === "out") args.push("--out");
      const r = await executor.exec({ command: "pm2", args, timeoutMs: 15_000 });
      if (r.exitCode !== 0 && !r.stdout) {
        throw new Error(`pm2 logs failed: ${r.stderr || "unknown error"}`);
      }
      return { logs: r.stdout, truncated: r.truncated };
    },
  });
}

/* ─── pm2 jlist raw shape (partial) ───────────────────────────────────── */

interface Pm2RawProc {
  name: string;
  pm_id: number;
  pid: number;
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
