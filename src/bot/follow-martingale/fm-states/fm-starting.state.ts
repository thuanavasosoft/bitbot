import { EEventBusEventType } from "@/utils/event-bus.util";
import ExchangeService from "@/services/exchange-service/exchange-service";
import type FollowMartingaleBot from "../follow-martingale-bot";

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

class FMStartingState {
  constructor(private bot: FollowMartingaleBot) {}

  async onEnter(): Promise<void> {
    await Promise.all([
      this.bot.ensureSymbolInfoLoaded(),
      (async () => {
        this.bot.queueMsg(`Updating leverage of ${this.bot.symbol} to X${this.bot.leverage}...`);
        await ExchangeService.setLeverage(this.bot.symbol, this.bot.leverage);
        await ExchangeService.setMarginMode(this.bot.symbol, "cross");
        this.bot.queueMsg(`Leverage updated successfully. Margin mode set to cross.`);
      })(),
    ]);

    const totalBalance = await this.bot.getExchTotalUsdtBalance();
    this.bot.startTotalBalance = totalBalance.toFixed(4);
    this.bot.currTotalBalance = totalBalance.toFixed(4);
    this.bot.runStartTs = new Date();

    await this.bot.refreshSignalLevels();

    this.bot.queueMsg(
      `🟢 FOLLOW MARTINGALE BOT STARTED
Start time: ${toIso(this.bot.runStartTs.getTime())}
Symbol: ${this.bot.symbol}
Side mode: AUTO (long + short)
Leverage: X${this.bot.leverage}

Signal N: ${this.bot.signalN}
Max legs: ${this.bot.maxLegs}
Size multiplier: ${this.bot.sizeMultiplier}
Take profit: ${(this.bot.takeProfitPct * 100).toFixed(4)}%
Stop loss: ${this.bot.stopLossPercent >= 100 ? "disabled" : `${this.bot.stopLossPercent}%`}
Buffer: ${(this.bot.bufferPct * 100).toFixed(4)}%
Maintenance discount: ${this.bot.maintenanceDiscountPct}%
Candle resolution: ${this.bot.candleResolution}
Loop interval: ${this.bot.loopIntervalMs}ms

Total balance: ${totalBalance.toFixed(4)} USDT
Sizing mode: ${typeof this.bot.fixedMarginUsdt === "number" && this.bot.fixedMarginUsdt > 0 ? `fixed FM_MARGIN_USDT=${this.bot.fixedMarginUsdt}` : "total balance geometric sizing"}
Leg-1 margin (default): ${this.bot.getLeg1MarginFromTotalBalance(totalBalance.toNumber()).toFixed(4)} USDT
Leg-1 notional (default): ${this.bot.getLeg1QuoteFromTotalBalance(totalBalance.toNumber()).toFixed(4)} USDT`
    );

    if (!this.bot.candleWatcher.isCandleWatcherStarted) {
      void this.bot.candleWatcher.startWatchingCandles().catch((error) => {
        console.error("[FM] Candle watcher crashed:", error);
        this.bot.queueMsg(`⚠️ FMCandleWatcher crashed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }

    this.bot.stateBus.emit(EEventBusEventType.StateChange);
  }

  async onExit(): Promise<void> {}
}

export default FMStartingState;
