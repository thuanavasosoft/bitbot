import ExchangeService from "@/services/exchange-service/exchange-service";
import { withRetries, isTransientError } from "./comb-retry";
import { generateImageOfCandlesWithSupportResistance } from "@/utils/image-generator.util";
import { calculateBreakoutSignal } from "./comb-backtest";
import { COMB_DEFAULT_SIGNAL_PARAMS } from "./comb-utils";
import BigNumber from "bignumber.js";
import { ICandleInfo } from "@/services/exchange-service/exchange-type";
import type CombBotInstance from "./comb-bot-instance";

class CombCandleWatcher {
  isCandleWatcherStarted = false;

  constructor(private bot: CombBotInstance) { }

  async startWatchingCandles() {
    if (this.isCandleWatcherStarted) return;
    this.isCandleWatcherStarted = true;
    this.bot.queueMsg("🔍 Starting CombCandleWatcher");
    while (true) {
      try {
        const now = new Date();
        await this.bot.tmobCandles.ensurePopulated();
        now.setSeconds(0);
        now.setMilliseconds(0);
        let currCandles = await this.bot.tmobCandles.getCandles(new Date(now.getTime() - (this.bot.nSignal + 1) * 60 * 1000), now);
        if (currCandles.length <= this.bot.nSignal) {
          const markPrice = await ExchangeService.getMarkPrice(this.bot.symbol);
          currCandles.push({
            timestamp: now.getTime(),
            openTime: now.getTime(),
            closeTime: now.getTime(),
            openPrice: markPrice,
            highPrice: markPrice,
            lowPrice: markPrice,
            closePrice: markPrice,
            volume: 0,
          } as ICandleInfo);
        }
        const signalParams = { ...COMB_DEFAULT_SIGNAL_PARAMS, N: this.bot.nSignal };
        const signalResult = calculateBreakoutSignal(currCandles, signalParams);
        const rawSupport = signalResult.support;
        const rawResistance = signalResult.resistance;
        this.bot.currentSupport = rawSupport;
        this.bot.currentResistance = rawResistance;

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

        if (rawResistance !== null) {
          const bufferMultiplier = new BigNumber(1).minus(this.bot.triggerBufferPercentage / 100);
          const longTriggerRaw = new BigNumber(rawResistance).times(bufferMultiplier);
          const multiplier = Math.pow(10, this.bot.pricePrecision);
          this.bot.longTrigger = Math.floor(longTriggerRaw.times(multiplier).toNumber()) / multiplier;
        } else {
          this.bot.longTrigger = null;
        }
        if (rawSupport !== null) {
          const bufferMultiplier = new BigNumber(1).plus(this.bot.triggerBufferPercentage / 100);
          const shortTriggerRaw = new BigNumber(rawSupport).times(bufferMultiplier);
          const multiplier = Math.pow(10, this.bot.pricePrecision);
          this.bot.shortTrigger = Math.ceil(shortTriggerRaw.times(multiplier).toNumber()) / multiplier;
        } else {
          this.bot.shortTrigger = null;
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
              this.bot.currActivePosition ?? undefined,
              this.bot.longTrigger ?? undefined,
              this.bot.shortTrigger ?? undefined,
              trailingStopRaw ?? undefined,
              trailingStopBuffered ?? undefined,
            ),
          {
            label: "[CombCandleWatcher] generateImageOfCandlesWithSupportResistance",
            retries: 5,
            minDelayMs: 5000,
            isTransientError,
            onRetry: ({ attempt, delayMs, error, label }) => {
              console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
            },
          }
        );
        this.bot.queueMsg(signalImageData);

        const currentPrice = currCandles[currCandles.length - 1].closePrice;
        const triggerMsg =
          this.bot.longTrigger !== null || this.bot.shortTrigger !== null
            ? `\nLong Trigger: ${this.bot.longTrigger !== null ? this.bot.longTrigger.toFixed(4) : "N/A"}\nShort Trigger: ${this.bot.shortTrigger !== null ? this.bot.shortTrigger.toFixed(4) : "N/A"}`
            : "";
        const trailingMsg =
          trailingStopRaw !== null || trailingStopBuffered !== null
            ? `\nTrail Stop (raw): ${trailingStopRaw !== null ? trailingStopRaw.toFixed(4) : "N/A"}\nTrail Stop (buffered): ${trailingStopBuffered !== null ? trailingStopBuffered.toFixed(4) : "N/A"}`
            : "";
        const optimizationAgeMsg =
          this.bot.lastOptimizationAtMs > 0
            ? (() => {
                const elapsedMs = now.getTime() - this.bot.lastOptimizationAtMs;
                const totalSeconds = Math.floor(elapsedMs / 1000);
                const hours = Math.floor(totalSeconds / 3600);
                const minutes = Math.floor((totalSeconds % 3600) / 60);
                return `\nLast optimized: ${hours}h${minutes}m`;
              })()
            : "\nLast optimized: N/A";
        const paramsMsg =
          `\nTrailing ATR Length: ${this.bot.trailingAtrLength} (fixed)` +
          `\nTrailing Multiplier: ${this.bot.trailingStopMultiplier}`;

        this.bot.queueMsg(
          `ℹ️ Price: ${currentPrice.toFixed(4)}\n` +
            `Support: ${rawSupport !== null ? rawSupport.toFixed(4) : "N/A"}\n` +
            `Resistance: ${rawResistance !== null ? rawResistance.toFixed(4) : "N/A"}${triggerMsg}${trailingMsg}${paramsMsg}${optimizationAgeMsg}`
        );

        this.bot.lastSRUpdateTime = Date.now();

        const nowMs = Date.now();
        const nextMinuteStartMs = (Math.floor(nowMs / 60_000) + 1) * 60_000;
        const delayMs = nextMinuteStartMs - nowMs;
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      } catch (error) {
        console.error("[COMB] Candle watcher iteration error:", error);
        this.bot.queueMsg(
          `⚠️ Comb candle watcher error (will retry next interval): ${error instanceof Error ? error.message : String(error)}`
        );
        await new Promise((r) => setTimeout(r, 60_000));
      }
    }
  }
}

export default CombCandleWatcher;
