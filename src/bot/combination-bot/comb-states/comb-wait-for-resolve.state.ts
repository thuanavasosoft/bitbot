import ExchangeService from "@/services/exchange-service/exchange-service";
import { ICandleInfo, IPosition, IWSOrderUpdate, TPositionSide } from "@/services/exchange-service/exchange-type";
import BigNumber from "bignumber.js";
import { withRetries, isTransientError } from "../comb-retry";
import type CombBotInstance from "../comb-bot-instance";
import { TickRoundMode } from "@/bot/trail-multiplier-optimization-bot/tmob-states/tmob-wait-for-resolve.state";
import { EEventBusEventType } from "@/utils/event-bus.util";
import { CombClosedExitReason, IClosePositionMsgToCopyTrader, JustManuallyClosedBy } from "../comb-types";
import { COMB_DEFAULT_SIGNAL_PARAMS } from "../comb-utils";
import { generateRandomString } from "@/utils/strings.util";
import { AsyncMutex } from "@/utils/async-mutex.util";

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

const VIRTUAL_CLOSE_EXIT_REASONS = ["tp_pullback", "margin_stop_loss", "bad_signal", "hard_take_profit", "trail_cut"] as const satisfies readonly CombClosedExitReason[];

function isVirtualCloseExitReason(reason: string): reason is (typeof VIRTUAL_CLOSE_EXIT_REASONS)[number] {
  return (VIRTUAL_CLOSE_EXIT_REASONS as readonly string[]).includes(reason);
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
  private isExited = false;
  private exitPriceMutex = new AsyncMutex();
  private isManuallyClosingBy: JustManuallyClosedBy | undefined;
  private static readonly LIQUIDATION_CHECK_INTERVAL_MS = 5_000;

  constructor(private bot: CombBotInstance) {}

  /** Recalculate trailing stop levels (e.g. after temp_tm change). Call before refreshChart to show updated trail stop. */
  async refreshTrailingStopLevels(): Promise<void> {
    await this._updateTrailingStopLevels();
  }

  async onEnter() {
    this.isExited = false;
    if (!this.bot.currActivePosition) {
      const msg = `[COMB] ${this.bot.symbol} currActivePosition is not defined but entering wait for resolve state`;
      console.error(msg);
      const reason =
        "no_active_position: entered wait-for-resolve without open position (internal state ordering error)";
      this.bot.stopInstance(reason);
      this.bot.stateBus.emit(EEventBusEventType.StateChange, this.bot.stoppedState);
      return;
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
      this.lastPrice = trade.price;
      void this._runExitPriceUpdateSerialized(trade.price);
    });
  }

  private async _runExitPriceUpdateSerialized(price: number) {
    if (this.isExited) return;
    await this.exitPriceMutex.acquire();
    try {
      await this._handleExitPriceUpdate(price);
    } finally {
      this.exitPriceMutex.release();
    }
  }

  private async _handleExitPriceUpdate(price: number) {
    if (this.isExited) return;

    try {
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

      // Margin stop loss: ROM% from entry fill (dashboard stopLossPercentage).
      if (
        !shouldExit &&
        this.bot.currStopLossPrice != null &&
        this.bot.isMarginStopLossEnabled() &&
        !this.bot.justManuallyClosedBy &&
        !this.isManuallyClosingBy
      ) {
        const slBn = new BigNumber(this.bot.currStopLossPrice);
        const marginStopLossTriggered =
          (position.side === "long" && priceBn.lte(slBn)) ||
          (position.side === "short" && priceBn.gte(slBn));
        if (marginStopLossTriggered) {
          shouldExit = true;
          this.isManuallyClosingBy = "margin_stop_loss";
          exitReason = "margin_stop_loss";
          console.log(
            `[COMB] waitForResolve marginStopLoss triggered (${position.side}) symbol=${this.bot.symbol} price=${price} stopLoss=${this.bot.currStopLossPrice}`
          );
          this.bot.queueMsg(
            `🛑 Margin stop loss triggered (${position.side})\nPrice: ${price}\nStop loss: ${this.bot.currStopLossPrice} (${this.bot.marginStopLossPercent}% of margin)`
          );
        }
      }

      // Hard take profit: ROM% from entry fill (dashboard takeProfitPercentage).
      if (
        !shouldExit &&
        this.bot.currTakeProfitPrice != null &&
        this.bot.isHardTakeProfitEnabled() &&
        !this.bot.justManuallyClosedBy &&
        !this.isManuallyClosingBy
      ) {
        const tpBn = new BigNumber(this.bot.currTakeProfitPrice);
        const hardTakeProfitTriggered =
          (position.side === "long" && priceBn.gte(tpBn)) ||
          (position.side === "short" && priceBn.lte(tpBn));
        if (hardTakeProfitTriggered) {
          shouldExit = true;
          this.isManuallyClosingBy = "hard_take_profit";
          exitReason = "hard_take_profit";
          console.log(
            `[COMB] waitForResolve hardTakeProfit triggered (${position.side}) symbol=${this.bot.symbol} price=${price} takeProfit=${this.bot.currTakeProfitPrice}`
          );
          this.bot.queueMsg(
            `🎯 Hard take profit triggered (${position.side})\nPrice: ${price}\nTake profit: ${this.bot.currTakeProfitPrice} (${this.bot.hardTakeProfitPercent}% of margin)`
          );
        }
      }

      // TP_PB v2: fixed TP from avg–LTP gap at /tp_pb time; no trailing. Runs without SR.
      if (
        !shouldExit &&
        this.bot.tpPbPercent > 0 &&
        this.bot.tpPbFixedPrice != null &&
        !this.bot.justManuallyClosedBy &&
        !this.isManuallyClosingBy
      ) {
        const tpBn = new BigNumber(this.bot.tpPbFixedPrice);
        const tpPbTriggered =
          (position.side === "long" && priceBn.lte(tpBn)) ||
          (position.side === "short" && priceBn.gte(tpBn));
        if (tpPbTriggered) {
          shouldExit = true;
          this.isManuallyClosingBy = "tp_pb";
          exitReason = "tp_pullback";
          const tpPbEmoji = position.side === "long" ? "📉" : "📈";
          console.log(
            `[COMB] waitForResolve TP_PB triggered (${position.side}) symbol=${this.bot.symbol} price=${price} fixedTp=${this.bot.tpPbFixedPrice}`
          );
          this.bot.queueMsg(
            `${tpPbEmoji} TP_PB (fixed) triggered (${position.side})\nPrice: ${price}\nFixed TP: ${this.bot.tpPbFixedPrice}`
          );
        }
      }

      if (!this.bot.currentSupport || !this.bot.currentResistance) {
        if (shouldExit) {
          if (isVirtualCloseExitReason(exitReason)) {
            await this._handleVirtualClose(exitReason);
          } else {
            this._clearPriceListener();
            await this._closeCurrPosition(exitReason);
          }
        }
        return;
      }

      if (this.bot.lastEntryTime > 0 && this.bot.lastSRUpdateTime <= this.bot.lastEntryTime) {
        if (shouldExit && isVirtualCloseExitReason(exitReason)) {
          await this._handleVirtualClose(exitReason);
        } else if (shouldExit) {
          this._clearPriceListener();
          await this._closeCurrPosition(exitReason);
        }
        return;
      }

      if (
        !shouldExit &&
        this.bot.trailCutStop &&
        this.bot.trailCutStop.side === position.side &&
        !this.bot.justManuallyClosedBy &&
        !this.isManuallyClosingBy
      ) {
        const { bufferedLevel, rawLevel } = this.bot.trailCutStop;
        const cutBreached = this._trailLevelBreached(position.side, priceBn, bufferedLevel);
        this.bot.trailCutBreachCount = cutBreached ? this.bot.trailCutBreachCount + 1 : 0;
        if (this.bot.trailCutBreachCount >= this.bot.trailConfirmBars) {
          const closesNaturally = this.bot.trailCutCloseMode === "natural";
          shouldExit = true;
          exitReason = closesNaturally ? "atr_trailing" : "trail_cut";
          if (!closesNaturally) this.isManuallyClosingBy = "trail_cut";
          this.bot.trailCutTriggeredExit = closesNaturally;
          console.log(
            `[COMB] waitForResolve trailCutTriggered symbol=${this.bot.symbol} side=${position.side} close=${this.bot.trailCutCloseMode} price=${price} bufferedLevel=${bufferedLevel} rawLevel=${rawLevel}`
          );
          this.bot.queueMsg(
            `✂️ Trail cut (${position.side}, ${this.bot.trailCutCloseMode}) triggered\nPrice: ${price}\nBuffered stop: ${bufferedLevel}\nRaw stop: ${rawLevel}`
          );
        }
      } else if (!shouldExit) {
        this.bot.trailCutBreachCount = 0;
      }

      if (!shouldExit && this.bot.trailingStopTargets && this.bot.trailingStopTargets.side === position.side) {
        const { bufferedLevel, rawLevel } = this.bot.trailingStopTargets;
        const candles = this.bot.currCandles;
        const lastCandle = candles[candles.length - 1];
        const last2Candle = candles[candles.length - 2];
        const candleExtremes = [lastCandle, last2Candle]
          .filter((c): c is ICandleInfo => c != null)
          .map((c) =>
            position.side === "long" ? new BigNumber(c.lowPrice) : new BigNumber(c.highPrice)
          );
        const candleExtreme =
          candleExtremes.length === 0
            ? undefined
            : position.side === "long"
              ? BigNumber.min(...candleExtremes)
              : BigNumber.max(...candleExtremes);
        const isBreached = this._trailLevelBreached(position.side, priceBn, bufferedLevel);

        this.bot.trailingStopBreachCount = isBreached ? this.bot.trailingStopBreachCount + 1 : 0;

        if (this.bot.trailingStopBreachCount >= this.bot.trailConfirmBars) {
          shouldExit = true;
          exitReason = "atr_trailing";
          console.log(
            `[COMB] waitForResolve trailingStopTriggered symbol=${this.bot.symbol} side=${position.side} price=${price} candleExtreme=${candleExtreme ?? "N/A"} bufferedLevel=${bufferedLevel} rawLevel=${rawLevel}`
          );
          this.bot.queueMsg(
            `🟣 Trailing stop (${position.side}) triggered\nPrice: ${price}\nCandle ${position.side === "long" ? "low" : "high"}: ${candleExtreme ?? "N/A"}\nBuffered stop: ${bufferedLevel}\nRaw stop: ${rawLevel}`
          );
        }
      } else if (!shouldExit) {
        this.bot.trailingStopBreachCount = 0;
      }

      if (shouldExit) {
        if (isVirtualCloseExitReason(exitReason)) {
          await this._handleVirtualClose(exitReason);
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
    this.bot.isClosingPosition = true;
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
      this.bot.isClosingPosition = false;
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
      if (this.bot.justManuallyClosedBy) {
        closedPosition = this.bot.currActivePosition || null;
      } else {
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

      if (!this.bot.justManuallyClosedBy) {
        this.bot.combUtils.broadcastToCopyTraders(JSON.stringify({
          id: generateRandomString(10),
          symbol: this.bot.symbol,
          msgType: "CLOSE_POSITION",
          timestamp: Date.now(),
        } as IClosePositionMsgToCopyTrader));
      }
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

    // Same candle the backtest pushes on entry: the 1m bar that was open when price crossed.
    // Flooring lastEntryTime is not enough — that clock is set after the order and can be the next minute.
    const entryCandleOpenMs = this.bot.getTrailEntryCandleOpenMs();
    const closesSinceEntry = finishedCandles
      .filter((c) => entryCandleOpenMs === 0 || c.timestamp >= entryCandleOpenMs)
      .map((c) => c.closePrice);

    if (!closesSinceEntry.length) {
      this.bot.trailingCloseWindow = [];
      this.bot.trailingStopTargets = undefined;
      return;
    }

    this.bot.trailingCloseWindow = closesSinceEntry.slice(-this.bot.trailingHighestLookback);

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
    this._applyTrailCut(finishedCandles, position, atrValue, closesWindow);
  }

  /** Once per position, after the filters pass, keep a tighter stop beside the natural trail. */
  private _applyTrailCut(
    finishedCandles: ICandleInfo[],
    position: IPosition,
    atrValue: number,
    closesWindow: number[],
  ): void {
    if (!this.bot.isTrailCutEnabled()) return;

    const candle = finishedCandles[finishedCandles.length - 1];
    if (!candle) return;

    if (this.bot.trailCutMode === "extreme") {
      this._noteTrailCutBestPrice(finishedCandles, position.side);
    }

    const justArmed = !this.bot.trailCutTightened && this._trailCutFiltersPass(finishedCandles, candle, position);
    if (justArmed) this.bot.trailCutTightened = true;

    if (!this.bot.trailCutTightened) {
      this.bot.trailCutStop = undefined;
      this.bot.trailCutBreachCount = 0;
      return;
    }

    if (this.bot.trailCutMode === "multiplier") {
      const rawLevel = this._stopForMultiplier(position.side, this._cutMultiplier(), atrValue, closesWindow);
      this.bot.trailCutStop = rawLevel == null ? undefined : {
        side: position.side,
        rawLevel,
        bufferedLevel: this._bufferTrailLevel(position.side, rawLevel),
      };
    } else {
      const rawLevel = this._extremeLockStop(position);
      if (rawLevel != null) {
        const previous = this.bot.trailCutStop?.rawLevel;
        const nextRaw = previous == null
          ? rawLevel
          : position.side === "long" ? Math.max(previous, rawLevel) : Math.min(previous, rawLevel);
        this.bot.trailCutStop = {
          side: position.side,
          rawLevel: nextRaw,
          bufferedLevel: this._bufferTrailLevel(position.side, nextRaw),
        };
      }
    }

    if (justArmed) {
      const stop = this.bot.trailCutStop?.bufferedLevel;
      const stopText = stop != null ? stop : "pending";
      const kind = this.bot.trailCutMode === "extreme" ? "lock extreme" : "cut multiplier";
      this.bot.queueMsg(
        `✂️ TRAIL CUT ON (${position.side})\n` +
        `${kind} ${this.bot.trailCutPercent}% → ${this.bot.trailCutCloseMode}\n` +
        `New stop: ${stopText}`
      );
    }
  }

  private _cutMultiplier(): number {
    const base = this.bot.temporaryTrailMultiplier ?? this.bot.trailingStopMultiplier;
    return base * (1 - (this.bot.trailCutPercent ?? 0) / 100);
  }

  private _noteTrailCutBestPrice(candles: ICandleInfo[], side: TPositionSide): void {
    const entryTs = this.bot.getTrailEntryCandleOpenMs();
    for (const candle of candles) {
      if (entryTs > 0 && candle.timestamp < entryTs) continue;
      const price = side === "long" ? candle.highPrice : candle.lowPrice;
      if (!Number.isFinite(price)) continue;
      const current = this.bot.trailCutBestPrice;
      this.bot.trailCutBestPrice = current == null
        ? price
        : side === "long" ? Math.max(current, price) : Math.min(current, price);
    }
  }

  private _trailCutFiltersPass(candles: ICandleInfo[], candle: ICandleInfo, position: IPosition): boolean {
    const breakout = this.bot.trailCutBreakoutLevel;
    if (breakout == null) return false;

    const side = position.side;
    const close = candle.closePrice;
    const onNewSide = side === "long" ? close > breakout : close < breakout;
    if (!onNewSide) {
      this.bot.trailCutStallLevel = undefined;
      this.bot.trailCutStallSinceMs = undefined;
      return false;
    }
    if (!this._stallHoursOk(candle, side)) return false;

    const unrealized = this._pnlPercentOfMargin(side, position.avgPrice, close);
    const minUnrealized = this.bot.trailCutMinUnrealizedPnlPercent;
    if (minUnrealized != null && (unrealized == null || unrealized < minUnrealized)) return false;

    const naturalStop = this.bot.trailingStopTargets?.rawLevel;
    const blueLine = naturalStop == null ? null : this._pnlPercentOfMargin(side, position.avgPrice, naturalStop);
    const minBlueLine = this.bot.trailCutMinBlueLinePnlPercent;
    if (minBlueLine != null && (blueLine == null || blueLine < minBlueLine)) return false;

    return this._rocExceeds(candles, side);
  }

  /** Sideways clock. A new high (long) or low (short) restarts it. */
  private _stallHoursOk(candle: ICandleInfo, side: TPositionSide): boolean {
    const hoursNeeded = this.bot.trailCutStallHours ?? 0;
    if (!(hoursNeeded > 0)) return true;

    const favorable = side === "long" ? candle.highPrice : candle.lowPrice;
    const srLevel = side === "long" ? this.bot.currentResistance : this.bot.currentSupport;
    const around = this.bot.trailCutStallLevel ?? srLevel;
    if (around == null || !(around > 0) || !Number.isFinite(favorable)) {
      this.bot.trailCutStallLevel = undefined;
      this.bot.trailCutStallSinceMs = undefined;
      return false;
    }

    const madeNewExtreme = side === "long" ? favorable > around : favorable < around;
    const nowMs = candle.openTime || candle.timestamp;
    if (madeNewExtreme) {
      this.bot.trailCutStallLevel = favorable;
      this.bot.trailCutStallSinceMs = nowMs;
    } else if (this.bot.trailCutStallSinceMs == null) {
      this.bot.trailCutStallLevel = around;
      this.bot.trailCutStallSinceMs = nowMs;
    }

    const since = this.bot.trailCutStallSinceMs;
    if (since == null) return false;
    return (nowMs - since) / 3_600_000 >= hoursNeeded;
  }

  private _rocExceeds(candles: ICandleInfo[], side: TPositionSide): boolean {
    const threshold = this.bot.trailCutRocThreshold;
    if (threshold == null) return true;
    const rocBars = COMB_DEFAULT_SIGNAL_PARAMS.K || 5;
    const start = candles[candles.length - 1 - rocBars];
    const candle = candles[candles.length - 1];
    if (!start || !candle || !(start.closePrice > 0)) return false;
    if (side === "long") return candle.highPrice / start.closePrice - 1 > threshold;
    return candle.lowPrice / start.closePrice - 1 < -threshold;
  }

  private _pnlPercentOfMargin(side: TPositionSide, entryPrice: number, markPrice: number): number | null {
    if (!(entryPrice > 0) || !(this.bot.leverage > 0) || !Number.isFinite(markPrice)) return null;
    const move = side === "long" ? (markPrice - entryPrice) / entryPrice : (entryPrice - markPrice) / entryPrice;
    return move * this.bot.leverage * 100;
  }

  /** Stop that locks trailCutPercent of the profit at the best price. */
  private _extremeLockStop(position: IPosition): number | null {
    const best = this.bot.trailCutBestPrice;
    const entry = position.avgPrice;
    const percent = this.bot.trailCutPercent ?? 0;
    if (best == null || !(entry > 0) || !(percent > 0)) return null;
    const favorable = position.side === "long" ? best - entry : entry - best;
    if (!(favorable > 0)) return null;
    const stop = position.side === "long"
      ? entry + favorable * (percent / 100)
      : entry - favorable * (percent / 100);
    if (!(stop > 0) || !Number.isFinite(stop)) return null;
    return position.side === "long" ? this._quantizeToTick(stop, "up") : this._quantizeToTick(stop, "down");
  }

  private _stopForMultiplier(side: TPositionSide, multiplier: number, atrValue: number, closesWindow: number[]): number | null {
    if (!closesWindow.length || !(atrValue > 0) || !(multiplier > 0)) return null;
    if (side === "long") {
      const candidate = Math.max(...closesWindow) - atrValue * multiplier;
      return candidate > 0 ? this._quantizeToTick(candidate, "up") : null;
    }
    const candidate = Math.min(...closesWindow) + atrValue * multiplier;
    return candidate > 0 ? this._quantizeToTick(candidate, "down") : null;
  }

  private _bufferTrailLevel(side: TPositionSide, rawLevel: number): number {
    const bufferPct = this.bot.triggerBufferPercentage / 100 || 0;
    if (!(bufferPct > 0)) return rawLevel;
    return side === "long" ? rawLevel * (1 + bufferPct) : rawLevel * (1 - bufferPct);
  }

  private _trailLevelBreached(side: TPositionSide, priceBn: BigNumber, bufferedLevel: number): boolean {
    const candles = this.bot.currCandles;
    const recent = [candles[candles.length - 1], candles[candles.length - 2]].filter((c): c is ICandleInfo => c != null);
    const extremes = recent.map((c) => (side === "long" ? new BigNumber(c.lowPrice) : new BigNumber(c.highPrice)));
    const candleExtreme = extremes.length === 0
      ? undefined
      : side === "long" ? BigNumber.min(...extremes) : BigNumber.max(...extremes);
    const level = new BigNumber(bufferedLevel);
    if (side === "long") return priceBn.lte(level) || (candleExtreme != null && candleExtreme.lte(level));
    return priceBn.gte(level) || (candleExtreme != null && candleExtreme.gte(level));
  }

  private async _handleExternalOrderUpdate(update: IWSOrderUpdate) {
    if (this.bot.justManuallyClosedBy) return;
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
          shouldTrackSlippage: false,
          exitReason: isLiquidation ? "liquidation_exit" : "signal_change",
          suppressStateChange: isLiquidation ? false : true,
        });

        if (isLiquidation) {
          this._stopAllWatchers();
          this.bot.combUtils.broadcastToCopyTraders(JSON.stringify({
            id: generateRandomString(10),
            symbol: this.bot.symbol,
            msgType: "CLOSE_POSITION",
            timestamp: Date.now(),
          } as IClosePositionMsgToCopyTrader));
        }
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
    if (this.bot.isClosingPosition) {
      console.log(`[COMB] _closeCurrPosition skipped: lock held for ${this.bot.symbol} reason=${reason}`);
      this.bot.queueMsg(`⚠️ [${this.bot.symbol}] Close order blocked (${reason}): another close is already in progress — lock is held.`);
      return;
    }
    this.bot.isClosingPosition = true;
    const triggerTs = Date.now();
    const activePosition = this.bot.currActivePosition;
    const exitReason: CombClosedExitReason =
      reason === "atr_trailing"
        ? "atr_trailing"
        : reason === "liquidation_exit"
          ? "liquidation_exit"
          : "signal_change";
    const triggerPrice = this.lastPrice > 0 ? this.lastPrice : undefined;
    try {
      const closedPosition = await this.bot.orderExecutor.triggerCloseSignal(activePosition);
      const fillTimestamp = this.bot.resolveWsPrice?.time ? this.bot.resolveWsPrice.time.getTime() : Date.now();
      await this.bot.finalizeClosedPosition(closedPosition, {
        activePosition,
        triggerTimestamp: triggerTs,
        fillTimestamp,
        triggerPrice,
        isLiquidation: reason === "liquidation_exit",
        exitReason,
      });
    } finally {
      this.bot.isClosingPosition = false;
    }
  }

  /** Virtual close (TP_PB, margin SL, hard TP, bad-entry consolidation): record PnL, preserve state, watchers stay running. */
  private async _handleVirtualClose(exitReason: (typeof VIRTUAL_CLOSE_EXIT_REASONS)[number]): Promise<void> {
    try {
      await this.bot.virtualClosePosition(exitReason, this.lastPrice > 0 ? this.lastPrice : undefined);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[COMB] Virtual close failed (${exitReason}):`, error);
      this.bot.justManuallyClosedBy = undefined;
      this.bot.queueMsg(`❌ Virtual close failed for ${this.bot.symbol} (${exitReason}): ${msg}`);
    }
  }

  async onExit() {
    console.log(`[COMB] CombWaitForResolveState onExit symbol=${this.bot.symbol}`);
    this._stopAllWatchers();
    this.isManuallyClosingBy = undefined;
    this.bot.isClosingPosition = false;
    this.isExited = true;
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
