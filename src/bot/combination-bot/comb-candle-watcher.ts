import ExchangeService from "@/services/exchange-service/exchange-service";
import { withRetries, isTransientError } from "./comb-retry";
import { generateImageOfCandlesWithSupportResistance } from "@/utils/image-generator.util";
import { calculateBreakoutSignal } from "./comb-backtest";
import { COMB_DEFAULT_SIGNAL_PARAMS, formatCombOptimizationAgeMessage } from "./comb-utils";
import BigNumber from "bignumber.js";
import { ICandleInfo } from "@/services/exchange-service/exchange-type";
import type CombBotInstance from "./comb-bot-instance";
import type { JustManuallyClosedBy } from "./comb-types";
import { calc_UnrealizedPnl } from "@/utils/maths.util";
import moment from "moment";

/** Delay in ms after the minute mark before running each candle watcher iteration (e.g. 500 => 00:01:00.500). */
const CANDLE_WATCHER_DELAY_AFTER_MINUTE_MS = 500;

function justManuallyClosedViaLabel(by: JustManuallyClosedBy): string {
  switch (by) {
    case "close_pos":
      return "/close_pos";
    case "tp_pb":
      return "TP_PB";
    case "margin_stop_loss":
      return "margin stop loss";
    case "minority_prevention":
      return "minority prevention";
    case "bad_signal":
      return "bad entry (consolidation)";
    case "hard_take_profit":
      return "hard take profit";
  }
}

function formatCombLiquidationLine(
  pos: { liquidationPrice?: number } | undefined,
  pricePrecision: number
): string {
  if (!pos) return "";
  const liq = pos.liquidationPrice;
  const display =
    liq != null && Number.isFinite(liq) && liq > 0 ? liq.toLocaleString(undefined, { maximumFractionDigits: pricePrecision }) : "N/A";
  return `\nLiquidation: ${display.toLocaleString()}`;
}

/** Telegram suffix line when the instance is in “closed but trailing context preserved” mode. */
export function formatCombJustManuallyClosedIndicator(
  justManuallyClosedBy: JustManuallyClosedBy | undefined,
  lastNetPnl: number | null | undefined
): string {
  if (!justManuallyClosedBy) return "";
  const pnl = lastNetPnl ?? 0;
  const pnlEmoji = pnl >= 0 ? "🟩" : "🟥";
  return `⚠️ [closed via ${justManuallyClosedViaLabel(justManuallyClosedBy)} at (${pnlEmoji} ${pnl.toFixed(2)} USDT)]`;
}

class CombCandleWatcher {
  isCandleWatcherStarted = false;
  private sleepTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private sleepWake?: () => void;

  constructor(private bot: CombBotInstance) { }

