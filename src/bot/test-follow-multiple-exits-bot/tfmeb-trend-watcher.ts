import TelegramService from "@/services/telegram.service";
import TestFollowMultipleExits from "./test-follow-multiple-exits-bot";
import ExchangeService from "@/services/exchange-service/exchange-service";
import type { ICandleInfo } from "@/services/exchange-service/exchange-type";
import { generateImageOfCandles } from "@/utils/image-generator.util";
import type { IAITrend } from "@/services/grok-ai.service";
import moment from "moment";

class TFMEBTrendWatcher {

  constructor(private bot: TestFollowMultipleExits) { }

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

        const tgImage = await generateImageOfCandles(this.bot.symbol, candles, false, candleEndDate, this.bot.currActivePosition);
        TelegramService.queueMsg(tgImage);

        const grokAiImageData = await generateImageOfCandles(this.bot.symbol, candles, false, candleEndDate);
        const trend = await this.bot.grokAi.analyzeBreakoutTrendV2(grokAiImageData);
        TelegramService.queueMsg(`ℹ️ New ${this.bot.candlesRollWindowInHours}H "breakout trend v2 (${moment(candleStartDate).format("YYYY-MM-DD HH:mm:ss")} - ${moment(candleEndDate).format("YYYY-MM-DD HH:mm:ss")}) check for ${watchFor} result: ${trend} - Price: ${lastCandle.closePrice}`);

        if (!isWatchingTrend) return;

        const aiTrend: IAITrend = {
          startDate: new Date(candles[0].timestamp),
          endDate: new Date(lastCandle.timestamp),
          closePrice: lastCandle.closePrice,
          trend: trend,
        };

        // Gonna check for the next trend exactly on next interval check minute 0 second
        const { nextCheckTs, waitInMs } = this.bot.bbUtil.getWaitInMs();
        this.bot.nextTrendCheckTs = nextCheckTs;

        callback(aiTrend);
        await new Promise(r => setTimeout(r, waitInMs));
      }
    })();

    return () => {
      console.log(`Stopping trend watcher for ${watchFor}...`);
      isWatchingTrend = false;
    }
  }
}

export default TFMEBTrendWatcher;