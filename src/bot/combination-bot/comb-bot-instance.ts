import { EventEmitter } from "events";
import { EEventBusEventType } from "@/utils/event-bus.util";
import TelegramService from "@/services/telegram.service";
import BigNumber from "bignumber.js";
import { randomUUID } from "crypto";
import type { CombState, CombInstanceConfig, CombPnlHistoryPoint, CombInstanceEvent, JustManuallyClosedBy, CombClosedExitReason, CombSignalResult } from "./comb-types";
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
import { calc_UnrealizedPnl, calcLiquidationPrice } from "@/utils/maths.util";
import CombinationBot from "./combination-bot";

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

/** Adverse virtual entry vs reference: long fills ~0.1% above; short ~0.1% below (same frac as TP_PB exit). */
function adverseSlippageEntryAvgPrice(side: TPositionSide, refPrice: number, pricePrecision: number): number {
  const raw =
    side === "long"
      ? refPrice * (1 + TP_PB_EXIT_SLIPPAGE_FRAC)
      : refPrice * (1 - TP_PB_EXIT_SLIPPAGE_FRAC);
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
  ["minority_prevention", "minority prevention"],
  ["margin_stop_loss", "margin stop loss"],
  ["bad_signal", "bad entry (consolidation)"],
  ["hard_take_profit", "hard take profit"],
]);

function formatExitReasonDisplay(exitReason: string): string {
  return EXIT_REASON_DISPLAY.get(exitReason) ?? exitReason;
}

