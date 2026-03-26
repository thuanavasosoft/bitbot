import { EventEmitter } from "events";
import { EEventBusEventType } from "@/utils/event-bus.util";
import TelegramService from "@/services/telegram.service";
import BigNumber from "bignumber.js";
import { randomUUID } from "crypto";
import type { CombState, CombInstanceConfig, CombPnlHistoryPoint, CombInstanceEvent, JustManuallyClosedBy } from "./comb-types";
import CombOrderWatcher from "./comb-order-watcher";
import CombCandles from "./comb-candles";
import CombUtils, { getLtpOrMarkPrice, quantizePriceByPrecision } from "./comb-utils";
import CombOrderExecutor from "./comb-order-executor";
import CombStartingState from "./comb-states/comb-starting.state";
import CombWaitForSignalState from "./comb-states/comb-wait-for-signal.state";
import CombWaitForResolveState from "./comb-states/comb-wait-for-resolve.state";
import CombStoppedState from "./comb-states/comb-stopped.state";
import CombCandleWatcher from "./comb-candle-watcher";
import CombOptimizationLoop from "./comb-optimization-loop";
import CombTelegramHandler from "./comb-telegram-handler";
import type { ICandleInfo, IPosition, ISymbolInfo, TPositionSide } from "@/services/exchange-service/exchange-type";
import { calc_UnrealizedPnl } from "@/utils/maths.util";

/** en-US grouping for Telegram (e.g. 6,000.5); maxFractionDigits caps decimal places. */
function formatEnUsNumber(n: number, maxFractionDigits: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits,
  });
}

function formatApproxPnlUsdt(pnl: number): string {
  const icon = pnl >= 0 ? "🟩" : "🟥";
  return `${icon} ${pnl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`;
}

/** Adverse market exit: long sells ~0.1% below TP; short buys ~0.1% above TP. */
const TP_PB_EXIT_SLIPPAGE_FRAC = 0.001;

function tpPbAdverseSlippageExitPrice(side: TPositionSide, tp: number, pricePrecision: number): number {
  const raw =
    side === "long"
      ? tp * (1 - TP_PB_EXIT_SLIPPAGE_FRAC)
      : tp * (1 + TP_PB_EXIT_SLIPPAGE_FRAC);
  return quantizePriceByPrecision(raw, pricePrecision, "half");
}

/** Human-readable labels for finalizeClosedPosition exit reasons (general channel / logs). */
const EXIT_REASON_DISPLAY = new Map<string, string>([
  ["atr_trailing", "trailing stop"],
  ["signal_change", "signal/close"],
  ["liquidation_exit", "liquidation"],
  ["end", "end"],
  ["tp_pullback", "TP_PB (state reset)"],
  ["close_command", "close command"],
]);

function formatExitReasonDisplay(exitReason: string): string {
  return EXIT_REASON_DISPLAY.get(exitReason) ?? exitReason;
}

class CombBotInstance {
  runId: string;
  runStartTs?: Date;
  symbol: string;
  leverage: number;
  margin: number;
  triggerBufferPercentage: number;
  nSignal: number;
  optimizationWindowMinutes: number;
  updateIntervalMinutes: number;
  trailConfirmBars: number;
  trailingAtrLength: number;
  trailingHighestLookback: number;
  trailBoundStepSize: number;
  trailMultiplierBounds: { min: number; max: number };
  telegramChatId?: string;
  stateBus: EventEmitter;

