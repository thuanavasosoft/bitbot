import ExchangeService from "@/services/exchange-service/exchange-service";
import { withRetries, isTransientError } from "./comb-retry";
import { generateImageOfCandlesWithSupportResistance } from "@/utils/image-generator.util";
import { calculateBreakoutSignal } from "./comb-backtest";
import { COMB_DEFAULT_SIGNAL_PARAMS } from "./comb-utils";
import BigNumber from "bignumber.js";
import { ICandleInfo } from "@/services/exchange-service/exchange-type";
import type CombBotInstance from "./comb-bot-instance";

/** Delay in ms after the minute mark before running each candle watcher iteration (e.g. 500 => 00:01:00.500). */
const CANDLE_WATCHER_DELAY_AFTER_MINUTE_MS = 500;

class CombCandleWatcher {
  isCandleWatcherStarted = false;

  constructor(private bot: CombBotInstance) { }

  /** Generate and send the price chart (support/resistance, trail stop, etc.) to the instance channel. */
  async refreshChart(): Promise<void> {
    try {
      const now = new Date();
      await this.bot.tmobCandles.ensurePopulated();
      now.setSeconds(0);
      now.setMilliseconds(0);
      let currCandles = await this.bot.tmobCandles.getCandles(
        new Date(now.getTime() - (this.bot.nSignal + 1) * 60 * 1000),
        now
      );
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
        this.bot.longTrigger = new BigNumber(rawResistance)
          .times(bufferMultiplier)
          .decimalPlaces(this.bot.pricePrecision, BigNumber.ROUND_DOWN)
          .toNumber();
      } else {
        this.bot.longTrigger = null;
      }
      if (rawSupport !== null) {
        const bufferMultiplier = new BigNumber(1).plus(this.bot.triggerBufferPercentage / 100);
        this.bot.shortTrigger = new BigNumber(rawSupport)
          .times(bufferMultiplier)
          .decimalPlaces(this.bot.pricePrecision, BigNumber.ROUND_UP)
          .toNumber();
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
          label: "[CombCandleWatcher] refreshChart generateImage",
          retries: 3,
          minDelayMs: 2000,
          isTransientError,
          onRetry: ({ attempt, delayMs, error, label }) =>
            console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
        }
      );
      this.bot.queueMsg(signalImageData);

      const currentPrice = currCandles[currCandles.length - 1].closePrice;
      const effectiveMult = this.bot.temporaryTrailMultiplier ?? this.bot.trailingStopMultiplier;
      const trailingMsg =
        trailingStopRaw !== null || trailingStopBuffered !== null
          ? `\nTrail Stop (raw): ${trailingStopRaw !== null ? trailingStopRaw : "N/A"}\nTrail Stop (buffered): ${trailingStopBuffered !== null ? trailingStopBuffered : "N/A"}`
          : "";
      const paramsMsg =
        `\nTrailing ATR Length: ${this.bot.trailingAtrLength} (fixed)` +
        `\nTrailing Multiplier: ${effectiveMult}${this.bot.temporaryTrailMultiplier != null ? " (temp)" : ""}`;
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
      const closedIndicator = this.bot.justManuallyClosedByTg ? "\n⚠️ [has been closed via /close_pos]" : "";

      const rocVal = signalResult.roc != null ? `${(signalResult.roc * 100).toFixed(4)}%` : "N/A";
      this.bot.queueMsg(
        `ℹ️ Price: ${currentPrice}\n` +
        `ROC Val: ${rocVal}\n` +
        `Resistance: ${rawResistance !== null ? rawResistance : "N/A"}\nLong Trigger: ${this.bot.longTrigger !== null ? this.bot.longTrigger : "N/A"}\n` +
        `Support: ${rawSupport !== null ? rawSupport : "N/A"}\nShort Trigger: ${this.bot.shortTrigger !== null ? this.bot.shortTrigger : "N/A"}${trailingMsg}${paramsMsg}${optimizationAgeMsg}${closedIndicator}`
      );
      this.bot.lastSRUpdateTime = Date.now();
    } catch (err) {
      this.bot.queueMsg(
        `⚠️ Failed to refresh chart: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async startWatchingCandles() {
    if (this.isCandleWatcherStarted) return;
    this.isCandleWatcherStarted = true;
    this.bot.queueMsg("🔍 Starting CombCandleWatcher");
    try {
      while (!this.bot.isStopped) {
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
            this.bot.longTrigger = longTriggerRaw
              .decimalPlaces(this.bot.pricePrecision, BigNumber.ROUND_DOWN)
              .toNumber();
          } else {
            this.bot.longTrigger = null;
          }
          if (rawSupport !== null) {
            const bufferMultiplier = new BigNumber(1).plus(this.bot.triggerBufferPercentage / 100);
            const shortTriggerRaw = new BigNumber(rawSupport).times(bufferMultiplier);
            this.bot.shortTrigger = shortTriggerRaw
              .decimalPlaces(this.bot.pricePrecision, BigNumber.ROUND_UP)
              .toNumber();
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
          const trailingMsg =
            trailingStopRaw !== null || trailingStopBuffered !== null
              ? `\nTrail Stop (raw): ${trailingStopRaw !== null ? trailingStopRaw : "N/A"}\nTrail Stop (buffered): ${trailingStopBuffered !== null ? trailingStopBuffered : "N/A"}`
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
          const effectiveMult = this.bot.temporaryTrailMultiplier ?? this.bot.trailingStopMultiplier;
          const paramsMsg =
            `\nTrailing ATR Length: ${this.bot.trailingAtrLength} (fixed)` +
            `\nTrailing Multiplier: ${effectiveMult}${this.bot.temporaryTrailMultiplier != null ? " (temp)" : ""}`;
          const closedIndicator = this.bot.justManuallyClosedByTg ? "\n⚠️ [has been closed via /close_pos]" : "";
          const rocVal = signalResult.roc != null ? `${(signalResult.roc * 100).toFixed(2)}%` : "N/A";

          this.bot.queueMsg(
            `ℹ️ Price: ${currentPrice}\n` +
            `ROC Val: ${rocVal}\n` +
            `Resistance: ${rawResistance !== null ? rawResistance : "N/A"}\nLong Trigger: ${this.bot.longTrigger !== null ? this.bot.longTrigger : "N/A"}\n` +
            `Support: ${rawSupport !== null ? rawSupport : "N/A"}\nShort Trigger: ${this.bot.shortTrigger !== null ? this.bot.shortTrigger : "N/A"}${trailingMsg}${paramsMsg}${optimizationAgeMsg}${closedIndicator}`
          );

          this.bot.lastSRUpdateTime = Date.now();

          const nowMs = Date.now();
          const nextMinuteStartMs = (Math.floor(nowMs / 60_000) + 1) * 60_000;
          const targetMs = nextMinuteStartMs + CANDLE_WATCHER_DELAY_AFTER_MINUTE_MS;
          const delayMs = targetMs - nowMs;
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        } catch (error) {
          if (this.bot.isStopped) break;
          console.error("[COMB] Candle watcher iteration error:", error);
          this.bot.queueMsg(
            `⚠️ Comb candle watcher error (will retry next interval): ${error instanceof Error ? error.message : String(error)}`
          );
          await new Promise((r) => setTimeout(r, 60_000));
        }
      }
    } finally {
      this.isCandleWatcherStarted = false;
    }
  }
}

export default CombCandleWatcher;
