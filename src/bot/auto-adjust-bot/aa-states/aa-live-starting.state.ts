import ExchangeService from "@/services/exchange-service/exchange-service";
import TelegramService from "@/services/telegram.service";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import AutoAdjustBot, { AAState } from "../auto-adjust-bot";
import BigNumber from "bignumber.js";

class AALiveStartingState implements AAState {
  constructor(private bot: AutoAdjustBot) {}

  private async _updateBotStartBalances() {
    const exchFreeUsdtBalance = await this.bot.aaUtil!.getExchFreeUsdtBalance();

    if (exchFreeUsdtBalance.lt(this.bot.margin)) {
      const msg = `Exchange free balance (${exchFreeUsdtBalance}) is less than the margin size: ${this.bot.margin} stopping bot`;
      console.error(msg);
      throw new Error(msg);
    }

    this.bot.startQuoteBalance = exchFreeUsdtBalance.decimalPlaces(4, BigNumber.ROUND_DOWN).toString();
  }

  async updateBotCurrentBalances() {
    const exchFreeUsdtBalance = await this.bot.aaUtil!.getExchFreeUsdtBalance();

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
    await Promise.all([
      (!this.bot.startQuoteBalance) && this._updateBotStartBalances(),
      (!this.bot.currQuoteBalance) && this.updateBotCurrentBalances(),
      this._updateLeverage(),
      this.bot.loadSymbolInfo(),
    ]);

    if (!this.bot.lastBestParams) {
      await this.bot.optimizeLiveParams();
      TelegramService.queueMsg(
        `🧠 Initial optimization complete\n` +
        `Trailing ATR Length: ${this.bot.trailingAtrLength}\n` +
        `Trailing Multiplier: ${this.bot.trailingStopMultiplier}`
      );
    }
    this.bot.startOptimizationLoop();

    if (!this.bot.aaTrendWatcher!.isTrendWatcherStarted) {
      void this.bot.aaTrendWatcher!.startWatchBreakoutSignals().catch((error) => {
        console.error("[AALiveStartingState] Trend watcher crashed:", error);
        TelegramService.queueMsg(`⚠️ Trend watcher crashed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }

    TelegramService.queueMsg("⚙️ Starting Auto-Adjust Live Bot");

    const msg = `
🟢 AUTO-ADJUST BOT (LIVE) STARTED
Symbol: ${this.bot.symbol}
Leverage: X${this.bot.leverage}
Margin size: ${this.bot.margin} USDT
Signal check interval: ${this.bot.checkIntervalMinutes} minutes
Optimization window: ${this.bot.optimizationWindowMinutes} minutes

Signal Parameters:
N: ${this.bot.signalParams.N}

Start Quote Balance (100%): ${this.bot.startQuoteBalance} USDT
Current Quote Balance (100%): ${this.bot.currQuoteBalance} USDT
`;
    console.log(msg);
    TelegramService.queueMsg(msg);

    eventBus.emit(EEventBusEventType.StateChange);
  }

  async onExit() {
    console.log("Exiting AA Live Starting State");
  }
}

export default AALiveStartingState;
