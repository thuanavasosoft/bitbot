import type { IAITrend } from "@/services/grok-ai.service";
import TestFollowMultipleExits, { type TFMEBState } from "../test-follow-multiple-exits-bot";
import TelegramService from "@/services/telegram.service";
import ExchangeService from "@/services/exchange-service/exchange-service";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import { calc_UnrealizedPnl, parseDurationStringIntoMs } from "@/utils/maths.util";
import { BigNumber } from "bignumber.js";
import { IPosition } from "@/services/exchange-service/exchange-type";

class TFMEBWaitForResolveSignalState implements TFMEBState {
  private aiTrendHookRemover?: () => void;
  private priceListenerRemover?: () => void;

  constructor(private bot: TestFollowMultipleExits) { }

  async onEnter() {
    if (!this.bot.shouldResolvePositionTrends?.length || !this.bot.currActivePosition) {
      const msg = `Something went wrong either this.bot.shouldResolvePositionTrends: ${this.bot.shouldResolvePositionTrends} or this.bot.currActivePosition: ${this.bot.currActivePosition} is not yet defined and already entering wait for resolve signal that means, the flow not work correctly`;
      console.log(msg);
      throw new Error(msg);
    }

    const msg = `🔁 Waiting for resolve signal ${(this.bot.shouldResolvePositionTrends || []).join(", ")} ...`
    console.log(msg);
    TelegramService.queueMsg(msg);

    const nowMs = +new Date();
    if (!!this.bot.nextTrendCheckTs && nowMs < this.bot.nextTrendCheckTs) {
      console.log(`Waiting for ${this.bot.nextTrendCheckTs - nowMs}ms before hook ai trends`);
      await new Promise(r => setTimeout(r, this.bot.nextTrendCheckTs - nowMs))
    }

    this.aiTrendHookRemover = this.bot.bbTrendWatcher.hookAiTrends("resolving", this._trendHandler.bind(this));

    this._watchForPositionLiquidation();
  }

  private async _watchForPositionLiquidation() {
    this.priceListenerRemover = ExchangeService.hookPriceListener(this.bot.symbol, async (p) => {
      if (!this.bot.currActivePosition) {
        this.priceListenerRemover && this.priceListenerRemover();
        this.aiTrendHookRemover && this.aiTrendHookRemover();
        console.log("No active position found, exiting price listener");
        return;
      }

      // Not liquidated yet
      if (
        (this.bot.currActivePosition!.side === "long" && new BigNumber(p).gt(this.bot.currActivePosition!.liquidationPrice!))
        || (this.bot.currActivePosition!.side === "short" && new BigNumber(p).lt(this.bot.currActivePosition!.liquidationPrice!))
      ) return;

      const msg = `💣 Current price ${p} is not good, exceeded liquidation price (${this.bot.currActivePosition!.liquidationPrice}) for ${this.bot.currActivePosition!.side}, checking it...`;
      console.log(msg);
      TelegramService.queueMsg(msg);

      this.priceListenerRemover && this.priceListenerRemover();
      this.aiTrendHookRemover && this.aiTrendHookRemover();

      let intervalId: NodeJS.Timeout;
      intervalId = setInterval(async () => {
        this.bot.sameTrendAsBetTrendCount = 0;
        this.bot.liquidationSleepFinishTs = +new Date() + parseDurationStringIntoMs(this.bot.sleepDurationAfterLiquidation);
        const closedPos = this.bot.currActivePosition;

        if (!closedPos) {
          return;
        }

        this.aiTrendHookRemover && this.aiTrendHookRemover();
        console.log("Liquidated position: ", closedPos);
        TelegramService.queueMsg(`
🤯 Position just got liquidated
Pos ID: ${closedPos.id}
Avg price: ${closedPos.avgPrice}
Liquidation price: ${closedPos.liquidationPrice}
Close price: ${closedPos.closePrice}

Realized PnL: 🟥🟥🟥 ${closedPos.realizedPnl}
`);
        this.bot.liquidationSleepFinishTs = +new Date() + parseDurationStringIntoMs(this.bot.sleepDurationAfterLiquidation);
        this.bot.bbUtil.handlePnL(closedPos.realizedPnl);
        clearInterval(intervalId);
        eventBus.emit(EEventBusEventType.StateChange);

      }, 5000);
      return;
    });
  }

  private async _trendHandler(aiTrend: IAITrend) {
    const currMarkPrice = await ExchangeService.getMarkPrice(this.bot.symbol);
    const estimatedUnrealizedProfit = calc_UnrealizedPnl(this.bot.currActivePosition!, currMarkPrice);
    TelegramService.queueMsg(`💭 Current estimated unrealized profit: ${estimatedUnrealizedProfit >= 0 ? "🟩️️️️️️" : "🟥"} ~${estimatedUnrealizedProfit}`)
    if (!this.bot.shouldResolvePositionTrends?.includes(aiTrend.trend)) {
      this.bot.sameTrendAsBetTrendCount++;
      TelegramService.queueMsg(`🙅‍♂️ ${aiTrend.trend} trend is not a resolve trigger trend (${this.bot.sameTrendAsBetTrendCount}) not doing anything`)
      return;
    }

    TelegramService.queueMsg(`🔚 Resolve trigger trend (${aiTrend.trend}) occured, closing position...`)
    this.aiTrendHookRemover && this.aiTrendHookRemover();
    await this._closeCurrPosition();

    this.bot.sameTrendAsBetTrendCount = 0;
    this.bot.commitedBetEntryTrend = undefined;
    eventBus.emit(EEventBusEventType.StateChange);
  }

  private async _closeCurrPosition() {
    const latestPrice = await ExchangeService.getMarkPrice(this.bot.symbol);
    const triggerTs = +new Date();
    this.bot.resolveWsPrice = {
      price: latestPrice,
      time: new Date(triggerTs),
    }

    let slippage: number = 0;
    let timeDiffMs: number = 0;

    const realizedPnl = this.bot.currActivePosition!.side === "long"
      ? (latestPrice - this.bot.currActivePosition!.avgPrice) * this.bot.currActivePosition!.size
      : (this.bot.currActivePosition!.avgPrice - latestPrice) * this.bot.currActivePosition!.size
    const closedPosition: IPosition = this.bot.currActivePosition!;
    closedPosition.closePrice = latestPrice;
    closedPosition.realizedPnl = realizedPnl;

    const closedPositionAvgPrice = closedPosition.avgPrice;
    const closedPositionTriggerTs = +new Date(closedPosition.updateTime);
    slippage = new BigNumber(latestPrice).minus(closedPositionAvgPrice).toNumber();
    timeDiffMs = closedPositionTriggerTs - triggerTs;

    const icon = this.bot.currActivePosition?.side === "long" ? slippage >= 0 ? "🟩" : "🟥" : slippage <= 0 ? "🟩" : "🟥";
    if (icon === "🟥") {
      this.bot.slippageAccumulation += Math.abs(slippage);
    } else {
      this.bot.slippageAccumulation -= Math.abs(slippage);
    }

    this.bot.currActivePosition = undefined;
    this.bot.entryWsPrice = undefined;
    this.bot.resolveWsPrice = undefined;
    this.bot.numberOfTrades++;

    await this.bot.bbUtil.handlePnL(closedPosition.realizedPnl, icon, slippage, timeDiffMs)
  }

  async onExit() {
    console.log("Exiting wait for reesolve signal state...");
  }
}

export default TFMEBWaitForResolveSignalState;