  totalActualCalculatedProfit: number = 0;
  slippageAccumulation: number = 0;
  numberOfTrades: number = 0;
  currentSupport: number | null = null;
  currentResistance: number | null = null;
  longTrigger: number | null = null;
  shortTrigger: number | null = null;
  lastExitTime: number = 0;
  /** Earliest wall-clock time (ms) a new entry is allowed; set on position close (next minute :00 after resolve). */
  nextEntryAllowedAtMs?: number;
  lastSRUpdateTime: number = 0;
  lastEntryTime: number = 0;
  currActivePosition?: IPosition;
  entryWsPrice?: { price: number; time: Date };
  resolveWsPrice?: { price: number; time: Date };
  bufferedExitLevels?: { support: number | null; resistance: number | null };
  trailingStopTargets?: { side: TPositionSide; rawLevel: number; bufferedLevel: number; updatedAt: number };
  trailingAtrWindow: ICandleInfo[] = [];
  trailingCloseWindow: number[] = [];
  lastTrailingStopUpdateTime: number = 0;
  trailingStopBreachCount: number = 0;
  currTrailMultiplier?: number;
  trailingStopMultiplier: number = 0;
  /** Temporary override for trailing stop multiplier. Cleared when position is closed. */
  temporaryTrailMultiplier?: number;
  /**
   * TP_PB v2: percent of the gap between avg price and LTP at command time. 0 = disabled.
   * Fixed take-profit price is stored in tpPbFixedPrice until disabled or position finalized.
   */
  tpPbPercent: number = 0;
  /** Fixed TP price set when /tp_pb runs (does not trail with LTP). */
  tpPbFixedPrice?: number;
  lastOptimizationAtMs: number = 0;
  pricePrecision: number = 0;
  tickSize: number = 0;
  symbolInfo?: ISymbolInfo;
  lastOpenClientOrderId?: string;
  lastCloseClientOrderId?: string;
  lastClosedPositionId?: number;
  lastGrossPnl?: number;
  lastBalanceDelta?: number;
  lastFeeEstimate?: number;
  lastNetPnl?: number;
  pnlHistory: CombPnlHistoryPoint[] = [];
  private botCloseOrderIds = new Set<string>();

  /** Set when position closed via /close_pos or TP_PB; reset after finalizeClosedPosition cleanup. */
  justManuallyClosedBy?: JustManuallyClosedBy;

  /**
   * Mutex for the close-order flow. Set to true before any path calls triggerCloseSignal,
   * released in its finally block. Any other path that wants to close checks this first and
   * bails out immediately if locked — preventing two market close orders from hitting the
   * exchange simultaneously (which would open an unintended opposite position).
   * Reset to false on new position open and on waitForResolveState.onExit().
   */
  isClosingPosition: boolean = false;

  /**
   * Guards finalizeClosedPosition against concurrent calls from racing close paths
   * (e.g. optimization loop fire-and-forget racing with trailing stop / liquidation).
   * Reset to false whenever a new position is assigned to currActivePosition.
   */
  isFinalizingPosition: boolean = false;

  /**
   * Set to true once PnL has been recorded for the current position.
   * Guards handlePnL against being called more than once per position (last-line defence
   * against sequential races where isFinalizingPosition has already been cleared).
   * Reset to false whenever a new position is assigned to currActivePosition.
   */
  isPnlRecorded: boolean = false;

  isStopped: boolean = false;
  stopReason?: string;
  stopAtMs?: number;

  orderWatcher: CombOrderWatcher;
  tmobCandles: CombCandles;
  tmobUtils: CombUtils;
  orderExecutor: CombOrderExecutor;
  startingState: CombStartingState;
  waitForSignalState: CombWaitForSignalState;
  waitForResolveState: CombWaitForResolveState;
  stoppedState: CombStoppedState;
  tmobCandleWatcher: CombCandleWatcher;
  optimizationLoop: CombOptimizationLoop;
  telegramHandler: CombTelegramHandler;
  currentState: CombState;

  /** Optional callback for the general bot to receive instance events (position opened/closed, liquidated). */
  onInstanceEvent?: (event: CombInstanceEvent) => void;
  /** Optional: send a short line to the general COMB channel (e.g. state cleared after prior manual/TP-PB close). */
  onGeneralInfoMessage?: (message: string) => void;

