import type {
  AssistantContentBlock,
  LLMProvider,
  ProviderMessage,
  UserContentBlock,
} from "../llm/types.js";
import type { ToolRegistry } from "./registry.js";
import type { Request, Response } from "./types.js";

const SYSTEM_PROMPT = `You are Sherlock, an operations bot that investigates and reports on PM2 servers, logs, and host state through typed tools.

Operating principles:
- Investigate before answering. Use pm2_list first to see what's running, then drill into specific processes with pm2_describe and pm2_logs.
- When a user asks "why is X restarting", check restart counts via pm2_list, then read pm2_logs with stream='err' to find the actual error.
- Cite concrete evidence: process names, restart counts, error messages, timestamps. Avoid vague answers.
- Be concise. Report the finding, then the evidence. Use code blocks for log excerpts.
- If a tool fails or returns no useful info, say so plainly. Don't speculate.
- Only use tools you have been given. Do not invent commands.`;

const MAX_TOOL_ITERATIONS = 10;

export interface OrchestratorOpts {
  llm: LLMProvider;
  registry: ToolRegistry;
  maxIterations?: number;
}

export class Orchestrator {
  private llm: LLMProvider;
  private registry: ToolRegistry;
  private maxIterations: number;

  constructor(opts: OrchestratorOpts) {
    this.llm = opts.llm;
    this.registry = opts.registry;
    this.maxIterations = opts.maxIterations ?? MAX_TOOL_ITERATIONS;
  }

  async handle(req: Request): Promise<Response> {
    const messages: ProviderMessage[] = [
      { role: "user", content: req.text },
    ];

    const toolDefs = this.registry.toProviderDefs();

    for (let i = 0; i < this.maxIterations; i++) {
      const resp = await this.llm.chat({
        system: SYSTEM_PROMPT,
        messages,
        tools: toolDefs,
      });

      messages.push({ role: "assistant", content: resp.content });

      const toolCalls = resp.content.filter(
        (b): b is Extract<AssistantContentBlock, { type: "tool_call" }> => b.type === "tool_call",
      );

      if (toolCalls.length === 0 || resp.stopReason === "end") {
        const text = resp.content
          .filter((b): b is Extract<AssistantContentBlock, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        return { text: text || "(no response)" };
      }

      const results: UserContentBlock[] = await Promise.all(
        toolCalls.map(async (call) => runToolCall(this.registry, call)),
      );
      messages.push({ role: "user", content: results });
    }

    return { text: `Stopped after ${this.maxIterations} tool iterations without a final answer.` };
  }
}

async function runToolCall(
  registry: ToolRegistry,
  call: Extract<AssistantContentBlock, { type: "tool_call" }>,
): Promise<UserContentBlock> {
  const tool = registry.get(call.name);
  if (!tool) {
    return {
      type: "tool_result",
      toolCallId: call.id,
      content: `unknown tool: ${call.name}`,
      isError: true,
    };
  }
  const parsed = tool.schema.safeParse(call.args);
  if (!parsed.success) {
    return {
      type: "tool_result",
      toolCallId: call.id,
      content: `invalid args: ${parsed.error.message}`,
      isError: true,
    };
  }
  try {
    const result = await tool.run(parsed.data);
    return {
      type: "tool_result",
      toolCallId: call.id,
      content: typeof result === "string" ? result : JSON.stringify(result, null, 2),
    };
  } catch (err) {
    return {
      type: "tool_result",
      toolCallId: call.id,
      content: err instanceof Error ? err.message : String(err),
      isError: true,
    };
  }
}
