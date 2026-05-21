/**
 * Interface-agnostic approval flow. Adapters implement the UI:
 *   - Slack: interactive message with Approve/Deny buttons in-thread.
 *   - CLI: stdin prompt (future).
 *   - Web: modal (future).
 *
 * The orchestrator calls broker.requestApproval(...) before executing any
 * tool whose scope is 'mutate' or 'dangerous'. The promise resolves with
 * the decision or times out → treated as denied.
 */

import type { ToolScope } from "../tools/types.js";

export interface ApprovalRequest {
  toolName: string;
  scope: ToolScope;
  args: unknown;
  /** What the LLM said about why it wants to run this — shown to the approver. */
  rationale?: string;
  /** Override the default approval timeout (ms). */
  timeoutMs?: number;
}

export interface ApprovalDecision {
  approved: boolean;
  decidedBy?: string; // adapter-namespaced user id
  reason?: string;    // e.g. "timed out", "denied: not safe right now"
}

export interface ApprovalBroker {
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
}

/**
 * Broker used when an interface doesn't support interactive approval.
 * Always denies mutating tools, with a clear message.
 */
export class DenyAllBroker implements ApprovalBroker {
  async requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    return {
      approved: false,
      reason: `${req.toolName} requires approval, but this interface doesn't support interactive approval`,
    };
  }
}
