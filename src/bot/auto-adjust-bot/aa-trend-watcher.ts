import AutoAdjustBot from "./auto-adjust-bot";
import ExchangeService from "@/services/exchange-service/exchange-service";
import TelegramService from "@/services/telegram.service";
import { calculateBreakoutSignal, SignalResult } from "./breakout-helpers";
import { normalizeCandles } from "./candle-utils";
import BigNumber from "bignumber.js";
import { generateImageOfCandlesWithSupportResistance } from "@/utils/image-generator.util";
import { isTransientError, withRetries } from "../breakout-bot/bb-retry";

export interface ISignalData {
  signalImageData: Buffer;
  signalResult: SignalResult;
  closePrice: number;
}

class AATrendWatcher {
  isTrendWatcherStarted: boolean = false;

  constructor(private bot: AutoAdjustBot) {}

  async startWatchBreakoutSignals() {
    if (this.isTrendWatcherStarted) return;
    this.isTrendWatcherStarted = true;

    while (true) {
      try {
        const candlesEndDate = new Date();
        const minRequired = Math.max(
          (this.bot.signalParams.N || 2) + 1,
          this.bot.signalParams.atr_len || 14,
          this.bot.signalParams.K || 5,
          this.bot.signalParams.ema_period || 10
        );
        const lookbackHours = Math.max(1, Math.ceil((minRequired * this.bot.checkIntervalMinutes) / 60));
        const candlesStartDate = new Date(candlesEndDate.getTime() - (lookbackHours * 60 * 60 * 1000));

        const candles = await withRetries(
          () => ExchangeService.getCandles(this.bot.symbol, candlesStartDate, candlesEndDate, "1Min"),
          {
            label: "[AATrendWatcher] getCandles",
            retries: 5,
            minDelayMs: 5000,
            isTransientError,
            onRetry: ({ attempt, delayMs, error, label }) => {
              console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
            },
          }
        );

        const now = Date.now();
        const oneMinuteAgo = now - 60 * 1000;
        const finishedCandles = candles.filter(candle => candle.timestamp < oneMinuteAgo);

        if (finishedCandles.length < minRequired) {
          TelegramService.queueMsg(
            `⚠️ Not enough finished candles (${finishedCandles.length}) for signal calculation. Need at least ${minRequired}. Waiting...`
          );
          await this._waitForNextCheck(this.bot.checkIntervalMinutes);
          continue;
        }

        const normalizedCandles = normalizeCandles(finishedCandles);
        if (!normalizedCandles.length) {
          await this._waitForNextCheck(this.bot.checkIntervalMinutes);
          continue;
        }

        const signalResult = calculateBreakoutSignal(normalizedCandles, this.bot.signalParams);
        const currentPrice = normalizedCandles[normalizedCandles.length - 1].close;
        const rawSupport = signalResult.support;
        const rawResistance = signalResult.resistance;

        let trailingStopRaw: number | null = null;
        let trailingStopBuffered: number | null = null;

        let longTrigger: number | null = null;
        let shortTrigger: number | null = null;

        const pricePrecision = this.bot.pricePrecision ?? this.bot.symbolInfo?.pricePrecision ?? 0;

        if (rawResistance !== null) {
          const bufferMultiplier = new BigNumber(1).minus(this.bot.bufferPercentage);
          const longTriggerRaw = new BigNumber(rawResistance).times(bufferMultiplier);
          const multiplier = Math.pow(10, pricePrecision);
          longTrigger = Math.floor(longTriggerRaw.times(multiplier).toNumber()) / multiplier;
        }

        if (rawSupport !== null) {
          const bufferMultiplier = new BigNumber(1).plus(this.bot.bufferPercentage);
          const shortTriggerRaw = new BigNumber(rawSupport).times(bufferMultiplier);
          const multiplier = Math.pow(10, pricePrecision);
          shortTrigger = Math.ceil(shortTriggerRaw.times(multiplier).toNumber()) / multiplier;
        }

        const trailingTargets = this.bot.trailingStopTargets;
        if (
          trailingTargets &&
          this.bot.currActivePosition &&
          trailingTargets.side === this.bot.currActivePosition.side
        ) {
          trailingStopRaw = trailingTargets.rawLevel;
          trailingStopBuffered = trailingTargets.bufferedLevel;
        }

        const signalImageData = await withRetries(
          () =>
            generateImageOfCandlesWithSupportResistance(
              this.bot.symbol,
              finishedCandles,
              rawSupport,
              rawResistance,
              false,
              candlesEndDate,
              this.bot.currActivePosition,
              longTrigger,
              shortTrigger,
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

        const signalData: ISignalData = {
          signalImageData,
          signalResult,
          closePrice: currentPrice,
        };

        TelegramService.queueMsg(signalImageData);
        const triggerMsg = longTrigger !== null || shortTrigger !== null
          ? `\nLong Trigger: ${longTrigger !== null ? longTrigger.toFixed(4) : "N/A"}\nShort Trigger: ${shortTrigger !== null ? shortTrigger.toFixed(4) : "N/A"}`
          : "";
        const trailingMsg = trailingStopRaw !== null || trailingStopBuffered !== null
          ? `\nTrail Stop (raw): ${trailingStopRaw !== null ? trailingStopRaw.toFixed(4) : "N/A"}\nTrail Stop (buffered): ${trailingStopBuffered !== null ? trailingStopBuffered.toFixed(4) : "N/A"}`
          : "";
        const optimizationAgeMsg = this.bot.lastOptimizationAtMs > 0
          ? (() => {
              const totalMinutes = Math.floor((Date.now() - this.bot.lastOptimizationAtMs) / 60000);
              const hours = Math.floor(totalMinutes / 60);
              const minutes = totalMinutes % 60;
              return `\nLast optimized: ${hours}h${minutes}m`;
            })()
          : `\nLast optimized: N/A`;
        const paramsMsg =
          `\nTrailing ATR Length: ${this.bot.trailingAtrLength}` +
          `\nTrailing Multiplier: ${this.bot.trailingStopMultiplier}`;
        TelegramService.queueMsg(
          `ℹ️ Price: ${signalData.closePrice.toFixed(4)}\n` +
          `Support: ${rawSupport !== null ? rawSupport.toFixed(4) : "N/A"}\n` +
          `Resistance: ${rawResistance !== null ? rawResistance.toFixed(4) : "N/A"}${triggerMsg}${trailingMsg}${paramsMsg}${optimizationAgeMsg}`
        );

        this.bot.currentSignal = signalResult.signal;
        this.bot.currentSupport = rawSupport;
        this.bot.currentResistance = rawResistance;
        this.bot.longTrigger = longTrigger;
        this.bot.shortTrigger = shortTrigger;
        this.bot.lastSRUpdateTime = Date.now();

        await this._waitForNextCheck(this.bot.checkIntervalMinutes);
      } catch (error) {
        console.error("[AATrendWatcher] Failed to process breakout signal iteration:", error);
        TelegramService.queueMsg(
          `⚠️ Auto-adjust signal watcher error (will retry next interval): ${error instanceof Error ? error.message : String(error)}`
        );
        await this._waitForNextCheck(this.bot.checkIntervalMinutes);
      }
    }
  }

  private async _waitForNextCheck(delayInMin: number) {
    const now = new Date();
    const nextIntervalCheckMinutes = new Date(now.getTime());
    nextIntervalCheckMinutes.setSeconds(this.bot.intervalDelaySeconds, 0);

    if (now.getSeconds() >= this.bot.intervalDelaySeconds) {
      nextIntervalCheckMinutes.setMinutes(now.getMinutes() + delayInMin);
    }

    const waitInMs = nextIntervalCheckMinutes.getTime() - now.getTime();
    await new Promise(r => setTimeout(r, waitInMs));
  }
}

export default AATrendWatcher;