  stop(): void {
    if (this.sleepTimeoutId !== null) {
      clearTimeout(this.sleepTimeoutId);
      this.sleepTimeoutId = null;
    }
    const wake = this.sleepWake;
    this.sleepWake = undefined;
    wake?.();
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.sleepWake = resolve;
      this.sleepTimeoutId = setTimeout(() => {
        this.sleepTimeoutId = null;
        this.sleepWake = undefined;
        resolve();
      }, ms);
    });
  }

  /** Generate and send the price chart (support/resistance, trail stop, etc.) to the instance channel. */
  async refreshChart(): Promise<void> {
    try {
      const now = new Date();
      await this.bot.combCandles.ensurePopulated();
      now.setSeconds(0);
      now.setMilliseconds(0);
      const signalLookbackMs = (this.bot.nSignal + 1) * 60 * 1000;
      let windowStartMs = now.getTime() - signalLookbackMs;
      const position = this.bot.currActivePosition;
      const entryOpenTime =
        this.bot.lastEntrySignal?.entryCandle?.openTime ??
        (this.bot.lastEntryTime > 0 ? this.bot.lastEntryTime : null);
      if (position && entryOpenTime != null) {
        const atrLen = COMB_DEFAULT_SIGNAL_PARAMS.atr_len ?? 14;
        const consolidationStartMs = entryOpenTime - (atrLen - 1) * 60 * 1000;
        windowStartMs = Math.min(windowStartMs, consolidationStartMs);
      }
      this.bot.currCandles = await this.bot.combCandles.getCandles(new Date(windowStartMs), now);
      const currCandles = this.bot.currCandles;
      if (currCandles.length <= this.bot.nSignal) {
        const markPrice = await ExchangeService.getMarkPrice(this.bot.symbol);
        currCandles.push({
          timestamp: now.getTime(),
          openTime: now.getTime(),
          closeTime: now.getTime(),
          openPrice: markPrice,
          highPrice: markPrice,
          lowPrice: markPrice,
          closePrice: markPrice,
          volume: 0,
        } as ICandleInfo);
      }
      const signalParams = { ...COMB_DEFAULT_SIGNAL_PARAMS, N: this.bot.nSignal };
      const consolidationCheck =
        position && entryOpenTime != null
          ? {
              maximumConsolidationBarsCheckTs: entryOpenTime,
              side: position.side,
            }
          : undefined;
      const signalResult = calculateBreakoutSignal(currCandles, signalParams, consolidationCheck);
      this.bot.lastSignalResult = signalResult;
      this.bot.isConsolidationAfterBreakout = !!signalResult.isConsolidationAfterBreakout;
      const rawSupport = signalResult.support;
      const rawResistance = signalResult.resistance;
      this.bot.currentSupport =
        rawSupport !== null
          ? new BigNumber(rawSupport).decimalPlaces(this.bot.pricePrecision, BigNumber.ROUND_UP).toNumber()
          : null;
      this.bot.currentResistance =
        rawResistance !== null
          ? new BigNumber(rawResistance).decimalPlaces(this.bot.pricePrecision, BigNumber.ROUND_DOWN).toNumber()
          : null;

      let trailingStopRaw: number | null = null;
      let trailingStopBuffered: number | null = null;
      const trailingTargets = this.bot.trailingStopTargets;
      if (
        trailingTargets &&
        this.bot.currActivePosition &&
        trailingTargets.side === this.bot.currActivePosition.side
      ) {
        trailingStopRaw = trailingTargets.rawLevel;
        trailingStopBuffered = trailingTargets.bufferedLevel;
      }

      let tpPbLevel: number | null = null;
      if (this.bot.tpPbPercent > 0 && this.bot.tpPbFixedPrice != null && this.bot.currActivePosition) {
        tpPbLevel = this.bot.tpPbFixedPrice;
      }

      let marginStopLossLevel: number | null = null;
      if (this.bot.currStopLossPrice != null && this.bot.isMarginStopLossEnabled() && this.bot.currActivePosition) {
        marginStopLossLevel = this.bot.currStopLossPrice;
      }

      let hardTakeProfitLevel: number | null = null;
      if (this.bot.currTakeProfitPrice != null && this.bot.isHardTakeProfitEnabled() && this.bot.currActivePosition) {
        hardTakeProfitLevel = this.bot.currTakeProfitPrice;
      }

      const quantizedResistance = this.bot.currentResistance;
      const quantizedSupport = this.bot.currentSupport;
      if (quantizedResistance !== null) {
        const bufferMultiplier = new BigNumber(1).minus(this.bot.triggerBufferPercentage / 100);
        this.bot.longTrigger = new BigNumber(quantizedResistance)
          .times(bufferMultiplier)
          .decimalPlaces(this.bot.pricePrecision, BigNumber.ROUND_DOWN)
          .toNumber();
      } else {
        this.bot.longTrigger = null;
      }
      if (quantizedSupport !== null) {
        const bufferMultiplier = new BigNumber(1).plus(this.bot.triggerBufferPercentage / 100);
        this.bot.shortTrigger = new BigNumber(quantizedSupport)
          .times(bufferMultiplier)
          .decimalPlaces(this.bot.pricePrecision, BigNumber.ROUND_UP)
          .toNumber();
      } else {
        this.bot.shortTrigger = null;
      }

      const signalImageData = await withRetries(
        () =>
          generateImageOfCandlesWithSupportResistance(
            this.bot.symbol,
            currCandles,
            quantizedSupport,
            quantizedResistance,
            false,
            now,
            this.bot.currActivePosition ?? undefined,
            this.bot.longTrigger ?? undefined,
            this.bot.shortTrigger ?? undefined,
            trailingStopRaw ?? undefined,
            trailingStopBuffered ?? undefined,
            tpPbLevel ?? undefined,
            hardTakeProfitLevel != null
              ? { price: hardTakeProfitLevel, percent: this.bot.hardTakeProfitPercent ?? 0 }
              : undefined,
            marginStopLossLevel ? { price: marginStopLossLevel ?? 0, percent: this.bot.marginStopLossPercent ?? 0 } : null,
          ),
        {
          label: "[CombCandleWatcher] generateImageOfCandlesWithSupportResistance",
          retries: 5,
          minDelayMs: 5000,
          isTransientError,
          onRetry: ({ attempt, delayMs, error, label }) =>
            console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
        }
      );
      this.bot.queueMsg(signalImageData);

      const effectiveMult = this.bot.temporaryTrailMultiplier ?? this.bot.trailingStopMultiplier;
      const trailingMsg =
        trailingStopRaw !== null || trailingStopBuffered !== null
          ? `\nTrail Stop (raw): ${trailingStopRaw !== null ? trailingStopRaw : "N/A"}\nTrail Stop (buffered): ${trailingStopBuffered !== null ? trailingStopBuffered : "N/A"}`
          : "";
      const tpPbMsg =
        tpPbLevel !== null ? `\nTP_PB fixed (${this.bot.tpPbPercent}% of gap): ${tpPbLevel}` : "";
      const marginSlMsg = this.bot.isMarginStopLossEnabled()
        ? `\n${this.bot.formatMarginStopLossStatus()}`
        : "";
      const hardTpMsg = this.bot.isHardTakeProfitEnabled()
        ? `\n${this.bot.formatHardTakeProfitStatus()}`
        : "";
      const paramsMsg =
        `\nTrailing ATR Length: ${this.bot.trailingAtrLength} (fixed)` +
        `\nTrailing Multiplier: ${effectiveMult}${this.bot.temporaryTrailMultiplier != null ? " (temp)" : ""}`;
      const optimizationAgeMsg = formatCombOptimizationAgeMessage(this.bot, now.getTime());
      const closedIndicator = formatCombJustManuallyClosedIndicator(this.bot.justManuallyClosedBy, this.bot.lastNetPnl);
      const rocHighVal =
        signalResult.roc != null ? `${(signalResult.roc.rocHigh * 100).toFixed(2)}%` : "N/A";
      const rocLowVal =
        signalResult.roc != null ? `${(signalResult.roc.rocLow * 100).toFixed(2)}%` : "N/A";
      const stdDevVal =
        signalResult.stdDev != null ? signalResult.stdDev.toFixed(4) : "N/A";
      const consolidationMsg = position
        ? `\nConsolidation after breakout: ${this.bot.isConsolidationAfterBreakout ? "yes" : "no"}`
        : "";
      const badEntryMsg = position
        ? `\nBad entry flagged: ${this.bot.isBadEntrySignal ? "yes" : "no"}`
        : "";

      const currLtpPrice = await ExchangeService.getLTPPrice(this.bot.symbol);
      const currPnl = !!this.bot.currActivePosition ? calc_UnrealizedPnl(this.bot.currActivePosition, currLtpPrice) : 0;
      const pnlIndicator = currPnl >= 0 ? "🟩" : "🟥";
      const liqMsg = formatCombLiquidationLine(this.bot.currActivePosition, this.bot.pricePrecision);

      this.bot.queueMsg(
        `ℹ️ Curr LTP Price: ${currLtpPrice.toLocaleString(undefined, { maximumFractionDigits: this.bot.pricePrecision })} ${!!this.bot.currActivePosition ? `(${pnlIndicator} ${currPnl.toFixed(2)} USDT)` : ""}\n` +
        `Now (UTC): ${moment(now).utc().format("YYYY-MM-DD HH:mm")}\n` +
        `ROC High: ${rocHighVal} | ROC Low: ${rocLowVal}\n` +
        `StdDev: ${stdDevVal}${consolidationMsg}${badEntryMsg}\n` +
        `Resistance: ${quantizedResistance !== null ? quantizedResistance.toLocaleString() : "N/A"}\nLong Trigger: ${this.bot.longTrigger !== null ? this.bot.longTrigger.toLocaleString() : "N/A"}\n` +
        `Support: ${quantizedSupport !== null ? quantizedSupport.toLocaleString() : "N/A"}\nShort Trigger: ${this.bot.shortTrigger !== null ? this.bot.shortTrigger.toLocaleString() : "N/A"}${liqMsg}${trailingMsg}${tpPbMsg}${marginSlMsg}${hardTpMsg}${paramsMsg}${optimizationAgeMsg}\n${closedIndicator}`
      );
      this.bot.lastSRUpdateTime = Date.now();
    } catch (err) {
      this.bot.queueMsg(
        `⚠️ Failed to refresh chart: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async startWatchingCandles() {
    if (this.isCandleWatcherStarted) return;
    this.isCandleWatcherStarted = true;
    this.bot.queueMsg("🔍 Starting CombCandleWatcher");
    try {
      while (!this.bot.isStopped) {
        try {
          const minuteStartMs = Math.floor(Date.now() / 60_000) * 60_000;
          const closedCandleOpenMs = minuteStartMs - 60_000;
          const consolidationFromPreviousBar = this.bot.isConsolidationAfterBreakout;
          await this.refreshChart();
          if (this.bot.isStopped) break;
          await this.bot.closeBadEntryIfNeededOnCandleClose(
            consolidationFromPreviousBar,
            closedCandleOpenMs,
          );

          const nowMs = Date.now();
          const nextMinuteStartMs = (Math.floor(nowMs / 60_000) + 1) * 60_000;
          const targetMs = nextMinuteStartMs + CANDLE_WATCHER_DELAY_AFTER_MINUTE_MS;
          const delayMs = targetMs - nowMs;
          if (delayMs > 0) await this.wait(delayMs);
        } catch (error) {
          if (this.bot.isStopped) break;
          console.error("[COMB] Candle watcher iteration error:", error);
          this.bot.queueMsg(
            `⚠️ Comb candle watcher error (will retry next interval): ${error instanceof Error ? error.message : String(error)}`
          );
          await this.wait(60_000);
        }
      }
    } finally {
      this.isCandleWatcherStarted = false;
      // Resume can race with the old paused loop unwinding. If that happened,
      // start a fresh loop now that the old one has fully released its guard.
      if (!this.bot.isStopped) {
        void this.startWatchingCandles();
      }
    }
  }
}

export default CombCandleWatcher;
