import ExchangeService from "@/services/exchange-service/exchange-service";
import TelegramService from "@/services/telegram.service";
import { generateImageOfCandlesWithSupportResistance } from "@/utils/image-generator.util";
import { withRetries, isTransientError } from "../breakout-bot/bb-retry";
import { calculateBreakoutSignal } from "./tmob-backtest";
import { TMOB_DEFAULT_SIGNAL_PARAMS } from "./tmob-utils";
import TrailMultiplierOptimizationBot from "./trail-multiplier-optimization-bot";
import BigNumber from "bignumber.js";
import { ICandleInfo } from "@/services/exchange-service/exchange-type";
import { Candle } from "../auto-adjust-bot/types";

/** Delay in ms after the minute mark before running each candle watcher iteration (e.g. 500 => 00:01:00.500). */
const CANDLE_WATCHER_DELAY_AFTER_MINUTE_MS = 500;

class TMOBCandleWatcher {
  isCandleWatcherStarted: boolean = false;

  constructor(private bot: TrailMultiplierOptimizationBot) { }

  async startWatchingCandles() {
    if (this.isCandleWatcherStarted) return;
    this.isCandleWatcherStarted = true;

    console.log("Starting TMOBCandleWatcher");
    TelegramService.queueMsg("🔍 Starting TMOBCandleWatcher");

    while (true) {
      try {
        const now = new Date();
        await this.bot.tmobCandles.ensurePopulated();

        now.setSeconds(0);
        now.setMilliseconds(0);
        const currCandles = await this.bot.tmobCandles.getCandles(new Date(now.getTime() - (this.bot.nSignal + (1)) * 60 * 1000), now);
        if (currCandles.length <= this.bot.nSignal) {
          console.log("Not enough candles to calculate signal, sometimes the exchange not returning correct candles like comment on the next line of this console log line:");
          /**
           * Sometimes this is happened
           * ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
           *  [BINANCE] serverTime:  2026-02-13T12:58:00.134Z
           *  [BINANCE] candles fetchStart:  2026-02-13T12:55:00.000Z
           *  [BINANCE] candles endTime:  2026-02-13T12:58:00.002Z
           *  [BINANCE] fetched candles:  2
           *  [BINANCE] fetched candles[0].openTime:  2026-02-13T12:55:00.000Z
           *  [BINANCE] fetched candles[last].openTime:  2026-02-13T12:56:00.000Z // 12:57 not returned by binance
           * ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
           */
          console.log("Hacky fix is using curr mark price as candle, this is extremely rarely happened, but it's a valid fix for now, next minute will be fixed");
          const currMarkPrice = await ExchangeService.getMarkPrice(this.bot.symbol);
          const hackCandle: ICandleInfo = {
            timestamp: now.getTime(),
            openTime: now.getTime(),
            closeTime: now.getTime(),
            openPrice: currMarkPrice,
            highPrice: currMarkPrice,
            lowPrice: currMarkPrice,
            closePrice: currMarkPrice,
            volume: 0,
          }
          currCandles.push(hackCandle);
        }

        const signalParams = { ...TMOB_DEFAULT_SIGNAL_PARAMS, N: this.bot.nSignal };
        const signalCandles: Candle[] = currCandles.map((c) => ({
          openTime: c.openTime,
          closeTime: c.closeTime,
          open: c.openPrice,
          high: c.highPrice,
          low: c.lowPrice,
          close: c.closePrice,
          volume: c.volume,
        }));
        const signalResult = calculateBreakoutSignal(signalCandles, signalParams);
        if (signalResult.support === null && signalResult.resistance === null) {
          process.exit(0);
        }

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
          ? `\nLong Trigger: ${this.bot.longTrigger !== null ? this.bot.longTrigger : "N/A"}\nShort Trigger: ${this.bot.shortTrigger !== null ? this.bot.shortTrigger : "N/A"}`
          : "";
        const trailingMsg = trailingStopRaw !== null || trailingStopBuffered !== null
          ? `\nTrail Stop (raw): ${trailingStopRaw !== null ? trailingStopRaw : "N/A"}\nTrail Stop (buffered): ${trailingStopBuffered !== null ? trailingStopBuffered : "N/A"}`
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
          `ℹ️ Price: ${currentPrice}\n` +
          `Support: ${rawSupport !== null ? rawSupport : "N/A"}\n` +
          `Resistance: ${rawResistance !== null ? rawResistance : "N/A"}${triggerMsg}${trailingMsg}${paramsMsg}${optimizationAgeMsg}`
        );

        this.bot.lastSRUpdateTime = Date.now();

        // Delay until 500ms after next minute mark before next iteration
        const nowMs = Date.now();
        const nextMinuteStartMs = (Math.floor(nowMs / 60_000) + 1) * 60_000;
        const targetMs = nextMinuteStartMs + CANDLE_WATCHER_DELAY_AFTER_MINUTE_MS;
        const delayMs = targetMs - nowMs;
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