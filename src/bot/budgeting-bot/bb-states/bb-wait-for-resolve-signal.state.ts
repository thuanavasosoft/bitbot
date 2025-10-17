import type { IAITrend } from "@/services/grok-ai.service";
import BudgetingBot, { type BBState } from "../budgeting-bot";
import TelegramService from "@/services/telegram.service";
import ExchangeService from "@/services/exchange-service/exchange-service";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";

class BBWaitForResolveSignalState implements BBState {
  private aiTrendHookRemover?: () => void;

  constructor(private bot: BudgetingBot) { }

  async onEnter() {
    if (!this.bot.shouldResolvePositionTrends) {
      const msg = `Something went wrong this.bot.shouldResolvePositionTrends is not yet defined and already entering wait for resolve signal that means, the flow not work correctly`;
      console.log(msg);
      throw new Error(msg);
    }

    const msg = `🔁 Waiting for resolve signal...`
    console.log(msg);
    TelegramService.queueMsg(msg);

    this.aiTrendHookRemover = this.bot.bbTrendWatcher.hookAiTrends("resolving", this._trendHandler.bind(this), this._handleSundayAndMondayTransition.bind(this));
  }

  private async _handleSundayAndMondayTransition() {
    const todayDayName = this.bot.bbUtil.getTodayDayName();

    const msg = `🕵️‍♀️ Found opened position (${this.bot.currActiveOpenedPositionId}) on early ${todayDayName}, force closing it...`;
    console.log(msg);
    TelegramService.queueMsg(msg);

    this._closeCurrPosition();
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
        const closedPosition = latestClosedPositions?.find(p => p.positionId === this.bot.currActiveOpenedPositionId!)
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
    eventBus.emit(EEventBusEventType.StateChange);
  }

  async onExit() {
    console.log("Exiting wait for reesolve signal state...");
  }
}

export default BBWaitForResolveSignalState;