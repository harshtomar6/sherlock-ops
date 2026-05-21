import Anthropic from "@anthropic-ai/sdk";
import type {
  AssistantContentBlock,
  ChatOpts,
  ChatResponse,
  LLMProvider,
  ProviderMessage,
} from "./types.js";

interface AnthropicProviderOpts {
  apiKey: string;
  model: string;
}

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;

  constructor(opts: AnthropicProviderOpts) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
  }

  async chat(opts: ChatOpts): Promise<ChatResponse> {
    // Cache the system + tools block: they're identical across every turn
    // of a tool-use loop, so this is a big cost win.
    const system = opts.system
      ? [{ type: "text" as const, text: opts.system, cache_control: { type: "ephemeral" as const } }]
      : undefined;

    const tools = opts.tools?.map((t, i, arr) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      ...(i === arr.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));

    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? 4096,
      system,
      tools,
      messages: opts.messages.map(toAnthropicMessage),
    });

    return {
      content: resp.content.map(fromAnthropicBlock).filter((b): b is AssistantContentBlock => b !== null),
      stopReason: mapStopReason(resp.stop_reason),
      usage: { inputTokens: resp.usage.input_tokens, outputTokens: resp.usage.output_tokens },
    };
  }
}

function toAnthropicMessage(m: ProviderMessage): Anthropic.MessageParam {
  if (m.role === "user") {
    if (typeof m.content === "string") return { role: "user", content: m.content };
    return {
      role: "user",
      content: m.content.map((b) =>
        b.type === "text"
          ? { type: "text" as const, text: b.text }
          : {
              type: "tool_result" as const,
              tool_use_id: b.toolCallId,
              content: b.content,
              is_error: b.isError,
            },
      ),
    };
  }
  return {
    role: "assistant",
    content: m.content.map((b) =>
      b.type === "text"
        ? { type: "text" as const, text: b.text }
        : { type: "tool_use" as const, id: b.id, name: b.name, input: b.args as object },
    ),
  };
}

function fromAnthropicBlock(b: Anthropic.ContentBlock): AssistantContentBlock | null {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type === "tool_use") return { type: "tool_call", id: b.id, name: b.name, args: b.input };
  return null;
}

function mapStopReason(r: string | null): ChatResponse["stopReason"] {
  if (r === "end_turn") return "end";
  if (r === "tool_use") return "tool_use";
  if (r === "max_tokens") return "max_tokens";
  return "other";
}
