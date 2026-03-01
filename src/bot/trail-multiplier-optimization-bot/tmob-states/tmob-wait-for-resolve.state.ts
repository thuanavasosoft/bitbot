import ExchangeService from "@/services/exchange-service/exchange-service";
import { ICandleInfo, IPosition, IWSOrderUpdate } from "@/services/exchange-service/exchange-type";
import TrailMultiplierOptimizationBot, { TMOBState } from "../trail-multiplier-optimization-bot";
import TelegramService from "@/services/telegram.service";
import BigNumber from "bignumber.js";
import { isTransientError, withRetries } from "../../breakout-bot/bb-retry";
import { toIso } from "@/bot/auto-adjust-bot/candle-utils";

export type TickRoundMode = "up" | "down" | "nearest";

class TMOBWaitForResolveState implements TMOBState {
  private ltpListenerRemover?: () => void;
  private orderUpdateRemover?: () => void;
  private trailingUpdaterAbort = false;
  private trailingUpdaterRunId = 0;
  private trailingSleepTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private trailingSleepWake?: () => void;
  private liquidationCheckInProgress = false;
  private liquidationAlertAlreadySent = false;
  private liquidationCheckIntervalId: ReturnType<typeof setInterval> | null = null;
  private lastPrice = 0;
  private static readonly LIQUIDATION_CHECK_INTERVAL_MS = 5_000;