  constructor(config: CombInstanceConfig) {
    this.runId = randomUUID();
    this.stateBus = new EventEmitter();
    this.symbol = config.SYMBOL;
    this.leverage = config.LEVERAGE;
    this.margin = config.MARGIN;
    this.triggerBufferPercentage = config.TRIGGER_BUFFER_PERCENTAGE;
    this.nSignal = config.N_SIGNAL_AND_ATR_LENGTH;
    this.trailingAtrLength = config.N_SIGNAL_AND_ATR_LENGTH;
    this.trailingHighestLookback = config.N_SIGNAL_AND_ATR_LENGTH;
    this.optimizationWindowMinutes = config.OPTIMIZATION_WINDOW_MINUTES;
    this.updateIntervalMinutes = config.UPDATE_INTERVAL_MINUTES;
    this.trailConfirmBars = config.TRAIL_CONFIRM_BARS;
    this.trailBoundStepSize = config.TRAIL_BOUND_STEP_SIZE;
    this.trailMultiplierBounds = { min: config.TRAIL_MULTIPLIER_BOUNDS_MIN, max: config.TRAIL_MULTIPLIER_BOUNDS_MAX };
    this.telegramChatId = config.TELEGRAM_CHAT_ID;

    this.orderWatcher = new CombOrderWatcher();

    this.tmobCandles = new CombCandles(this);
    this.tmobUtils = new CombUtils(this);
    this.orderExecutor = new CombOrderExecutor(this);
    this.startingState = new CombStartingState(this);
    this.waitForSignalState = new CombWaitForSignalState(this);
    this.waitForResolveState = new CombWaitForResolveState(this);
    this.stoppedState = new CombStoppedState(this);
    this.tmobCandleWatcher = new CombCandleWatcher(this);
    this.optimizationLoop = new CombOptimizationLoop(this);
    this.telegramHandler = new CombTelegramHandler(this);
    this.currentState = this.startingState;
  }

  queueMsg(message: string | Buffer): void {
    TelegramService.queueMsg(message, this.telegramChatId);
  }

  queueMsgPriority(message: string | Buffer): void {
    TelegramService.queueMsgPriority(message, this.telegramChatId);
  }

  /** Notify the general bot of an instance event (position opened/closed, liquidated). No-op if onInstanceEvent not set. */
  notifyInstanceEvent(event: CombInstanceEvent): void {
    this.onInstanceEvent?.(event);
  }

  resetTrailingStopTracking(): void {
    this.trailingAtrWindow = [];
    this.trailingCloseWindow = [];
    this.trailingStopTargets = undefined;
    this.trailingStopBreachCount = 0;
  }

  /** Refresh trailing stop levels (if in wait-for-resolve) and send the price chart to the instance channel. */
  async refreshChartAndTrailingLevels(): Promise<void> {
    if (this.currentState === this.waitForResolveState && this.currActivePosition) {
      await this.waitForResolveState.refreshTrailingStopLevels();
    }
    await this.tmobCandleWatcher.refreshChart();
  }

