import ExchangeService from "@/services/exchange-service/exchange-service";
import TelegramService from "@/services/telegram.service";
import { generateImageOfCandlesWithSupportResistance } from "@/utils/image-generator.util";
import { RingBuffer } from "@/utils/ring-buffer.util";
import { withRetries, isTransientError } from "../breakout-bot/bb-retry";
import { calculateBreakoutSignal } from "./tmob-backtest";
import { TMOB_DEFAULT_SIGNAL_PARAMS } from "./tmob-utils";
import TrailMultiplierOptimizationBot from "./trail-multiplier-optimization-bot";
import { ICandleInfo } from "@/services/exchange-service/exchange-type";
import BigNumber from "bignumber.js";

class TMOBCandleWatcher {
  isCandleWatcherStarted: boolean = false;
  private candleBuffer: RingBuffer<ICandleInfo> | null = null;

  constructor(private bot: TrailMultiplierOptimizationBot) { }

  async startWatchingCandles() {
    if (this.isCandleWatcherStarted) return;
    this.isCandleWatcherStarted = true;

    console.log("Starting TMOBCandleWatcher");
    TelegramService.queueMsg("🔍 Starting TMOBCandleWatcher");

    while (true) {
      try {
        const now = new Date();
        if (!this.candleBuffer) {
          const rawCandles = await withRetries(
            () => ExchangeService.getCandles(this.bot.symbol, new Date(now.getTime() - 60_000 - this.bot.nSignal * 60 * 1000), now, "1Min"),
            {
              label: "[TMOBCandleWatcher] getCandles (initial)",
              retries: 5,
              minDelayMs: 5000,
              isTransientError,
              onRetry: ({ attempt, delayMs, error, label }) => {
                console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
              },
            }
          );
          const candles = rawCandles.filter((c): c is ICandleInfo => c != null && c.openTime != null);
          if (candles.length === 0) throw new Error("getCandles returned no valid candles");
          this.candleBuffer = RingBuffer.fromArray(candles);
        } else {
          const currCandles = this.candleBuffer.toArray();
          const lastCurrCandle = currCandles[currCandles.length - 1];
          const lastCandleCloseTimeTime = new Date(lastCurrCandle.openTime);

          const timeDiff = now.getTime() - lastCandleCloseTimeTime.getTime();
          const waitTime = 60_000 - timeDiff;
          if (timeDiff < 60_000 && waitTime > 0) await new Promise(r => setTimeout(r, waitTime));

          // Add the new candle via ring buffer (O(1), overwrites oldest)
          const newLastCandles = await withRetries(
            () => ExchangeService.getCandles(this.bot.symbol, lastCandleCloseTimeTime, now, "1Min"),
            {
              label: "[TMOBCandleWatcher] getCandles (update)",
              retries: 5,
              minDelayMs: 5000,
              isTransientError,
              onRetry: ({ attempt, delayMs, error, label }) => {
                console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
              },
            }
          );

          const newCandle = newLastCandles.filter((c): c is ICandleInfo => c != null && c.openTime != null).pop();
          if (newCandle) this.candleBuffer.push(newCandle);
        }
        const currCandles = this.candleBuffer.toArray();
        const signalParams = { ...TMOB_DEFAULT_SIGNAL_PARAMS, N: this.bot.nSignal };
        const signalResult = calculateBreakoutSignal(currCandles, signalParams);
        if (signalResult.support === null && signalResult.resistance === null) continue;

        const rawSupport = signalResult.support;
        const rawResistance = signalResult.resistance;

        let trailingStopRaw: number | null = null;
        let trailingStopBuffered: number | null = null;

        const trailingTargets = this.bot.trailingStopTargets;
        if (
          trailingTargets &&
          this.bot.currActivePosition &&
          trailingTargets.side === this.bot.currActivePosition.side
        ) {
          trailingStopRaw = trailingTargets.rawLevel;
          trailingStopBuffered = trailingTargets.bufferedLevel;
        }

        this.bot.currentSupport = rawSupport;

        if (rawResistance !== null) {
          this.bot.currentResistance = rawResistance;
          const bufferMultiplier = new BigNumber(1).minus(this.bot.triggerBufferPercentage / 100);
          const longTriggerRaw = new BigNumber(rawResistance).times(bufferMultiplier);
          const multiplier = Math.pow(10, this.bot.pricePrecision);
          this.bot.longTrigger = Math.floor(longTriggerRaw.times(multiplier).toNumber()) / multiplier;
        }

        if (rawSupport !== null) {
          const bufferMultiplier = new BigNumber(1).plus(this.bot.triggerBufferPercentage / 100);
          const shortTriggerRaw = new BigNumber(rawSupport).times(bufferMultiplier);
          const multiplier = Math.pow(10, this.bot.pricePrecision);
          this.bot.shortTrigger = Math.ceil(shortTriggerRaw.times(multiplier).toNumber()) / multiplier;
        }

        const signalImageData = await withRetries(
          () =>
            generateImageOfCandlesWithSupportResistance(
              this.bot.symbol,
              currCandles,
              rawSupport,
              rawResistance,
              false,
              now,
              this.bot.currActivePosition,
              this.bot.longTrigger,
              this.bot.shortTrigger,
              trailingStopRaw,
              trailingStopBuffered,
            ),
          {
            label: "[AATrendWatcher] generateImageOfCandlesWithSupportResistance",
            retries: 5,
            minDelayMs: 5000,
            isTransientError,
            onRetry: ({ attempt, delayMs, error, label }) => {
              console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
            },
          }
        );

        TelegramService.queueMsg(signalImageData);

        // Enhanced messaging with all details
        const currentPrice = currCandles[currCandles.length - 1].closePrice;
        const triggerMsg = this.bot.longTrigger !== null || this.bot.shortTrigger !== null
          ? `\nLong Trigger: ${this.bot.longTrigger !== null ? this.bot.longTrigger.toFixed(4) : "N/A"}\nShort Trigger: ${this.bot.shortTrigger !== null ? this.bot.shortTrigger.toFixed(4) : "N/A"}`
          : "";
        const trailingMsg = trailingStopRaw !== null || trailingStopBuffered !== null
          ? `\nTrail Stop (raw): ${trailingStopRaw !== null ? trailingStopRaw.toFixed(4) : "N/A"}\nTrail Stop (buffered): ${trailingStopBuffered !== null ? trailingStopBuffered.toFixed(4) : "N/A"}`
          : "";

        const optimizationAgeMsg = this.bot.lastOptimizationAtMs > 0
          ? (() => {
            const elapsedMs = now.getTime() - this.bot.lastOptimizationAtMs;
            const totalSeconds = Math.floor(elapsedMs / 1000);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            return `\nLast optimized: ${hours}h${minutes}m`;
          })()
          : `\nLast optimized: N/A`;
        const paramsMsg =
          `\nTrailing ATR Length: ${this.bot.trailingAtrLength} (fixed)` +
          `\nTrailing Multiplier: ${this.bot.trailingStopMultiplier}`;

        TelegramService.queueMsg(
          `ℹ️ Price: ${currentPrice.toFixed(4)}\n` +
          `Support: ${rawSupport !== null ? rawSupport.toFixed(4) : "N/A"}\n` +
          `Resistance: ${rawResistance !== null ? rawResistance.toFixed(4) : "N/A"}${triggerMsg}${trailingMsg}${paramsMsg}${optimizationAgeMsg}`
        );

        this.bot.lastSRUpdateTime = Date.now();

        // Delay until next minute at 0 seconds before next iteration
        const nowMs = Date.now();
        const nextMinuteStartMs = (Math.floor(nowMs / 60_000) + 1) * 60_000;
        const delayMs = nextMinuteStartMs - nowMs;
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      } catch (error) {
        console.error("[TMOBCandleWatcher] Failed to process candle watcher iteration:", error);
        TelegramService.queueMsg(
          `⚠️ TMOB candle watcher error (will retry next interval): ${error instanceof Error ? error.message : String(error)}`
        );
        // Wait a minute before retrying
        await new Promise((r) => setTimeout(r, 60_000));
      }
    }
  }
}

export default TMOBCandleWatcher;