import BreakoutBot from "./breakout-bot";
import ExchangeService from "@/services/exchange-service/exchange-service";
import { generateImageOfCandlesWithSupportResistance } from "@/utils/image-generator.util";
import TelegramService from "@/services/telegram.service";
import { calculateBreakoutSignal, SignalResult } from "./breakout-helpers";
import { ICandleInfo } from "@/services/exchange-service/exchange-type";
import BigNumber from "bignumber.js";

export interface ISignalData {
  signalImageData: Buffer;
  signalResult: SignalResult;
  closePrice: number;
}

interface IPriceTick {
  price: number;
  timestamp: number;
}

class BBTrendWatcher {
  isTrendWatcherStarted: boolean = false;
  private websocketTicks: IPriceTick[] = [];
  // private priceListenerRemover?: () => void;
  private readonly CLEANUP_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

  constructor(private bot: BreakoutBot) { }

  async startWatchBreakoutSignals() {
    if (this.isTrendWatcherStarted) return;
    this.isTrendWatcherStarted = true;

    // Subscribe to websocket price updates with timestamps
    ExchangeService.hookPriceListenerWithTimestamp(
      this.bot.symbol,
      (price: number, timestamp: number) => {
        this.websocketTicks.push({ price, timestamp });
        this._cleanupOldTicks();
      }
    );

    while (true) {
      if (this.bot.isSleeping) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      if (this.bot.connectedClientsAmt === 0) {
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
      
      if (candles.length < minRequired) {
        TelegramService.queueMsg(`⚠️ Not enough candles (${candles.length}) for signal calculation. Need at least ${minRequired}. Waiting...`);
        await this._waitForNextCheck(this.bot.checkIntervalMinutes);
        continue;
      }

      // Build synthetic candle from websocket ticks and append to candles
      const candlesWithSynthetic = this._buildCandlesWithSynthetic(candles);

      const signalResult = calculateBreakoutSignal(candlesWithSynthetic, this.bot.signalParams);
      
      // Halve support/resistance distance from current price
      const currentPrice = candlesWithSynthetic[candlesWithSynthetic.length - 1].closePrice;
      let adjustedSupport = signalResult.support;
      let adjustedResistance = signalResult.resistance;
      
      if (signalResult.resistance !== null) {
        // New resistance = currentPrice + (originalResistance - currentPrice) / 2
        const distance = new BigNumber(signalResult.resistance).minus(currentPrice).div(2);
        adjustedResistance = new BigNumber(currentPrice).plus(distance).toNumber();
      }
      
      if (signalResult.support !== null) {
        // New support = currentPrice - (currentPrice - originalSupport) / 2
        const distance = new BigNumber(currentPrice).minus(signalResult.support).div(2);
        adjustedSupport = new BigNumber(currentPrice).minus(distance).toNumber();
      }
      
      // Generate chart with adjusted support/resistance lines
      const signalImageData = await generateImageOfCandlesWithSupportResistance(
        this.bot.symbol,
        candlesWithSynthetic,
        adjustedSupport,
        adjustedResistance,
        false,
        candlesEndDate,
        this.bot.currActivePosition
      );

      const signalData: ISignalData = {
        signalImageData,
        signalResult,
        closePrice: currentPrice,
      };

      // Send visualization to Telegram
      TelegramService.queueMsg(signalImageData);
      TelegramService.queueMsg(
        `ℹ️ Breakout signal check result: ${signalResult.signal} - Price: ${signalData.closePrice.toFixed(4)}\n` +
        `Support: ${adjustedSupport !== null ? adjustedSupport.toFixed(4) : 'N/A'}\n` +
        `Resistance: ${adjustedResistance !== null ? adjustedResistance.toFixed(4) : 'N/A'}`
      );

      // Update bot's current signal levels with adjusted values
      this.bot.currentSignal = signalResult.signal;
      this.bot.currentSupport = adjustedSupport;
      this.bot.currentResistance = adjustedResistance;
      this.bot.lastSRUpdateTime = Date.now(); // Track when S/R was updated

      await this._waitForNextCheck(this.bot.checkIntervalMinutes);
    }
  }

  private readonly SAFETY_BUFFER_MS = 10;
  private async _waitForNextCheck(delayInMin: number) {
    const now = new Date();

    const nextIntervalCheckMinutes = new Date(now.getTime());
    nextIntervalCheckMinutes.setSeconds(0, this.SAFETY_BUFFER_MS);

    if (now.getSeconds() > 0 || now.getMilliseconds() > this.SAFETY_BUFFER_MS) nextIntervalCheckMinutes.setMinutes(now.getMinutes() + delayInMin);
    const waitInMs = nextIntervalCheckMinutes.getTime() - now.getTime();

    await new Promise(r => setTimeout(r, waitInMs));
  }

  /**
   * Build synthetic candle from websocket ticks and append to queried candles
   * Synthetic candle represents the current incomplete minute
   */
  private _buildCandlesWithSynthetic(candles: ICandleInfo[]): ICandleInfo[] {
    if (candles.length === 0) return candles;

    const latestCandle = candles[candles.length - 1];
    // For 1Min candles, closeTime is timestamp + 60000ms (1 minute)
    const latestCandleCloseTime = latestCandle.timestamp + 60000;

    // Filter ticks that occurred after the latest candle's closeTime
    const relevantTicks = this.websocketTicks.filter(tick => tick.timestamp >= latestCandleCloseTime);

    // If no relevant ticks, return original candles
    if (relevantTicks.length === 0) {
      return candles;
    }

    // Build synthetic candle
    const prices = relevantTicks.map(tick => tick.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const latestTick = relevantTicks[relevantTicks.length - 1];

    const syntheticCandle: ICandleInfo = {
      timestamp: latestCandleCloseTime,
      openPrice: latestCandle.closePrice,
      lowPrice: minPrice,
      highPrice: maxPrice,
      closePrice: latestTick.price,
    };

    // Clean up ticks that are older than the latest candle's closeTime
    this._cleanupTicksBefore(latestCandleCloseTime);

    return [...candles, syntheticCandle];
  }

  /**
   * Clean up ticks older than the specified timestamp
   */
  private _cleanupTicksBefore(timestamp: number): void {
    this.websocketTicks = this.websocketTicks.filter(tick => tick.timestamp >= timestamp);
  }

  /**
   * Clean up old ticks to prevent memory growth
   * Removes ticks older than CLEANUP_WINDOW_MS
   */
  private _cleanupOldTicks(): void {
    const now = Date.now();
    const cutoffTime = now - this.CLEANUP_WINDOW_MS;
    this.websocketTicks = this.websocketTicks.filter(tick => tick.timestamp >= cutoffTime);
  }
}

export default BBTrendWatcher;

