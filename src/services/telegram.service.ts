import { Context, Telegraf } from 'telegraf';
import type { Update } from 'telegraf/types';

export enum ETGCommand {
  FullUpdate = "full_update",
  Help = "help",
  ChatID = "chat_id",
}

class TelegramService {
  private static chatId: string;
  private static botToken: string;
  private static messageQueue: { message: string | Buffer, chatId: string }[] = [];
  private static isProcessing: boolean = false;
  private static appendedTgCmdHandler: { [cmd: string]: (ctx: Context<Update>) => Promise<void> | void } = {};

  private static bot: Telegraf<Context<Update>>

  static async initialize() {

    this.chatId = process.env.TELEGRAM_CHAT_ID!;
    this.botToken = process.env.TELEGRAM_BOT_TOKEN!;

    this.bot = new Telegraf(this.botToken);
    this.handleTgGeneralMsgs(); // Set up command handlers
    this.startTgBot(); // Start the bot
  }

  static queueMsg(message: string | Buffer, chatId?: string): void {
    TelegramService.messageQueue.push({ message: message, chatId: chatId || this.chatId || process.env.TELEGRAM_CHAT_ID! });
    if (!TelegramService.isProcessing) {
      TelegramService.processQueue();
    }
  }

  private static async processQueue(): Promise<void> {
    this.isProcessing = true;

    while (this.messageQueue.length > 0) {
      const message = this.messageQueue.shift();
      if (message) {
        try {
          if (typeof message.message === 'string') {
            await this.sendMsg(message.message, message.chatId);
          } else if (Buffer.isBuffer(message.message)) {
            await this.sendImg(message.message, message.chatId);
          }
        } catch (error) {
          const stringError = error + ""
          console.log("stringError: ", stringError, `On sending message: ${message.message}`);

          const errMsg = "Error: 429: Too Many Requests: retry after "
          if ((stringError).includes(errMsg)) {
            const splitted = stringError.split(errMsg)
            console.log("splitted: ", splitted);

            const retryNumber = splitted[1]
            console.log("retryNumber: ", retryNumber);
            const sleepTime = Number(retryNumber) * 1000
            console.log("sleepTime: ", sleepTime);

            await new Promise(r => setTimeout(r, sleepTime));
            this.messageQueue.unshift(message)
          }
        }

        await new Promise(r => setTimeout(r, 1000));
      }
    }

    this.isProcessing = false;
  }

  static async sendImg(img: Buffer, chatId: string): Promise<void> {
    try {
      await this.bot.telegram.sendPhoto(chatId, { source: img });
    } catch (error) {
      throw error;
    }
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