import type {
  AssistantContentBlock,
  ChatOpts,
  ChatResponse,
  LLMProvider,
  ProviderMessage,
} from "./types.js";

/**
 * OpenAI-compatible provider. Works with:
 *   - OpenAI:      baseUrl = https://api.openai.com/v1
 *   - OpenRouter:  baseUrl = https://openrouter.ai/api/v1
 *   - Together:    baseUrl = https://api.together.xyz/v1
 *   - Groq:        baseUrl = https://api.groq.com/openai/v1
 *   - Ollama:      baseUrl = http://localhost:11434/v1
 *
 * Direct fetch — no SDK dep. The chat-completions wire format is small enough
 * to translate inline, and it keeps the dep tree clean.
 */

interface OpenAIProviderOpts {
  apiKey: string;
  model: string;
  baseUrl: string;
  /** Optional headers — OpenRouter wants HTTP-Referer + X-Title for app identification. */
  extraHeaders?: Record<string, string>;
}

export class OpenAIProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private extraHeaders: Record<string, string>;

  constructor(opts: OpenAIProviderOpts) {
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.extraHeaders = opts.extraHeaders ?? {};
  }

  async chat(opts: ChatOpts): Promise<ChatResponse> {
    const messages: OpenAIMessage[] = [];
    if (opts.system) messages.push({ role: "system", content: opts.system });
    for (const m of opts.messages) {
      messages.push(...toOpenAIMessages(m));
    }

    const tools = opts.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    const body: OpenAIRequest = {
      model: this.model,
      messages,
      max_tokens: opts.maxTokens ?? 4096,
      ...(tools && tools.length > 0 ? { tools } : {}),
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenAI-compatible API ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = (await res.json()) as OpenAIResponse;
    const choice = data.choices[0];
    if (!choice) throw new Error("OpenAI-compatible API returned no choices");

    return {
      content: fromOpenAIMessage(choice.message),
      stopReason: mapFinishReason(choice.finish_reason),
      usage: data.usage
        ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
        : undefined,
    };
  }
}

function toOpenAIMessages(m: ProviderMessage): OpenAIMessage[] {
  if (m.role === "user") {
    if (typeof m.content === "string") return [{ role: "user", content: m.content }];

    // user content with tool_result blocks: each tool_result becomes its own
    // {role: "tool"} message, text blocks join into one {role: "user"} message.
    const out: OpenAIMessage[] = [];
    const textParts: string[] = [];
    for (const b of m.content) {
      if (b.type === "text") {
        textParts.push(b.text);
      } else {
        out.push({
          role: "tool",
          tool_call_id: b.toolCallId,
          content: b.isError ? `ERROR: ${b.content}` : b.content,
        });
      }
    }
    if (textParts.length > 0) out.push({ role: "user", content: textParts.join("\n") });
    return out;
  }

  // assistant
  const textParts: string[] = [];
  const toolCalls: OpenAIToolCall[] = [];
  for (const b of m.content) {
    if (b.type === "text") {
      textParts.push(b.text);
    } else {
      toolCalls.push({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.args ?? {}) },
      });
    }
  }
  const msg: OpenAIMessage = { role: "assistant", content: textParts.join("\n") || null };
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  return [msg];
}

function fromOpenAIMessage(m: OpenAIResponseMessage): AssistantContentBlock[] {
  const blocks: AssistantContentBlock[] = [];
  if (m.content && m.content.trim()) blocks.push({ type: "text", text: m.content });
  for (const tc of m.tool_calls ?? []) {
    let args: unknown = {};
    try {
      args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      args = { _raw: tc.function.arguments };
    }
    blocks.push({ type: "tool_call", id: tc.id, name: tc.function.name, args });
  }
  return blocks;
}

function mapFinishReason(r: string | null | undefined): ChatResponse["stopReason"] {
  if (r === "stop") return "end";
  if (r === "tool_calls") return "tool_use";
  if (r === "length") return "max_tokens";
  return "other";
}

/* ─── OpenAI wire types (just what we use) ────────────────────────────── */

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens: number;
  tools?: Array<{
    type: "function";
    function: { name: string; description: string; parameters: object };
  }>;
}

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIResponse {
  choices: Array<{ message: OpenAIResponseMessage; finish_reason: string | null }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface OpenAIResponseMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
}
