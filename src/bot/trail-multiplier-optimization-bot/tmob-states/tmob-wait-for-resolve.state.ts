import ExchangeService from "@/services/exchange-service/exchange-service";
import { ICandleInfo, IPosition, IWSOrderUpdate } from "@/services/exchange-service/exchange-type";
import TrailMultiplierOptimizationBot, { TMOBState } from "../trail-multiplier-optimization-bot";
import TelegramService from "@/services/telegram.service";
import BigNumber from "bignumber.js";
import { isTransientError, withRetries } from "../../breakout-bot/bb-retry";

class TMOBWaitForResolveState implements TMOBState {
  private priceListenerRemover?: () => void;
  private orderUpdateRemover?: () => void;
  private trailingUpdaterAbort = false;
  private trailingUpdaterPromise?: Promise<void>;

  constructor(private bot: TrailMultiplierOptimizationBot) {}

  async onEnter() {
    if (!this.bot.currActivePosition) {
      const msg = `currActivePosition is not defined but entering wait for resolve state`;
      console.log(msg);
      throw new Error(msg);
    }

    const msg = `🔁 Waiting for resolve signal - monitoring price for exit...`;
    console.log(msg);
    TelegramService.queueMsg(msg);

    this._watchForPositionExit();
    this._watchForPositionLiquidation();
    this._startTrailingUpdater();
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
    this._stopTrailingUpdater();
  }

  private async _watchForPositionExit() {
    this.priceListenerRemover = ExchangeService.hookPriceListener(this.bot.symbol, (price) => {
      void this._handleExitPriceUpdate(price);
    });
  }

