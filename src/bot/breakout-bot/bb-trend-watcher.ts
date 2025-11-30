import BreakoutBot from "./breakout-bot";
import ExchangeService from "@/services/exchange-service/exchange-service";
import { generateImageOfCandlesWithSupportResistance } from "@/utils/image-generator.util";
import TelegramService from "@/services/telegram.service";
import { calculateBreakoutSignal, SignalResult } from "./breakout-helpers";
import BigNumber from "bignumber.js";

export interface ISignalData {
  signalImageData: Buffer;
  signalResult: SignalResult;
  closePrice: number;
}

class BBTrendWatcher {
  isTrendWatcherStarted: boolean = false;
  private readonly intervalDelaySeconds: number;

  constructor(private bot: BreakoutBot) {
    this.intervalDelaySeconds = Number(process.env.BREAKOUT_BOT_INTERVAL_DELAY_SECONDS || 1);
  }

  async startWatchBreakoutSignals() {
    if (this.isTrendWatcherStarted) return;
    this.isTrendWatcherStarted = true;

    while (true) {
      if (this.bot.isSleeping) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      if (this.bot.connectedClientsAmt === 0 && process.env.EXCHANGE_ADAPTER === "1") {
        TelegramService.queueMsg("❗ No clients connected yet, waiting for client to be connected to continue...");

        while (true) {
          if (this.bot.connectedClientsAmt > 0) {
            TelegramService.queueMsg("✅ Client connected, continuing to wait for signal...");
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before checking again
        }
      }

      const candlesEndDate = new Date();
      // Calculate lookback window: need enough candles for signal calculation
      const minRequired = Math.max(
        (this.bot.signalParams.N || 2) + 1,
        this.bot.signalParams.atr_len || 14,
        this.bot.signalParams.K || 5,
        this.bot.signalParams.ema_period || 10
      );
      // Fetch extra candles for safety (at least 50 candles or 2x minRequired)
      const lookbackHours = Math.max(1, Math.ceil((minRequired * this.bot.checkIntervalMinutes) / 60));
      const candlesStartDate = new Date(candlesEndDate.getTime() - (lookbackHours * 60 * 60 * 1000));

      const candles = await ExchangeService.getCandles(this.bot.symbol, candlesStartDate, candlesEndDate, "1Min");
      
      // Filter out unfinished candles (timestamp is startTime, so if latest candle started within last minute, exclude it)
      const now = Date.now();
      const oneMinuteAgo = now - 60 * 1000;
      const finishedCandles = candles.filter(candle => candle.timestamp < oneMinuteAgo);
      
      if (finishedCandles.length < minRequired) {
        TelegramService.queueMsg(`⚠️ Not enough finished candles (${finishedCandles.length}) for signal calculation. Need at least ${minRequired}. Waiting...`);
        await this._waitForNextCheck(this.bot.checkIntervalMinutes);
        continue;
      }

      const signalResult = calculateBreakoutSignal(finishedCandles, this.bot.signalParams);
      
      const currentPrice = finishedCandles[finishedCandles.length - 1].closePrice;
      
      // Use raw support/resistance (no halving)
      const rawSupport = signalResult.support;
      const rawResistance = signalResult.resistance;
      
      let fractionalStopRaw: number | null = null;
      let fractionalStopBuffered: number | null = null;

      // Calculate trigger prices with buffer percentage
      let longTrigger: number | null = null;
      let shortTrigger: number | null = null;
      
      // Helper function to get price precision (decimal places)
      const getPricePrecision = (price: number): number => {
        const priceStr = price.toString();
        if (priceStr.includes('.')) {
          return priceStr.split('.')[1].length;
        }
        return 0;
      };
      
      if (rawResistance !== null) {
        // Long trigger: resistance * (1 - buffer_percentage), rounded UP
        const bufferMultiplier = new BigNumber(1).minus(this.bot.bufferPercentage);
        const longTriggerRaw = new BigNumber(rawResistance).times(bufferMultiplier);
        const precision = getPricePrecision(rawResistance);
        // Round up: add a small epsilon and then round down, or use ceil with precision
        const multiplier = Math.pow(10, precision);
        longTrigger = Math.ceil(longTriggerRaw.times(multiplier).toNumber()) / multiplier;
      }
      
      if (rawSupport !== null) {
        // Short trigger: support * (1 + buffer_percentage), rounded DOWN
        const bufferMultiplier = new BigNumber(1).plus(this.bot.bufferPercentage);
        const shortTriggerRaw = new BigNumber(rawSupport).times(bufferMultiplier);
        const precision = getPricePrecision(rawSupport);
        // Round down: use floor with precision
        const multiplier = Math.pow(10, precision);
        shortTrigger = Math.floor(shortTriggerRaw.times(multiplier).toNumber()) / multiplier;
      }

      if (
        this.bot.currActivePosition &&
        rawSupport !== null &&
        rawResistance !== null &&
        this.bot.fractionalStopLoss > 0
      ) {
        const supportBn = new BigNumber(rawSupport);
        const resistanceBn = new BigNumber(rawResistance);
        const range = resistanceBn.minus(supportBn);
        if (range.gt(0)) {
          const fractionalDistance = range.times(this.bot.fractionalStopLoss);
          const bufferPct = new BigNumber(this.bot.bufferPercentage || 0);
          
          if (this.bot.currActivePosition.side === "long") {
            fractionalStopRaw = resistanceBn.minus(fractionalDistance).toNumber();
            const stopBufferDelta = new BigNumber(fractionalStopRaw).times(bufferPct);
            
            fractionalStopBuffered = new BigNumber(fractionalStopRaw).plus(stopBufferDelta).toNumber();
          } else {
            fractionalStopRaw = supportBn.plus(fractionalDistance).toNumber();
            const stopBufferDelta = new BigNumber(fractionalStopRaw).times(bufferPct);

            fractionalStopBuffered = new BigNumber(fractionalStopRaw).minus(stopBufferDelta).toNumber();
          }
        }
      }
      
      // Generate chart with support/resistance and trigger lines
      const signalImageData = await generateImageOfCandlesWithSupportResistance(
        this.bot.symbol,
        finishedCandles,
        rawSupport,
        rawResistance,
        false,
        candlesEndDate,
        this.bot.currActivePosition,
        longTrigger,
        shortTrigger,
        fractionalStopRaw,
        fractionalStopBuffered
      );

      const signalData: ISignalData = {
        signalImageData,
        signalResult,
        closePrice: currentPrice,
      };

      // Send visualization to Telegram
      TelegramService.queueMsg(signalImageData);
      const triggerMsg = longTrigger !== null || shortTrigger !== null
        ? `\nLong Trigger: ${longTrigger !== null ? longTrigger.toFixed(4) : 'N/A'}\nShort Trigger: ${shortTrigger !== null ? shortTrigger.toFixed(4) : 'N/A'}`
        : '';
      const fractionalMsg = fractionalStopRaw !== null || fractionalStopBuffered !== null
        ? `\nFrac Stop (raw): ${fractionalStopRaw !== null ? fractionalStopRaw.toFixed(4) : 'N/A'}\nFrac Stop (buffered): ${fractionalStopBuffered !== null ? fractionalStopBuffered.toFixed(4) : 'N/A'}`
        : '';
      TelegramService.queueMsg(
        `ℹ️ Breakout signal check result: ${signalResult.signal} - Price: ${signalData.closePrice.toFixed(4)}\n` +
        `Support: ${rawSupport !== null ? rawSupport.toFixed(4) : 'N/A'}\n` +
        `Resistance: ${rawResistance !== null ? rawResistance.toFixed(4) : 'N/A'}${triggerMsg}${fractionalMsg}`
      );

      // Update bot's current signal levels with raw values and triggers
      this.bot.currentSignal = signalResult.signal;
      this.bot.currentSupport = rawSupport;
      this.bot.currentResistance = rawResistance;
      this.bot.longTrigger = longTrigger;
      this.bot.shortTrigger = shortTrigger;
      this.bot.lastSRUpdateTime = Date.now(); // Track when S/R was updated

      await this._waitForNextCheck(this.bot.checkIntervalMinutes);
    }
  }

  private async _waitForNextCheck(delayInMin: number) {
    const now = new Date();

    const nextIntervalCheckMinutes = new Date(now.getTime());
    // Set to the next minute mark with the configured delay in seconds
    nextIntervalCheckMinutes.setSeconds(this.intervalDelaySeconds, 0);

    // If we've already passed the delay second mark in the current minute, move to next minute
    if (now.getSeconds() >= this.intervalDelaySeconds) {
      nextIntervalCheckMinutes.setMinutes(now.getMinutes() + delayInMin);
    }
    
    const waitInMs = nextIntervalCheckMinutes.getTime() - now.getTime();

    await new Promise(r => setTimeout(r, waitInMs));
  }

}

export default BBTrendWatcher;