/** Maps virtual-close exit reason to `justManuallyClosedBy` when state should stay preserved until trailing/resolve. */
function justManuallyClosedByFromVirtualExitReason(
  exitReason: CombClosedExitReason
): JustManuallyClosedBy | undefined {
  switch (exitReason) {
    case "close_command":
      return "close_pos";
    case "minority_prevention":
      return "minority_prevention";
    case "tp_pullback":
      return "tp_pb";
    case "margin_stop_loss":
      return "margin_stop_loss";
    case "bad_signal":
      return "bad_signal";
    case "hard_take_profit":
      return "hard_take_profit";
    case "atr_trailing":
    case "signal_change":
    case "end":
    case "liquidation_exit":
      return undefined;
  }
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
  currCandles: ICandleInfo[] = [];
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
  trailingStopTargets?: { side: TPositionSide; rawLevel: number; bufferedLevel: number; updatedAt: number };
  trailingAtrWindow: ICandleInfo[] = [];
  trailingCloseWindow: number[] = [];
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
  /**
   * Max unrealized loss as % of margin (from env or /set_sl). Undefined or 0 = disabled.
   */
  marginStopLossPercent?: number;
  /** Stop-loss trigger price for the current position. Cleared on close. */
  currStopLossPrice?: number;
  /**
   * Hard take profit as % of margin / ROM (from env or /set_tp). Undefined or 0 = disabled.
   * Price move = percent / leverage, matching dashboard `takeProfitPercentage`.
   */
  hardTakeProfitPercent?: number;
  /** Take-profit trigger price for the current position. Cleared on close. */
  currTakeProfitPrice?: number;
  /** Latest breakout signal from the candle watcher (S/R, ROC high/low, consolidation). */
  lastSignalResult: CombSignalResult | null = null;
  /** Signal snapshot taken at entry; used for bad-entry ROC and consolidation window. */
  lastEntrySignal: CombSignalResult | null = null;
  isBadEntrySignal: boolean = false;
  isConsolidationAfterBreakout: boolean = false;
  badEntryLongRocHighThreshold?: number;
  badEntryShortRocLowThreshold?: number;
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
   * Guards the entry flow against concurrent trade ticks opening multiple positions before
   * currActivePosition is assigned and the state transition reaches wait-for-resolve.
   */
  isOpeningPosition: boolean = false;

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
  /** Graceful pause requested from the general Telegram channel. */
  pauseRequested: boolean = false;
  /** Distinguishes an operator pause from a fatal/internal stopped state. */
  isPausedByCommand: boolean = false;
  /** Graceful remove requested from the general Telegram channel. */
  removeRequested: boolean = false;

  orderWatcher: CombOrderWatcher;
  combCandles: CombCandles;
  combUtils: CombUtils;
  orderExecutor: CombOrderExecutor;
  startingState: CombStartingState;
  waitForSignalState: CombWaitForSignalState;
  waitForResolveState: CombWaitForResolveState;
  stoppedState: CombStoppedState;
  combCandleWatcher: CombCandleWatcher;
  optimizationLoop: CombOptimizationLoop;
  telegramHandler: CombTelegramHandler;
  currentState: CombState;
  combinationBot: CombinationBot;

  /** Optional callback for the general bot to receive instance events (position opened/closed, liquidated). */
  onInstanceEvent?: (event: CombInstanceEvent) => void;
  /** Optional: send a short line to the general COMB channel (e.g. state cleared after prior manual/TP-PB close). */
  onGeneralInfoMessage?: (message: string) => void;

  constructor(config: CombInstanceConfig, combinationBot: CombinationBot) {
    this.combinationBot = combinationBot;
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
    this.marginStopLossPercent = config.MARGIN_STOP_LOSS;
    this.hardTakeProfitPercent = config.HARD_TAKE_PROFIT_PCT;
    this.badEntryLongRocHighThreshold = config.BAD_ENTRY_LONG_ROC_HIGH_THRESHOLD_PCT;
    this.badEntryShortRocLowThreshold = config.BAD_ENTRY_SHORT_ROC_LOW_THRESHOLD_PCT;

    this.orderWatcher = new CombOrderWatcher();

    this.combCandles = new CombCandles(this);
    this.combUtils = new CombUtils(this);
    this.orderExecutor = new CombOrderExecutor(this);
    this.startingState = new CombStartingState(this);
    this.waitForSignalState = new CombWaitForSignalState(this);
    this.waitForResolveState = new CombWaitForResolveState(this);
    this.stoppedState = new CombStoppedState(this);
    this.combCandleWatcher = new CombCandleWatcher(this);
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

  isMarginStopLossEnabled(): boolean {
    return this.marginStopLossPercent != null && this.marginStopLossPercent > 0;
  }

  isHardTakeProfitEnabled(): boolean {
    return this.hardTakeProfitPercent != null && this.hardTakeProfitPercent > 0;
  }

  isBadEntryCloseEnabled(): boolean {
    return (
      (this.badEntryLongRocHighThreshold != null && this.badEntryLongRocHighThreshold > 0) ||
      (this.badEntryShortRocLowThreshold != null && this.badEntryShortRocLowThreshold > 0)
    );
  }

  resetBadEntryTracking(): void {
    this.lastEntrySignal = null;
    this.isBadEntrySignal = false;
    this.isConsolidationAfterBreakout = false;
  }

  /**
   * Dashboard `_checkStopBadEntrySignal`: previous bar's consolidation flag, and only
   * after the just-closed 1m candle open is ≥ entry+60s. Do not call from LTP ticks.
   */
  shouldCloseBadEntryOnClosedCandle(
    consolidationFromPreviousBar: boolean,
    closedCandleOpenMs: number,
  ): boolean {
    if (!this.isBadEntryCloseEnabled()) return false;
    if (!this.isBadEntrySignal || !consolidationFromPreviousBar) return false;
    if (this.justManuallyClosedBy || this.isClosingPosition) return false;
    if (!this.currActivePosition) return false;
    if (this.currentState !== this.waitForResolveState) return false;
    if (!(this.lastEntryTime > 0) || closedCandleOpenMs < this.lastEntryTime + 60_000) return false;
    return true;
  }

  async closeBadEntryIfNeededOnCandleClose(
    consolidationFromPreviousBar: boolean,
    closedCandleOpenMs: number,
  ): Promise<void> {
    if (!this.shouldCloseBadEntryOnClosedCandle(consolidationFromPreviousBar, closedCandleOpenMs)) {
      return;
    }
    const side = this.currActivePosition?.side ?? "unknown";
    console.log(
      `[COMB] badSignal candleClose (${side}) symbol=${this.symbol} closedCandleOpen=${new Date(closedCandleOpenMs).toISOString()}`
    );
    this.queueMsg(
      `ℹ️ℹ️ℹ️ Bad entry consolidation triggered at candle close (${side})\n` +
      `Closed candle open: ${new Date(closedCandleOpenMs).toISOString()}\n` +
      `${this.formatBadEntryStatus()}`
    );
    await this.virtualClosePosition("bad_signal");
  }

  /**
   * Stop when maintenanceMargin + unrealizedPnl = -SL% of margin.
   * `maintenanceMargin` comes from the exchange position; price is quantized to
   * pricePrecision (long down, short up).
   */
  computeStopLossPrice(
    entryFill: number,
    side: TPositionSide,
    size: number,
    maintenanceMargin: number
  ): number | undefined {
    if (!this.isMarginStopLossEnabled()) return undefined;
    if (!(size > 0) || !Number.isFinite(entryFill) || !Number.isFinite(maintenanceMargin)) return undefined;

    const desiredLoss = new BigNumber(this.margin).times(this.marginStopLossPercent!).div(100);
    const targetUnrealized = desiredLoss.negated().minus(maintenanceMargin);
    const targetUnrealizedPerUnit = targetUnrealized.div(size).toNumber();
    const slPriceRaw =
      side === "long" ? entryFill + targetUnrealizedPerUnit : entryFill - targetUnrealizedPerUnit;
    return quantizePriceByPrecision(
      slPriceRaw,
      this.pricePrecision,
      side === "long" ? "down" : "up"
    );
  }

  /**
   * Hard TP from entry: price move = (percent / leverage), i.e. percent of margin (ROM).
   * Quantize long up / short down so the trigger is not easier than the raw level.
   */
  computeTakeProfitPrice(entryFill: number, side: TPositionSide): number | undefined {
    if (!this.isHardTakeProfitEnabled()) return undefined;
    if (!Number.isFinite(entryFill) || !(this.leverage > 0)) return undefined;

    const takeProfitPctFrac = this.hardTakeProfitPercent! / 100;
    const raw =
      side === "long"
        ? entryFill * (1 + takeProfitPctFrac / this.leverage)
        : entryFill * (1 - takeProfitPctFrac / this.leverage);
    return quantizePriceByPrecision(raw, this.pricePrecision, side === "long" ? "up" : "down");
  }

  /** Recompute currStopLossPrice from the active position (e.g. after open or /set_sl). */
  updateCurrStopLossFromPosition(): void {
    const pos = this.currActivePosition;
    if (!pos || !this.isMarginStopLossEnabled()) {
      this.currStopLossPrice = undefined;
      return;
    }
    this.currStopLossPrice = this.computeStopLossPrice(
      pos.avgPrice,
      pos.side,
      pos.size,
      pos.maintenanceMargin
    );
  }

  /** Recompute currTakeProfitPrice from the active position (e.g. after open or /set_tp). */
  updateCurrTakeProfitFromPosition(): void {
    const pos = this.currActivePosition;
    if (!pos || !this.isHardTakeProfitEnabled()) {
      this.currTakeProfitPrice = undefined;
      return;
    }
    this.currTakeProfitPrice = this.computeTakeProfitPrice(pos.avgPrice, pos.side);
  }

  formatMarginStopLossStatus(pricePrecision?: number): string {
    if (!this.isMarginStopLossEnabled()) return "Margin stop loss: disabled";
    const fd = pricePrecision ?? this.pricePrecision;
    const pricePart =
      this.currStopLossPrice != null
        ? ` → ${formatEnUsNumber(this.currStopLossPrice, fd)}`
        : "";
    return `Margin stop loss: ${formatEnUsNumber(this.marginStopLossPercent!, 4)}% of margin${pricePart}`;
  }

  formatHardTakeProfitStatus(pricePrecision?: number): string {
    if (!this.isHardTakeProfitEnabled()) return "Hard take profit: disabled";
    const fd = pricePrecision ?? this.pricePrecision;
    const pricePart =
      this.currTakeProfitPrice != null
        ? ` → ${formatEnUsNumber(this.currTakeProfitPrice, fd)}`
        : "";
    return `Hard take profit: ${formatEnUsNumber(this.hardTakeProfitPercent!, 4)}% of margin${pricePart}`;
  }

  formatBadEntryStatus(): string {
    if (!this.isBadEntryCloseEnabled()) return "Bad-entry close: disabled";
    const longPct =
      this.badEntryLongRocHighThreshold != null
        ? `${(this.badEntryLongRocHighThreshold * 100)}%`
        : "off";
    const shortPct =
      this.badEntryShortRocLowThreshold != null
        ? `-${Math.abs(this.badEntryShortRocLowThreshold * 100)}%`
        : "off";
    const live =
      this.currActivePosition && !this.justManuallyClosedBy
        ? ` | is currently flagged=${this.isBadEntrySignal ? "yes" : "no"}`
        : "";
    return `Bad-entry close: long ROC high ${longPct} / short ROC low ${shortPct}${live}`;
  }

  /**
   * Set margin stop-loss percent (0 or invalid disables). Recalculates price when a position is open.
   */
  applyMarginStopLossPercent(percent: number): void {
    if (!Number.isFinite(percent) || percent <= 0) {
      this.marginStopLossPercent = undefined;
      this.currStopLossPrice = undefined;
      return;
    }
    this.marginStopLossPercent = percent;
    this.updateCurrStopLossFromPosition();
  }

  /**
   * Set hard take-profit percent of margin (0 or invalid disables). Recalculates price when a position is open.
   */
  applyHardTakeProfitPercent(percent: number): void {
    if (!Number.isFinite(percent) || percent <= 0) {
      this.hardTakeProfitPercent = undefined;
      this.currTakeProfitPrice = undefined;
      return;
    }
    this.hardTakeProfitPercent = percent;
    this.updateCurrTakeProfitFromPosition();
  }

  /**
   * Set bad-entry ROC thresholds. Inputs are percents (e.g. 0.6 = 0.6%), stored as fractions.
   * 0 or invalid disables that side.
   */
  applyBadEntryRocFilter(longPct: number, shortPct: number): void {
    this.badEntryLongRocHighThreshold =
      Number.isFinite(longPct) && longPct > 0 ? longPct / 100 : undefined;
    this.badEntryShortRocLowThreshold =
      Number.isFinite(shortPct) && shortPct > 0 ? shortPct / 100 : undefined;
  }

  /** Refresh trailing stop levels (if in wait-for-resolve) and send the price chart to the instance channel. */
  async refreshChartAndTrailingLevels(): Promise<void> {
    if (this.currentState === this.waitForResolveState && this.currActivePosition) {
      await this.waitForResolveState.refreshTrailingStopLevels();
    }
    await this.combCandleWatcher.refreshChart();
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
    if (this.justManuallyClosedBy) {
      this.queueMsg(`Cannot set TP_PB for ${this.symbol}: a position was already closed via ${this.justManuallyClosedBy}. Not doing anything..`);
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
  stopInstance(reason: string, isCommandPause = false): void {
    if (this.isStopped) return;
    this.isStopped = true;
    this.pauseRequested = isCommandPause;
    this.isPausedByCommand = isCommandPause;
    this.stopReason = reason;
    this.stopAtMs = Date.now();
    this.optimizationLoop.stop();
    this.combCandleWatcher.stop();
  }

  /** Request a graceful pause. Active/opening positions remain managed until safe to stop. */
  requestCommandPause(): "paused" | "pending" {
    this.pauseRequested = true;
    if (this.completeCommandPauseIfSafe()) return "paused";
    return "pending";
  }

  /** Complete a requested pause only when there is no live or in-flight entry. */
  completeCommandPauseIfSafe(): boolean {
    if (this.removeRequested || this.isStopped || !this.pauseRequested || this.currActivePosition || this.isOpeningPosition) return false;
    this.stopInstance("Paused via /pause_symbol", true);
    return this.isPausedByCommand;
  }

  /** Request a graceful remove. Active/opening positions remain managed until safe to unregister. */
  requestCommandRemove(): "ready" | "pending" {
    this.removeRequested = true;
    if (this.completeCommandRemoveIfSafe()) return "ready";
    return "pending";
  }

  /** Complete a requested remove only when there is no live or in-flight entry. */
  completeCommandRemoveIfSafe(): boolean {
    if (!this.removeRequested || this.currActivePosition || this.isOpeningPosition) return false;
    if (!this.isStopped) this.stopInstance("Removed via /remove_symbol");
    return true;
  }

  /** Resume a completed pause, or cancel a pause that is still pending. */
  resumeCommandPause(): "resuming" | "cancelled_pending" | "not_paused" {
    if (this.removeRequested) return "not_paused";
    if (this.pauseRequested && !this.isPausedByCommand) {
      this.pauseRequested = false;
      return "cancelled_pending";
    }
    if (!this.isStopped || !this.isPausedByCommand) return "not_paused";

    this.pauseRequested = false;
    this.isPausedByCommand = false;
    this.isStopped = false;
    this.stopReason = undefined;
    this.stopAtMs = undefined;
    this.stateBus.emit(EEventBusEventType.StateChange, this.startingState);
    return "resuming";
  }

  /** Drop exchange/runtime listeners after this instance is unregistered. */
  disposeRuntimeResources(): void {
    this.optimizationLoop.stop();
    this.combCandleWatcher.stop();
    this.orderWatcher.dispose();
    this.stateBus.removeAllListeners();
    this.onInstanceEvent = undefined;
    this.onGeneralInfoMessage = undefined;
  }

  async finalizeClosedPosition(
    closedPosition: IPosition,
    _options?: {
      activePosition?: IPosition;
      triggerTimestamp?: number;
      fillTimestamp?: number;
      isLiquidation?: boolean;
      exitReason?: CombClosedExitReason;
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
          `⏭️ Position ${closedPosition.id} was already closed (via ${this.justManuallyClosedBy}) and PnL recorded. Skipping duplicate update, clearing state only.`
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
        await this.combUtils.handlePnL(
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
      this.isPnlRecorded = false;
      this.tpPbPercent = 0;
      this.tpPbFixedPrice = undefined;
      this.currStopLossPrice = undefined;
      this.currTakeProfitPrice = undefined;
      this.resetBadEntryTracking();

      if (!_options?.suppressStateChange) {
        this.stateBus.emit(EEventBusEventType.StateChange);
      }
    } finally {
      this.isFinalizingPosition = false;
    }
  }

  async activateDummyPosition(args: {
    requestedSide: TPositionSide;
    price: number;
    trigger: number | null;
    activePositionsText?: string;
    blockedReason?: string;
  }): Promise<void> {
    if (this.currActivePosition) return;

    const { requestedSide, price, trigger, activePositionsText, blockedReason } = args;
    const now = new Date();
    const entryAvgPrice = adverseSlippageEntryAvgPrice(requestedSide, price, this.pricePrecision);
    const simulatedNotional = new BigNumber(this.margin).times(this.leverage);
    const simulatedSize =
      entryAvgPrice > 0
        ? simulatedNotional.div(entryAvgPrice).decimalPlaces(this.symbolInfo?.basePrecision ?? 8, BigNumber.ROUND_DOWN).toNumber()
        : 0;
    const simulatedInitialMargin = this.margin;
    const maintenanceMarginRate = this.symbolInfo?.maintenanceMarginRate ?? 0;
    const simulatedMaintenanceMargin = new BigNumber(simulatedNotional).times(maintenanceMarginRate).toNumber();
    const simulatedLiquidationPrice =
      this.leverage > 1 && entryAvgPrice > 0
        ? calcLiquidationPrice(requestedSide, entryAvgPrice, this.leverage)
        : 0;

    const virtualPosition: IPosition = {
      id: -now.getTime(),
      symbol: this.symbol,
      size: simulatedSize,
      side: requestedSide,
      notional: simulatedNotional.toNumber(),
      leverage: this.leverage,
      unrealizedPnl: 0,
      realizedPnl: 0,
      avgPrice: entryAvgPrice,
      liquidationPrice: simulatedLiquidationPrice,
      maintenanceMargin: simulatedMaintenanceMargin,
      initialMargin: simulatedInitialMargin,
      marginMode: "virtual",
      createTime: now.getTime(),
      updateTime: now.getTime(),
    };

    this.currActivePosition = virtualPosition;
    this.justManuallyClosedBy = "minority_prevention";

    this.isClosingPosition = false;
    this.isFinalizingPosition = false;
    this.isPnlRecorded = false;
    this.nextEntryAllowedAtMs = undefined;
    this.resetTrailingStopTracking();
    this.resetBadEntryTracking();
    this.tpPbPercent = 0;
    this.tpPbFixedPrice = undefined;
    this.lastEntryTime = Date.now();
    this.numberOfTrades++;

    this.lastCloseClientOrderId = undefined;
    this.lastClosedPositionId = undefined;
    this.lastOpenClientOrderId = undefined;

    await this.combUtils.handlePnL(
      0,
      false,
      undefined,
      undefined,
      undefined,
      -now.getTime(),
    );

    const entryFill = this.entryWsPrice;
    this.pnlHistory.push({
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
      side: requestedSide,
      totalPnL: this.totalActualCalculatedProfit,
      entryTimestamp: entryFill?.time ? entryFill.time.toISOString() : null,
      entryTimestampMs: entryFill?.time ? entryFill.time.getTime() : null,
      entryFillPrice: 0,
      exitTimestamp: new Date().toISOString(),
      exitTimestampMs: now.getTime(),
      exitFillPrice: 0,
      tradePnL: 0,
      exitReason: "minority_prevention",
    });

    const instanceLabel = `${this.symbol}`;
    const message =
      `🛡️ Minority prevention blocked entry and simulated an opened ${requestedSide.toUpperCase()} virtual position\n` +
      `No exchange order was placed.\n` +
      `Instance: ${instanceLabel}\n` +
      `Symbol: ${this.symbol}\n` +
      `Requested side: ${requestedSide.toUpperCase()}\n` +
      `Virtual position ID: ${virtualPosition.id}\n` +
      `Reference price: ${price}\n` +
      `Simulated avg entry (0.1% adverse slippage): ${entryAvgPrice}\n` +
      `Trigger: ${trigger ?? "N/A"}\n` +
      `${activePositionsText ? `Active comb positions: ${activePositionsText}\n` : ""}` +
      `${blockedReason ? `Reason: ${blockedReason}\n` : ""}` +
      `State will clear only on trailing stop or re-optimization.`;
    this.queueMsg(message);
    this.combinationBot.queueGeneralMessage(`[COMB] ${this.symbol} ${message}`);
  }

  async virtualClosePosition(exitReason: CombClosedExitReason): Promise<void> {
    if (this.justManuallyClosedBy) {
      this.queueMsg(`Cannot virtually close position for ${this.symbol}: a position was already closed via ${this.justManuallyClosedBy}. Not doing anything..`);
      return;
    }

    if (this.isClosingPosition) {
      return;
    }

    const activePosition = this.currActivePosition;
    if (!activePosition) {
      this.queueMsgPriority(`No active position for ${this.symbol}. State unchanged.`);
      return;
    }

    this.isClosingPosition = true;
    try {
      this.queueMsgPriority(`Closing active position for ${this.symbol}...`);
      const closedPosition = await this.orderExecutor.triggerCloseSignal(activePosition);
      this.justManuallyClosedBy = justManuallyClosedByFromVirtualExitReason(exitReason);
      const netPnl = await this.combUtils.handlePnL(
        typeof closedPosition.realizedPnl === "number" ? closedPosition.realizedPnl : 0,
        false,
        undefined,
        undefined,
        undefined,
        closedPosition.id,
      );

      this.notifyInstanceEvent({
        type: "position_closed",
        closedPosition,
        exitReason,
        realizedPnl: closedPosition.realizedPnl,
        netPnl: netPnl,
        symbol: this.symbol,
      });
      const entryFill = this.entryWsPrice;
      this.pnlHistory.push({
        timestamp: new Date().toISOString(),
        timestampMs: Date.now(),
        side: closedPosition.side,
        totalPnL: this.totalActualCalculatedProfit,
        entryTimestamp: entryFill?.time ? entryFill.time.toISOString() : null,
        entryTimestampMs: entryFill?.time ? entryFill.time.getTime() : null,
        entryFillPrice: entryFill?.price ?? (Number.isFinite(activePosition.avgPrice) ? activePosition.avgPrice : null),
        exitTimestamp: new Date(closedPosition.updateTime).toISOString(),
        exitTimestampMs: closedPosition.updateTime,
        exitFillPrice: typeof closedPosition.closePrice === "number" ? closedPosition.closePrice : closedPosition.avgPrice,
        tradePnL: closedPosition.realizedPnl,
        exitReason,
      });

      this.queueMsgPriority(`✅ ${exitReason} Close request completed for ${this.symbol}. State unchanged.`);
    } finally {
      this.isClosingPosition = false;
    }
  }
}

export default CombBotInstance;
