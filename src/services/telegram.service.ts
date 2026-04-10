import sharp from 'sharp';
import { Context, Telegraf } from 'telegraf';
import type { Update } from 'telegraf/types';

export enum ETGCommand {
  FullUpdate = "full_update",
  Help = "help",
  ChatID = "chat_id",
}

type TelegramQueuedItem = { message: string | Buffer };

class TelegramService {
  private static chatId: string;
  private static botToken: string;
  private static queuesByChat = new Map<string, TelegramQueuedItem[]>();
  private static chatProcessorsActive = new Set<string>();
  private static appendedTgCmdHandler: { [cmd: string]: (ctx: Context<Update>) => Promise<void> | void } = {};

  private static bot: Telegraf<Context<Update>>

  static async initialize() {

    this.chatId = process.env.TELEGRAM_CHAT_ID!;
    this.botToken = process.env.TELEGRAM_BOT_TOKEN!;

    this.bot = new Telegraf(this.botToken);
    this.handleTgGeneralMsgs(); // Set up command handlers
    this.startTgBot(); // Start the bot
  }

  private static resolveChatId(chatId?: string): string {
    return chatId || this.chatId || process.env.TELEGRAM_CHAT_ID!;
  }

  private static enqueue(chatId: string, item: TelegramQueuedItem, atFront: boolean): void {
    let q = this.queuesByChat.get(chatId);
    if (!q) {
      q = [];
      this.queuesByChat.set(chatId, q);
    }
    if (atFront) {
      q.unshift(item);
    } else {
      q.push(item);
    }
    void this.processChatQueue(chatId);
  }

  static queueMsg(message: string | Buffer, chatId?: string): void {
    this.enqueue(this.resolveChatId(chatId), { message }, false);
  }

  /** Queue a message at the front so it is sent before other queued messages (higher priority). */
  static queueMsgPriority(message: string | Buffer, chatId?: string): void {
    this.enqueue(this.resolveChatId(chatId), { message }, true);
  }

  /** Telegram message length limit. */
  private static readonly TG_MAX_MESSAGE_LENGTH = 4096;

  /** JPEG quality (1–100) for outgoing photos; 50 ≈ 50% of max quality for smaller uploads. */
  private static readonly TELEGRAM_PHOTO_JPEG_QUALITY = 50;

  /** Minimum gap between sends to the same chat (reduces 429s; chats are independent). */
  private static readonly MIN_SEND_INTERVAL_MS = 150;

  private static readonly TG_429_PREFIX = "Error: 429: Too Many Requests: retry after ";

  /**
   * Queue a long string as multiple priority messages (each under Telegram's limit).
   * Chunks are queued at the front in order so the first part is sent first.
   */
  static queueMsgLongPriority(message: string, chatId?: string, maxLen: number = this.TG_MAX_MESSAGE_LENGTH): void {
    const resolvedChatId = chatId || this.chatId || process.env.TELEGRAM_CHAT_ID!;
    if (message.length <= maxLen) {
      this.queueMsgPriority(message, resolvedChatId);
      return;
    }
    const lines = message.split("\n");
    const chunks: string[] = [];
    let chunk = "";
    for (const line of lines) {
      const next = chunk ? chunk + "\n" + line : line;
      if (next.length > maxLen) {
        if (chunk) chunks.push(chunk);
        if (line.length > maxLen) {
          for (let i = 0; i < line.length; i += maxLen) {
            chunks.push(line.slice(i, i + maxLen));
          }
          chunk = "";
        } else {
          chunk = line;
        }
      } else {
        chunk = next;
      }
    }
    if (chunk) chunks.push(chunk);
    for (let i = chunks.length - 1; i >= 0; i--) {
      this.enqueue(resolvedChatId, { message: chunks[i] }, true);
    }
  }

  private static parse429RetryAfterMs(error: unknown): number | null {
    const stringError = String(error);
    if (!stringError.includes(this.TG_429_PREFIX)) {
      return null;
    }
    const parts = stringError.split(this.TG_429_PREFIX);
    const retrySeconds = Number(parts[1]?.trim().split(/\s/)[0]);
    if (!Number.isFinite(retrySeconds) || retrySeconds < 0) {
      return null;
    }
    return retrySeconds * 1000;
  }

