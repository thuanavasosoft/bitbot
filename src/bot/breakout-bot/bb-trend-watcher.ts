import BreakoutBot from "./breakout-bot";
import ExchangeService from "@/services/exchange-service/exchange-service";
import { generateImageOfCandlesWithSupportResistance } from "@/utils/image-generator.util";
import TelegramService from "@/services/telegram.service";
import { calculateBreakoutSignal, SignalResult } from "./breakout-helpers";

export interface ISignalData {
  signalImageData: Buffer;
  signalResult: SignalResult;
  closePrice: number;
}

class BBTrendWatcher {
  isTrendWatcherStarted: boolean = false;

  constructor(private bot: BreakoutBot) { }

  async startWatchBreakoutSignals() {
    if (this.isTrendWatcherStarted) return;
    this.isTrendWatcherStarted = true;

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

      const signalResult = calculateBreakoutSignal(candles, this.bot.signalParams);
      
      // Generate chart with support/resistance lines
      const signalImageData = await generateImageOfCandlesWithSupportResistance(
        this.bot.symbol,
        candles,
        signalResult.support,
        signalResult.resistance,
        false,
        candlesEndDate,
        this.bot.currActivePosition
      );

      const signalData: ISignalData = {
        signalImageData,
        signalResult,
        closePrice: candles[candles.length - 1].closePrice,
      };

      // Send visualization to Telegram
      TelegramService.queueMsg(signalImageData);
      TelegramService.queueMsg(
        `ℹ️ Breakout signal check result: ${signalResult.signal} - Price: ${signalData.closePrice.toFixed(4)}\n` +
        `Support: ${signalResult.support !== null ? signalResult.support.toFixed(4) : 'N/A'}\n` +
        `Resistance: ${signalResult.resistance !== null ? signalResult.resistance.toFixed(4) : 'N/A'}`
      );

      // Update bot's current signal levels
      this.bot.currentSignal = signalResult.signal;
      this.bot.currentSupport = signalResult.support;
      this.bot.currentResistance = signalResult.resistance;

      await this._waitForNextCheck(this.bot.checkIntervalMinutes);
    }
  }

  private async _waitForNextCheck(delayInMin: number) {
    const now = new Date();

    const nextIntervalCheckMinutes = new Date(now.getTime());
    nextIntervalCheckMinutes.setSeconds(0, 0);

    if (now.getSeconds() > 0 || now.getMilliseconds() > 0) nextIntervalCheckMinutes.setMinutes(now.getMinutes() + delayInMin);
    const waitInMs = nextIntervalCheckMinutes.getTime() - now.getTime();

    await new Promise(r => setTimeout(r, waitInMs));
  }
}

export default BBTrendWatcher;

