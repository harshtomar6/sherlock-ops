import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { ExecOpts, ExecResult } from "../executor/types.js";
import {
  PROTOCOL_VERSION,
  type AgentMessage,
  type ServerMessage,
} from "../proto/types.js";

export interface HostConfig {
  id: string;
  token: string;
}

export interface AgentHubOpts {
  port: number;
  path?: string; // default "/agent"
  hosts: HostConfig[];
  serverVersion: string;
  pingIntervalMs?: number;
}

interface PendingCall {
  resolve: (r: ExecResult) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Connection {
  ws: WebSocket;
  hostId: string;
  connectedAt: number;
  agentVersion: string;
  capabilities: string[];
  pending: Map<string, PendingCall>;
}

export class AgentHub {
  private wss: WebSocketServer;
  private hostsByToken = new Map<string, HostConfig>();
  private connections = new Map<string, Connection>();
  private serverVersion: string;
  private pingTimer?: NodeJS.Timeout;
  private pingIntervalMs: number;

  constructor(private opts: AgentHubOpts) {
    this.serverVersion = opts.serverVersion;
    this.pingIntervalMs = opts.pingIntervalMs ?? 30_000;
    for (const h of opts.hosts) this.hostsByToken.set(`${h.id}:${h.token}`, h);
    this.wss = new WebSocketServer({ port: opts.port, path: opts.path ?? "/agent" });
    this.wire();
  }

  start(): void {
    this.pingTimer = setInterval(() => this.pingAll(), this.pingIntervalMs);
    console.log(
      JSON.stringify({
        component: "agent_hub",
        event: "listening",
        port: this.opts.port,
        path: this.opts.path ?? "/agent",
        hostsConfigured: this.opts.hosts.map((h) => h.id),
      }),
    );
  }

  async close(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const conn of this.connections.values()) conn.ws.close(1001, "shutdown");
    await new Promise<void>((res) => this.wss.close(() => res()));
  }

  connectedHosts(): string[] {
    return [...this.connections.keys()];
  }

  isConnected(hostId: string): boolean {
    return this.connections.has(hostId);
  }

  async exec(hostId: string, opts: ExecOpts): Promise<ExecResult> {
    const conn = this.connections.get(hostId);
    if (!conn) {
      const known = this.opts.hosts.map((h) => h.id);
      throw new Error(
        known.includes(hostId)
          ? `host '${hostId}' is configured but no agent is connected`
          : `unknown host '${hostId}' — known hosts: ${known.join(", ") || "(none)"}`,
      );
    }

    const id = randomUUID();
    const timeoutMs = opts.timeoutMs ?? 30_000;

    return new Promise<ExecResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`exec timed out after ${timeoutMs}ms on host '${hostId}'`));
      }, timeoutMs + 5_000); // server-side timeout is slightly longer than agent's

      conn.pending.set(id, { resolve, reject, timer });

      const msg: ServerMessage = {
        type: "exec",
        id,
        command: opts.command,
        args: opts.args ?? [],
        cwd: opts.cwd,
        env: opts.env,
        timeoutMs,
        maxOutputBytes: opts.maxOutputBytes,
      };
      conn.ws.send(JSON.stringify(msg));
    });
  }

  private wire(): void {
    this.wss.on("connection", (ws, req) => {
      let helloHandled = false;

      const helloTimer = setTimeout(() => {
        if (!helloHandled) {
          send(ws, { type: "reject", reason: "hello timeout" });
          ws.close(4001, "hello timeout");
        }
      }, 5_000);

      ws.on("message", (raw) => {
        let msg: AgentMessage;
        try {
          msg = JSON.parse(raw.toString()) as AgentMessage;
        } catch {
          send(ws, { type: "reject", reason: "malformed json" });
          ws.close(4002, "malformed json");
          return;
        }

        if (!helloHandled) {
          clearTimeout(helloTimer);
          if (msg.type !== "hello") {
            send(ws, { type: "reject", reason: "expected hello first" });
            ws.close(4003, "expected hello");
            return;
          }
          if (msg.protocolVersion !== PROTOCOL_VERSION) {
            send(ws, { type: "reject", reason: `protocol version mismatch (server=${PROTOCOL_VERSION}, agent=${msg.protocolVersion})` });
            ws.close(4004, "version mismatch");
            return;
          }
          const host = this.hostsByToken.get(`${msg.hostId}:${msg.token}`);
          if (!host) {
            send(ws, { type: "reject", reason: "auth failed" });
            ws.close(4005, "auth failed");
            console.log(JSON.stringify({ component: "agent_hub", event: "auth_failed", hostId: msg.hostId, remoteAddr: req.socket.remoteAddress }));
            return;
          }

          // kick any existing connection for the same host
          const existing = this.connections.get(host.id);
          if (existing) {
            existing.ws.close(1000, "superseded by new connection");
          }

          const conn: Connection = {
            ws,
            hostId: host.id,
            connectedAt: Date.now(),
            agentVersion: msg.agentVersion,
            capabilities: msg.capabilities,
            pending: new Map(),
          };
          this.connections.set(host.id, conn);
          helloHandled = true;
          send(ws, { type: "welcome", protocolVersion: PROTOCOL_VERSION, serverVersion: this.serverVersion });
          console.log(
            JSON.stringify({
              component: "agent_hub",
              event: "agent_connected",
              hostId: host.id,
              agentVersion: msg.agentVersion,
              capabilities: msg.capabilities,
            }),
          );
          return;
        }

        const conn = this.connections.get(getConnHostId(ws, this.connections));
        if (!conn) return;
        this.handleMessage(conn, msg);
      });

      ws.on("close", (code) => {
        clearTimeout(helloTimer);
        if (!helloHandled) return;
        const conn = findConnByWs(ws, this.connections);
        if (!conn) return;
        for (const [_id, pc] of conn.pending) {
          clearTimeout(pc.timer);
          pc.reject(new Error(`agent for host '${conn.hostId}' disconnected (code ${code})`));
        }
        this.connections.delete(conn.hostId);
        console.log(JSON.stringify({ component: "agent_hub", event: "agent_disconnected", hostId: conn.hostId, code }));
      });

      ws.on("error", (err) => {
        console.log(JSON.stringify({ component: "agent_hub", event: "ws_error", error: err.message }));
      });
    });
  }

  private handleMessage(conn: Connection, msg: AgentMessage): void {
    if (msg.type === "result") {
      const pc = conn.pending.get(msg.id);
      if (!pc) return; // late reply for a timed-out request
      conn.pending.delete(msg.id);
      clearTimeout(pc.timer);
      pc.resolve({
        stdout: msg.stdout,
        stderr: msg.stderr,
        exitCode: msg.exitCode,
        durationMs: msg.durationMs,
        truncated: msg.truncated,
      });
      return;
    }
    if (msg.type === "pong") {
      return;
    }
    if (msg.type === "hello") {
      // duplicate hello — ignore
      return;
    }
  }

  private pingAll(): void {
    for (const conn of this.connections.values()) {
      const id = randomUUID();
      try {
        conn.ws.send(JSON.stringify({ type: "ping", id } satisfies ServerMessage));
      } catch {
        // socket will surface error via 'error' / 'close' handlers
      }
    }
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* socket already closing */
  }
}

function findConnByWs(ws: WebSocket, conns: Map<string, Connection>): Connection | undefined {
  for (const c of conns.values()) if (c.ws === ws) return c;
  return undefined;
}

function getConnHostId(ws: WebSocket, conns: Map<string, Connection>): string {
  return findConnByWs(ws, conns)?.hostId ?? "";
}
