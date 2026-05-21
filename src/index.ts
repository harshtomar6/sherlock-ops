import { SlackAdapter } from "./adapters/slack.js";
import { loadConfig, type LlmCfg } from "./config.js";
import { Gateway } from "./core/gateway.js";
import { Orchestrator } from "./core/orchestrator.js";
import { ToolRegistry } from "./core/registry.js";
import { LocalExecutor } from "./executor/local.js";
import { AnthropicProvider } from "./llm/anthropic.js";
import { OpenAIProvider } from "./llm/openai.js";
import type { LLMProvider } from "./llm/types.js";
import { buildPm2Tools } from "./tools/pm2.js";

function buildLlm(cfg: LlmCfg): LLMProvider {
  if (cfg.kind === "anthropic") return new AnthropicProvider({ apiKey: cfg.apiKey, model: cfg.model });
  return new OpenAIProvider({
    apiKey: cfg.apiKey,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    extraHeaders: cfg.extraHeaders,
  });
}

async function main(): Promise<void> {
  const cfg = loadConfig();

  const executor = new LocalExecutor();
  const llm = buildLlm(cfg.llm);

  const registry = new ToolRegistry();
  registry.registerAll(buildPm2Tools(executor));

  const orchestrator = new Orchestrator({ llm, registry });
  const gateway = new Gateway({ orchestrator, allowedUsers: cfg.allowedUsers });

  const slack = new SlackAdapter({
    botToken: cfg.slack.botToken,
    appToken: cfg.slack.appToken,
    signingSecret: cfg.slack.signingSecret,
    gateway,
  });

  await slack.start();
  console.log(
    JSON.stringify({
      event: "sherlock_ops_ready",
      llm: cfg.llm.kind === "anthropic" ? `anthropic:${cfg.llm.model}` : `openai-compat:${cfg.llm.baseUrl}:${cfg.llm.model}`,
      tools: registry.toProviderDefs().map((t) => t.name),
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
