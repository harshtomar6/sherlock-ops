import { spawn } from "node:child_process";
import type { ExecOpts, ExecResult, Executor } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 256 * 1024; // 256 KB — LLM context budget protection

export class LocalExecutor implements Executor {
  async exec(opts: ExecOpts): Promise<ExecResult> {
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_BYTES;

    return new Promise<ExecResult>((resolve, reject) => {
      const child = spawn(opts.command, opts.args ?? [], {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        shell: false,
      });

      let stdout = "";
      let stderr = "";
      let truncated = false;
      let bytes = 0;

      const onData = (stream: "out" | "err") => (chunk: Buffer) => {
        if (truncated) return;
        bytes += chunk.length;
        if (bytes > maxBytes) {
          truncated = true;
          child.kill("SIGTERM");
          return;
        }
        if (stream === "out") stdout += chunk.toString("utf8");
        else stderr += chunk.toString("utf8");
      };

      child.stdout.on("data", onData("out"));
      child.stderr.on("data", onData("err"));

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
      }, timeoutMs);

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr,
          exitCode: code ?? -1,
          durationMs: Date.now() - started,
          truncated,
        });
      });
    });
  }
}
