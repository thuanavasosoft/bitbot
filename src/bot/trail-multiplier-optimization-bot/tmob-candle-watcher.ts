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
      const now = new Date();
      if (!this.candleBuffer) {
        const rawCandles = await ExchangeService.getCandles(this.bot.symbol, new Date(now.getTime() - 60_000 - this.bot.nSignal * 60 * 1000), now, "1Min");
        const candles = rawCandles.filter((c): c is ICandleInfo => c != null && c.openTime != null);
        if (candles.length === 0) throw new Error("getCandles returned no valid candles");
        console.log("candles length: ", candles.length);
        console.log("candles[0]: ", candles[0]);
        this.candleBuffer = RingBuffer.fromArray(candles);
      } else {
        const currCandles = this.candleBuffer.toArray();
        const lastCurrCandle = currCandles[currCandles.length - 1];
        const lastCandleCloseTimeTime = new Date(lastCurrCandle.closeTime);
        const timeDiff = now.getTime() - lastCandleCloseTimeTime.getTime();
        console.log("lastCandleCloseTimeTime: ", lastCandleCloseTimeTime);
        console.log("now: ", now);
        console.log("timeDiff: ", timeDiff);

        const waitTime = 60_000 - timeDiff;
        console.log("waitTime: ", waitTime);

        if (timeDiff < 60_000) await new Promise(r => setTimeout(r, waitTime));

        // Add the new candle via ring buffer (O(1), overwrites oldest)
        const newLastCandles = await ExchangeService.getCandles(this.bot.symbol, lastCandleCloseTimeTime, now, "1Min");
        console.log("newLastCandles: ", newLastCandles);

        const newCandle = newLastCandles.filter((c): c is ICandleInfo => c != null && c.openTime != null).pop();
        if (newCandle) this.candleBuffer.push(newCandle);
      }
      const currCandles = this.candleBuffer.toArray();
      console.log("currCandles length: ", currCandles.length);
      console.log("currCandles[currCandles.length - 1].timestamp: ", currCandles[currCandles.length - 1].closeTime);
      console.log("=======================================");
      const signalResult = calculateBreakoutSignal(currCandles, TMOB_DEFAULT_SIGNAL_PARAMS);
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

      // Delay until next minute at 0 seconds before next iteration
      const nowMs = Date.now();
      const nextMinuteStartMs = (Math.floor(nowMs / 60_000) + 1) * 60_000;
      const delayMs = nextMinuteStartMs - nowMs;
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export default TMOBCandleWatcher;