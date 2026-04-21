import ExchangeService from "@/services/exchange-service/exchange-service";
import TelegramService from "@/services/telegram.service";
import { generateImageOfCandlesWithSupportResistance } from "@/utils/image-generator.util";
import { calc_UnrealizedPnl } from "@/utils/maths.util";
import type { ICandleInfo } from "@/services/exchange-service/exchange-type";
import type FollowMartingaleBot from "./follow-martingale-bot";
import { isTransientError, withRetries } from "./fm-retry";

const CANDLE_WATCHER_DELAY_AFTER_MINUTE_MS = 500;

class FMCandleWatcher {
  isCandleWatcherStarted = false;

  constructor(private bot: FollowMartingaleBot) { }

  private async getChartCandles(now: Date): Promise<ICandleInfo[]> {
    await this.bot.candles.ensurePopulated();
    const allCandles = await this.bot.candles.toArray();
    let currCandles = allCandles.slice(-(this.bot.signalN + 1));

    if (currCandles.length <= this.bot.signalN) {
      const currMarkPrice = await ExchangeService.getMarkPrice(this.bot.symbol);
      currCandles = [...currCandles, {
        timestamp: now.getTime(),
        openTime: now.getTime(),
        closeTime: now.getTime(),
        openPrice: currMarkPrice,
        highPrice: currMarkPrice,
        lowPrice: currMarkPrice,
        closePrice: currMarkPrice,
        volume: 0,
      }];
    }

    return currCandles;
  }

  async refreshChart(): Promise<void> {
    try {
      const now = new Date();
      now.setSeconds(0);
      now.setMilliseconds(0);

      await this.bot.refreshSignalLevels();
      const currCandles = await this.getChartCandles(now);
      const activeSide = this.bot.getActiveCycleSide();
      const takeProfitLevel =
        this.bot.currActivePosition && activeSide
          ? this.bot.computeTpPrice(activeSide, this.bot.currActivePosition.avgPrice)
          : undefined;

      const signalImageData = await withRetries(
        () =>
          generateImageOfCandlesWithSupportResistance(
            this.bot.symbol,
            currCandles,
            this.bot.currentSupport,
            this.bot.currentResistance,
            false,
            now,
            this.bot.currActivePosition ?? undefined,
            this.bot.currentLongTrigger ?? undefined,
            this.bot.currentShortTrigger ?? undefined,
            undefined,
            undefined,
            undefined,
            takeProfitLevel
          ),
        {
          label: "[FMCandleWatcher] generateImageOfCandlesWithSupportResistance",
          retries: 3,
          minDelayMs: 2000,
          isTransientError,
          onRetry: ({ attempt, delayMs, error, label }) =>
            console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
        }
      );

      TelegramService.queueMsg(signalImageData);

      const currLtpPrice = await ExchangeService.getLTPPrice(this.bot.symbol);
      const currPnl = this.bot.currActivePosition ? calc_UnrealizedPnl(this.bot.currActivePosition, currLtpPrice) : 0;
      const pnlIndicator = currPnl >= 0 ? "🟩" : "🟥";
      const activeCycleMsg = activeSide ? `\nActive side: ${activeSide.toUpperCase()}` : "";
      const avgMsg = this.bot.currActivePosition ? `\nAvg price: ${this.bot.currActivePosition.avgPrice}` : "";
      const tpMsg = takeProfitLevel != null ? `\nTake profit: ${takeProfitLevel}` : "";
      const liqMsg = this.bot.currActivePosition ? `\nLiquidation: ${this.bot.currActivePosition.liquidationPrice}` : "";

      TelegramService.queueMsg(
        `ℹ️ Curr LTP Price: ${currLtpPrice.toFixed(this.bot.pricePrecision)} ${this.bot.currActivePosition ? `(${pnlIndicator} ${currPnl.toFixed(2)} USDT)` : ""}\n` +
        `Resistance: ${this.bot.currentResistance ?? "N/A"}\nLong Trigger: ${this.bot.currentLongTrigger ?? "N/A"}\n` +
        `Support: ${this.bot.currentSupport ?? "N/A"}\nShort Trigger: ${this.bot.currentShortTrigger ?? "N/A"}${activeCycleMsg}${avgMsg}${tpMsg}${liqMsg}`
      );
    } catch (error) {
      this.bot.queueMsg(`⚠️ Failed to refresh martingale chart: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async startWatchingCandles(): Promise<void> {
    if (this.isCandleWatcherStarted) return;
    this.isCandleWatcherStarted = true;
    this.bot.queueMsg("🔍 Starting FMCandleWatcher");

    try {
      while (!this.bot.isStopped) {
        try {
          await this.refreshChart();

          const nowMs = Date.now();
          const nextMinuteStartMs = (Math.floor(nowMs / 60_000) + 1) * 60_000;
          const targetMs = nextMinuteStartMs + CANDLE_WATCHER_DELAY_AFTER_MINUTE_MS;
          const delayMs = targetMs - nowMs;
          if (delayMs > 0) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        } catch (error) {
          if (this.bot.isStopped) break;
          console.error("[FM] Candle watcher iteration error:", error);
          this.bot.queueMsg(
            `⚠️ Follow-martingale candle watcher error (will retry next interval): ${error instanceof Error ? error.message : String(error)}`
          );
          await new Promise((r) => setTimeout(r, 60_000));
        }
      }
    } finally {
      this.isCandleWatcherStarted = false;
    }
  }
}

export default FMCandleWatcher;
