import type { ServerWebSocket, Socket } from "bun";

export type VncWsData = {
  kind: "vnc";
  tcp: Socket<undefined> | null;
  /** Frames received before the TCP connection opened. */
  pending: Uint8Array[];
  closed: boolean;
};

export function createVncWsData(): VncWsData {
  return { kind: "vnc", tcp: null, pending: [], closed: false };
}

/**
 * Transparent binary bridge: WebSocket <-> TCP (the VM's own Screen Sharing
 * server). Raw bytes both directions; closing either side closes the other.
 */
export function openVncBridge(
  ws: ServerWebSocket<VncWsData>,
  hostname: string,
  port: number,
): void {
  Bun.connect({
    hostname,
    port,
    socket: {
      open(socket) {
        if (ws.data.closed) {
          socket.end();
          return;
        }
        ws.data.tcp = socket;
        for (const chunk of ws.data.pending) {
          socket.write(chunk);
        }
        ws.data.pending.length = 0;
      },
      data(_socket, data) {
        ws.send(data);
      },
      close() {
        ws.data.tcp = null;
        if (!ws.data.closed) {
          ws.data.closed = true;
          ws.close(1000, "vnc server closed");
        }
      },
      error(_socket, error) {
        console.error("[gateway] vnc tcp error:", error);
      },
    },
  }).catch((error) => {
    console.error("[gateway] vnc connect failed:", error);
    if (!ws.data.closed) {
      ws.data.closed = true;
      ws.close(1011, "vnc upstream unavailable");
    }
  });
}

export function forwardVncClientFrame(
  data: VncWsData,
  frame: string | Uint8Array,
): void {
  const bytes =
    typeof frame === "string" ? new TextEncoder().encode(frame) : frame;
  if (data.tcp !== null) {
    data.tcp.write(bytes);
  } else {
    data.pending.push(bytes);
  }
}

export function closeVncBridge(data: VncWsData): void {
  data.closed = true;
  data.tcp?.end();
  data.tcp = null;
}
