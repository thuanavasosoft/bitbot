import ExchangeService from "@/services/exchange-service/exchange-service";
import { ICandleInfo, IPosition, IWSOrderUpdate } from "@/services/exchange-service/exchange-type";
import BigNumber from "bignumber.js";
import { withRetries, isTransientError } from "../comb-retry";
import type CombBotInstance from "../comb-bot-instance";
import { TickRoundMode } from "@/bot/trail-multiplier-optimization-bot/tmob-states/tmob-wait-for-resolve.state";

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

class CombWaitForResolveState {
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
  private tpPullbackCloseInProgress = false;
  private static readonly LIQUIDATION_CHECK_INTERVAL_MS = 5_000;

  constructor(private bot: CombBotInstance) { }

  /** Recalculate trailing stop levels (e.g. after temp_tm change). Call before refreshChart to show updated trail stop. */
  async refreshTrailingStopLevels(): Promise<void> {
    await this._updateTrailingStopLevels();
  }

  async onEnter() {
    if (!this.bot.currActivePosition) {
      const msg = `[COMB] ${this.bot.symbol} currActivePosition is not defined but entering wait for resolve state`;
      console.log(msg);
      throw new Error(msg);
    }

    const msg = `🔁 Waiting for resolve signal - monitoring price for exit...`;
    console.log(`[COMB] CombWaitForResolveState onEnter symbol=${this.bot.symbol} positionId=${this.bot.currActivePosition?.id} side=${this.bot.currActivePosition?.side}`);
    this.bot.queueMsg(msg);

    this._watchForPositionExit();
    this._watchForPositionLiquidation();
    const trailingRunId = this._startTrailingUpdater();
    void this._updateTrailingStopLevels(trailingRunId).catch((error) => {
      console.error("[COMB] Failed to update trailing stop levels (onEnter):", error);
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

  private _watchForPositionExit() {
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
          console.log(
            `[COMB LIQ CHECK] price entered liquidation zone symbol=${this.bot.symbol} positionId=${position.id} price=${price} liqPrice=${position.liquidationPrice} side=${position.side}`
          );
          this.bot.queueMsg(
            `⚠️ Mark price crossed liquidation threshold!\nSymbol: ${this.bot.symbol}\nCurrent price: ${price}\nLiquidation price: ${position.liquidationPrice}\nPosition side: ${position.side}\n\nChecking if position is liquidated via REST API every ${CombWaitForResolveState.LIQUIDATION_CHECK_INTERVAL_MS / 1000}s.`
          );
          this.liquidationAlertAlreadySent = true;
        }
        if (!this.liquidationCheckIntervalId) {
          console.log("[COMB LIQ CHECK] starting liquidation check interval (every 5s)");
          void this._runLiquidationCheck();
          this.liquidationCheckIntervalId = setInterval(() => {
            void this._runLiquidationCheck();
          }, CombWaitForResolveState.LIQUIDATION_CHECK_INTERVAL_MS);
        }
      } else {
        if (this.liquidationCheckIntervalId != null) {
          console.log("[COMB LIQ CHECK] price left liquidation zone, clearing interval and running one final check");
          this._clearLiquidationCheckInterval();
          await this._runLiquidationCheck()
        }
      }

      let shouldExit = false;
      let exitReason = "";

      // Take profit on pullback: close when price pulls back X% from highest (long) or lowest (short). Runs without SR.
      if (!shouldExit && this.bot.tpPullbackPercent > 0 && !this.bot.justManuallyClosedBy) {
        const entryPrice = this.bot.entryWsPrice?.price ?? position.avgPrice;
        if (position.side === "long") {
          const prev = this.bot.highestPriceSinceEntry;
          this.bot.highestPriceSinceEntry = prev != null ? Math.max(prev, price) : Math.max(entryPrice, price);
          const threshold = this.bot.highestPriceSinceEntry * (1 - this.bot.tpPullbackPercent / 100);
          if (priceBn.lte(threshold)) {
            shouldExit = true;
            exitReason = "tp_pullback";
            this.bot.justManuallyClosedBy = "tp_pb"; // Set immediately to prevent concurrent price updates from re-triggering
            console.log(
              `[COMB] waitForResolve TP_PB triggered (long) symbol=${this.bot.symbol} price=${price} highest=${this.bot.highestPriceSinceEntry} threshold=${threshold}`
            );
            this.bot.queueMsg(
              `📉 TP pullback (long) triggered\nPrice: ${price}\nHighest: ${this.bot.highestPriceSinceEntry}\nPullback: ${this.bot.tpPullbackPercent}%`
            );
          }
        } else {
          const prev = this.bot.lowestPriceSinceEntry;
          this.bot.lowestPriceSinceEntry = prev != null ? Math.min(prev, price) : Math.min(entryPrice, price);
          const threshold = this.bot.lowestPriceSinceEntry * (1 + this.bot.tpPullbackPercent / 100);
          if (priceBn.gte(threshold)) {
            shouldExit = true;
            exitReason = "tp_pullback";
            this.bot.justManuallyClosedBy = "tp_pb"; // Set immediately to prevent concurrent price updates from re-triggering
            console.log(
              `[COMB] waitForResolve TP_PB triggered (short) symbol=${this.bot.symbol} price=${price} lowest=${this.bot.lowestPriceSinceEntry} threshold=${threshold}`
            );
            this.bot.queueMsg(
              `📈 TP pullback (short) triggered\nPrice: ${price}\nLowest: ${this.bot.lowestPriceSinceEntry}\nPullback: ${this.bot.tpPullbackPercent}%`
            );
          }
        }
      }

      if (!this.bot.currentSupport || !this.bot.currentResistance) {
        if (shouldExit) {
          if (exitReason === "tp_pullback") {
            await this._handleTpPullbackClose();
          } else {
            this._clearPriceListener();
            await this._closeCurrPosition(exitReason);
          }
        }
        return;
      }

      if (this.bot.lastEntryTime > 0 && this.bot.lastSRUpdateTime <= this.bot.lastEntryTime) {
        if (shouldExit && exitReason === "tp_pullback") {
          await this._handleTpPullbackClose();
        } else if (shouldExit) {
          this._clearPriceListener();
          await this._closeCurrPosition(exitReason);
        }
        return;
      }

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
            console.log(
              `[COMB] waitForResolve trailingStopTriggered symbol=${this.bot.symbol} side=long price=${price} bufferedLevel=${bufferedLevel} rawLevel=${rawLevel}`
            );
            this.bot.queueMsg(
              `🟣 Trailing stop (long) triggered\nPrice: ${price}\nBuffered stop: ${bufferedLevel}\nRaw stop: ${rawLevel}`
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
            console.log(
              `[COMB] waitForResolve trailingStopTriggered symbol=${this.bot.symbol} side=short price=${price} bufferedLevel=${bufferedLevel} rawLevel=${rawLevel}`
            );
            this.bot.queueMsg(
              `🟣 Trailing stop (short) triggered\nPrice: ${price}\nBuffered stop: ${bufferedLevel}\nRaw stop: ${rawLevel}`
            );
          }
        }
      } else if (!shouldExit) {
        this.bot.trailingStopBreachCount = 0;
      }

