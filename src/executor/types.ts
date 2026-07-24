export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
}

export interface ExecOpts {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Text written to the child's stdin. stdin is always closed after writing. */
  stdin?: string;
}

export interface Executor {
  exec(opts: ExecOpts): Promise<ExecResult>;
}
