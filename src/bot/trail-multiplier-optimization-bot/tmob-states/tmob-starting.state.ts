import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import TrailMultiplierOptimizationBot, { TMOBState } from "../trail-multiplier-optimization-bot";
import ExchangeService from "@/services/exchange-service/exchange-service";
import BigNumber from "bignumber.js";
import TelegramService from "@/services/telegram.service";
import { toIso } from "@/bot/auto-adjust-bot/candle-utils";

class TMOBStartingState implements TMOBState {
  constructor(private bot: TrailMultiplierOptimizationBot) { }

  private async updateBotBalances() {
    const currExchFreeUsdtBalance = await this.bot.tmobUtils.getExchFreeUsdtBalance();
    if (!this.bot.startQuoteBalance) this.bot.startQuoteBalance = currExchFreeUsdtBalance.decimalPlaces(4, BigNumber.ROUND_DOWN).toString();
    if (!this.bot.currQuoteBalance) this.bot.currQuoteBalance = currExchFreeUsdtBalance.decimalPlaces(4, BigNumber.ROUND_DOWN).toString();
  }

  async onEnter() {
    console.log("Starting TMOBStartingState");

    this.bot.runStartTs = new Date();

    const symbolInfo = await ExchangeService.getSymbolInfo(this.bot.symbol);
    this.bot.basePrecisiion = symbolInfo.basePrecision;
    this.bot.pricePrecision = symbolInfo.pricePrecision;

    if (!this.bot.startQuoteBalance) await this.updateBotBalances();
    if (this.bot.currTrailMultiplier === undefined) await this.bot.tmobUtils.updateCurrTrailMultiplier();
    if (!this.bot.tmobCandleWatcher.isCandleWatcherStarted) this.bot.tmobCandleWatcher.startWatchingCandles();

    this.bot.runStartTs = new Date();
    const msg = `🟢 TRAIL MULTIPLIER OPTIMIZATION BOT STARTED
Start time: ${toIso(this.bot.runStartTs.getTime())}
Symbol: ${this.bot.symbol}
Leverage: X${this.bot.leverage}
Margin size: ${this.bot.margin} USDT
Start quote balance: ${this.bot.startQuoteBalance} USDT
Current quote balance: ${this.bot.currQuoteBalance} USDT
Trigger buffer percentage: ${this.bot.triggerBufferPercentage}%
N signal: ${this.bot.nSignal}
Trailing ATR length: ${this.bot.trailingAtrLength}
Trail multiplier bounds: ${this.bot.trailMultiplierBounds.min} to ${this.bot.trailMultiplierBounds.max}
Trail confirm bars: ${this.bot.trailConfirmBars}
Update interval: ${this.bot.updateIntervalMinutes}m
Optimization window: ${this.bot.optimizationWindowMinutes}m`;

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