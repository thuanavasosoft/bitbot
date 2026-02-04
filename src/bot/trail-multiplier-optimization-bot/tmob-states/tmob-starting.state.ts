import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import TrailMultiplierOptimizationBot, { TMOBState } from "../trail-multiplier-optimization-bot";
import ExchangeService from "@/services/exchange-service/exchange-service";
import BigNumber from "bignumber.js";

class TMOBStartingState implements TMOBState {
  constructor(private bot: TrailMultiplierOptimizationBot) { }

  private async updateBotBalances() {
    const currExchFreeUsdtBalance = await this.bot.tmobUtils.getExchFreeUsdtBalance();
    if (!this.bot.startQuoteBalance) this.bot.startQuoteBalance = currExchFreeUsdtBalance.decimalPlaces(4, BigNumber.ROUND_DOWN).toString();
    if (!this.bot.currQuoteBalance) this.bot.currQuoteBalance = currExchFreeUsdtBalance.decimalPlaces(4, BigNumber.ROUND_DOWN).toString();
  }

  async onEnter() {
    console.log("Starting TMOBStartingState");

    const symbolInfo = await ExchangeService.getSymbolInfo(this.bot.symbol);
    this.bot.basePrecisiion = symbolInfo.basePrecision;
    this.bot.pricePrecision = symbolInfo.pricePrecision;

    // Cold start update balances
    if (!this.bot.startQuoteBalance) await this.updateBotBalances();
    // Cold start update trail multiplier
    if (this.bot.currTrailMultiplier === undefined) this.bot.tmobUtils.updateCurrTrailMultiplier();

    eventBus.emit(EEventBusEventType.StateChange, this.bot.optimizeTrailMultiplierState);
  }

  async onExit() {
    console.log("Exiting TMOBStartingState");
  }
}

export default TMOBStartingState;