import { z } from "zod";

export type ToolScope = "read" | "mutate" | "dangerous";

export interface Tool {
  name: string;
  description: string;
  /** Static scope. Used when evaluateScope is absent. */
  scope: ToolScope;
  /** Optional — compute scope per call based on validated args. */
  evaluateScope?: (args: unknown) => ToolScope;
  schema: z.ZodTypeAny;
  run: (args: unknown) => Promise<unknown>;
}

export function defineTool<S extends z.ZodTypeAny, R>(spec: {
  name: string;
  description: string;
  scope: ToolScope;
  evaluateScope?: (args: z.infer<S>) => ToolScope;
  schema: S;
  run: (args: z.infer<S>) => Promise<R>;
}): Tool {
  return spec as unknown as Tool;
}

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface ToolResult {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export function effectiveScope(tool: Tool, args: unknown): ToolScope {
  return tool.evaluateScope ? tool.evaluateScope(args) : tool.scope;
}
