import TelegramService from "@/services/telegram.service";
import BudgetingBot from "./budgeting-bot";
import ExchangeService from "@/services/exchange-service/exchange-service";
import type { ICandleInfo } from "@/services/exchange-service/exchange-type";
import { generateImageOfCandles } from "@/utils/image-generator.util";
import type { IAITrend } from "@/services/grok-ai.service";
import { sundayDayName } from "./bb-util";

class BBTrendWatcher {

  constructor(private bot: BudgetingBot) { }

  hookAiTrends(watchFor: "betting" | "resolving", callback: (aiTrend: IAITrend) => void, sundayMondayTransitionCb?: () => Promise<void>): () => void {
    console.log("Hooking ai trends...");

    let isWatchingTrend = true;

    (async () => {
      console.log("Starting watch trends: ", isWatchingTrend);
      while (isWatchingTrend) {

        if (this.bot.connectedClientsAmt === 0) {
          TelegramService.queueMsg("❗ It's should checking trend by now, No clients connected yet, waiting for client to be connected to check trend again, otherwise the bot will die!!!");
          while (true) {
            if (this.bot.connectedClientsAmt > 0) {
              TelegramService.queueMsg("✅ Client connected, checking trend again...");
              break;
            }
            await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before checking again
          }
        }

        const todayDayName = this.bot.bbUtil.getTodayDayName();
        const isTodaySunday = todayDayName === sundayDayName;
        const isTodayMonday = todayDayName === sundayDayName;

        if (!isTodaySunday && !!this.bot.isEarlySundayHandled) this.bot.isEarlySundayHandled = false;
        if (!isTodayMonday && !!this.bot.isEarlyMondayHandled) this.bot.isEarlyMondayHandled = false;

        if ((isTodaySunday && !this.bot.isEarlySundayHandled) || (isTodayMonday && !this.bot.isEarlyMondayHandled)) {
          if (isTodayMonday) {
            this.bot.isEarlyMondayHandled = true;
            TelegramService.queueMsg(`🤶 !!! [INFO] Sunday is over today is Monday - will use analyze trend with after`);
          }

          if (!!sundayMondayTransitionCb) {
            await sundayMondayTransitionCb();
            return;
          }
        }

        const candleEndDate = new Date();
        const candleStartDate = new Date(candleEndDate.getTime() - (this.bot.candlesRollWindowInHours * 60 * 60 * 1000));
        const [candles, currMarkPrice] = await Promise.all([
          await ExchangeService.getCandles(this.bot.symbol, candleStartDate, candleEndDate, '1Min'),
          await ExchangeService.getMarkPrice(this.bot.symbol)
        ]);
        const lastCandle: ICandleInfo = {
          closePrice: currMarkPrice,
          highPrice: currMarkPrice,
          lowPrice: currMarkPrice,
          openPrice: currMarkPrice,
          timestamp: +new Date(),
        }
        candles.push(lastCandle);

        const imageData = await generateImageOfCandles(this.bot.symbol, candles, false, candleEndDate);
        TelegramService.queueMsg(imageData);

        const trend = await (isTodaySunday ? this.bot.grokAi.analyzeTrend(imageData) : this.bot.grokAi.analyzeBreakOutTrend(imageData));
        TelegramService.queueMsg(`ℹ️ New ${this.bot.candlesRollWindowInHours}H ${isTodaySunday ? "regular trend" : "breakout trend"} check for ${watchFor} result: ${trend} - Price: ${lastCandle.closePrice}`);

        if (!isWatchingTrend) return;

        const aiTrend: IAITrend = {
          startDate: new Date(candles[0].timestamp),
          endDate: new Date(lastCandle.timestamp),
          closePrice: lastCandle.closePrice,
          trend: trend as any,
        };

        callback(aiTrend);

        // Gonna check for the next trend exactly on next interval check minute 0 second
        const now = new Date();

        const nextIntervalCheckMinutes = new Date(now.getTime());
        nextIntervalCheckMinutes.setSeconds(0, 0);

        if (now.getSeconds() > 0 || now.getMilliseconds() > 0) nextIntervalCheckMinutes.setMinutes(now.getMinutes() + this.bot.aiTrendIntervalCheckInMinutes);

        const nextCheckTs = nextIntervalCheckMinutes.getTime()
        const waitInMs = nextIntervalCheckMinutes.getTime() - now.getTime();
        this.bot.nextTrendCheckTs = nextCheckTs;
        await new Promise(r => setTimeout(r, waitInMs));
      }
    })();

    return () => {
      console.log(`Stopping trend watcher for ${watchFor}...`);
      isWatchingTrend = false;
    }
  }
}

export default BBTrendWatcher;