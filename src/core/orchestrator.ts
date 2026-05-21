import type { AuditStore } from "../audit/store.js";
import type {
  AssistantContentBlock,
  LLMProvider,
  ProviderMessage,
  UserContentBlock,
} from "../llm/types.js";
import { effectiveScope, type Tool, type ToolScope } from "../tools/types.js";
import type { ApprovalBroker, ApprovalDecision } from "./approval.js";
import { DenyAllBroker } from "./approval.js";
import type { ConversationStore } from "./conversationStore.js";
import type { ToolRegistry } from "./registry.js";
import type { Request, Response } from "./types.js";

const SYSTEM_PROMPT = `You are Sherlock, an operations bot that investigates and reports on PM2 servers, logs, and host state through typed tools.

Operating principles:
- Investigate before answering. Use pm2_list first to see what's running, then drill into specific processes with pm2_describe and pm2_logs.
- When a user asks "why is X restarting", check restart counts via pm2_list, then read pm2_logs with stream='err' to find the actual error.
- Cite concrete evidence: process names, restart counts, error messages, timestamps. Avoid vague answers.
- Be concise. Report the finding, then the evidence. Use code blocks for log excerpts.
- If a tool fails or returns no useful info, say so plainly. Don't speculate.
- Some tools (pm2_restart, pm2_stop, shell_exec with non-allowlisted commands) require human approval. Explain *why* you want to run them in your message text right before the tool call — the approver sees this rationale.
- Conversations can span multiple messages in the same Slack thread. Prior turns and tool results are visible to you — use them. Don't re-investigate something you already established earlier in the thread.
- Only use tools you have been given. Do not invent commands.`;

const MAX_TOOL_ITERATIONS = 10;

export interface OrchestratorOpts {
  llm: LLMProvider;
  registry: ToolRegistry;
  maxIterations?: number;
  conversations?: ConversationStore;
}

export interface OrchestratorContext {
  audit?: AuditStore;
  requestId?: string;
}

export class Orchestrator {
  private llm: LLMProvider;
  private registry: ToolRegistry;
  private maxIterations: number;
  private conversations?: ConversationStore;

  constructor(opts: OrchestratorOpts) {
    this.llm = opts.llm;
    this.registry = opts.registry;
    this.maxIterations = opts.maxIterations ?? MAX_TOOL_ITERATIONS;
    this.conversations = opts.conversations;
  }

  async handle(req: Request, ctx: OrchestratorContext = {}): Promise<Response> {
    const history = this.conversations?.load(req.conversationId) ?? [];
    const messages: ProviderMessage[] = [...history];
    const historyEnd = messages.length; // new messages from this turn start here
    messages.push({ role: "user", content: req.text });

    const toolDefs = this.registry.toProviderDefs();
    const broker = req.approvalBroker ?? new DenyAllBroker();

    let lastAssistantText = "";
    let hitMax = false;
    let toolSeq = 0;

    // Aggregated observability across the loop.
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let iterations = 0;
    let llmModel: string | undefined;
    let finalStopReason: string | undefined;

    for (let i = 0; i < this.maxIterations; i++) {
      const resp = await this.llm.chat({
        system: SYSTEM_PROMPT,
        messages,
        tools: toolDefs,
      });
      messages.push({ role: "assistant", content: resp.content });
      iterations++;
      if (resp.usage) {
        totalInputTokens += resp.usage.inputTokens;
        totalOutputTokens += resp.usage.outputTokens;
      }
      if (resp.model && !llmModel) llmModel = resp.model;
      finalStopReason = resp.stopReason;

      lastAssistantText = textOf(resp.content);

      const toolCalls = resp.content.filter(
        (b): b is Extract<AssistantContentBlock, { type: "tool_call" }> => b.type === "tool_call",
      );

      if (toolCalls.length === 0 || resp.stopReason === "end") {
        this.persist(req, ctx, messages, historyEnd);
        return {
          text: lastAssistantText || "(no response)",
          meta: { llmModel, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, iterations, finalStopReason },
        };
      }

      const results: UserContentBlock[] = await Promise.all(
        toolCalls.map((call) => this.runOne(call, broker, ctx, lastAssistantText, toolSeq++)),
      );
      messages.push({ role: "user", content: results });

      if (i === this.maxIterations - 1) hitMax = true;
    }

    if (hitMax) {
      const note = `(investigation stopped — reached ${this.maxIterations} tool iterations without a final answer)`;
      messages.push({ role: "assistant", content: [{ type: "text", text: note }] });
      this.persist(req, ctx, messages, historyEnd);
      return {
        text: note,
        meta: { llmModel, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, iterations, finalStopReason: "max_iterations" },
      };
    }

    this.persist(req, ctx, messages, historyEnd);
    return {
      text: lastAssistantText || "(no response)",
      meta: { llmModel, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, iterations, finalStopReason },
    };
  }