  constructor(private bot: TrailMultiplierOptimizationBot) { }

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
    const trailingRunId = this._startTrailingUpdater();
    void this._updateTrailingStopLevels(trailingRunId).catch((error) => {
      console.error("[TMOBWaitForResolveState] Failed to update trailing stop levels (onEnter):", error);
    });
  }

  private _clearPriceListener() {
    if (this.ltpListenerRemover) {
      this.ltpListenerRemover();
      this.ltpListenerRemover = undefined;
    }
  }

  private _clearOrderUpdateListener() {
    if (this.orderUpdateRemover) {
      this.orderUpdateRemover();
      this.orderUpdateRemover = undefined;
    }
  }

  private _clearLiquidationCheckInterval() {
    if (this.liquidationCheckIntervalId != null) {
      clearInterval(this.liquidationCheckIntervalId);
      this.liquidationCheckIntervalId = null;
    }
  }

  private _stopAllWatchers() {
    this._clearPriceListener();
    this._clearOrderUpdateListener();
    this._clearLiquidationCheckInterval();
    this._stopTrailingUpdater();
  }

  private async _watchForPositionExit() {
    this.ltpListenerRemover = ExchangeService.hookTradeListener(this.bot.symbol, (trade) => {
      void this._handleExitPriceUpdate(trade.price);
    });
  }

  private async _handleExitPriceUpdate(price: number) {
    try {
      this.lastPrice = price;
      if (!this.bot.currActivePosition) {
        this._clearPriceListener();
        this._clearLiquidationCheckInterval();
        return;
      }

      const position = this.bot.currActivePosition;
      const hasValidLiquidationPrice = Number.isFinite(position.liquidationPrice) && position.liquidationPrice > 0;

      const priceBn = new BigNumber(price);
      const liqBn = new BigNumber(position.liquidationPrice);
      const priceInLiquidationZone =
        hasValidLiquidationPrice &&
        ((position.side === "long" && priceBn.lte(liqBn)) || (position.side === "short" && priceBn.gte(liqBn)));

      if (priceInLiquidationZone) {
        if (!this.liquidationAlertAlreadySent) {
          TelegramService.queueMsg(
            `⚠️ Mark price crossed liquidation threshold!\nSymbol: ${this.bot.symbol}\nCurrent price: ${price}\nLiquidation price: ${position.liquidationPrice}\nPosition side: ${position.side}\n\nChecking if position is liquidated via REST API every ${TMOBWaitForResolveState.LIQUIDATION_CHECK_INTERVAL_MS / 1000}s.`
          );
          this.liquidationAlertAlreadySent = true;
        }
        if (!this.liquidationCheckIntervalId) {
          void this._runLiquidationCheck();
          this.liquidationCheckIntervalId = setInterval(() => {
            void this._runLiquidationCheck();
          }, TMOBWaitForResolveState.LIQUIDATION_CHECK_INTERVAL_MS);
        }
      } else {
        if (this.liquidationCheckIntervalId != null) {
          this._clearLiquidationCheckInterval();
          await this._runLiquidationCheck();
        }
      }

      if (!this.bot.currentSupport || !this.bot.currentResistance) {
        return;
      }

      if (this.bot.lastEntryTime > 0 && this.bot.lastSRUpdateTime <= this.bot.lastEntryTime) {
        return;
      }

      let shouldExit = false;
      let exitReason = "";
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

  private _wakeTrailingSleep() {
    if (this.trailingSleepTimeoutId != null) {
      clearTimeout(this.trailingSleepTimeoutId);
      this.trailingSleepTimeoutId = null;
    }
    if (this.trailingSleepWake) {
      const wake = this.trailingSleepWake;
      this.trailingSleepWake = undefined;
      wake();
    }
  }

  private _startTrailingUpdater(): number {
    this.trailingUpdaterAbort = false;
    const runId = ++this.trailingUpdaterRunId;
    this._wakeTrailingSleep();
    void this._runTrailingUpdaterLoop(runId);
    return runId;
  }

  private _stopTrailingUpdater() {
    this.trailingUpdaterAbort = true;
    this._wakeTrailingSleep();
  }

  private async _sleepUntilNextMinuteOrWake(runId: number): Promise<void> {
    const waitMs = this._msUntilNextMinute();
    await new Promise<void>((resolve) => {
      if (this.trailingUpdaterAbort || this.trailingUpdaterRunId !== runId) {
        resolve();
        return;
      }
      this.trailingSleepWake = resolve;
      this.trailingSleepTimeoutId = setTimeout(() => {
        this.trailingSleepTimeoutId = null;
        this.trailingSleepWake = undefined;
        resolve();
      }, waitMs);
    });
  }

  private async _runTrailingUpdaterLoop(runId: number) {
    try {
      while (!this.trailingUpdaterAbort && this.trailingUpdaterRunId === runId) {
        try {
          await this._updateTrailingStopLevels(runId);
        } catch (error) {
          console.error("[TMOBWaitForResolveState] Failed to update trailing stop levels:", error);
        }

        if (this.trailingUpdaterAbort || this.trailingUpdaterRunId !== runId) break;
        await this._sleepUntilNextMinuteOrWake(runId);
      }
    } finally {
      if (this.trailingSleepTimeoutId != null) {
        clearTimeout(this.trailingSleepTimeoutId);
        this.trailingSleepTimeoutId = null;
      }
      if (this.trailingSleepWake) {
        this.trailingSleepWake = undefined;
      }
    }
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

  private async _runLiquidationCheck(): Promise<void> {
    if (this.liquidationCheckInProgress || !this.bot.currActivePosition) {
      console.log("Liquidation check in progress by order update listener or no active position, skipping _runLiquidationCheck...");
      return;
    }
    this.liquidationCheckInProgress = true;
    try {
      const finalized = await this._checkAndFinalizeLiquidationByPrice(this.lastPrice);
      if (finalized) {
        this._clearLiquidationCheckInterval();
        this._stopAllWatchers();
      }
    } finally {
      this.liquidationCheckInProgress = false;
    }
  }

  /**
   * When mark price has crossed liquidation price, check if position was closed by liquidation via REST
   * and finalize so we catch liquidations even when ORDER_TRADE_UPDATE is not received.
   */
  private async _checkAndFinalizeLiquidationByPrice(lastPrice: number): Promise<boolean> {
    const activePosition = this.bot.currActivePosition;
    if (!activePosition) return false;
    try {
      const positionHistory = await ExchangeService.getPositionsHistory({ symbol: activePosition.symbol });
      if (!positionHistory.length) return false;

      const closedPosition = positionHistory.find((p) => {
        const isCorrectSize = p.size === activePosition.size;
        const isCorrectSide = p.side === activePosition.side;
        const isCorrectSymbol = p.symbol === activePosition.symbol;

        return isCorrectSize && isCorrectSide && isCorrectSymbol;
      });
      if (!closedPosition) return false;
      closedPosition.avgPrice = activePosition.avgPrice;
      closedPosition.liquidationPrice = activePosition.liquidationPrice;
      closedPosition.notional = activePosition.notional;
      closedPosition.leverage = activePosition.leverage;
      closedPosition.initialMargin = activePosition.initialMargin;
      closedPosition.maintenanceMargin = activePosition.maintenanceMargin;
      closedPosition.marginMode = activePosition.marginMode;

      if (!this._isLiquidationClose(closedPosition)) return false;

      const resolvePrice = closedPosition.closePrice ?? closedPosition.avgPrice ?? lastPrice;
      this.bot.resolveWsPrice = {
        price: resolvePrice,
        time: new Date(),
      };

      TelegramService.queueMsg(this._formatLiquidationMessage(closedPosition));

      await this.bot.finalizeClosedPosition(closedPosition, {
        activePosition,
        triggerTimestamp: closedPosition.createTime ?? Date.now(),
        fillTimestamp: closedPosition.updateTime ?? Date.now(),
        isLiquidation: true,
        exitReason: "liquidation_exit",
      });
      return true;
    } catch (error) {
      console.error("[TMOBWaitForResolveState] Failed to check/finalize liquidation by price:", error);
      return false;
    }
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

  async _updateTrailingStopLevels(runId?: number) {
    if (runId !== undefined && (this.trailingUpdaterAbort || this.trailingUpdaterRunId !== runId)) {
      return;
    }
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
    if (runId !== undefined && (this.trailingUpdaterAbort || this.trailingUpdaterRunId !== runId)) {
      return;
    }
    const cutoffTs = now - 60 * 1000;
    const finishedCandles = candles.filter((candle) => candle.timestamp <= cutoffTs);

    const atrWindowSize = Math.max(this.bot.trailingAtrLength + 1, 2);
    if (finishedCandles.length < atrWindowSize) {
      return;
    }

    this.bot.trailingAtrWindow = finishedCandles.slice(-atrWindowSize);

    const entryTime = this.bot.lastEntryTime || 0;
    // Align entry time to the 1-minute candle boundary so the first finished candle after entry
    // is eligible, avoiding a common ~2-minute delay when entry occurs mid-minute.
    const alignedEntryTime = entryTime === 0 ? 0 : Math.floor(entryTime / 60_000) * 60_000;
    const closesSinceEntry = finishedCandles
      .filter((candle) => alignedEntryTime === 0 || candle.timestamp >= alignedEntryTime)
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
      const candidateStop = highestClose - atrValue * multiplier;
      if (candidateStop > 0) {
        rawLevel = this._quantizeToTick(candidateStop, "up");
      }
    } else {
      const lowestClose = Math.min(...closesWindow);
      const candidateStop = lowestClose + atrValue * multiplier;
      if (candidateStop > 0) {
        rawLevel = this._quantizeToTick(candidateStop, "down");
      }
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

    if (this.liquidationCheckInProgress) {
      console.log("Liquidation check in progress, skipping _handleExternalOrderUpdate...");
      return;
    }
    this.liquidationCheckInProgress = true;
    try {
      const closedPosition = await this.bot.fetchClosedPositionSnapshot(activePosition.id);
      if (!closedPosition) {
        console.warn(`[TMOBWaitForResolveState] Closed position snapshot missing for id ${activePosition.id}`);
        TelegramService.queueMsg(`[TMOBWaitForResolveState] Closed position snapshot missing for id ${activePosition.id} waiting for next update...`);
        return;
      }

      const resolvePrice = update.executionPrice ?? closedPosition.closePrice ?? closedPosition.avgPrice;
      const resolveTime = update.updateTime ? new Date(update.updateTime) : new Date();
      this.bot.resolveWsPrice = {
        price: resolvePrice,
        time: resolveTime,
      };

      const isLiquidation = this._isLiquidationClose(closedPosition) || ["auto-close-", "autoclose"].some(prefix => update.clientOrderId?.toLowerCase().startsWith(prefix));
      if (isLiquidation) {
        TelegramService.queueMsg(this._formatLiquidationMessage(closedPosition));
      } else {
        TelegramService.queueMsg("Position is closed manually from dashboard");
        const detail =
          `Symbol: ${this.bot.symbol}\n` +
          `Position ID: ${activePosition.id}\n` +
          `Order: ${update.clientOrderId || "N/A"}\n` +
          `Recording outcome...`;
        console.warn(detail);
        TelegramService.queueMsg(detail);
      }

      await this.bot.finalizeClosedPosition(closedPosition, {
        activePosition,
        triggerTimestamp: update.updateTime ?? Date.now(),
        fillTimestamp: update.updateTime ?? Date.now(),
        isLiquidation,
        exitReason: isLiquidation ? "liquidation_exit" : "signal_change",
      });
      this._clearLiquidationCheckInterval();
      this._stopAllWatchers();
    } catch (error) {
      console.error("[TMOBWaitForResolveState] Failed to process external order update:", error);
    } finally {
      this.liquidationCheckInProgress = false;
    }
  }

  private _formatLiquidationMessage(closedPosition: IPosition): string {
    return `
🤯 Position just got liquidated at ${toIso(closedPosition.updateTime ?? closedPosition.createTime)}
Pos ID: ${closedPosition.id}
Avg price: ${closedPosition.avgPrice}
Liquidation price: ${closedPosition.liquidationPrice}
Close price: ${closedPosition.closePrice}

Realized PnL: 🟥🟥🟥 ${closedPosition.realizedPnl}
`;
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

  _quantizeToTick(price: number, mode: TickRoundMode, withLogs?: boolean): number {
    if (!Number.isFinite(price)) return price;
    const tickSize = this.bot.tickSize;
    if (!Number.isFinite(tickSize) || tickSize <= 0) return price;
    const p = new BigNumber(price);
    const t = new BigNumber(tickSize);
    const q = p.div(t);

    const rounded =
      mode === "up"
        ? q.integerValue(BigNumber.ROUND_CEIL)
        : mode === "down"
          ? q.integerValue(BigNumber.ROUND_FLOOR)
          : q.integerValue(BigNumber.ROUND_HALF_UP);
    const tick = rounded.times(t).toNumber();
    return tick;
  };
}

export default TMOBWaitForResolveState;