  /**
   * TP_PB v2: set a fixed TP at avg + gap×pct (long) or avg − gap×pct (short) from current LTP vs avg.
   * If LTP is not favorable vs avg (long needs LTP above avg; short needs LTP below avg), only a message is sent — no close, no TP level. percent 0 disables.
   */
  async applyTpPbFromTelegram(value: number): Promise<void> {
    if (value === 0) {
      this.tpPbPercent = 0;
      this.tpPbFixedPrice = undefined;
      await this.refreshChartAndTrailingLevels();
      this.queueMsg(`TP_PB disabled for ${this.symbol}.`);
      return;
    }
    if (!Number.isFinite(value) || value < 0) {
      this.queueMsg("TP_PB: value must be a non-negative number.");
      return;
    }
    if (!this.currActivePosition) {
      this.queueMsg(`No open position for ${this.symbol}. /tp_pb ignored.`);
      return;
    }
    if (this.currentState !== this.waitForResolveState) {
      this.queueMsg(`TP_PB requires an open position in resolve state for ${this.symbol}.`);
      return;
    }
    if (this.isClosingPosition) {
      this.queueMsg(`Cannot set TP_PB for ${this.symbol}: a close is already in progress.`);
      return;
    }
    const ltp = await getLtpOrMarkPrice(this.symbol);
    const avg = this.currActivePosition.avgPrice;
    const side = this.currActivePosition.side;
    const ltpBn = new BigNumber(ltp);
    const avgBn = new BigNumber(avg);

    if (side === "long") {
      if (ltpBn.lte(avgBn)) {
        const fd = this.pricePrecision;
        this.queueMsg(
          `Cannot set /tp_pb: LTP (${formatEnUsNumber(ltp, fd)}) must be above avg (${formatEnUsNumber(avg, fd)}) for a long. Not doing anything.`
        );
        return;
      }
      const gap = ltpBn.minus(avgBn);
      const rawTp = avgBn.plus(gap.times(value).div(100));
      const tp = quantizePriceByPrecision(rawTp.toNumber(), this.pricePrecision, "half");
      this.tpPbPercent = value;
      this.tpPbFixedPrice = tp;
      const fd = this.pricePrecision;
      const slipPx = tpPbAdverseSlippageExitPrice("long", tp, this.pricePrecision);
      const approxPnlTp = calc_UnrealizedPnl(this.currActivePosition, tp);
      const approxPnlSlip = calc_UnrealizedPnl(this.currActivePosition, slipPx);
      this.queueMsg(
        `TP_PB set for ${this.symbol} (long): fixed TP ${formatEnUsNumber(tp, fd)} (${formatEnUsNumber(value, 8)}% of gap ${formatEnUsNumber(gap.toNumber(), fd)} between avg ${formatEnUsNumber(avg, fd)} and LTP ${formatEnUsNumber(ltp, fd)}). Re-run /tp_pb to change.` +
        `\nApprox. PnL @ TP: ${formatApproxPnlUsdt(approxPnlTp)}` +
        `\n0.1% slip exit ~${formatEnUsNumber(slipPx, fd)} → approx. PnL: ${formatApproxPnlUsdt(approxPnlSlip)}`
      );
      await this.refreshChartAndTrailingLevels();
      return;
    }

    if (ltpBn.gte(avgBn)) {
      const fd = this.pricePrecision;
      this.queueMsg(
        `Cannot set /tp_pb: LTP (${formatEnUsNumber(ltp, fd)}) must be below avg (${formatEnUsNumber(avg, fd)}) for a short. Not doing anything.`
      );
      return;
    }
    const gap = avgBn.minus(ltpBn);
    const rawTp = avgBn.minus(gap.times(value).div(100));
    const tp = quantizePriceByPrecision(rawTp.toNumber(), this.pricePrecision, "half");
    this.tpPbPercent = value;
    this.tpPbFixedPrice = tp;
    const fd = this.pricePrecision;
    const slipPx = tpPbAdverseSlippageExitPrice("short", tp, this.pricePrecision);
    const approxPnlTp = calc_UnrealizedPnl(this.currActivePosition, tp);
    const approxPnlSlip = calc_UnrealizedPnl(this.currActivePosition, slipPx);
    this.queueMsg(
      `TP_PB set for ${this.symbol} (short): fixed TP ${formatEnUsNumber(tp, fd)} (${formatEnUsNumber(value, 8)}% of gap ${formatEnUsNumber(gap.toNumber(), fd)} between avg ${formatEnUsNumber(avg, fd)} and LTP ${formatEnUsNumber(ltp, fd)}). Re-run /tp_pb to change.` +
      `\nApprox. PnL @ TP: ${formatApproxPnlUsdt(approxPnlTp)}` +
      `\n0.1% slip exit ~${formatEnUsNumber(slipPx, fd)} → approx. PnL: ${formatApproxPnlUsdt(approxPnlSlip)}`
    );
    await this.refreshChartAndTrailingLevels();
  }

  async fetchClosedPositionSnapshot(positionId: number, maxRetries = 5): Promise<IPosition | undefined> {
    return this.orderExecutor.fetchClosedPositionSnapshot(positionId, maxRetries);
  }

  updateLastTradeMetrics(metrics: { closedPositionId?: number; grossPnl?: number; feeEstimate?: number; netPnl?: number }): void {
    if (metrics.closedPositionId !== undefined) this.lastClosedPositionId = metrics.closedPositionId;
    if (metrics.grossPnl !== undefined) this.lastGrossPnl = metrics.grossPnl;
    if (metrics.feeEstimate !== undefined) this.lastFeeEstimate = metrics.feeEstimate;
    if (metrics.netPnl !== undefined) this.lastNetPnl = metrics.netPnl;
  }

