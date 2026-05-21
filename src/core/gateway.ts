import type { Orchestrator } from "./orchestrator.js";
import type { Request, Response } from "./types.js";

export interface GatewayOpts {
  orchestrator: Orchestrator;
  allowedUsers?: Set<string>; // adapter-namespaced ids (e.g. "slack:U123")
}

export class Gateway {
  private orchestrator: Orchestrator;
  private allowedUsers?: Set<string>;

  constructor(opts: GatewayOpts) {
    this.orchestrator = opts.orchestrator;
    this.allowedUsers = opts.allowedUsers;
  }

  async handle(req: Request): Promise<Response> {
    const startedAt = new Date();
    this.audit({ at: startedAt.toISOString(), event: "request", user: req.userId, source: req.source, text: req.text });

    if (this.allowedUsers && !this.allowedUsers.has(req.userId)) {
      this.audit({ at: new Date().toISOString(), event: "denied", user: req.userId });
      return { text: "You are not authorized to use Sherlock. Ask an admin to add your user ID to ALLOWED_SLACK_USERS." };
    }

    try {
      const resp = await this.orchestrator.handle(req);
      this.audit({
        at: new Date().toISOString(),
        event: "response",
        user: req.userId,
        durationMs: Date.now() - startedAt.getTime(),
      });
      return resp;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.audit({ at: new Date().toISOString(), event: "error", user: req.userId, error: msg });
      return { text: `Sherlock hit an error: ${msg}` };
    }
  }

  private audit(entry: Record<string, unknown>): void {
    // MVP: structured logs to stdout. Replace with SQLite append-only table later.
    console.log(JSON.stringify({ audit: entry }));
  }
}
