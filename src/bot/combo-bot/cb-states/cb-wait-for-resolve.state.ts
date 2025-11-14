import ExchangeService from "@/services/exchange-service/exchange-service";
import { ICandlesData } from "../cb-trend-watcher";
import ComboBot, { CBState } from "../combo-bot";
import { calc_UnrealizedPnl, parseDurationStringIntoMs } from "@/utils/maths.util";
import TelegramService from "@/services/telegram.service";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import BigNumber from "bignumber.js";

class CBWaitForResolveState implements CBState {
  private trendListenerRemover?: () => void;
  private priceListenerRemover?: () => void;

  constructor(private bot: ComboBot) { }

  async onEnter() {
    if (!this.bot.betRuleValsToResolvePosition?.length || !this.bot.currActivePosition) {
      const msg = `Something went wrong either this.bot.betRuleValsToResolvePosition: ${this.bot.betRuleValsToResolvePosition} or this.bot.currActivePosition: ${this.bot.currActivePosition} is not yet defined and already entering wait for resolve signal that means, the flow not work correctly`;
      console.log(msg);
      throw new Error(msg);
    }

    const msg = `🔁 Waiting for resolve signal ${(this.bot.betRuleValsToResolvePosition || []).join(", ")} ...`
    console.log(msg);
    TelegramService.queueMsg(msg);

    console.log("Hooking trend listener for resolve...");
    this.trendListenerRemover = this.bot.cbTrendWatcher.hookCandlesTrendListener(this._handleTrend.bind(this))
    console.log("Trend listener for resolve hooked");

    this._watchForPositionLiquidation();
  }

  private async _watchForPositionLiquidation() {
    this.priceListenerRemover = ExchangeService.hookPriceListener(this.bot.symbol, async (p) => {
      if (!this.bot.currActivePosition) {
        this.priceListenerRemover && this.priceListenerRemover();
        console.log("No active position found, exiting price liquidation listener");
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
      this.trendListenerRemover && this.trendListenerRemover();

      let intervalId: NodeJS.Timeout;
      intervalId = setInterval(async () => {
        this.bot.liquidationSleepFinishTs = +new Date() + parseDurationStringIntoMs(this.bot.sleepDurationAfterLiquidation);
        const posHistory = await ExchangeService.getPositionsHistory({ positionId: this.bot.currActivePosition!.id });
        const closedPos = posHistory[0];
        console.log("closedPos: ", closedPos);

        if (!closedPos) {
          console.log("No closed position found, returning");
          return;
        }

        const isPositionLiquidated = (closedPos.side === "long" && new BigNumber(closedPos.closePrice!).lte(closedPos.liquidationPrice)) ||
          (closedPos.side === "short" && new BigNumber(closedPos.closePrice!).gte(closedPos.liquidationPrice))


        if (isPositionLiquidated) {
          this.trendListenerRemover && this.trendListenerRemover();
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
          this.bot.cbUtil.handlePnL(closedPos.realizedPnl, true);
          clearInterval(intervalId);
          this.bot.currActivePosition = undefined;
          eventBus.emit(EEventBusEventType.StateChange);
        }

      }, 5000);
      return;
    });
  }

  private async _handleTrend(bigCandlesData: ICandlesData, smallCandlesData: ICandlesData) {
    const ruleValPosDir = this.bot.betRules[bigCandlesData.candlesTrend][smallCandlesData.candlesTrend];
    const currMarkPrice = await ExchangeService.getMarkPrice(this.bot.symbol);
    const estimatedUnrealizedProfit = calc_UnrealizedPnl(this.bot.currActivePosition!, currMarkPrice);
    TelegramService.queueMsg(`💭 Current estimated unrealized profit: ${estimatedUnrealizedProfit >= 0 ? "🟩️️️️️️" : "🟥"} ~${estimatedUnrealizedProfit}`)

    if (!this.bot.betRuleValsToResolvePosition?.includes(ruleValPosDir)) return;

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

    this.trendListenerRemover && this.trendListenerRemover();
    this.priceListenerRemover && this.priceListenerRemover();

    TelegramService.queueMsg(`🔚 Resolve trigger trend (${bigCandlesData.candlesTrend}-${smallCandlesData.candlesTrend}: ${ruleValPosDir}) occured, closing position...`)
    await this._closeCurrPosition();

    if (ruleValPosDir !== "skip") {
      this.bot.nextRunForceBetCandlesDatas = {
        big: bigCandlesData,
        small: smallCandlesData,
      };
    }

    eventBus.emit(EEventBusEventType.StateChange);
  }

  private async _closeCurrPosition() {
    const currLatestMarkPrice = await ExchangeService.getMarkPrice(this.bot.symbol);
    const triggerTs = +new Date();
    this.bot.resolveWsPrice = {
      price: currLatestMarkPrice,
      time: new Date(triggerTs),
    }

    let slippage: number = 0;
    let timeDiffMs: number = 0;

    const closedPosition = await (async () => {
      for (let i = 0; i < 10; i++) { // Try 10 times
        this.bot.cbWsServer.broadcast("close-position");
        await new Promise(r => setTimeout(r, 5000)); // Wait 5 seconds before checking closed position again

        console.log("Fetching position for this position id: ", this.bot.currActivePosition!.id!);
        const latestClosedPositions = await ExchangeService.getPositionsHistory({
          positionId: this.bot.currActivePosition!.id!
        });
        const closedPosition = latestClosedPositions?.find(p => p.id === this.bot.currActivePosition!.id!)
        console.log("Found closed position: ", closedPosition);

        if (!!closedPosition) {
          return closedPosition;
        }

        TelegramService.queueMsg(`No closed position found will try again after 5 seconds attempt (${i + 1}/20)`)
      }
    })();

    if (!closedPosition) {
      TelegramService.queueMsg(`Failed to fetch latest closed position that needed to get the realized PnL this will make the calculation wrong`);
      process.exit(-100);
    }

    const closedPositionAvgPrice = closedPosition.avgPrice;
    const closedPositionTriggerTs = +new Date(closedPosition.updateTime);
    slippage = new BigNumber(currLatestMarkPrice).minus(closedPositionAvgPrice).toNumber();
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

    await this.bot.cbUtil.handlePnL(closedPosition.realizedPnl, false, icon, slippage, timeDiffMs);
  }

  async onExit() {
    console.log("Exiting CB Wait For Resolve State");
  }
}

export default CBWaitForResolveState;