/**
 * Provider-agnostic LLM interface. Anthropic, OpenAI, Ollama all implement this.
 * The orchestrator only ever speaks in these shapes.
 */

export type ProviderMessage =
  | { role: "user"; content: string | UserContentBlock[] }
  | { role: "assistant"; content: AssistantContentBlock[] };

export type UserContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_result"; toolCallId: string; content: string; isError?: boolean };

export type AssistantContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown };

export interface ProviderToolDef {
  name: string;
  description: string;
  inputSchema: object; // JSONSchema
}

export interface ChatOpts {
  system?: string;
  messages: ProviderMessage[];
  tools?: ProviderToolDef[];
  maxTokens?: number;
}

export interface ChatResponse {
  content: AssistantContentBlock[];
  stopReason: "end" | "tool_use" | "max_tokens" | "other";
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LLMProvider {
  chat(opts: ChatOpts): Promise<ChatResponse>;
}
