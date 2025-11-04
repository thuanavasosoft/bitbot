import TelegramService from "@/services/telegram.service";
import TestFollowMultipleExits from "./test-follow-multiple-exits-bot";
import ExchangeService from "@/services/exchange-service/exchange-service";
import type { ICandleInfo } from "@/services/exchange-service/exchange-type";
import { generateImageOfCandles } from "@/utils/image-generator.util";
import type { IAITrend } from "@/services/grok-ai.service";

class TFMEBTrendWatcher {

  constructor(private bot: TestFollowMultipleExits) { }

  private async getCandlesData() {
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

    return {
      candleEndDate, candleStartDate, firstCandle: candles[0], lastCandle, grokAiImageData
    };
  }

  hookAiTrends(watchFor: "betting" | "resolving", callback: (aiTrend: IAITrend) => void, sundayMondayTransitionCb?: () => Promise<void>): () => void {
    console.log("Hooking ai trends...");

    let isWatchingTrend = true;

    (async () => {
      console.log("Starting watch trends: ", isWatchingTrend);
      while (isWatchingTrend) {
        const { firstCandle, lastCandle, grokAiImageData } = await this.getCandlesData()
        const trend = await (watchFor === "betting" ? this.bot.grokAi.analyzeTrend(grokAiImageData) : this.bot.grokAi.analyzeShouldHoldOrResolve(grokAiImageData));
        TelegramService.queueMsg(`ℹ️ New ${this.bot.candlesRollWindowInHours}H check for ${watchFor} result: ${trend} - Price: ${lastCandle.closePrice}`);

        if (!isWatchingTrend) return;

        const aiTrend: IAITrend = {
          startDate: new Date(firstCandle.timestamp),
          endDate: new Date(lastCandle.timestamp),
          closePrice: lastCandle.closePrice,
          trend: trend as any,
        };



        // Gonna check for the next trend exactly on next interval check minute 0 second
        const { nextCheckTs, waitInMs } = this.bot.tfmebUtil.getWaitInMs();
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