import { App, type BlockAction, type ButtonAction } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import type { Gateway } from "../core/gateway.js";
import { SlackApprovalRegistry } from "./slackApproval.js";

export interface SlackAdapterOpts {
  botToken: string;
  appToken: string;
  signingSecret: string;
  gateway: Gateway;
}

export class SlackAdapter {
  private app: App;
  private gateway: Gateway;
  private approvals = new SlackApprovalRegistry();

  constructor(opts: SlackAdapterOpts) {
    this.gateway = opts.gateway;
    this.app = new App({
      token: opts.botToken,
      appToken: opts.appToken,
      signingSecret: opts.signingSecret,
      socketMode: true,
    });
    this.wire();
  }

  async start(): Promise<void> {
    await this.app.start();
    console.log(JSON.stringify({ adapter: "slack", event: "started" }));
  }

  private wire(): void {
    this.app.event("app_mention", async ({ event, client }) => {
      await this.dispatch({
        userId: event.user ?? "unknown",
        channel: event.channel,
        threadTs: event.thread_ts ?? event.ts,
        text: stripMention(event.text),
        client,
      });
    });

    this.app.message(async ({ message, client }) => {
      if (message.channel_type !== "im") return;
      if (!("user" in message) || !message.user) return;
      if (!("text" in message) || !message.text) return;

      const threadTs =
        "thread_ts" in message && typeof message.thread_ts === "string"
          ? message.thread_ts
          : message.ts;

      await this.dispatch({
        userId: message.user,
        channel: message.channel,
        threadTs,
        text: message.text,
        client,
      });
    });

    this.app.action<BlockAction<ButtonAction>>(
      /^sherlock_approval:/,
      async ({ ack, action, body, client }) => {
        await ack();
        // action_id is "sherlock_approval:<verb>:<uuid>"
        const parts = action.action_id.split(":");
        if (parts.length !== 3) return;
        const [, verb, id] = parts;
        if (!id || (verb !== "approve" && verb !== "deny")) return;
        const decidedBy = `slack:${body.user.id}`;
        await this.approvals.decide(id, verb === "approve", decidedBy, client);
      },
    );
  }

  private async dispatch(opts: {
    userId: string;
    channel: string;
    threadTs: string;
    text: string;
    client: WebClient;
  }): Promise<void> {
    const ack = await opts.client.chat.postMessage({
      channel: opts.channel,
      thread_ts: opts.threadTs,
      text: ":mag: investigating…",
    });

    const broker = this.approvals.newBroker(opts.channel, opts.threadTs, opts.client);

    const resp = await this.gateway.handle({
      source: "slack",
      userId: `slack:${opts.userId}`,
      conversationId: `slack:${opts.channel}:${opts.threadTs}`,
      text: opts.text,
      approvalBroker: broker,
    });

    if (ack.ts) {
      await opts.client.chat.update({
        channel: opts.channel,
        ts: ack.ts,
        text: resp.text,
      });
    } else {
      await opts.client.chat.postMessage({
        channel: opts.channel,
        thread_ts: opts.threadTs,
        text: resp.text,
      });
    }
  }
}

function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();
}
