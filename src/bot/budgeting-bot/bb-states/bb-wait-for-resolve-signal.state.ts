import type { IAITrend } from "@/services/grok-ai.service";
import BudgetingBot, { type BBState } from "../budgeting-bot";
import TelegramService from "@/services/telegram.service";
import ExchangeService from "@/services/exchange-service/exchange-service";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import { parseDurationStringIntoMs } from "@/utils/maths.util";

class BBWaitForResolveSignalState implements BBState {
  private aiTrendHookRemover?: () => void;
  private priceListenerRemover?: () => void;

  constructor(private bot: BudgetingBot) { }

  async onEnter() {
    if (!this.bot.shouldResolvePositionTrends) {
      const msg = `Something went wrong this.bot.shouldResolvePositionTrends is not yet defined and already entering wait for resolve signal that means, the flow not work correctly`;
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

    this.aiTrendHookRemover = this.bot.bbTrendWatcher.hookAiTrends("resolving", this._trendHandler.bind(this), this._handleSundayAndMondayTransition.bind(this));
    this._watchForPositionLiquidation();
  }

  private async _watchForPositionLiquidation() {
    const pos = await ExchangeService.getPosition(this.bot.symbol);
    if (!pos) return;

    this.priceListenerRemover = ExchangeService.hookPriceListener(this.bot.symbol, async (p) => {
      if (
        (pos!.side === "long" && new BigNumber(pos!.liquidationPrice).lt(p))
        || (pos!.side === "short" && new BigNumber(pos!.liquidationPrice).gt(p))
      ) return;

      const msg = `💣 Current price ${p} is not good, exceed liquidation price (${pos?.liquidationPrice}) for ${pos?.side}, handling it...`;
      console.log(msg);
      TelegramService.queueMsg(msg);

      this.priceListenerRemover && this.priceListenerRemover();
      this.aiTrendHookRemover && this.aiTrendHookRemover();
      this.bot.sameTrendAsBetTrendCount = 0;
      this.bot.liquidationSleepFinishTs = +new Date() + parseDurationStringIntoMs(this.bot.sleepDurationAfterLiquidation);
      const posHistory = await ExchangeService.getPositionsHistory({ positionId: pos!.id });
      const closedPos = posHistory[0];
      if (
        (closedPos.side === "long" && new BigNumber(closedPos.closePrice!).lte(closedPos.liquidationPrice)) ||
        (closedPos.side === "short" && new BigNumber(closedPos.closePrice!).gte(closedPos.liquidationPrice))
      ) {
        this.aiTrendHookRemover && this.aiTrendHookRemover();
        console.log("Liquidated position: ", closedPos);
        TelegramService.queueMsg(`
🤯 Position just got liquidated
Pos ID: ${closedPos.id}
Avg price: ${closedPos.avgPrice}
Liquidation price: ${closedPos.liquidationPrice}
Close price: ${closedPos.closePrice}

Realized PnL: ${closedPos.realizedPnl}
`);

        this.bot.liquidationSleepFinishTs = +new Date() + parseDurationStringIntoMs(this.bot.sleepDurationAfterLiquidation);
        eventBus.emit(EEventBusEventType.StateChange);
      } else {
        // Re run this function
        await this._watchForPositionLiquidation();
      }
    });
  }

  private async _handleSundayAndMondayTransition() {
    if (!this.bot.currActiveOpenedPositionId) return;

    const todayDayName = this.bot.bbUtil.getTodayDayName();

    const msg = `🕵️‍♀️ Found opened position (${this.bot.currActiveOpenedPositionId}) on early ${todayDayName}, force closing it...`;
    console.log(msg);
    TelegramService.queueMsg(msg);

    const { nextCheckTs } = this.bot.bbUtil.getWaitInMs();
    this.bot.nextTrendCheckTs = nextCheckTs;

    await this._closeCurrPosition();
    eventBus.emit(EEventBusEventType.StateChange);
  }

  private async _trendHandler(aiTrend: IAITrend) {
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
    const closedPosition = await (async () => {
      for (let i = 0; i < 10; i++) { // Try 10 times
        this.bot.bbWSSignaling.broadcast("close-position");
        await new Promise(r => setTimeout(r, 5000)); // Wait 5 seconds before checking closed position again

        console.log("Fetching position for this position id: ", this.bot.currActiveOpenedPositionId!);
        const latestClosedPositions = await ExchangeService.getPositionsHistory({
          positionId: this.bot.currActiveOpenedPositionId!
        });
        const closedPosition = latestClosedPositions?.find(p => p.id === this.bot.currActiveOpenedPositionId!)
        console.log("Found closed position: ", closedPosition);

        if (!!closedPosition) return closedPosition;

        TelegramService.queueMsg(`No closed position found will try again after 5 seconds attempt (${i + 1}/20)`)
      }
    })();

    if (!closedPosition) {
      TelegramService.queueMsg(`Failed to fetch latest closed position that needed to get the realized PnL this will make the calculation wrong`);
      process.exit(-100);
    }

    this.bot.currActiveOpenedPositionId = undefined;
    this.bot.currPositionSide = undefined;

    await this.bot.bbUtil.handlePnL(closedPosition.realizedPnl)
  }

  async onExit() {
    console.log("Exiting wait for reesolve signal state...");
  }
}

export default BBWaitForResolveSignalState;