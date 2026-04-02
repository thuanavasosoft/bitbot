import WebSocket, { WebSocketServer } from "ws";

export type WsReceiveHandler = (data: string, client: WebSocket) => void;

function rawDataToString(raw: WebSocket.RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  return Buffer.from(raw).toString("utf8");
}

/** Opaque id returned by `addMsgHandler` for use with `removeMsgHandler`. */
export type WsMessageHandlerId = number;

class WsServerService {
  private static wss: WebSocketServer | null = null;
  private static nextHandlerId = 1;
  private static messageHandlers = new Map<number, WsReceiveHandler>();

  /**
   * Starts the WebSocket server if not already running.
   * Uses `WS_PORT` when `port` is omitted (defaults to 8090).
   */
  static start(): void {
    if (this.wss) {
      return;
    }
    const p = Number(process.env.WS_PORT) || 8090;
    this.wss = new WebSocketServer({ port: p });
    this.wss.on("listening", () => {
      const addr = this.wss?.address();
      if (addr && typeof addr === "object") {
        console.log(
          `[WsServer] WebSocket server started — listening on ${addr.address}:${addr.port} (${addr.family}), WS_PORT=${process.env.WS_PORT ?? "(unset, using 8090)"}`,
        );
      } else {
        console.log(
          `[WsServer] WebSocket server started — listening on ${String(addr)}, WS_PORT=${process.env.WS_PORT ?? "(unset, using 8090)"}`,
        );
      }
    });
    this.wss.on("connection", (ws) => {
      ws.on("message", (raw) => {
        const str = rawDataToString(raw);
        for (const handler of this.messageHandlers.values()) {
          handler(str, ws);
        }
      });
    });
    this.wss.on("error", (err: Error) => {
      console.error("WebSocket server error:", err);
    });
  }

  private static ensureStarted(): void {
    this.start();
  }

  /**
   * Sends the same payload to every connected client whose socket is open.
   */
  static broadcastMsg(body: string | Buffer | object): void {
    this.ensureStarted();
    const wss = this.wss;
    if (!wss) {
      return;
    }
    const payload =
      typeof body === "string"
        ? body
        : Buffer.isBuffer(body)
          ? body
          : JSON.stringify(body);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  /**
   * Registers a handler for incoming client messages. Multiple handlers may be active; each receives every message.
   * Returns an id for `removeMsgHandler`.
   */
  static addMsgHandler(handler: WsReceiveHandler): WsMessageHandlerId {
    this.ensureStarted();
    const id = this.nextHandlerId++;
    this.messageHandlers.set(id, handler);
    return id;
  }

  /**
   * Removes a handler previously added with `addMsgHandler`. No-op if the id is unknown.
   */
  static removeMsgHandler(id: WsMessageHandlerId): void {
    this.messageHandlers.delete(id);
  }

  static async close(): Promise<void> {
    if (!this.wss) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.wss!.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
    this.wss = null;
    this.messageHandlers.clear();
  }
}

export default WsServerService;
