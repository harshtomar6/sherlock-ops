import "dotenv/config";

export type LlmProviderKind = "anthropic" | "openai";

export interface AnthropicCfg {
  kind: "anthropic";
  apiKey: string;
  model: string;
}

export interface OpenAICfg {
  kind: "openai";
  apiKey: string;
  baseUrl: string;
  model: string;
  extraHeaders: Record<string, string>;
}

export type LlmCfg = AnthropicCfg | OpenAICfg;

export interface Config {
  slack: {
    botToken: string;
    appToken: string;
    signingSecret: string;
  };
  llm: LlmCfg;
  allowedUsers: Set<string> | undefined;
}

export function loadConfig(): Config {
  const allowed = process.env.ALLOWED_SLACK_USERS?.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    slack: {
      botToken: required("SLACK_BOT_TOKEN"),
      appToken: required("SLACK_APP_TOKEN"),
      signingSecret: required("SLACK_SIGNING_SECRET"),
    },
    llm: loadLlmConfig(),
    allowedUsers: allowed && allowed.length > 0 ? new Set(allowed.map((u) => `slack:${u}`)) : undefined,
  };
}

function loadLlmConfig(): LlmCfg {
  const provider = (process.env.LLM_PROVIDER ?? "anthropic").toLowerCase() as LlmProviderKind;

  if (provider === "anthropic") {
    return {
      kind: "anthropic",
      apiKey: required("ANTHROPIC_API_KEY"),
      model: process.env.LLM_MODEL ?? "claude-opus-4-7",
    };
  }

  if (provider === "openai") {
    // Default to OpenRouter if OPENROUTER_API_KEY is set, else require OPENAI_API_KEY.
    const orKey = process.env.OPENROUTER_API_KEY;
    const baseUrl =
      process.env.OPENAI_BASE_URL ??
      (orKey ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1");
    const apiKey = orKey ?? required("OPENAI_API_KEY");
    const model = process.env.LLM_MODEL ?? (orKey ? "anthropic/claude-opus-4" : "gpt-4o");

    const extraHeaders: Record<string, string> = {};
    if (baseUrl.includes("openrouter.ai")) {
      extraHeaders["HTTP-Referer"] = process.env.OPENROUTER_REFERER ?? "https://github.com/sherlock-ops";
      extraHeaders["X-Title"] = process.env.OPENROUTER_TITLE ?? "sherlock-ops";
    }

    return { kind: "openai", apiKey, baseUrl, model, extraHeaders };
  }

  throw new Error(`unknown LLM_PROVIDER: ${provider} (expected anthropic | openai)`);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}
