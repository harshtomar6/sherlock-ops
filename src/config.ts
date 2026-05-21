import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
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

export interface HostEntry {
  id: string;
  token: string;
  shellAllowlist?: string[];
}

export interface HostsCfg {
  port: number;
  path: string;
  hosts: HostEntry[];
}

export interface Config {
  slack: {
    botToken: string;
    appToken: string;
    signingSecret: string;
  };
  llm: LlmCfg;
  allowedUsers: Set<string> | undefined;
  /** undefined ⇒ single-host (LocalExecutor only). */
  hostsCfg: HostsCfg | undefined;
  /** Local-mode shell allowlist (single-host only). Multi-host uses per-host allowlists. */
  localShellAllowlist: string[];
  /** Path to SQLite file. */
  auditDbPath: string;
  /** Max past Slack exchanges to load into context on each turn. */
  conversationMaxExchanges: number;
  /** Drop history older than this on load. */
  conversationTtlHours: number;
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
    hostsCfg: loadHostsConfig(),
    localShellAllowlist: process.env.LOCAL_SHELL_ALLOWLIST
      ? process.env.LOCAL_SHELL_ALLOWLIST.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
    auditDbPath: process.env.SHERLOCK_AUDIT_DB ?? "sherlock-audit.sqlite",
    conversationMaxExchanges: parsePositiveInt(process.env.CONVERSATION_MAX_EXCHANGES, 10),
    conversationTtlHours: parsePositiveInt(process.env.CONVERSATION_TTL_HOURS, 24),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
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

function loadHostsConfig(): HostsCfg | undefined {
  const path = process.env.SHERLOCK_HOSTS_FILE ?? "hosts.json";
  let raw: string;
  try {
    raw = readFileSync(resolvePath(process.cwd(), path), "utf8");
  } catch {
    return undefined;
  }

  let parsed: { port?: number; path?: string; hosts?: HostEntry[] };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!parsed.hosts || !Array.isArray(parsed.hosts) || parsed.hosts.length === 0) {
    throw new Error(`${path}: 'hosts' must be a non-empty array of {id, token}`);
  }
  for (const h of parsed.hosts) {
    if (!h.id || !h.token) throw new Error(`${path}: each host needs both 'id' and 'token'`);
    if (h.shellAllowlist && !Array.isArray(h.shellAllowlist)) {
      throw new Error(`${path}: shellAllowlist for ${h.id} must be an array of strings`);
    }
  }

  return {
    port: parsed.port ?? Number(process.env.SHERLOCK_HUB_PORT ?? 8787),
    path: parsed.path ?? "/agent",
    hosts: parsed.hosts,
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var: ${name}`);
  return v;
}
