import { EEventBusEventType } from "@/utils/event-bus.util";
import ExchangeService from "@/services/exchange-service/exchange-service";
import { withRetries, isTransientError } from "../comb-retry";
import type CombBotInstance from "../comb-bot-instance";

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

class CombStartingState {
  constructor(private bot: CombBotInstance) { }

  private async _ensureMarginAvailable() {
    const bal = await this.bot.combUtils.getExchFreeUsdtBalance();
    if (bal.lt(this.bot.margin)) throw new Error(`Exchange balance ${bal} < margin ${this.bot.margin}`);
  }

  private async _loadSymbolInfo(): Promise<void> {
    this.bot.symbolInfo = await withRetries(
      () => ExchangeService.getSymbolInfo(this.bot.symbol),
      {
        label: "[COMB] getSymbolInfo",
        retries: 5,
        minDelayMs: 5000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) =>
          console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
      }
    );
    this.bot.pricePrecision = this.bot.symbolInfo?.pricePrecision ?? 0;
    this.bot.tickSize = Math.pow(10, -this.bot.pricePrecision);
  }

  async onEnter() {
    console.log(`[COMB] CombStartingState onEnter symbol=${this.bot.symbol} runId=${this.bot.runId}`);
    await Promise.all([
      this._ensureMarginAvailable(),
      (async () => {
        this.bot.queueMsg(`Updating leverage of ${this.bot.symbol} to X${this.bot.leverage}...`);
        await ExchangeService.setLeverage(this.bot.symbol, this.bot.leverage);
        await ExchangeService.setMarginMode(this.bot.symbol, "isolated");
        this.bot.queueMsg("Leverage and margin mode updated successfully");
      })(),
      this._loadSymbolInfo(),
    ]);
    if (this.bot.currTrailMultiplier === undefined) {
      await this.bot.combUtils.updateCurrTrailMultiplier();
      if (this.bot.currTrailMultiplier !== undefined) {
        this.bot.trailingStopMultiplier = this.bot.currTrailMultiplier;
        const intervalMs = this.bot.updateIntervalMinutes * 60_000;
        const nextOptimizationMs = this.bot.lastOptimizationAtMs + intervalMs + 1000;
        this.bot.queueMsg(
          `🧠 Initial optimization complete\n` +
          `Trailing ATR Length: ${this.bot.trailingAtrLength} (fixed)\n` +
          `Trailing Multiplier: ${this.bot.trailingStopMultiplier}\n` +
          `Next optimization: ${toIso(nextOptimizationMs)}`
        );
      }
    }
    this.bot.startOptimizationLoop();
    if (!this.bot.tmobCandleWatcher.isCandleWatcherStarted) {
      void this.bot.tmobCandleWatcher.startWatchingCandles().catch((err) => {
        console.error("[COMB] Candle watcher crashed:", err);
        this.bot.queueMsg(`⚠️ Candle watcher crashed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    if (!this.bot.runStartTs) this.bot.runStartTs = new Date();
    this.bot.queueMsg("⚙️ Starting Combination Bot (instance)");
    const msg = `
🟢 COMB BOT INSTANCE STARTED
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

Current PnL: ${this.bot.totalActualCalculatedProfit >= 0 ? "🟩" : "🟥"} ${this.bot.totalActualCalculatedProfit.toFixed(4)} USDT
`;
    this.bot.queueMsg(msg);
    this.bot.stateBus.emit(EEventBusEventType.StateChange);
  }

  async onExit() {
    console.log(`[COMB] CombStartingState onExit symbol=${this.bot.symbol}`);
  }
}

export default CombStartingState;
