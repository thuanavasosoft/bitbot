import { EventEmitter } from "events";
import { EEventBusEventType } from "@/utils/event-bus.util";
import TelegramService from "@/services/telegram.service";
import BigNumber from "bignumber.js";
import { randomUUID } from "crypto";
import type { CombState, CombInstanceConfig, CombPnlHistoryPoint, CombInstanceEvent, JustManuallyClosedBy } from "./comb-types";
import CombOrderWatcher from "./comb-order-watcher";
import CombCandles from "./comb-candles";
import CombUtils from "./comb-utils";
import CombOrderExecutor from "./comb-order-executor";
import CombStartingState from "./comb-states/comb-starting.state";
import CombWaitForSignalState from "./comb-states/comb-wait-for-signal.state";
import CombWaitForResolveState from "./comb-states/comb-wait-for-resolve.state";
import CombStoppedState from "./comb-states/comb-stopped.state";
import CombCandleWatcher from "./comb-candle-watcher";
import CombOptimizationLoop from "./comb-optimization-loop";
import CombTelegramHandler from "./comb-telegram-handler";
import type { ICandleInfo, IPosition, ISymbolInfo, TPositionSide } from "@/services/exchange-service/exchange-type";

/** Human-readable labels for finalizeClosedPosition exit reasons (general channel / logs). */
const EXIT_REASON_DISPLAY = new Map<string, string>([
  ["atr_trailing", "trailing stop"],
  ["signal_change", "signal/close"],
  ["liquidation_exit", "liquidation"],
  ["end", "end"],
  ["tp_pullback", "TP pullback (state reset)"],
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
  /** Take profit on pullback: close when price pulls back X% from highest (long) or lowest (short). 0 = disabled. */
  tpPullbackPercent: number = 0;
  /** Highest price since entry (for long). Used by TP_PB. */
  highestPriceSinceEntry?: number;
  /** Lowest price since entry (for short). Used by TP_PB. */
  lowestPriceSinceEntry?: number;
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
    this.tpPullbackPercent = 0;
    this.highestPriceSinceEntry = undefined;
    this.lowestPriceSinceEntry = undefined;

    if (!_options?.suppressStateChange) {
      this.stateBus.emit(EEventBusEventType.StateChange);
    }
  }
}

export default CombBotInstance;
