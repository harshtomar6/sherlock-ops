import { randomUUID } from "node:crypto";
import type { WebClient } from "@slack/web-api";
import type {
  ApprovalBroker,
  ApprovalDecision,
  ApprovalRequest,
} from "../core/approval.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  channel: string;
  messageTs: string;
  timer: NodeJS.Timeout;
  req: ApprovalRequest;
}

/**
 * Owns in-flight approval prompts across the SlackAdapter. The Bolt action
 * handler routes Approve/Deny button clicks back here via resolve(...).
 */
export class SlackApprovalRegistry {
  private pending = new Map<string, PendingApproval>();

  newBroker(channel: string, threadTs: string, client: WebClient): ApprovalBroker {
    return new SlackApprovalBroker(this, channel, threadTs, client);
  }

  add(id: string, p: PendingApproval): void {
    this.pending.set(id, p);
  }

  remove(id: string): PendingApproval | undefined {
    const p = this.pending.get(id);
    if (p) this.pending.delete(id);
    return p;
  }

  /** Called by the SlackAdapter's action handler when a user clicks a button. */
  async decide(id: string, approved: boolean, decidedBy: string, client: WebClient): Promise<boolean> {
    const p = this.remove(id);
    if (!p) return false;
    clearTimeout(p.timer);

    const decision: ApprovalDecision = {
      approved,
      decidedBy,
      reason: approved ? undefined : "denied by approver",
    };
    p.resolve(decision);

    try {
      await client.chat.update({
        channel: p.channel,
        ts: p.messageTs,
        text: `${approved ? ":white_check_mark: Approved" : ":x: Denied"} \`${p.req.toolName}\` by <@${stripSlackPrefix(decidedBy)}>`,
        blocks: outcomeBlocks(p.req, approved, decidedBy),
      });
    } catch {
      /* ignore — message may be gone */
    }
    return true;
  }
}

class SlackApprovalBroker implements ApprovalBroker {
  constructor(
    private registry: SlackApprovalRegistry,
    private channel: string,
    private threadTs: string,
    private client: WebClient,
  ) {}

  async requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    const id = randomUUID();
    const post = await this.client.chat.postMessage({
      channel: this.channel,
      thread_ts: this.threadTs,
      text: `Approval required: \`${req.toolName}\` (${req.scope})`,
      blocks: promptBlocks(id, req),
    });

    if (!post.ts) {
      return { approved: false, reason: "could not post approval prompt" };
    }

    const messageTs = post.ts;
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(async () => {
        const p = this.registry.remove(id);
        if (!p) return; // already resolved by a click
        try {
          await this.client.chat.update({
            channel: this.channel,
            ts: messageTs,
            text: `:clock3: Approval timed out for \`${req.toolName}\``,
            blocks: timeoutBlocks(req),
          });
        } catch {
          /* ignore */
        }
        resolve({ approved: false, reason: `timed out after ${Math.round(timeoutMs / 1000)}s` });
      }, timeoutMs);

      this.registry.add(id, { resolve, channel: this.channel, messageTs, timer, req });
    });
  }
}

/* ─── Block builders ──────────────────────────────────────────────────── */

function promptBlocks(id: string, req: ApprovalRequest) {
  const argsText = JSON.stringify(req.args ?? {}, null, 2);
  const danger = req.scope === "dangerous";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${danger ? ":warning: *DANGEROUS*" : ":lock:"} approval required for \`${req.toolName}\``,
      },
    },
    ...(req.rationale
      ? [{ type: "section", text: { type: "mrkdwn", text: `*Why:* ${req.rationale}` } }]
      : []),
    {
      type: "section",
      text: { type: "mrkdwn", text: "*Arguments:*\n```" + truncate(argsText, 1500) + "```" },
    },
    {
      type: "actions",
      block_id: `sherlock_approval_${id}`,
      elements: [
        {
          type: "button",
          action_id: "sherlock_approval",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          value: `approve:${id}`,
        },
        {
          type: "button",
          action_id: "sherlock_approval",
          text: { type: "plain_text", text: "Deny" },
          style: "danger",
          value: `deny:${id}`,
        },
      ],
    },
  ];
}

function outcomeBlocks(req: ApprovalRequest, approved: boolean, decidedBy: string) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${approved ? ":white_check_mark: *Approved*" : ":x: *Denied*"}: \`${req.toolName}\` by <@${stripSlackPrefix(decidedBy)}>`,
      },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `scope: \`${req.scope}\`` }],
    },
  ];
}

function timeoutBlocks(req: ApprovalRequest) {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:clock3: *Approval timed out* for \`${req.toolName}\`` },
    },
  ];
}

function stripSlackPrefix(id: string): string {
  return id.replace(/^slack:/, "");
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n…" : s;
}