  private persist(
    req: Request,
    ctx: OrchestratorContext,
    messages: ProviderMessage[],
    historyEnd: number,
  ): void {
    if (!this.conversations || !ctx.requestId) return;
    const newMessages = messages.slice(historyEnd);
    if (newMessages.length === 0) return;
    try {
      this.conversations.save(req.conversationId, ctx.requestId, newMessages);
    } catch (err) {
      console.error(JSON.stringify({
        component: "orchestrator",
        event: "conversation_save_failed",
        conversationId: req.conversationId,
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  private async runOne(
    call: Extract<AssistantContentBlock, { type: "tool_call" }>,
    broker: ApprovalBroker,
    ctx: OrchestratorContext,
    rationale: string,
    seq: number,
  ): Promise<UserContentBlock> {
    const tool = this.registry.get(call.name);
    if (!tool) {
      return toolError(call.id, `unknown tool: ${call.name}`);
    }

    const parsed = tool.schema.safeParse(call.args);
    if (!parsed.success) {
      return toolError(call.id, `invalid args: ${parsed.error.message}`);
    }
    const args = parsed.data;
    const scope: ToolScope = effectiveScope(tool, args);
    const host = extractHost(args);

    let approvalId: string | undefined;
    if (scope === "mutate" || scope === "dangerous") {
      approvalId = ctx.audit?.recordApprovalRequest({
        requestId: ctx.requestId ?? "",
        toolName: tool.name,
        scope,
        args,
      });

      const decision: ApprovalDecision = await broker.requestApproval({
        toolName: tool.name,
        scope,
        args,
        rationale: rationale || undefined,
      });

      if (approvalId && ctx.audit) {
        ctx.audit.recordApprovalDecision({
          approvalId,
          approved: decision.approved,
          decidedBy: decision.decidedBy,
          reason: decision.reason,
        });
      }

      if (!decision.approved) {
        ctx.audit?.recordToolCall({
          requestId: ctx.requestId ?? "",
          seq,
          name: tool.name,
          scope,
          host,
          args,
          ok: false,
          error: decision.reason ?? "denied",
          durationMs: 0,
          approvalId,
        });
        return toolError(
          call.id,
          `denied${decision.decidedBy ? ` by ${decision.decidedBy}` : ""}${decision.reason ? `: ${decision.reason}` : ""}`,
        );
      }
    }

    const startedAt = Date.now();
    try {
      const result = await tool.run(args);
      const durationMs = Date.now() - startedAt;
      ctx.audit?.recordToolCall({
        requestId: ctx.requestId ?? "",
        seq,
        name: tool.name,
        scope,
        host,
        args,
        ok: true,
        result,
        durationMs,
        approvalId,
      });
      return {
        type: "tool_result",
        toolCallId: call.id,
        content: typeof result === "string" ? result : JSON.stringify(result, null, 2),
      };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const msg = err instanceof Error ? err.message : String(err);
      ctx.audit?.recordToolCall({
        requestId: ctx.requestId ?? "",
        seq,
        name: tool.name,
        scope,
        host,
        args,
        ok: false,
        error: msg,
        durationMs,
        approvalId,
      });
      return toolError(call.id, msg);
    }
  }
}

function toolError(id: string, content: string): UserContentBlock {
  return { type: "tool_result", toolCallId: id, content, isError: true };
}

function textOf(content: AssistantContentBlock[]): string {
  return content
    .filter((b): b is Extract<AssistantContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function extractHost(args: unknown): string | undefined {
  if (args && typeof args === "object" && "host" in args) {
    const h = (args as { host?: unknown }).host;
    if (typeof h === "string") return h;
  }
  return undefined;
}