  getLastTradeMetrics(): { closedPositionId?: number; grossPnl?: number; feeEstimate?: number; netPnl?: number } {
    return {
      closedPositionId: this.lastClosedPositionId,
      grossPnl: this.lastGrossPnl,
      feeEstimate: this.lastFeeEstimate,
      netPnl: this.lastNetPnl ?? this.lastBalanceDelta,
    };
  }

  trackCloseOrderId(clientOrderId: string): void {
    if (clientOrderId) this.botCloseOrderIds.add(clientOrderId);
  }

  untrackCloseOrderId(clientOrderId: string): void {
    this.botCloseOrderIds.delete(clientOrderId);
  }

  isBotGeneratedCloseOrder(clientOrderId?: string | null): boolean {
    return !!clientOrderId && this.botCloseOrderIds.has(clientOrderId);
  }

  startOptimizationLoop(): void {
    this.optimizationLoop.start();
  }

  /**
   * Stop only this instance (symbol). This does not exit the overall process.
   * Idempotent: repeated calls do nothing after the first stop.
   */
  stopInstance(reason: string): void {
    if (this.isStopped) return;
    this.isStopped = true;
    this.stopReason = reason;
    this.stopAtMs = Date.now();
    this.optimizationLoop.stop();
  }

  async finalizeClosedPosition(
    closedPosition: IPosition,
    _options?: {
      activePosition?: IPosition;
      triggerTimestamp?: number;
      fillTimestamp?: number;
      isLiquidation?: boolean;
      exitReason?: "atr_trailing" | "signal_change" | "end" | "liquidation_exit" | "tp_pullback" | "close_command";
      /** When true, does not emit a state transition event. Caller must handle state transition explicitly. */
      suppressStateChange?: boolean;
    }
  ): Promise<void> {
    if (this.isFinalizingPosition) {
      const msg = `⚠️ [${this.symbol}] Close skipped (${_options?.exitReason ?? "signal_change"}): another close path is already finalizing this position — narrow time gap between two simultaneous triggers.`;
      console.log(`[COMB] finalizeClosedPosition skipped: already in progress for ${this.symbol} positionId=${closedPosition.id} exitReason=${_options?.exitReason ?? "signal_change"}`);
      this.queueMsg(msg);
      return;
    }
    if (!this.currActivePosition) {
      const msg = `⚠️ [${this.symbol}] Close skipped (${_options?.exitReason ?? "signal_change"}): position already finalized by another trigger — narrow time gap between two simultaneous closes.`;
      console.log(`[COMB] finalizeClosedPosition skipped: no active position for ${this.symbol} positionId=${closedPosition.id} exitReason=${_options?.exitReason ?? "signal_change"}`);
      this.queueMsg(msg);
      return;
    }
    this.isFinalizingPosition = true;

    try {
      const exitReason = _options?.exitReason ?? "signal_change";
      const exitReasonDisplay = formatExitReasonDisplay(exitReason);

      if (this.justManuallyClosedBy) {
        console.log(
          `[COMB] finalizeClosedPosition: position ${closedPosition.id} already recorded (via ${this.justManuallyClosedBy}). Skipping duplicate PnL/slippage/history.`
        );
        this.queueMsg(
          `⏭️ Position ${closedPosition.id} was already closed and PnL recorded (via ${this.justManuallyClosedBy}). Skipping duplicate update, clearing state only.`
        );
        this.onGeneralInfoMessage?.(
          `has cleared its position due to ${exitReasonDisplay}. The instance can enter a new position again.`
        );
      }
      const activePosition = _options?.activePosition ?? this.currActivePosition;
      const positionSide = activePosition?.side ?? closedPosition.side;
      const entryFill = this.entryWsPrice;
      const fillTimestamp =
        _options?.fillTimestamp ??
        this.resolveWsPrice?.time?.getTime() ??
        closedPosition.updateTime ??
        Date.now();
      this.lastExitTime = fillTimestamp;
      const resolvedAtMs = Math.max(fillTimestamp, Date.now());
      this.nextEntryAllowedAtMs = (Math.floor(resolvedAtMs / 60_000) + 1) * 60_000;
      const triggerTimestamp = _options?.triggerTimestamp ?? fillTimestamp;
      const shouldTrackSlippage = !_options?.isLiquidation;
      const realizedPnl = typeof closedPosition.realizedPnl === "number" ? closedPosition.realizedPnl : (closedPosition as any).realizedPnl ?? 0;

      const closedPrice = typeof closedPosition.closePrice === "number" ? closedPosition.closePrice : closedPosition.avgPrice;

      let srLevel: number | null = null;
      if (positionSide === "long") {
        srLevel = this.currentSupport;
      } else if (positionSide === "short") {
        srLevel = this.currentResistance;
      }

      let slippage = 0;
      const timeDiffMs = fillTimestamp - triggerTimestamp;

      if (!this.justManuallyClosedBy && shouldTrackSlippage) {
        if (srLevel === null) {
          this.queueMsg(
            `⚠️ Warning: Cannot calculate slippage - ${positionSide === "long" ? "support" : "resistance"} level not available`
          );
        } else {
          slippage =
            positionSide === "short"
              ? new BigNumber(closedPrice).minus(srLevel).toNumber()
              : new BigNumber(srLevel).minus(closedPrice).toNumber();
        }
      }

      const icon = slippage <= 0 ? "🟩" : "🟥";
      if (!this.justManuallyClosedBy && shouldTrackSlippage) {
        if (icon === "🟥") {
          this.slippageAccumulation += Math.abs(slippage);
        } else {
          this.slippageAccumulation -= Math.abs(slippage);
        }
        this.numberOfTrades++;
      }

      if (!this.justManuallyClosedBy) {
        await this.tmobUtils.handlePnL(
          realizedPnl,
          _options?.isLiquidation ?? false,
          shouldTrackSlippage ? icon : undefined,
          shouldTrackSlippage ? slippage : undefined,
          shouldTrackSlippage ? timeDiffMs : undefined,
          closedPosition.id
        );
        this.notifyInstanceEvent({
          type: "position_closed",
          closedPosition,
          exitReason,
          realizedPnl,
          netPnl: this.lastNetPnl ?? realizedPnl,
          symbol: this.symbol,
        });
        console.log(
          `[COMB] finalizeClosedPosition symbol=${this.symbol} positionId=${closedPosition.id} exitReason=${exitReason} realizedPnl=${realizedPnl.toFixed(4)} totalCalculatedProfit=${this.totalActualCalculatedProfit.toFixed(4)}`
        );
        this.pnlHistory.push({
          timestamp: new Date().toISOString(),
          timestampMs: Date.now(),
          side: positionSide as "long" | "short",
          totalPnL: this.totalActualCalculatedProfit,
          entryTimestamp: entryFill?.time ? entryFill.time.toISOString() : null,
          entryTimestampMs: entryFill?.time ? entryFill.time.getTime() : null,
          entryFillPrice: entryFill?.price ?? (Number.isFinite(activePosition?.avgPrice) ? activePosition!.avgPrice : null),
          exitTimestamp: new Date(fillTimestamp).toISOString(),
          exitTimestampMs: fillTimestamp,
          exitFillPrice: typeof closedPosition.closePrice === "number" ? closedPosition.closePrice : closedPosition.avgPrice,
          tradePnL: realizedPnl,
          exitReason,
        });
      }

      this.currActivePosition = undefined;
      this.entryWsPrice = undefined;
      this.resolveWsPrice = undefined;
      this.justManuallyClosedBy = undefined;
      this.temporaryTrailMultiplier = undefined;
      this.tpPbPercent = 0;
      this.tpPbFixedPrice = undefined;

      if (!_options?.suppressStateChange) {
        this.stateBus.emit(EEventBusEventType.StateChange);
      }
    } finally {
      this.isFinalizingPosition = false;
    }
  }
}

export default CombBotInstance;
