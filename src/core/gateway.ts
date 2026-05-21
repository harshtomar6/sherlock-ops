import type { AuditStore } from "../audit/store.js";
import type { Orchestrator } from "./orchestrator.js";
import type { Request, Response } from "./types.js";

export interface GatewayOpts {
  orchestrator: Orchestrator;
  audit?: AuditStore;
  allowedUsers?: Set<string>; // adapter-namespaced ids (e.g. "slack:U123")
}

export class Gateway {
  private orchestrator: Orchestrator;
  private audit?: AuditStore;
  private allowedUsers?: Set<string>;

  constructor(opts: GatewayOpts) {
    this.orchestrator = opts.orchestrator;
    this.audit = opts.audit;
    this.allowedUsers = opts.allowedUsers;
  }

  async handle(req: Request): Promise<Response> {
    const startedAt = Date.now();

    if (this.allowedUsers && !this.allowedUsers.has(req.userId)) {
      return { text: "You are not authorized to use Sherlock. Ask an admin to add your user ID to ALLOWED_SLACK_USERS." };
    }

    const requestId = this.audit?.recordRequest({
      user: req.userId,
      source: req.source,
      conversationId: req.conversationId,
      text: req.text,
    });

    try {
      const resp = await this.orchestrator.handle(req, { audit: this.audit, requestId });
      if (requestId) {
        this.audit?.recordResponse(requestId, { text: resp.text, durationMs: Date.now() - startedAt });
      }
      return resp;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (requestId) {
        this.audit?.recordResponse(requestId, { error: msg, durationMs: Date.now() - startedAt });
      }
      return { text: `Sherlock hit an error: ${msg}` };
    }
  }
}
