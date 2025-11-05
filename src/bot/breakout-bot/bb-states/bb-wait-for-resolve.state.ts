import ExchangeService from "@/services/exchange-service/exchange-service";
import BreakoutBot, { BBState } from "../breakout-bot";
import { parseDurationStringIntoMs } from "@/utils/maths.util";
import TelegramService from "@/services/telegram.service";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import BigNumber from "bignumber.js";

class BBWaitForResolveState implements BBState {
  private priceListenerRemover?: () => void;

  constructor(private bot: BreakoutBot) { }

  async onEnter() {
    if (!this.bot.currActivePosition) {
      const msg = `Something went wrong - currActivePosition is not defined but entering wait for resolve state`;
      console.log(msg);
      throw new Error(msg);
    }

    const msg = `🔁 Waiting for resolve signal - monitoring price for exit...`
    console.log(msg);
    TelegramService.queueMsg(msg);

    this._watchForPositionExit();
    this._watchForPositionLiquidation();
  }

  private async _watchForPositionExit() {
    this.priceListenerRemover = ExchangeService.hookPriceListener(this.bot.symbol, async (price) => {
      if (!this.bot.currActivePosition) {
        this.priceListenerRemover && this.priceListenerRemover();
        console.log("No active position found, exiting price exit listener");
        return;
      }

      if (!this.bot.currentSupport || !this.bot.currentResistance) {
        // Wait for support/resistance levels to be calculated
        return;
      }

      const position = this.bot.currActivePosition;
      let shouldExit = false;
      let exitReason = "";

      // Check take profit first (using BigNumber for precision)
      const entryPrice = new BigNumber(position.avgPrice);
      const takeProfitMultiplier = new BigNumber(this.bot.takeProfitPercentage).div(100);
      
      const takeProfitPrice = position.side === "long" 
        ? entryPrice.times(new BigNumber(1).plus(takeProfitMultiplier))
        : entryPrice.times(new BigNumber(1).minus(takeProfitMultiplier));

      if (position.side === "long" && new BigNumber(price).gte(takeProfitPrice)) {
        shouldExit = true;
        exitReason = "take_profit";
        TelegramService.queueMsg(`💰 Take profit triggered (${this.bot.takeProfitPercentage}%): Long position - Price ${price} >= TP ${takeProfitPrice.toFixed(4)}`);
      } else if (position.side === "short" && new BigNumber(price).lte(takeProfitPrice)) {
        shouldExit = true;
        exitReason = "take_profit";
        TelegramService.queueMsg(`💰 Take profit triggered (${this.bot.takeProfitPercentage}%): Short position - Price ${price} <= TP ${takeProfitPrice.toFixed(4)}`);
      }
      // Check support/resistance exits
      else if (position.side === "long" && new BigNumber(price).lte(this.bot.currentSupport)) {
        shouldExit = true;
        exitReason = "support_resistance";
        TelegramService.queueMsg(`📉 Long position exit trigger: Price ${price} <= Support ${this.bot.currentSupport}`);
      } else if (position.side === "short" && new BigNumber(price).gte(this.bot.currentResistance)) {
        shouldExit = true;
        exitReason = "support_resistance";
        TelegramService.queueMsg(`📈 Short position exit trigger: Price ${price} >= Resistance ${this.bot.currentResistance}`);
      }

      if (shouldExit) {
        this.priceListenerRemover && this.priceListenerRemover();
        await this._closeCurrPosition(exitReason);
      }
    });
  }

  private async _watchForPositionLiquidation() {
    const liquidationListenerRemover = ExchangeService.hookPriceListener(this.bot.symbol, async (p) => {
      if (!this.bot.currActivePosition) {
        liquidationListenerRemover && liquidationListenerRemover();
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
      liquidationListenerRemover && liquidationListenerRemover();

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
          this.bot.bbUtil.handlePnL(closedPos.realizedPnl, true);
          clearInterval(intervalId);
          this.bot.currActivePosition = undefined;
          this.bot.lastExitTime = Date.now(); // Track when we exited (liquidation)
          eventBus.emit(EEventBusEventType.StateChange);
        }

      }, 5000);
      return;
    });
  }

  private async _closeCurrPosition(reason: string = "support_resistance") {
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
        this.bot.bbWsSignaling.broadcast("close-position");
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

        TelegramService.queueMsg(`No closed position found will try again after 5 seconds attempt (${i + 1}/10)`)
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
    this.bot.lastExitTime = Date.now(); // Track when we exited

    await this.bot.bbUtil.handlePnL(closedPosition.realizedPnl, false, icon, slippage, timeDiffMs);
    
    eventBus.emit(EEventBusEventType.StateChange);
  }

  async onExit() {
    console.log("Exiting BB Wait For Resolve State");
    this.priceListenerRemover && this.priceListenerRemover();
  }
}

export default BBWaitForResolveState;

