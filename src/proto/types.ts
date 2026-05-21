/**
 * Protocol between sherlock-ops control plane and sherlock-agent.
 *
 * Transport: agent dials *out* over WebSocket. JSON-encoded messages. The agent
 * is responsible for reconnects with backoff; the control plane is stateless
 * about agent identity beyond what hosts.json declares.
 *
 * Auth: agent presents { hostId, token } in the first Hello; control plane
 * matches against the entry in hosts.json. No token-on-wire after Hello.
 */

export const PROTOCOL_VERSION = 1;

/* ─── Agent → Control plane ──────────────────────────────────────────── */

export interface AgentHello {
  type: "hello";
  protocolVersion: number;
  hostId: string;
  token: string;
  agentVersion: string;
  capabilities: string[]; // e.g. ["exec"]
}

export interface AgentResult {
  type: "result";
  id: string; // matches Exec.id
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
  error?: string;
}

export interface AgentPong {
  type: "pong";
  id: string;
}

export type AgentMessage = AgentHello | AgentResult | AgentPong;

/* ─── Control plane → Agent ──────────────────────────────────────────── */

export interface ServerWelcome {
  type: "welcome";
  protocolVersion: number;
  serverVersion: string;
}

export interface ServerReject {
  type: "reject";
  reason: string;
}

export interface ServerExec {
  type: "exec";
  id: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ServerPing {
  type: "ping";
  id: string;
}

export type ServerMessage = ServerWelcome | ServerReject | ServerExec | ServerPing;
