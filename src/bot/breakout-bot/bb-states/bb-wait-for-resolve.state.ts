import ExchangeService from "@/services/exchange-service/exchange-service";
import BreakoutBot, { BBState } from "../breakout-bot";
import { parseDurationStringIntoMs } from "@/utils/maths.util";
import TelegramService from "@/services/telegram.service";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import BigNumber from "bignumber.js";

class BBWaitForResolveState implements BBState {
  private priceListenerRemover?: () => void;
  private liquidationListenerRemover?: () => void;
  private liquidationPollInterval?: NodeJS.Timeout;
  private manualCloseInProgress = false;

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

  private _clearPriceListener() {
    if (this.priceListenerRemover) {
      this.priceListenerRemover();
      this.priceListenerRemover = undefined;
    }
  }

  private _clearLiquidationListener() {
    if (this.liquidationListenerRemover) {
      this.liquidationListenerRemover();
      this.liquidationListenerRemover = undefined;
    }
  }

  private _clearLiquidationPollInterval() {
    if (this.liquidationPollInterval) {
      clearInterval(this.liquidationPollInterval);
      this.liquidationPollInterval = undefined;
    }
  }

  private _stopAllWatchers() {
    this._clearPriceListener();
    this._clearLiquidationListener();
    this._clearLiquidationPollInterval();
  }

  private async _watchForPositionExit() {
    this.priceListenerRemover = ExchangeService.hookPriceListener(this.bot.symbol, async (price) => {
      if (!this.bot.currActivePosition) {
        this._clearPriceListener();
        console.log("No active position found, exiting price exit listener");
        return;
      }

      if (!this.bot.currentSupport || !this.bot.currentResistance) {
        // Wait for support/resistance levels to be calculated
        return;
      }

      // IMPORTANT: Only allow exit if S/R has been updated AFTER the last entry
      // This prevents exits in the same minute as entry
      if (this.bot.lastEntryTime > 0 && this.bot.lastSRUpdateTime <= this.bot.lastEntryTime) {
        // Still using old S/R levels from entry minute, wait for next update
        return;
      }

      const position = this.bot.currActivePosition;
      let shouldExit = false;
      let exitReason = "";
      const priceBn = new BigNumber(price);
      const fractionalStopLoss = this.bot.fractionalStopLoss;
      const one = new BigNumber(1);
      const bufferPct = new BigNumber(this.bot.bufferPercentage || 0);
      const resistanceBn = this.bot.currentResistance !== null ? new BigNumber(this.bot.currentResistance) : null;
      const supportBn = this.bot.currentSupport !== null ? new BigNumber(this.bot.currentSupport) : null;
      const bufferedResistance = resistanceBn ? resistanceBn.times(one.minus(bufferPct)) : null;
      const bufferedSupport = supportBn ? supportBn.times(one.plus(bufferPct)) : null;

      this.bot.bufferedExitLevels = {
        resistance: bufferedResistance ? bufferedResistance.toNumber() : null,
        support: bufferedSupport ? bufferedSupport.toNumber() : null,
      };

      if (
        !shouldExit &&
        fractionalStopLoss > 0 &&
        resistanceBn !== null &&
        supportBn !== null
      ) {
        const range = resistanceBn.minus(supportBn);

        if (range.gt(0)) {
          const fractionalDistance = range.times(fractionalStopLoss);
          let bufferedStopLevel: BigNumber | null = null;
          let rawStopLevel: BigNumber | null = null;

          if (position.side === "long") {
            rawStopLevel = resistanceBn.minus(fractionalDistance);
            const stopBufferDelta = rawStopLevel.times(bufferPct);
            bufferedStopLevel = rawStopLevel.plus(stopBufferDelta);

            if (priceBn.lte(bufferedStopLevel)) {
              shouldExit = true;
              exitReason = "fractional_stop_loss";
              const msg = `🛑 Fractional stop hit (long). Price ${price} <= ${bufferedStopLevel.toFixed(4)} [fraction ${fractionalStopLoss}]`;
              console.log(msg);
              TelegramService.queueMsg(msg);
            }
          } else if (position.side === "short") {
            rawStopLevel = supportBn.plus(fractionalDistance);
            const stopBufferDelta = rawStopLevel.times(bufferPct);
            bufferedStopLevel = rawStopLevel.minus(stopBufferDelta);

            if (priceBn.gte(bufferedStopLevel)) {
              shouldExit = true;
              exitReason = "fractional_stop_loss";
              const msg = `🛑 Fractional stop hit (short). Price ${price} >= ${bufferedStopLevel.toFixed(4)} [fraction ${fractionalStopLoss}]`;
              console.log(msg);
              TelegramService.queueMsg(msg);
            }
          }

          if (rawStopLevel && bufferedStopLevel) {
            this.bot.fractionalStopTargets = {
              side: position.side,
              rawLevel: rawStopLevel.toNumber(),
              bufferedLevel: bufferedStopLevel.toNumber(),
            };
          }
        }
      } else {
        this.bot.fractionalStopTargets = undefined;
      }

      if (!shouldExit) {
        // Check support/resistance exits
        if (position.side === "long" && bufferedSupport && priceBn.lte(bufferedSupport)) {
          shouldExit = true;
          exitReason = "support_resistance";
          TelegramService.queueMsg(`📉 Long position exit trigger: Price ${price} <= Buffered Support ${bufferedSupport.toFixed(4)}`);
        } else if (position.side === "short" && bufferedResistance && priceBn.gte(bufferedResistance)) {
          shouldExit = true;
          exitReason = "support_resistance";
          TelegramService.queueMsg(`📈 Short position exit trigger: Price ${price} >= Buffered Resistance ${bufferedResistance.toFixed(4)}`);
        }
      }

      if (shouldExit) {
        this._clearPriceListener();
        await this._closeCurrPosition(exitReason);
      }
    });
  }

