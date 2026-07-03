// /ws/steer client: reconnects with exponential backoff and queues outbound
// messages while disconnected. History replay idempotency is handled by the
// transcript reducer (a "history" message rebuilds the transcript).

import type {
  SteerClientMessage,
  SteerServerMessage,
} from "../../shared/protocol";

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

export type SteerClientHandlers = {
  onMessage: (message: SteerServerMessage) => void;
  onConnectionChange: (connected: boolean) => void;
};

export class SteerClient {
  private readonly url: string;
  private readonly handlers: SteerClientHandlers;
  private ws: WebSocket | null = null;
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private outbox: SteerClientMessage[] = [];

  constructor(url: string, handlers: SteerClientHandlers) {
    this.url = url;
    this.handlers = handlers;
  }

  start(): void {
    this.closed = false;
    this.connect();
  }

  /** Queues while disconnected; flushed in order on (re)connect. */
  send(message: SteerClientMessage): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.outbox.push(message);
    }
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.closed) {
      return;
    }
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.handlers.onConnectionChange(true);
      const queued = this.outbox;
      this.outbox = [];
      for (const message of queued) {
        this.send(message);
      }
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        return;
      }
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { type?: unknown }).type === "string"
      ) {
        this.handlers.onMessage(parsed as SteerServerMessage);
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) {
        return;
      }
      this.ws = null;
      this.handlers.onConnectionChange(false);
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose follows; nothing to do here.
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) {
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}

export function wsUrl(loc: Location, path: string): string {
  const scheme = loc.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${loc.host}${path}`;
}
