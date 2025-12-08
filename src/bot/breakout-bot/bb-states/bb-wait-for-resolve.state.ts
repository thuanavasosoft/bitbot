import ExchangeService from "@/services/exchange-service/exchange-service";
import { IPosition, IWSOrderUpdate } from "@/services/exchange-service/exchange-type";
import BreakoutBot, { BBState } from "../breakout-bot";
import { parseDurationStringIntoMs } from "@/utils/maths.util";
import TelegramService from "@/services/telegram.service";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import BigNumber from "bignumber.js";

class BBWaitForResolveState implements BBState {
  private priceListenerRemover?: () => void;
  private orderUpdateRemover?: () => void;
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

  private _clearOrderUpdateListener() {
    if (this.orderUpdateRemover) {
      this.orderUpdateRemover();
      this.orderUpdateRemover = undefined;
    }
  }

  private _stopAllWatchers() {
    this._clearPriceListener();
    this._clearOrderUpdateListener();
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

  private _watchForPositionLiquidation() {
    this._clearOrderUpdateListener();
    this.orderUpdateRemover = this.bot.orderWatcher.onOrderUpdate((update) => {
      void this._handleExternalOrderUpdate(update);
    });
  }

  private async _handleExternalOrderUpdate(update: IWSOrderUpdate) {
    if (!this.bot.currActivePosition) return;
    if (update.orderStatus !== "filled") return;

    const activePosition = this.bot.currActivePosition;
    if (!activePosition) return;

    if (update.positionSide && update.positionSide !== activePosition.side) return;

    const normalizedSymbol = update.symbol?.toUpperCase();
    if (normalizedSymbol && normalizedSymbol !== activePosition.symbol.toUpperCase()) return;

    if (update.clientOrderId?.startsWith("bb-close-")) return;

    try {
      const closedPosition = await this.bot.fetchClosedPositionSnapshot(activePosition.id);
      if (!closedPosition) {
        console.warn(`[BBWaitForResolveState] Closed position snapshot missing for id ${activePosition.id}`);
        return;
      }

      const resolvePrice = update.executionPrice ?? closedPosition.closePrice ?? closedPosition.avgPrice;
      const resolveTime = update.updateTime ? new Date(update.updateTime) : new Date();
      this.bot.resolveWsPrice = {
        price: resolvePrice,
        time: resolveTime,
      };

      const isLiquidation = this._isLiquidationClose(closedPosition);
      if (isLiquidation) {
        console.log("Liquidated position detected via websocket:", closedPosition);
        TelegramService.queueMsg(`
🤯 Position just got liquidated
Pos ID: ${closedPosition.id}
Avg price: ${closedPosition.avgPrice}
Liquidation price: ${closedPosition.liquidationPrice}
Close price: ${closedPosition.closePrice}

Realized PnL: 🟥🟥🟥 ${closedPosition.realizedPnl}
`);
        this.bot.liquidationSleepFinishTs = Date.now() + parseDurationStringIntoMs(this.bot.sleepDurationAfterLiquidation);
      } else {
        const msg = `⚠️ Active position ${activePosition.id} closed outside bot (order: ${update.clientOrderId || "N/A"}). Recording outcome...`;
        console.warn(msg);
        TelegramService.queueMsg(msg);
      }

      await this._finalizeClosedPosition(closedPosition, {
        activePosition,
        triggerTimestamp: update.updateTime ?? Date.now(),
        fillTimestamp: update.updateTime ?? Date.now(),
        isLiquidation,
      });
    } catch (error) {
      console.error("[BBWaitForResolveState] Failed to process external order update:", error);
    }
  }

  private _isLiquidationClose(position: IPosition): boolean {
    const closePrice = typeof position.closePrice === "number" ? position.closePrice : position.avgPrice;
    if (!Number.isFinite(closePrice) || !Number.isFinite(position.liquidationPrice)) return false;

    const closePriceBn = new BigNumber(closePrice);
    if (position.side === "long") {
      return closePriceBn.lte(position.liquidationPrice);
    }
    return closePriceBn.gte(position.liquidationPrice);
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
    const triggerTs = Date.now();
    const activePosition = this.bot.currActivePosition;
    const closedPosition = await this.bot.triggerCloseSignal(this.bot.currActivePosition);
    const fillTimestamp = this.bot.resolveWsPrice?.time ? this.bot.resolveWsPrice.time.getTime() : Date.now();

    await this._finalizeClosedPosition(closedPosition, {
      activePosition,
      triggerTimestamp: triggerTs,
      fillTimestamp,
      isLiquidation: false,
    });
  }

  private async _finalizeClosedPosition(
    closedPosition: IPosition,
    options: {
      activePosition?: IPosition;
      triggerTimestamp?: number;
      fillTimestamp?: number;
      isLiquidation?: boolean;
    } = {}
  ) {
    const activePosition = options.activePosition ?? this.bot.currActivePosition;
    const positionSide = activePosition?.side;
    const fillTimestamp = options.fillTimestamp ?? this.bot.resolveWsPrice?.time?.getTime() ?? closedPosition.updateTime ?? Date.now();
    const triggerTimestamp = options.triggerTimestamp ?? fillTimestamp;
    const shouldTrackSlippage = !options.isLiquidation;

    const closedPrice = typeof closedPosition.closePrice === "number" ? closedPosition.closePrice : closedPosition.avgPrice;

    let srLevel: number | null = null;
    if (this.bot.fractionalStopTargets && this.bot.fractionalStopTargets.side === positionSide) {
      srLevel = this.bot.fractionalStopTargets.rawLevel;
    } else if (positionSide === "long") {
      srLevel = this.bot.currentSupport;
    } else if (positionSide === "short") {
      srLevel = this.bot.currentResistance;
    }

    let slippage = 0;
    const timeDiffMs = fillTimestamp - triggerTimestamp;

    if (shouldTrackSlippage) {
      if (srLevel === null) {
        console.warn(`⚠️ Cannot calculate slippage: ${positionSide === "long" ? "support/fractional stop" : "resistance/fractional stop"} level is null`);
        TelegramService.queueMsg(`⚠️ Warning: Cannot calculate slippage - ${positionSide === "long" ? "support/fractional stop" : "resistance/fractional stop"} level not available`);
      } else {
        slippage = positionSide === "short"
          ? new BigNumber(closedPrice).minus(srLevel).toNumber()
          : new BigNumber(srLevel).minus(closedPrice).toNumber();
      }
    }

    const icon = slippage <= 0 ? "🟩" : "🟥";
    if (shouldTrackSlippage) {
      if (icon === "🟥") {
        this.bot.slippageAccumulation += Math.abs(slippage);
      } else {
        this.bot.slippageAccumulation -= Math.abs(slippage);
      }
    }

    this.bot.currActivePosition = undefined;
    this.bot.entryWsPrice = undefined;
    this.bot.resolveWsPrice = undefined;
    this.bot.fractionalStopTargets = undefined;
    this.bot.bufferedExitLevels = undefined;
    if (!options.isLiquidation) {
      this.bot.numberOfTrades++;
    }
    this.bot.lastExitTime = Date.now();

    await this.bot.bbUtil.handlePnL(
      closedPosition.realizedPnl,
      options.isLiquidation ?? false,
      shouldTrackSlippage ? icon : undefined,
      shouldTrackSlippage ? slippage : undefined,
      shouldTrackSlippage ? timeDiffMs : undefined,
    );

    eventBus.emit(EEventBusEventType.StateChange);
  }

  async onExit() {
    console.log("Exiting BB Wait For Resolve State");
    this._stopAllWatchers();
  }
}

export default BBWaitForResolveState;

