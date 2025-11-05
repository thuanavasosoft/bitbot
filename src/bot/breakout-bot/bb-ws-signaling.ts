import { WebSocketServer, WebSocket } from "ws";
import TelegramService from "@/services/telegram.service";
import type BreakoutBot from "./breakout-bot";

export type TSignalToClientType = "open-long" | "open-short" | "close-position" | "pong";

interface IOpenPositionMsgToClient {
  type: "open-long" | "open-short";
  openBalanceAmt: number | string;
}

interface IClosePositionMsgToClient {
  type: "close-position";
}

interface IPongMsgToClient {
  type: "pong";
}

type IBBWSMsgToClient =
  | IOpenPositionMsgToClient
  | IClosePositionMsgToClient
  | IPongMsgToClient;

interface IPingMsgFromClient {
  type: "ping";
}

type IMsgFromClient = IPingMsgFromClient;

class BBWSSignaling {
  private clients = new Set<WebSocket>();

  constructor(private bot: BreakoutBot) { }

  serveServer(port: number) {
    const wss = new WebSocketServer({ port });

    wss.on("connection", (ws: WebSocket) => {
      this.handleOpen(ws);

      ws.on("close", () => this.handleClose(ws));
      ws.on("message", (msg: Buffer) => this.handleMessage(ws, msg.toString()));
    });

    console.log(`✅ WebSocket server running on ws://127.0.0.1:${port}`);
  }

  private handleOpen(ws: WebSocket) {
    this.clients.add(ws);
    this.bot.connectedClientsAmt = this.clients.size;
    TelegramService.queueMsg(
      `➕ New WS client connected. Total connected: ${this.clients.size}`
    );
    console.log("Client connected");
  }

  private handleClose(ws: WebSocket) {
    this.clients.delete(ws);
    this.bot.connectedClientsAmt = this.clients.size;
    TelegramService.queueMsg(
      `➖ WS client disconnected. Total connected: ${this.clients.size}`
    );
    console.log("Client disconnected");
  }

  private handleMessage(ws: WebSocket, msg: string) {
    try {
      const data: IMsgFromClient = JSON.parse(msg);

      if (data.type === "ping") {
        const response: IBBWSMsgToClient = { type: "pong" };
        ws.send(JSON.stringify(response));
      }
    } catch (err) {
      console.error("Invalid JSON message:", msg);
    }
  }

  broadcast(type: TSignalToClientType, openBalanceAmt?: string) {
    for (const client of this.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;

      let msg: IBBWSMsgToClient;

      if (type === "open-long" || type === "open-short") {
        msg = { type, openBalanceAmt: openBalanceAmt! };
      } else {
        msg = { type };
      }

      client.send(JSON.stringify(msg));
    }
  }
}

export default BBWSSignaling;

