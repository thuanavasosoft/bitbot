import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import TrailMultiplierOptimizationBot, { TMOBState } from "../trail-multiplier-optimization-bot";
import ExchangeService from "@/services/exchange-service/exchange-service";
import BigNumber from "bignumber.js";
import TelegramService from "@/services/telegram.service";
import { toIso } from "@/bot/auto-adjust-bot/candle-utils";

class TMOBStartingState implements TMOBState {
  constructor(private bot: TrailMultiplierOptimizationBot) { }

  private async _updateBotStartBalances() {
    const exchFreeUsdtBalance = await this.bot.tmobUtils.getExchFreeUsdtBalance();

    if (exchFreeUsdtBalance.lt(this.bot.margin)) {
      const msg = `Exchange free balance (${exchFreeUsdtBalance}) is less than the margin size: ${this.bot.margin} stopping bot`;
      console.error(msg);
      throw new Error(msg);
    }

    this.bot.startQuoteBalance = exchFreeUsdtBalance.decimalPlaces(4, BigNumber.ROUND_DOWN).toString();
  }

  async updateBotCurrentBalances() {
    const exchFreeUsdtBalance = await this.bot.tmobUtils.getExchFreeUsdtBalance();

    if (exchFreeUsdtBalance.lt(this.bot.margin)) {
      const msg = `Exchange free balance (${exchFreeUsdtBalance}) is less than the margin size: ${this.bot.margin} stopping bot`;
      console.error(msg);
      throw new Error(msg);
    }

    this.bot.currQuoteBalance = exchFreeUsdtBalance.decimalPlaces(4, BigNumber.ROUND_DOWN).toString();
  }

  private async _updateLeverage() {
    const msg = `Updating leverage of ${this.bot.symbol} to X${this.bot.leverage}...`;
    console.log(msg);
    TelegramService.queueMsg(msg);

    await ExchangeService.setLeverage(this.bot.symbol, this.bot.leverage);
    TelegramService.queueMsg("Leverage updated successfully");
  }

  async onEnter() {
    console.log("Starting TMOBStartingState");

    await Promise.all([
      (!this.bot.startQuoteBalance) && this._updateBotStartBalances(),
      (!this.bot.currQuoteBalance) && this.updateBotCurrentBalances(),
      this._updateLeverage(),
      this.bot.loadSymbolInfo(),
    ]);

    // Initial optimization if needed
    if (this.bot.currTrailMultiplier === undefined) {
      await this.bot.tmobUtils.updateCurrTrailMultiplier();
      if (this.bot.currTrailMultiplier !== undefined) {
        this.bot.trailingStopMultiplier = this.bot.currTrailMultiplier;

        const intervalMs = this.bot.updateIntervalMinutes * 60_000;
        // This is will be 1 second more of the minute mark handled on tmob optimization loop
        const nextOptimizationMs = this.bot.lastOptimizationAtMs + intervalMs + 1000;
        TelegramService.queueMsg(
          `🧠 Initial optimization complete\n` +
          `Trailing ATR Length: ${this.bot.trailingAtrLength} (fixed)\n` +
          `Trailing Multiplier: ${this.bot.trailingStopMultiplier}\n` +
          `Next optimization: ${toIso(nextOptimizationMs)}`
        );
      }
    }

    // Start optimization loop
    this.bot.startOptimizationLoop();

    // Start candle watcher if not started
    if (!this.bot.tmobCandleWatcher.isCandleWatcherStarted) {
      void this.bot.tmobCandleWatcher.startWatchingCandles().catch((error) => {
        console.error("[TMOBStartingState] Candle watcher crashed:", error);
        TelegramService.queueMsg(`⚠️ Candle watcher crashed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }

    this.bot.runStartTs = new Date();
    TelegramService.queueMsg("⚙️ Starting Trail Multiplier Optimization Bot");

    const msg = `
🟢 TRAIL MULTIPLIER OPTIMIZATION BOT STARTED
Start time: ${toIso(this.bot.runStartTs.getTime())}
Symbol: ${this.bot.symbol}
Leverage: X${this.bot.leverage}
Margin size: ${this.bot.margin} USDT
Trigger buffer percentage: ${this.bot.triggerBufferPercentage}%
Trail confirm bars: ${this.bot.trailConfirmBars}

Optimization window: ${this.bot.optimizationWindowMinutes} minutes
Update interval: ${this.bot.updateIntervalMinutes} minutes

N signal: ${this.bot.nSignal}
Trailing ATR length: ${this.bot.trailingAtrLength} (fixed)
Trail multiplier bounds: ${this.bot.trailMultiplierBounds.min} to ${this.bot.trailMultiplierBounds.max}
Current trail multiplier: ${this.bot.trailingStopMultiplier}

Start Quote Balance (100%): ${this.bot.startQuoteBalance} USDT
Current Quote Balance (100%): ${this.bot.currQuoteBalance} USDT
`;

    console.log(msg);
    TelegramService.queueMsg(msg);

    console.log("Emitting state change");
    eventBus.emit(EEventBusEventType.StateChange);
  }

  async onExit() {
    console.log("Exiting TMOBStartingState");
  }
}

export default TMOBStartingState;