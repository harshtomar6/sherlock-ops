import "dotenv/config";
import { WebSocket } from "ws";
import { LocalExecutor } from "../executor/local.js";
import {
  PROTOCOL_VERSION,
  type AgentHello,
  type AgentMessage,
  type AgentResult,
  type ServerMessage,
} from "../proto/types.js";

const AGENT_VERSION = "0.1.0";
const CAPABILITIES = ["exec"];

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const CONTROL_URL = required("SHERLOCK_CONTROL_URL"); // e.g. ws://controlplane:8787/agent
const HOST_ID = required("SHERLOCK_HOST_ID");
const TOKEN = required("SHERLOCK_AGENT_TOKEN");

const executor = new LocalExecutor();

let ws: WebSocket | undefined;
let reconnectDelay = RECONNECT_INITIAL_MS;
let shuttingDown = false;

function log(event: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ component: "sherlock_agent", hostId: HOST_ID, event, ...extra }));
}

function connect(): void {
  log("connecting", { url: CONTROL_URL });
  ws = new WebSocket(CONTROL_URL);

  ws.on("open", () => {
    log("connected");
    const hello: AgentHello = {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      hostId: HOST_ID,
      token: TOKEN,
      agentVersion: AGENT_VERSION,
      capabilities: CAPABILITIES,
    };
    ws?.send(JSON.stringify(hello));
  });

  ws.on("message", async (raw) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw.toString()) as ServerMessage;
    } catch {
      log("malformed_message_from_server");
      return;
    }

    if (msg.type === "welcome") {
      log("welcomed", { serverVersion: msg.serverVersion });
      reconnectDelay = RECONNECT_INITIAL_MS;
      return;
    }

    if (msg.type === "reject") {
      log("rejected", { reason: msg.reason });
      ws?.close();
      // Don't auto-reconnect on auth/version rejection — die so an operator notices.
      shuttingDown = true;
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 500);
      return;
    }

    if (msg.type === "ping") {
      ws?.send(JSON.stringify({ type: "pong", id: msg.id }));
      return;
    }

    if (msg.type === "exec") {
      const started = Date.now();
      const result: AgentResult = {
        type: "result",
        id: msg.id,
        ok: true,
        stdout: "",
        stderr: "",
        exitCode: -1,
        durationMs: 0,
        truncated: false,
      };
      try {
        const r = await executor.exec({
          command: msg.command,
          args: msg.args,
          cwd: msg.cwd,
          env: msg.env,
          timeoutMs: msg.timeoutMs,
          maxOutputBytes: msg.maxOutputBytes,
        });
        result.stdout = r.stdout;
        result.stderr = r.stderr;
        result.exitCode = r.exitCode;
        result.durationMs = r.durationMs;
        result.truncated = r.truncated;
        result.ok = true;
      } catch (err) {
        result.ok = false;
        result.error = err instanceof Error ? err.message : String(err);
        result.durationMs = Date.now() - started;
      }
      ws?.send(JSON.stringify(result satisfies AgentMessage));
    }
  });

  ws.on("close", (code) => {
    log("disconnected", { code });
    if (shuttingDown) return;
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    log("ws_error", { error: err.message });
  });
}

function scheduleReconnect(): void {
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  log("reconnect_scheduled", { inMs: delay });
  setTimeout(connect, delay);
}

function shutdown(): void {
  shuttingDown = true;
  log("shutting_down");
  ws?.close(1000, "shutdown");
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

connect();
