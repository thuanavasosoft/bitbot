import WebSocket, { WebSocketServer } from "ws";
import CombinationBot from "../combination-bot";
import TelegramService from "@/services/telegram.service";

export type WsReceiveHandler = (data: string, client: WebSocket) => void;


export interface IWSMessage {
  type: "halo" | "welcome" | "bye";
  data: any;
}

export interface ILeverageMap {
  [symbol: string]: number
}

export interface IWSHaloMessage extends IWSMessage {
  type: "halo";
  data: { label: string };
}

export interface IWSByeMessage extends IWSMessage {
  type: "bye";
  data: { label: string };
}

export interface IWSWelcomeMessage {
  type: "welcome";
  data: ILeverageMap;
  label: string;
}

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

class CombWsServerService {
  constructor(private bot: CombinationBot) { }

  private wss: WebSocketServer | null = null;
  private nextHandlerId = 1;
  private messageHandlers = new Map<number, WsReceiveHandler>();

  /**
   * Starts the WebSocket server if not already running.
   * Uses `COMB_WS_PORT` when `port` is omitted (defaults to 8090).
   */
  start(): void {
    if (this.wss) {
      return;
    }
    const p = Number(process.env.COMB_WS_PORT) || 8090;
    this.wss = new WebSocketServer({ port: p });
    this.wss.on("listening", () => {
      const addr = this.wss?.address();
      if (addr && typeof addr === "object") {
        console.log(
          `[WsServer] WebSocket server started — listening on ${addr.address}:${addr.port} (${addr.family}), COMB_WS_PORT=${process.env.COMB_WS_PORT ?? "(unset, using 8090)"}`,
        );
        TelegramService.queueMsg(`[COMB] 🔌 WebSocket server started — listening on ${addr.address}:${addr.port} (${addr.family}), COMB_WS_PORT=${process.env.COMB_WS_PORT ?? "(unset, using 8090)"}`, this.bot.generalChatId);
      } else {
        console.log(
          `[WsServer] WebSocket server started — listening on ${String(addr)}, COMB_WS_PORT=${process.env.COMB_WS_PORT ?? "(unset, using 8090)"}`,
        );
        TelegramService.queueMsg(`[COMB] 🔌 WebSocket server started — listening on ${String(addr)}, COMB_WS_PORT=${process.env.COMB_WS_PORT ?? "(unset, using 8090)"}`, this.bot.generalChatId);
      }
    });
    this.wss.on("connection", (ws, req) => {
      const remote = req.socket.remoteAddress ?? "unknown";
      console.log(`[WsServer] client connected — ${remote} (total: ${this.wss?.clients.size})`);
      ws.on("message", (raw) => {
        const str = rawDataToString(raw);
        for (const [id, handler] of this.messageHandlers) {
          try {
            handler(str, ws);
          } catch (err) {
            console.error(`[WsServer] handler ${id} threw:`, err);
            TelegramService.queueMsg(`[COMB] 🔌 WsServer handler ${id} threw: ${err}`, this.bot.generalChatId);
          }
        }
      });

      ws.on("close", (code, reason) => {
        console.log(
          `[WsServer] client disconnected — ${remote} code=${code} reason=${reason.toString() || "(none)"} (total clients: ${this.wss?.clients.size})`,
        );
      });
    });
    this.wss.on("error", (err: Error) => {
      console.error("[WsServer] server error:", err);
      TelegramService.queueMsg(`[COMB] 🔌 Error starting copy trading services: ${err}`, this.bot.generalChatId);
    });
  }

  /**
   * Sends the same payload to every connected client whose socket is open.
   */
  broadcastMsg(body: string | Buffer | object): void {
    this.start();
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
        console.log("Sending message to client", payload);

        client.send(payload);
      }
    }
  }

  /**
   * Registers a handler for incoming client messages. Multiple handlers may be active; each receives every message.
   * Returns an id for `removeMsgHandler`.
   */
  addMsgHandler(handler: WsReceiveHandler): WsMessageHandlerId {
    this.start();
    const id = this.nextHandlerId++;
    this.messageHandlers.set(id, handler);
    return id;
  }

  /**
   * Removes a handler previously added with `addMsgHandler`. No-op if the id is unknown.
   */
  removeMsgHandler(id: WsMessageHandlerId): void {
    this.messageHandlers.delete(id);
  }

  async close(): Promise<void> {
    if (!this.wss) {
      return;
    }
    for (const client of this.wss.clients) {
      client.terminate();
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
    this.nextHandlerId = 1;
    this.messageHandlers.clear();
  }
}

export default CombWsServerService;