      if (shouldExit) {
        if (exitReason === "tp_pullback") {
          await this._handleTpPullbackClose();
          // Do not clear price listener - watchers stay running so trailing stop can trigger and reset state
        } else {
          this._clearPriceListener();
          await this._closeCurrPosition(exitReason);
        }
      }
    } catch (error) {
      console.error("[COMB] WaitForResolve price listener error:", error);
      this.bot.queueMsg(`⚠️ Exit price listener error: ${error instanceof Error ? error.message : String(error)}`);
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
          console.error("[COMB] Failed to update trailing stop levels:", error);
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
      if (!this.bot.currActivePosition) {
        console.log("[COMB LIQ CHECK] _runLiquidationCheck skipped: no currActivePosition");
      } else if (this.liquidationCheckInProgress) {
        console.log("[COMB LIQ CHECK] _runLiquidationCheck skipped: check already in progress");
      }
      return;
    }
    this.liquidationCheckInProgress = true;
    console.log(
      `[COMB LIQ CHECK] _runLiquidationCheck started symbol=${this.bot.symbol} positionId=${this.bot.currActivePosition.id} lastPrice=${this.lastPrice}`
    );
    try {
      const finalized = await this._checkAndFinalizeLiquidationByPrice(this.lastPrice);
      if (finalized) {
        console.log("[COMB LIQ CHECK] _runLiquidationCheck finalized=true, clearing interval and stopping watchers");
        this._clearLiquidationCheckInterval();
        this._stopAllWatchers();
      } else {
        console.log("[COMB LIQ CHECK] _runLiquidationCheck finalized=false, will retry on next interval");
      }
    } finally {
      this.liquidationCheckInProgress = false;
    }
  }

  private async _checkAndFinalizeLiquidationByPrice(lastPrice: number): Promise<boolean> {
    const activePosition = this.bot.currActivePosition;
    if (!activePosition) return false;
    console.log(
      `[COMB LIQ CHECK] _checkAndFinalizeLiquidationByPrice entry symbol=${activePosition.symbol} positionId=${activePosition.id} side=${activePosition.side} lastPrice=${lastPrice} liqPrice=${activePosition.liquidationPrice} size=${activePosition.size}`
    );
    try {
      // Check 1: Try positionId-based lookup (most reliable)
      let closedPosition: IPosition | null = null;
      const positionHistoryById = await withRetries(
        () => ExchangeService.getPositionsHistory({ positionId: activePosition.id }),
        {
          label: "[COMB] getPositionsHistory (positionId)",
          retries: 5,
          minDelayMs: 5000,
          isTransientError,
          onRetry: ({ attempt, delayMs, error, label }) => console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
        }
      );
      console.log(
        `[COMB LIQ CHECK] check 1 (positionId): historyCount=${positionHistoryById.length}`
      );
      if (positionHistoryById.length > 0) {
        const found = positionHistoryById.find((p) => p.id === activePosition.id) ?? positionHistoryById[0];
        const isLiq = this._isLiquidationClose({ ...found, liquidationPrice: activePosition.liquidationPrice });
        console.log(
          `[COMB LIQ CHECK] check 1 found closedPosition id=${found.id} closePrice=${found.closePrice} isLiquidationClose=${isLiq}`
        );
        if (isLiq) {
          closedPosition = found;
        }
      }

      // Check 2: Fallback to symbol-based lookup with size/side/symbol match
      if (!closedPosition) {
        console.log("[COMB LIQ CHECK] check 2 (symbol): fetching history by symbol");
        const positionHistoryBySymbol = await withRetries(
          () => ExchangeService.getPositionsHistory({ symbol: activePosition.symbol }),
          {
            label: "[COMB] getPositionsHistory (symbol)",
            retries: 5,
            minDelayMs: 5000,
            isTransientError,
            onRetry: ({ attempt, delayMs, error, label }) => console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
          }
        );
        const matched = positionHistoryBySymbol.find((p) => {
          return p.size === activePosition.size && p.side === activePosition.side && p.symbol === activePosition.symbol;
        });
        const isLiq = matched ? this._isLiquidationClose({ ...matched, liquidationPrice: activePosition.liquidationPrice }) : false;
        console.log(
          `[COMB LIQ CHECK] check 2 (symbol): historyCount=${positionHistoryBySymbol.length} matched=${!!matched} isLiquidationClose=${isLiq}${matched ? ` matchedId=${matched.id} matchedSize=${matched.size}` : ""}`
        );
        if (matched && isLiq) {
          closedPosition = matched;
        }
      }

      // Check 3: Fallback - infer liquidation from current account position (our position is gone)
      if (!closedPosition) {
        console.log("[COMB LIQ CHECK] check 3 (infer from current position): calling _tryInferLiquidationFromCurrentPosition");
        const inferred = await this._tryInferLiquidationFromCurrentPosition(activePosition, lastPrice);
        if (inferred) closedPosition = inferred;
        console.log(`[COMB LIQ CHECK] check 3 result: inferred=${!!inferred}`);
      }

      if (!closedPosition) {
        console.log("[COMB LIQ CHECK] all checks failed: no closed position found, not liquidated (or not yet visible)");
        return false;
      }

      closedPosition.avgPrice = activePosition.avgPrice;
      closedPosition.liquidationPrice = activePosition.liquidationPrice;
      closedPosition.notional = activePosition.notional;
      closedPosition.leverage = activePosition.leverage;
      closedPosition.initialMargin = activePosition.initialMargin;
      closedPosition.maintenanceMargin = activePosition.maintenanceMargin;
      closedPosition.marginMode = activePosition.marginMode;

      console.log(
        `[COMB LIQ CHECK] finalizing liquidation symbol=${this.bot.symbol} positionId=${closedPosition.id} closePrice=${closedPosition.closePrice} realizedPnl=${closedPosition.realizedPnl}`
      );
      console.log(
        `[COMB] waitForResolve liquidationConfirmed symbol=${this.bot.symbol} positionId=${closedPosition.id} closePrice=${closedPosition.closePrice} realizedPnl=${closedPosition.realizedPnl}`
      );
      const resolvePrice = closedPosition.closePrice ?? closedPosition.avgPrice ?? lastPrice;
      this.bot.resolveWsPrice = { price: resolvePrice, time: new Date() };

      this.bot.queueMsg(this._formatLiquidationMessage(closedPosition));

      await this.bot.finalizeClosedPosition(closedPosition, {
        activePosition,
        triggerTimestamp: closedPosition.createTime ?? Date.now(),
        fillTimestamp: closedPosition.updateTime ?? Date.now(),
        isLiquidation: true,
        exitReason: "liquidation_exit",
      });
      return true;
    } catch (error) {
      console.error("[COMB LIQ CHECK] _checkAndFinalizeLiquidationByPrice error:", error);
      return false;
    }
  }

  /**
   * Last-resort fallback: if both position history checks fail, infer liquidation by checking
   * current account position. If our position is gone (no position or different side),
   * assume liquidation and create a synthetic closed position with PnL = -(100% of initial margin).
   */
  private async _tryInferLiquidationFromCurrentPosition(
    activePosition: IPosition,
    lastPrice: number
  ): Promise<IPosition | null> {
    try {
      console.log(
        `[COMB LIQ CHECK] _tryInferLiquidationFromCurrentPosition entry symbol=${activePosition.symbol} positionId=${activePosition.id} side=${activePosition.side} lastPrice=${lastPrice}`
      );
      const currentPosition = await withRetries(
        () => ExchangeService.getPosition(activePosition.symbol),
        {
          label: "[COMB] getPosition (liquidation infer)",
          retries: 5,
          minDelayMs: 5000,
          isTransientError,
          onRetry: ({ attempt, delayMs, error, label }) => console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
        }
      );
      const ourPositionGone =
        !currentPosition || currentPosition.side !== activePosition.side;

      console.log(
        `[COMB LIQ CHECK] _tryInferLiquidationFromCurrentPosition currentPosition=${currentPosition ? `id=${currentPosition.id} side=${currentPosition.side}` : "none"} ourPositionGone=${ourPositionGone}`
      );

      if (!ourPositionGone) return null;

      const marginLost = Math.abs(activePosition.initialMargin) || Math.abs(activePosition.maintenanceMargin) || 0;
      const realizedPnl = marginLost > 0 ? -marginLost : 0;

      console.log(
        `[COMB LIQ CHECK] _tryInferLiquidationFromCurrentPosition inferring liquidation marginLost=${marginLost} realizedPnl=${realizedPnl}`
      );
      console.log(
        `[COMB] waitForResolve liquidationInferredFromCurrentPosition symbol=${this.bot.symbol} positionId=${activePosition.id} ` +
        `(currentPosition=${currentPosition ? `id=${currentPosition.id} side=${currentPosition.side}` : "none"}) realizedPnl=${realizedPnl}`
      );

      const syntheticClosed: IPosition = {
        ...activePosition,
        closePrice: lastPrice > 0 ? lastPrice : activePosition.liquidationPrice ?? activePosition.avgPrice,
        realizedPnl,
        updateTime: Date.now(),
      };
      return syntheticClosed;
    } catch (error) {
      console.error("[COMB LIQ CHECK] _tryInferLiquidationFromCurrentPosition error:", error);
      console.error("[COMB] Failed to infer liquidation from current position:", error);
      return null;
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
      if (!previous) return null;

      const highLow = current.highPrice - current.lowPrice;
      const highPrevClose = Math.abs(current.highPrice - previous.closePrice);
      const lowPrevClose = Math.abs(current.lowPrice - previous.closePrice);
      const trueRange = Math.max(highLow, highPrevClose, lowPrevClose);
      trSum += trueRange;
    }
    return trSum / period;
  }

  private async _updateTrailingStopLevels(runId?: number) {
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
        label: "[COMB] getCandles (trailing updater)",
        retries: 5,
        minDelayMs: 5000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) => console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
      }
    );
    if (runId !== undefined && (this.trailingUpdaterAbort || this.trailingUpdaterRunId !== runId)) {
      return;
    }
    const cutoffTs = now - 60 * 1000;
    const finishedCandles = candles.filter((c) => c.timestamp <= cutoffTs);

    const atrWindowSize = Math.max(this.bot.trailingAtrLength + 1, 2);
    if (finishedCandles.length < atrWindowSize) return;

    this.bot.trailingAtrWindow = finishedCandles.slice(-atrWindowSize);

    const entryTime = this.bot.lastEntryTime || 0;
    // Align entry time to the 1-minute candle boundary so the first finished candle after entry
    // is eligible, avoiding a common ~2-minute delay when entry occurs mid-minute.
    const alignedEntryTime = entryTime === 0 ? 0 : Math.floor(entryTime / 60_000) * 60_000;
    const closesSinceEntry = finishedCandles
      .filter((c) => alignedEntryTime === 0 || c.timestamp >= alignedEntryTime)
      .map((c) => c.closePrice);

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

    const multiplier = this.bot.temporaryTrailMultiplier ?? this.bot.trailingStopMultiplier;
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
      bufferedLevel = position.side === "long" ? rawLevel * (1 + bufferPct) : rawLevel * (1 - bufferPct);
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
    if (update.positionSide && update.positionSide !== activePosition.side) return;

    const normalizedSymbol = update.symbol?.toUpperCase();
    if (normalizedSymbol && normalizedSymbol !== activePosition.symbol.toUpperCase()) return;

    if (this.bot.isBotGeneratedCloseOrder(update.clientOrderId)) return;

    if (this.liquidationCheckInProgress) return;

    this.liquidationCheckInProgress = true;
    try {
      const closedPosition = await this.bot.fetchClosedPositionSnapshot(activePosition.id);
      if (!closedPosition) {
        console.warn(`[COMB] Closed position snapshot missing for id ${activePosition.id}`);
        this.bot.queueMsg(`⚠️ Closed position snapshot missing for id ${activePosition.id}, waiting for next update...`);
        return;
      }

      const resolvePrice = update.executionPrice ?? closedPosition.closePrice ?? closedPosition.avgPrice;
      const resolveTime = update.updateTime ? new Date(update.updateTime) : new Date();
      this.bot.resolveWsPrice = { price: resolvePrice, time: resolveTime };

      const isLiquidation = this._isLiquidationClose(closedPosition) || ["auto-close-", "autoclose"].some((prefix) => update.clientOrderId?.toLowerCase().startsWith(prefix));
      if (isLiquidation) {
        console.log(
          `[COMB] waitForResolve externalCloseLiquidation symbol=${this.bot.symbol} positionId=${activePosition.id} clientOrderId=${update.clientOrderId ?? "N/A"}`
        );
        this.bot.queueMsg(this._formatLiquidationMessage(closedPosition));
      } else {
        console.log(
          `[COMB] waitForResolve externalClose symbol=${this.bot.symbol} positionId=${activePosition.id} clientOrderId=${update.clientOrderId ?? "N/A"} realizedPnl=${closedPosition.realizedPnl}`
        );
        this.bot.queueMsg("Position closed manually. Recording PnL and continuing.");
      }

      if (!this.bot.justManuallyClosedBy) {
        await this.bot.finalizeClosedPosition(closedPosition, {
          activePosition,
          triggerTimestamp: update.updateTime ?? Date.now(),
          fillTimestamp: update.updateTime ?? Date.now(),
          isLiquidation,
          exitReason: isLiquidation ? "liquidation_exit" : "signal_change",
          suppressStateChange: true,
        });
        this._stopAllWatchers();
      }

      this._clearLiquidationCheckInterval();
    } catch (error) {
      console.error("[COMB] Failed to process external order update:", error);
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

Realized PnL: 🟥🟥🟥 -${(this.bot.margin + (this.bot.lastFeeEstimate || 0) * 2).toFixed(4)} USDT
`;
  }

  private _isLiquidationClose(position: IPosition): boolean {
    const closePrice = typeof position.closePrice === "number" ? position.closePrice : position.avgPrice;
    if (!Number.isFinite(closePrice) || !Number.isFinite(position.liquidationPrice)) return false;
    const closePriceBn = new BigNumber(closePrice);
    if (position.side === "long") return closePriceBn.lte(position.liquidationPrice);
    return closePriceBn.gte(position.liquidationPrice);
  }

  private async _closeCurrPosition(reason: string = "support_resistance") {
    const triggerTs = Date.now();
    const activePosition = this.bot.currActivePosition;
    const closedPosition = await this.bot.orderExecutor.triggerCloseSignal(activePosition);

    const fillTimestamp = this.bot.resolveWsPrice?.time ? this.bot.resolveWsPrice.time.getTime() : Date.now();
    await this.bot.finalizeClosedPosition(closedPosition, {
      activePosition,
      triggerTimestamp: triggerTs,
      fillTimestamp,
      isLiquidation: reason === "liquidation_exit",
      exitReason: reason === "atr_trailing" ? "atr_trailing" : "signal_change",
    });
  }

  /** Close via TP pullback - same pattern as /close_pos: record PnL, preserve state, watchers stay running. */
  private async _handleTpPullbackClose(): Promise<void> {
    const activePosition = this.bot.currActivePosition;
    if (!activePosition) return;
    if (this.tpPullbackCloseInProgress) return; // Guard: prevent concurrent price updates from spamming
    this.tpPullbackCloseInProgress = true;
    try {
      const closedPosition = await this.bot.orderExecutor.triggerCloseSignal(activePosition);
      const netPnl = await this.bot.tmobUtils.handlePnL(
        typeof closedPosition.realizedPnl === "number" ? closedPosition.realizedPnl : 0,
        false,
        undefined,
        undefined,
        undefined,
        closedPosition.id,
      );
      this.bot.notifyInstanceEvent({
        type: "position_closed",
        closedPosition,
        exitReason: "tp_pullback",
        realizedPnl: closedPosition.realizedPnl,
        netPnl,
        symbol: this.bot.symbol,
      });
      const entryFill = this.bot.entryWsPrice;
      this.bot.pnlHistory.push({
        timestamp: new Date().toISOString(),
        timestampMs: Date.now(),
        side: closedPosition.side,
        totalPnL: this.bot.totalActualCalculatedProfit,
        entryTimestamp: entryFill?.time ? entryFill.time.toISOString() : null,
        entryTimestampMs: entryFill?.time ? entryFill.time.getTime() : null,
        entryFillPrice: entryFill?.price ?? (Number.isFinite(activePosition?.avgPrice) ? activePosition!.avgPrice : null),
        exitTimestamp: new Date(closedPosition.updateTime).toISOString(),
        exitTimestampMs: closedPosition.updateTime,
        exitFillPrice: typeof closedPosition.closePrice === "number" ? closedPosition.closePrice : closedPosition.avgPrice,
        tradePnL: closedPosition.realizedPnl,
        exitReason: "tp_pullback",
      });
      this.bot.queueMsg(`✅ TP pullback close completed for ${this.bot.symbol}. State unchanged. Watchers continue.`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[COMB] TP pullback close failed:", error);
      this.bot.justManuallyClosedBy = undefined; // Reset so user can retry
      this.bot.queueMsg(`❌ TP pullback close failed for ${this.bot.symbol}: ${msg}`);
    } finally {
      this.tpPullbackCloseInProgress = false;
    }
  }

  async onExit() {
    console.log(`[COMB] CombWaitForResolveState onExit symbol=${this.bot.symbol}`);
    this._stopAllWatchers();
    this.tpPullbackCloseInProgress = false;
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

export default CombWaitForResolveState;