  /**
   * Serializes sends per chatId; multiple chats run in parallel.
   * On 429, only this chat waits retry_after; the failed item is retried first.
   */
  private static async processChatQueue(chatId: string): Promise<void> {
    if (this.chatProcessorsActive.has(chatId)) {
      return;
    }
    this.chatProcessorsActive.add(chatId);
    try {
      while (true) {
        const q = this.queuesByChat.get(chatId);
        if (!q || q.length === 0) {
          this.queuesByChat.delete(chatId);
          break;
        }
        const item = q.shift()!;
        try {
          if (typeof item.message === "string") {
            await this.sendMsg(item.message, chatId);
          } else if (Buffer.isBuffer(item.message)) {
            await this.sendImg(item.message, chatId);
          }
        } catch (error) {
          const stringError = String(error);
          console.log(
            "stringError:",
            stringError,
            typeof item.message === "string"
              ? `On sending message: ${item.message}`
              : `On sending image (buffer length: ${item.message.length})`
          );
          const retryMs = this.parse429RetryAfterMs(error);
          if (retryMs !== null) {
            console.log("Telegram 429 retry after ms: ", retryMs);
            await new Promise((r) => setTimeout(r, retryMs));
            q.unshift(item);
          }
        }

        const stillQueued = this.queuesByChat.get(chatId);
        if (stillQueued && stillQueued.length > 0) {
          await new Promise((r) => setTimeout(r, this.MIN_SEND_INTERVAL_MS));
        }
      }
    } finally {
      this.chatProcessorsActive.delete(chatId);
      if (this.queuesByChat.get(chatId)?.length) {
        void this.processChatQueue(chatId);
      }
    }
  }

  private static totalQueuedCount(): number {
    let n = 0;
    for (const q of this.queuesByChat.values()) {
      n += q.length;
    }
    return n;
  }

  static async waitForQueueIdle(timeoutMs = 15000, pollMs = 200): Promise<boolean> {
    const start = Date.now();
    while (this.totalQueuedCount() > 0 || this.chatProcessorsActive.size > 0) {
      if (Date.now() - start >= timeoutMs) {
        return false;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return true;
  }

  static async sendImg(img: Buffer, chatId: string): Promise<void> {
    const compressed = await sharp(img)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: this.TELEGRAM_PHOTO_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    await this.bot.telegram.sendPhoto(chatId, { source: compressed });
  }

  static async sendMsg(message: string, chatId: string): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(chatId, message);
    } catch (error) {
      throw error;
    }
  }

  public static appendTgCmdHandler(cmd: string, handler: (ctx: Context<Update>) => Promise<void> | void) {
    this.appendedTgCmdHandler[cmd] = handler;
    this.bot.command(cmd, handler);
  }

  private static handleTgGeneralMsgs(): void {
    console.log("Setting up bot command handlers");

    // Command handler for /chat_id
    TelegramService.appendTgCmdHandler(ETGCommand.ChatID, (ctx) => {
      ctx.reply(`Chat id is: ${ctx.chat!.id}`);
    });

    // Start command handler
    this.bot.start((ctx) => {
      ctx.reply('Welcome to Publish Bot!');
    });

    // Error handling
    this.bot.catch((err, ctx) => {
      console.error('Error in bot:', err);
      ctx.reply('An error occurred. Please try again later.');
    });
  }

  private static isLaunched = false;
  private static retryTimeout: NodeJS.Timeout | null = null;

  private static startTgBot(isAfterTokenMultipleUseError?: boolean): void {
    if (this.isLaunched) {
      console.warn("Bot already launched, skipping start.");
      return;
    }

    console.log("Starting bot receiver...");
    const msg = "🛑🛑🛑Someone has just run another program using the same telegram token as this, please make sure that program stopped otherwise this bot will have communication issue 🛑🛑🛑";
    if (isAfterTokenMultipleUseError) {
      TelegramService.queueMsg(msg, this.chatId);
      for (const key in this.appendedTgCmdHandler) {
        this.bot.command(key, this.appendedTgCmdHandler[key]);
      }
    }

    this.bot.launch()
      .then(() => {
        this.isLaunched = true;
        console.log(`Bot is running with token: ${this.botToken}`);
      })
      .catch((err) => {
        const errMsg = String(err);
        console.error('Failed to start bot:', errMsg);

        // --- Auto recovery for conflict error ---
        if (errMsg.includes("409: Conflict")) {
          console.warn("Detected 409 Conflict — likely another instance using the same token.");
          console.warn("Retrying to relaunch in 10 seconds...");

          if (this.retryTimeout) clearTimeout(this.retryTimeout);

          this.retryTimeout = setTimeout(async () => {
            try {
              console.log("Attempting to relaunch Telegram bot...");
              await this.bot.stop(); // Stop any partial session
              this.isLaunched = false;
              this.startTgBot(true);
            } catch (e) {
              console.error("Failed during retry relaunch:", e);
            }
          }, 10_000); // 10 seconds
        }
      });
  }
}

export default TelegramService;