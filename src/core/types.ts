import type { ApprovalBroker } from "./approval.js";

/**
 * Interface-agnostic shapes. Adapters (Slack/CLI/Web) translate native
 * events into Request; orchestrator returns Response; adapters render it.
 */

export interface Request {
  source: "slack" | "cli" | "rest";
  userId: string;          // adapter-namespaced (e.g. "slack:U123ABC")
  conversationId: string;  // thread/session key
  text: string;
  /** Optional — present when the interface supports interactive approval. */
  approvalBroker?: ApprovalBroker;
  context?: Record<string, unknown>;
}

export interface Response {
  text: string;
  blocks?: ResponseBlock[];
}

export type ResponseBlock =
  | { kind: "text"; text: string }
  | { kind: "code"; language?: string; content: string }
  | { kind: "table"; headers: string[]; rows: string[][] };