  private async _handleExitPriceUpdate(price: number) {
    try {
      if (!this.bot.currActivePosition) {
        this._clearPriceListener();
        return;
      }

      if (!this.bot.currentSupport || !this.bot.currentResistance) {
        return;
      }

      if (this.bot.lastEntryTime > 0 && this.bot.lastSRUpdateTime <= this.bot.lastEntryTime) {
        return;
      }

      const position = this.bot.currActivePosition;
      let shouldExit = false;
      let exitReason = "";
      const priceBn = new BigNumber(price);
      const one = new BigNumber(1);
      const bufferPct = new BigNumber(this.bot.triggerBufferPercentage || 0).div(100);
      const resistanceBn = this.bot.currentResistance !== null ? new BigNumber(this.bot.currentResistance) : null;
      const supportBn = this.bot.currentSupport !== null ? new BigNumber(this.bot.currentSupport) : null;
      const bufferedResistance = resistanceBn ? resistanceBn.times(one.minus(bufferPct)) : null;
      const bufferedSupport = supportBn ? supportBn.times(one.plus(bufferPct)) : null;

      this.bot.bufferedExitLevels = {
        resistance: bufferedResistance ? bufferedResistance.toNumber() : null,
        support: bufferedSupport ? bufferedSupport.toNumber() : null,
      };

      if (!shouldExit && this.bot.trailingStopTargets && this.bot.trailingStopTargets.side === position.side) {
        const { bufferedLevel, rawLevel } = this.bot.trailingStopTargets;
        if (position.side === "long") {
          if (priceBn.lte(bufferedLevel)) {
            this.bot.trailingStopBreachCount++;
          } else {
            this.bot.trailingStopBreachCount = 0;
          }

          if (this.bot.trailingStopBreachCount >= this.bot.trailConfirmBars) {
            shouldExit = true;
            exitReason = "atr_trailing";
            TelegramService.queueMsg(
              `🟣 Trailing stop (long) triggered\nPrice: ${price}\nBuffered stop: ${bufferedLevel.toFixed(4)}\nRaw stop: ${rawLevel.toFixed(4)}`
            );
          }
        } else {
          if (priceBn.gte(bufferedLevel)) {
            this.bot.trailingStopBreachCount++;
          } else {
            this.bot.trailingStopBreachCount = 0;
          }

          if (this.bot.trailingStopBreachCount >= this.bot.trailConfirmBars) {
            shouldExit = true;
            exitReason = "atr_trailing";
            TelegramService.queueMsg(
              `🟣 Trailing stop (short) triggered\nPrice: ${price}\nBuffered stop: ${bufferedLevel.toFixed(4)}\nRaw stop: ${rawLevel.toFixed(4)}`
            );
          }
        }
      } else if (!shouldExit) {
        this.bot.trailingStopBreachCount = 0;
      }

      if (shouldExit) {
        this._clearPriceListener();
        await this._closeCurrPosition(exitReason);
      }
    } catch (error) {
      console.error("[TMOBWaitForResolveState] Price listener error:", error);
      TelegramService.queueMsg(`⚠️ Exit price listener error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private _startTrailingUpdater() {
    if (this.trailingUpdaterPromise) return;
    this.trailingUpdaterAbort = false;
    this.trailingUpdaterPromise = this._runTrailingUpdaterLoop();
  }

  private _stopTrailingUpdater() {
    this.trailingUpdaterAbort = true;
  }

  private async _runTrailingUpdaterLoop() {
    while (!this.trailingUpdaterAbort) {
      try {
        await this._updateTrailingStopLevels();
      } catch (error) {
        console.error("[TMOBWaitForResolveState] Failed to update trailing stop levels:", error);
      }

      if (this.trailingUpdaterAbort) break;
      const waitMs = this._msUntilNextMinute();
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    this.trailingUpdaterPromise = undefined;
  }

  private _msUntilNextMinute(): number {
    const now = new Date();
    const next = new Date(now.getTime());
    next.setSeconds(0, 0);
    next.setMinutes(now.getMinutes() + 1);
    return Math.max(200, next.getTime() - now.getTime());
  }

  private _watchForPositionLiquidation() {
    this._clearOrderUpdateListener();
    this.orderUpdateRemover = this.bot.orderWatcher?.onOrderUpdate((update) => {
      void this._handleExternalOrderUpdate(update);
    });
  }

  private _calculateAtrValue(candles: ICandleInfo[], period: number): number | null {
    if (period <= 0) return null;
    if (!candles.length || candles.length <= period) return null;

    let trSum = 0;
    const startIdx = candles.length - period;
    for (let idx = startIdx; idx < candles.length; idx++) {
      const current = candles[idx];
      const previous = candles[idx - 1];
      if (!previous) {
        return null;
      }

      const highLow = current.highPrice - current.lowPrice;
      const highPrevClose = Math.abs(current.highPrice - previous.closePrice);
      const lowPrevClose = Math.abs(current.lowPrice - previous.closePrice);
      const trueRange = Math.max(highLow, highPrevClose, lowPrevClose);
      trSum += trueRange;
    }

    return trSum / period;
  }

  private async _updateTrailingStopLevels() {
    const position = this.bot.currActivePosition;
    if (!position) {
      this.bot.resetTrailingStopTracking();
      return;
    }

    const maxWindowLength = Math.max(this.bot.trailingAtrLength + 1, this.bot.trailingHighestLookback);
    if (!Number.isFinite(maxWindowLength) || maxWindowLength <= 0) {
      this.bot.resetTrailingStopTracking();
      return;
    }

    const now = Date.now();
    const windowMinutes = Math.max(maxWindowLength + 5, 60);
    const endDate = new Date(now);
    const startDate = new Date(endDate.getTime() - windowMinutes * 60 * 1000);

    const candles = await withRetries(
      () => ExchangeService.getCandles(this.bot.symbol, startDate, endDate, "1Min"),
      {
        label: "[TMOBWaitForResolveState] getCandles (trailing updater)",
        retries: 5,
        minDelayMs: 5000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) => {
          console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
        },
      }
    );
    const cutoffTs = now - 60 * 1000;
    const finishedCandles = candles.filter((candle) => candle.timestamp <= cutoffTs);

    const atrWindowSize = Math.max(this.bot.trailingAtrLength + 1, 2);
    if (finishedCandles.length < atrWindowSize) {
      return;
    }

    this.bot.trailingAtrWindow = finishedCandles.slice(-atrWindowSize);

    const entryTime = this.bot.lastEntryTime || 0;
    const closesSinceEntry = finishedCandles
      .filter((candle) => entryTime === 0 || candle.timestamp >= entryTime)
      .map((candle) => candle.closePrice);

    if (!closesSinceEntry.length) {
      this.bot.trailingCloseWindow = [];
      this.bot.trailingStopTargets = undefined;
      return;
    }

    this.bot.trailingCloseWindow = closesSinceEntry.slice(-this.bot.trailingHighestLookback);
    this.bot.lastTrailingStopUpdateTime = finishedCandles[finishedCandles.length - 1]?.timestamp || now;

    const atrValue = this._calculateAtrValue(this.bot.trailingAtrWindow, this.bot.trailingAtrLength);
    if (atrValue === null || !Number.isFinite(atrValue) || atrValue <= 0) {
      this.bot.trailingStopTargets = undefined;
      return;
    }

    const closesWindow = this.bot.trailingCloseWindow;
    if (!closesWindow.length) {
      this.bot.trailingStopTargets = undefined;
      return;
    }

    const multiplier = this.bot.trailingStopMultiplier;
    let rawLevel: number | null = null;
    if (position.side === "long") {
      const highestClose = Math.max(...closesWindow);
      rawLevel = highestClose - atrValue * multiplier;
    } else {
      const lowestClose = Math.min(...closesWindow);
      rawLevel = lowestClose + atrValue * multiplier;
    }

    if (rawLevel === null || !Number.isFinite(rawLevel) || rawLevel <= 0) {
      this.bot.trailingStopTargets = undefined;
      return;
    }

    const bufferPct = this.bot.triggerBufferPercentage / 100 || 0;
    let bufferedLevel = rawLevel;
    if (bufferPct > 0) {
      if (position.side === "long") {
        bufferedLevel = rawLevel * (1 + bufferPct);
      } else {
        bufferedLevel = rawLevel * (1 - bufferPct);
      }
    }

    this.bot.trailingStopTargets = {
      side: position.side,
      rawLevel,
      bufferedLevel,
      updatedAt: Date.now(),
    };
  }

  private async _handleExternalOrderUpdate(update: IWSOrderUpdate) {
    if (!this.bot.currActivePosition) return;
    if (update.orderStatus !== "filled") return;

    const activePosition = this.bot.currActivePosition;
    if (!activePosition) return;

    if (update.positionSide && update.positionSide !== activePosition.side) return;

    const normalizedSymbol = update.symbol?.toUpperCase();
    if (normalizedSymbol && normalizedSymbol !== activePosition.symbol.toUpperCase()) return;

    if (this.bot.isBotGeneratedCloseOrder(update.clientOrderId)) return;

    try {
      const closedPosition = await this.bot.fetchClosedPositionSnapshot(activePosition.id);
      if (!closedPosition) {
        console.warn(`[TMOBWaitForResolveState] Closed position snapshot missing for id ${activePosition.id}`);
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
        TelegramService.queueMsg(`
🤯 Position just got liquidated
Pos ID: ${closedPosition.id}
Avg price: ${closedPosition.avgPrice}
Liquidation price: ${closedPosition.liquidationPrice}
Close price: ${closedPosition.closePrice}

Realized PnL: 🟥🟥🟥 ${closedPosition.realizedPnl}
`);
      } else {
        const msg = `⚠️ Active position ${activePosition.id} closed outside bot (order: ${update.clientOrderId || "N/A"}). Recording outcome...`;
        console.warn(msg);
        TelegramService.queueMsg(msg);
      }

      await this.bot.finalizeClosedPosition(closedPosition, {
        activePosition,
        triggerTimestamp: update.updateTime ?? Date.now(),
        fillTimestamp: update.updateTime ?? Date.now(),
        isLiquidation,
        exitReason: isLiquidation ? "liquidation_exit" : "signal_change",
      });
    } catch (error) {
      console.error("[TMOBWaitForResolveState] Failed to process external order update:", error);
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

  private async _closeCurrPosition(reason: string = "support_resistance") {
    const triggerTs = Date.now();
    const activePosition = this.bot.currActivePosition;
    const closedPosition = await this.bot.triggerCloseSignal(this.bot.currActivePosition);
    const fillTimestamp = this.bot.resolveWsPrice?.time ? this.bot.resolveWsPrice.time.getTime() : Date.now();

    await this.bot.finalizeClosedPosition(closedPosition, {
      activePosition,
      triggerTimestamp: triggerTs,
      fillTimestamp,
      isLiquidation: reason === "liquidation_exit",
      exitReason: reason === "atr_trailing" ? "atr_trailing" : "signal_change",
    });
  }

  async onExit() {
    console.log("Exiting TMOB Wait For Resolve State");
    this._stopAllWatchers();
  }
}

export default TMOBWaitForResolveState;