  private async _watchForPositionLiquidation() {
    this._clearLiquidationListener();
    this.liquidationListenerRemover = ExchangeService.hookPriceListener(this.bot.symbol, async (p) => {
      if (!this.bot.currActivePosition) {
        this._clearLiquidationListener();
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

      this._clearPriceListener();
      this._clearLiquidationListener();

      this._clearLiquidationPollInterval();
      this.liquidationPollInterval = setInterval(async () => {
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
          
          this._clearLiquidationPollInterval();
          this.bot.currActivePosition = undefined;
          this.bot.lastExitTime = Date.now(); // Track when we exited (liquidation)
          eventBus.emit(EEventBusEventType.StateChange);
        }

      }, 5000);
      return;
    });
  }

  async handleManualCloseRequest() {
    if (this.manualCloseInProgress) {
      const msg = `Close position request is already being processed, please wait...`;
      console.log(msg);
      TelegramService.queueMsg(msg);
      return;
    }

    if (!this.bot.currActivePosition) {
      const msg = `No active position to close manually.`;
      console.warn(msg);
      TelegramService.queueMsg(msg);
      return;
    }

    this.manualCloseInProgress = true;

    try {
      this._stopAllWatchers();
      await this._closeCurrPosition("manual_close_command");
    } finally {
      this.manualCloseInProgress = false;
    }
  }

  private async _closeCurrPosition(reason: string = "support_resistance") {
    const currLatestMarkPrice = await ExchangeService.getMarkPrice(this.bot.symbol);
    const triggerTs = +new Date();
    this.bot.resolveWsPrice = {
      price: currLatestMarkPrice,
      time: new Date(triggerTs),
    }

    const activePosition = this.bot.currActivePosition;

    const closedPosition = await this.bot.triggerCloseSignal(this.bot.currActivePosition);
    const closedPositionPrice = typeof closedPosition.closePrice === "number"
      ? closedPosition.closePrice
      : closedPosition.avgPrice;
    const closedPositionTriggerTs = +new Date(closedPosition.updateTime);
    let slippage: number = 0;
    let timeDiffMs: number = 0;
    
    // Calculate slippage based on support/resistance levels
    // For long exit (sell): compare fill price with support (higher fill relative to support = better = negative slippage)
    // For short exit (buy): compare fill price with resistance (lower fill relative to resistance = better = negative slippage)
    const positionSide = activePosition?.side;
    let srLevel: number | null = null;
    if (this.bot.fractionalStopTargets && this.bot.fractionalStopTargets.side === positionSide) {
      srLevel = this.bot.fractionalStopTargets.rawLevel;
    } else if (positionSide === "long") {
      srLevel = this.bot.currentSupport;
    } else if (positionSide === "short") {
      srLevel = this.bot.currentResistance;
    }
    
    if (srLevel === null) {
      console.warn(`⚠️ Cannot calculate slippage: ${positionSide === "long" ? "support/fractional stop" : "resistance/fractional stop"} level is null`);
      TelegramService.queueMsg(`⚠️ Warning: Cannot calculate slippage - ${positionSide === "long" ? "support/fractional stop" : "resistance/fractional stop"} level not available`);
    }
    
    slippage = srLevel !== null
      ? positionSide === "short"
        ? new BigNumber(closedPositionPrice).minus(srLevel).toNumber()
        : new BigNumber(srLevel).minus(closedPositionPrice).toNumber()
      : 0;
    timeDiffMs = closedPositionTriggerTs - triggerTs;

    // Negative slippage is good (better price than SR level), positive slippage is bad
    const icon = slippage <= 0 ? "🟩" : "🟥";
    if (icon === "🟥") {
      this.bot.slippageAccumulation += Math.abs(slippage);
    } else {
      this.bot.slippageAccumulation -= Math.abs(slippage);
    }

    this.bot.currActivePosition = undefined;
    this.bot.entryWsPrice = undefined;
    this.bot.resolveWsPrice = undefined;
    this.bot.fractionalStopTargets = undefined;
    this.bot.bufferedExitLevels = undefined;
    this.bot.numberOfTrades++;
    this.bot.lastExitTime = Date.now(); // Track when we exited

    await this.bot.bbUtil.handlePnL(closedPosition.realizedPnl, false, icon, slippage, timeDiffMs);
    
    eventBus.emit(EEventBusEventType.StateChange);
  }

  async onExit() {
    console.log("Exiting BB Wait For Resolve State");
    this._stopAllWatchers();
  }
}

export default BBWaitForResolveState;

