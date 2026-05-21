import { zodToJsonSchema } from "zod-to-json-schema";
import type { ProviderToolDef } from "../llm/types.js";
import type { Tool } from "../tools/types.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: Tool[]): void {
    for (const t of tools) this.register(t);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  toProviderDefs(): ProviderToolDef[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: stripJsonSchemaMeta(zodToJsonSchema(t.schema, { target: "openApi3" })),
    }));
  }
}

function stripJsonSchemaMeta(schema: unknown): object {
  if (typeof schema !== "object" || schema === null) return {};
  const { $schema: _s, definitions: _d, ...rest } = schema as Record<string, unknown>;
  return rest;
}
