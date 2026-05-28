import type { AgentHub } from "../controlplane/agentHub.js";
import { LocalExecutor } from "./local.js";
import { RemoteExecutor } from "./remote.js";
import type { Executor } from "./types.js";

export interface HostResolver {
  isMultiHost(): boolean;
  knownHosts(): string[];
  resolve(hostId?: string): Executor;
  onlineHosts(): string[];
  /** Returns the shell allowlist for the host (raw command strings, e.g. ["df -h", "free -m"]). */
  shellAllowlistFor(hostId?: string): string[];
}

export class LocalHostResolver implements HostResolver {
  private executor = new LocalExecutor();
  private allowlist: string[];

  constructor(allowlist: string[] = []) {
    this.allowlist = allowlist;
  }

  isMultiHost(): boolean { return false; }
  knownHosts(): string[] { return ["local"]; }
  onlineHosts(): string[] { return ["local"]; }
  resolve(): Executor { return this.executor; }
  shellAllowlistFor(): string[] { return this.allowlist; }
}

export interface RemoteHost {
  id: string;
  shellAllowlist?: string[];
}

export interface ControlPlaneHost {
  id: string;
  shellAllowlist: string[];
}

export class RemoteHostResolver implements HostResolver {
  private hosts = new Map<string, RemoteHost>();
  private controlPlane: ControlPlaneHost | undefined;
  private localExecutor = new LocalExecutor();

  constructor(
    private hub: AgentHub,
    hosts: RemoteHost[],
    controlPlane?: ControlPlaneHost,
  ) {
    if (hosts.length === 0) throw new Error("RemoteHostResolver requires at least one host");
    for (const h of hosts) this.hosts.set(h.id, h);
    if (controlPlane && this.hosts.has(controlPlane.id)) {
      throw new Error(
        `control-plane id '${controlPlane.id}' conflicts with a remote host id`,
      );
    }
    this.controlPlane = controlPlane;
  }

  isMultiHost(): boolean { return true; }

  knownHosts(): string[] {
    const ids = [...this.hosts.keys()];
    if (this.controlPlane) ids.push(this.controlPlane.id);
    return ids;
  }

  onlineHosts(): string[] {
    const online = this.hub.connectedHosts();
    // Control plane is always "online" — it's this process.
    if (this.controlPlane) online.push(this.controlPlane.id);
    return online;
  }

  resolve(hostId?: string): Executor {
    if (!hostId) {
      throw new Error(`host is required in multi-host mode. Known hosts: ${this.knownHosts().join(", ")}`);
    }
    if (this.controlPlane && hostId === this.controlPlane.id) {
      return this.localExecutor;
    }
    if (!this.hosts.has(hostId)) {
      throw new Error(`unknown host '${hostId}'. Known hosts: ${this.knownHosts().join(", ")}`);
    }
    return new RemoteExecutor(this.hub, hostId);
  }

  shellAllowlistFor(hostId?: string): string[] {
    if (!hostId) return [];
    if (this.controlPlane && hostId === this.controlPlane.id) {
      return this.controlPlane.shellAllowlist;
    }
    return this.hosts.get(hostId)?.shellAllowlist ?? [];
  }
}
