import type { AgentHub } from "../controlplane/agentHub.js";
import type { ExecOpts, ExecResult, Executor } from "./types.js";

/**
 * Executor that targets a specific connected agent by host id. Tools build
 * one of these per call via the HostAwareExecutor in the registry, or call
 * AgentHub directly through tool wrappers.
 */
export class RemoteExecutor implements Executor {
  constructor(
    private hub: AgentHub,
    private hostId: string,
  ) {}

  async exec(opts: ExecOpts): Promise<ExecResult> {
    return this.hub.exec(this.hostId, opts);
  }
}
