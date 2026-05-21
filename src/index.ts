import { SlackAdapter } from "./adapters/slack.js";
import { AuditStore } from "./audit/store.js";
import { loadConfig, type LlmCfg } from "./config.js";
import { AgentHub } from "./controlplane/agentHub.js";
import { ConversationStore } from "./core/conversationStore.js";
import { Gateway } from "./core/gateway.js";
import { Orchestrator } from "./core/orchestrator.js";
import { ToolRegistry } from "./core/registry.js";
import {
  LocalHostResolver,
  RemoteHostResolver,
  type HostResolver,
} from "./executor/hostResolver.js";
import { AnthropicProvider } from "./llm/anthropic.js";
import { OpenAIProvider } from "./llm/openai.js";
import type { LLMProvider } from "./llm/types.js";
import { buildPm2Tools } from "./tools/pm2.js";
import { buildShellTools } from "./tools/shell.js";

const CONTROL_PLANE_VERSION = "0.3.0";

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
  const llm = buildLlm(cfg.llm);
  const audit = new AuditStore(cfg.auditDbPath);
  const conversations = new ConversationStore({
    dbPath: cfg.auditDbPath,
    maxExchanges: cfg.conversationMaxExchanges,
    ttlHours: cfg.conversationTtlHours,
  });

  let hub: AgentHub | undefined;
  let resolver: HostResolver;
  if (cfg.hostsCfg) {
    hub = new AgentHub({
      port: cfg.hostsCfg.port,
      path: cfg.hostsCfg.path,
      hosts: cfg.hostsCfg.hosts,
      serverVersion: CONTROL_PLANE_VERSION,
    });
    hub.start();
    resolver = new RemoteHostResolver(
      hub,
      cfg.hostsCfg.hosts.map((h) => ({ id: h.id, shellAllowlist: h.shellAllowlist })),
    );
  } else {
    resolver = new LocalHostResolver(cfg.localShellAllowlist);
  }

  const registry = new ToolRegistry();
  registry.registerAll(buildPm2Tools(resolver));
  registry.registerAll(buildShellTools(resolver));

  const orchestrator = new Orchestrator({ llm, registry, conversations });
  const gateway = new Gateway({ orchestrator, audit, allowedUsers: cfg.allowedUsers });

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
      mode: cfg.hostsCfg ? "multi_host" : "single_host",
      hosts: resolver.knownHosts(),
      llm: cfg.llm.kind === "anthropic" ? `anthropic:${cfg.llm.model}` : `openai-compat:${cfg.llm.baseUrl}:${cfg.llm.model}`,
      tools: registry.toProviderDefs().map((t) => t.name),
      hubPort: cfg.hostsCfg?.port,
      auditDb: cfg.auditDbPath,
      conversationMaxExchanges: cfg.conversationMaxExchanges,
      conversationTtlHours: cfg.conversationTtlHours,
    }),
  );

  const shutdown = async () => {
    console.log(JSON.stringify({ event: "shutting_down" }));
    if (hub) await hub.close();
    conversations.close();
    audit.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
