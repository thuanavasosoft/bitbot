import TMOBStartingState from "./tmob-states/tmob-starting.state";
import TMOBOptimizeTrailMultiplierState from "./tmob-states/tmob-optimize-trail-multiplier.state";
import TMOBWaitForResolveState from "./tmob-states/tmob-wait-for-resolve.state";
import TMOBWaitForSignalState from "./tmob-states/tmob-wait-for-signal.state";
import TMOBUtils from "./tmob-utils";
import TMOBTelegramHandler from "./tmob-telegram-handler";
import TMOBOrderExecutor from "./tmob-order-executor";
import TMOBOptimizationLoop from "./tmob-optimization-loop";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import { ICandleInfo, IPosition, ISymbolInfo, TPositionSide } from "@/services/exchange-service/exchange-type";
import TMOBCandleWatcher from "./tmob-candle-watcher";
import TMOBCandles from "./tmob-candles";
import TMOBOrderWatcher from "./tmob-order-watcher";
import TelegramService from "@/services/telegram.service";
import BigNumber from "bignumber.js";
import { TMOBState } from "./tmob-types";
import { persistTMOBAction } from "./tmob-persistence";
import { TMOB_ACTION_TYPE, orderToSnapshot, positionToSnapshot, type TMOBBotStateSnapshot } from "./tmob-action-types";
import { randomUUID } from "crypto";
import ExchangeService from "@/services/exchange-service/exchange-service";

export type { TMOBState } from "./tmob-types";

class TrailMultiplierOptimizationBot {
  runId: string;
  runStartTs?: Date;

  symbol: string;
  leverage: number;
  margin: number;

  startQuoteBalance?: string;
  currQuoteBalance?: string;
  totalActualCalculatedProfit: number = 0;
  slippageAccumulation: number = 0;
  numberOfTrades: number = 0;

  currentSupport: number | null = null;
  currentResistance: number | null = null;
  triggerBufferPercentage: number;
  longTrigger: number | null = null;
  shortTrigger: number | null = null;
  lastSRUpdateTime: number = 0;
  lastExitTime: number = 0;
  lastEntryTime: number = 0;

  currActivePosition?: IPosition;
  entryWsPrice?: { price: number; time: Date };
  resolveWsPrice?: { price: number; time: Date };
  bufferedExitLevels?: { support: number | null; resistance: number | null };

  trailingStopTargets?: { side: TPositionSide; rawLevel: number; bufferedLevel: number; updatedAt: number };
  trailConfirmBars: number;
  trailingAtrLength: number;
  trailingHighestLookback: number;
  trailingStopMultiplier: number = 0;
  trailingAtrWindow: ICandleInfo[] = [];
  trailingCloseWindow: number[] = [];
  lastTrailingStopUpdateTime: number = 0;
  trailingStopBreachCount: number = 0;

  updateIntervalMinutes: number;
  optimizationWindowMinutes: number;
  nSignal: number;

  isOpeningPosition: boolean = false;

  trailBoundStepSize: number;
  trailMultiplierBounds: { min: number; max: number };

  symbolInfo?: ISymbolInfo;
  pricePrecision!: number;
  tickSize: number = 0;

  orderWatcher?: TMOBOrderWatcher;
  private botCloseOrderIds: Set<string> = new Set();
  lastOpenClientOrderId?: string;
  lastCloseClientOrderId?: string;

  currTrailMultiplier?: number;
  lastOptimizationAtMs: number = 0;

  lastClosedPositionId?: number;
  lastGrossPnl?: number;
  lastBalanceDelta?: number;
  lastFeeEstimate?: number;
  lastNetPnl?: number;

  pnlHistory: Array<{
    timestamp: string;
    timestampMs: number;
    side: "long" | "short";
    totalPnL: number;
    entryTimestamp: string | null;
    entryTimestampMs: number | null;
    entryFillPrice: number | null;
    exitTimestamp: string;
    exitTimestampMs: number;
    exitFillPrice: number;
    tradePnL: number;
    exitReason: "atr_trailing" | "signal_change" | "end" | "liquidation_exit";
  }> = [];

  tmobCandleWatcher: TMOBCandleWatcher;
  tmobCandles: TMOBCandles;
  tmobUtils: TMOBUtils;
  telegramHandler: TMOBTelegramHandler;
  orderExecutor: TMOBOrderExecutor;
  optimizationLoop: TMOBOptimizationLoop;
  startingState: TMOBStartingState;
  optimizeTrailMultiplierState: TMOBOptimizeTrailMultiplierState;
  waitForResolveState: TMOBWaitForResolveState;
  waitForSignalState: TMOBWaitForSignalState;
  currentState: TMOBState;

  constructor() {
    console.log("INITIATING TRAIL MULTIPLIER OPTIMIZATION BOT");
    this.runId = randomUUID();

    this.symbol = process.env.SYMBOL!;
    this.leverage = Number(process.env.LEVERAGE!);
    this.margin = Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_MARGIN!);
    this.triggerBufferPercentage = Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_TRIGGER_BUFFER_PERCENTAGE! || 0);
    this.trailingAtrLength = Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_N_SIGNAL_AND_ATR_LENGTH!);
    this.trailingHighestLookback = Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_N_SIGNAL_AND_ATR_LENGTH!);
    this.updateIntervalMinutes = Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_UPDATE_INTERVAL_MINUTES!);
    this.optimizationWindowMinutes = Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_OPTIMIZATION_WINDOW_MINUTES!);
    this.nSignal = Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_N_SIGNAL_AND_ATR_LENGTH!);
    this.trailConfirmBars = Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_TRAIL_CONFIRM_BARS! || 1);
    this.trailBoundStepSize = Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_TRAIL_BOUND_STEP_SIZE! || 1);
    this.trailMultiplierBounds = {
      min: Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_TRAIL_MULTIPLIER_BOUNDS_MIN!),
      max: Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_TRAIL_MULTIPLIER_BOUNDS_MAX!),
    };

    const defaultOrderTimeout = Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_ORDER_TIMEOUT_MS || 60000);
    this.orderWatcher = new TMOBOrderWatcher({
      defaultTimeoutMs: Number.isFinite(defaultOrderTimeout) ? defaultOrderTimeout : 60000,
    });

    this.tmobUtils = new TMOBUtils(this);
    this.tmobCandles = new TMOBCandles(this);
    this.tmobCandleWatcher = new TMOBCandleWatcher(this);
    this.telegramHandler = new TMOBTelegramHandler(this);
    this.orderExecutor = new TMOBOrderExecutor(this);
    this.optimizationLoop = new TMOBOptimizationLoop(this);

    this.startingState = new TMOBStartingState(this);
    this.optimizeTrailMultiplierState = new TMOBOptimizeTrailMultiplierState(this);
    this.waitForResolveState = new TMOBWaitForResolveState(this);
    this.waitForSignalState = new TMOBWaitForSignalState(this);
    this.currentState = this.startingState;

    this.telegramHandler.register();
  }

  async startMakeMoney() {
    await persistTMOBAction(this.runId, TMOB_ACTION_TYPE.RESTARTING, { message: "Run started" }, getTMOBBotStateSnapshot(this));

    eventBus.addListener(EEventBusEventType.StateChange, async (nextState: TMOBState) => {
      console.log("State change triggered, changing state");

      await this.currentState.onExit();

      if (this.currentState === this.startingState) {
        console.log("Current state is starting, next state is waiting for signal");
        this.currentState = this.waitForSignalState;
      } else if (this.currentState === this.waitForSignalState) {
        console.log("Current state is waiting for signal, next state is waiting for resolve");
        this.currentState = this.waitForResolveState;
      } else if (this.currentState === this.optimizeTrailMultiplierState) {
        console.log("Current state is optimizing trail multiplier, next state is waiting for signal");
        this.currentState = this.waitForSignalState;
      } else if (this.currentState === this.waitForResolveState) {
        if (!!nextState) this.currentState = nextState;
        else this.currentState = this.startingState;
      }

      await this.currentState.onEnter();
    });

    try {
      await this.currentState.onEnter();
    } catch (error) {
      await persistTMOBAction(this.runId, TMOB_ACTION_TYPE.ERROR, {
        message: error instanceof Error ? error.message : String(error),
        context: "startMakeMoney.initialOnEnter",
        stack: error instanceof Error ? error.stack : undefined,
      }, getTMOBBotStateSnapshot(this));
      throw error;
    }
  }

  async loadSymbolInfo() {
    return this.orderExecutor.loadSymbolInfo();
  }

  async triggerOpenSignal(posDir: TPositionSide, openBalanceAmt: string): Promise<IPosition> {
    return this.orderExecutor.triggerOpenSignal(posDir, openBalanceAmt);
  }

  async triggerCloseSignal(position?: IPosition): Promise<IPosition> {
    return this.orderExecutor.triggerCloseSignal(position);
  }

  async fetchClosedPositionSnapshot(positionId: number, maxRetries = 5): Promise<IPosition | undefined> {
    return this.orderExecutor.fetchClosedPositionSnapshot(positionId, maxRetries);
  }

  resetTrailingStopTracking() {
    this.trailingAtrWindow = [];
    this.trailingCloseWindow = [];
    this.trailingStopTargets = undefined;
    this.lastTrailingStopUpdateTime = 0;
    this.trailingStopBreachCount = 0;
  }

  async finalizeClosedPosition(
    closedPosition: IPosition,
    options: {
      activePosition?: IPosition;
      triggerTimestamp?: number;
      fillTimestamp?: number;
      isLiquidation?: boolean;
      exitReason?: "atr_trailing" | "signal_change" | "end" | "liquidation_exit";
    } = {}
  ) {
    const activePosition = options.activePosition ?? this.currActivePosition;
    const entryFill = this.entryWsPrice;
    const closedPositionId = closedPosition.id;
    const positionSide = activePosition?.side;
    const fillTimestamp = options.fillTimestamp ?? this.resolveWsPrice?.time?.getTime() ?? closedPosition.updateTime ?? Date.now();
    const triggerTimestamp = options.triggerTimestamp ?? fillTimestamp;
    const shouldTrackSlippage = !options.isLiquidation;

    const closedPrice = typeof closedPosition.closePrice === "number" ? closedPosition.closePrice : closedPosition.avgPrice;

    let srLevel: number | null = null;
    if (positionSide === "long") {
      srLevel = this.currentSupport;
    } else if (positionSide === "short") {
      srLevel = this.currentResistance;
    }

    let slippage = 0;
    const timeDiffMs = fillTimestamp - triggerTimestamp;

    if (shouldTrackSlippage) {
      if (srLevel === null) {
        TelegramService.queueMsg(
          `⚠️ Warning: Cannot calculate slippage - ${positionSide === "long" ? "support" : "resistance"} level not available`
        );
      } else {
        slippage = positionSide === "short"
          ? new BigNumber(closedPrice).minus(srLevel).toNumber()
          : new BigNumber(srLevel).minus(closedPrice).toNumber();
      }
    }

    const icon = slippage <= 0 ? "🟩" : "🟥";
    if (shouldTrackSlippage) {
      if (icon === "🟥") {
        this.slippageAccumulation += Math.abs(slippage);
      } else {
        this.slippageAccumulation -= Math.abs(slippage);
      }
    }

    this.currActivePosition = undefined;
    this.entryWsPrice = undefined;
    this.resolveWsPrice = undefined;
    this.bufferedExitLevels = undefined;
    this.resetTrailingStopTracking();
    if (!options.isLiquidation) {
      this.numberOfTrades++;
    }
    this.lastExitTime = Date.now();

    await this.tmobUtils?.handlePnL(
      closedPosition.realizedPnl,
      options.isLiquidation ?? false,
      shouldTrackSlippage ? icon : undefined,
      shouldTrackSlippage ? slippage : undefined,
      shouldTrackSlippage ? timeDiffMs : undefined,
      closedPositionId,
    );

    const entryTimestampMs =
      entryFill?.time?.getTime() ?? (Number.isFinite(activePosition?.createTime) ? activePosition!.createTime : null);
    const entryTimestamp = entryTimestampMs ? new Date(entryTimestampMs).toISOString() : null;
    const entryFillPrice = entryFill?.price ?? (Number.isFinite(activePosition?.avgPrice) ? activePosition!.avgPrice : null);
    const exitFillPrice = typeof closedPosition.closePrice === "number" ? closedPosition.closePrice : closedPosition.avgPrice;
    const exitReason =
      options.exitReason ?? (options.isLiquidation ? "liquidation_exit" : "signal_change");

    this.pnlHistory.push({
      timestamp: new Date(fillTimestamp).toISOString(),
      timestampMs: fillTimestamp,
      side: (positionSide ?? closedPosition.side) as "long" | "short",
      totalPnL: this.totalActualCalculatedProfit,
      entryTimestamp,
      entryTimestampMs,
      entryFillPrice,
      exitTimestamp: new Date(fillTimestamp).toISOString(),
      exitTimestampMs: fillTimestamp,
      exitFillPrice,
      tradePnL: Number.isFinite(closedPosition.realizedPnl) ? closedPosition.realizedPnl : 0,
      exitReason,
    });

    const closeOrder = await ExchangeService.getOrderDetail(this.symbol, this.lastCloseClientOrderId ?? "");
    await persistTMOBAction(this.runId, TMOB_ACTION_TYPE.CLOSED_POSITION, {
      order: orderToSnapshot(closeOrder ?? undefined),
      position: positionToSnapshot(closedPosition),
      exitReason,
      isLiquidation: options.isLiquidation,
      triggerTimestamp,
      fillTimestamp,
      entryWsPrice: entryFill
        ? { price: entryFill.price, time: entryFill.time.toISOString() }
        : undefined,
    }, getTMOBBotStateSnapshot(this));

    eventBus.emit(EEventBusEventType.StateChange);
  }

  updateLastTradeMetrics(metrics: { closedPositionId?: number; grossPnl?: number; balanceDelta?: number; feeEstimate?: number; netPnl?: number }) {
    if ("closedPositionId" in metrics) {
      this.lastClosedPositionId = metrics.closedPositionId;
    }
    if ("grossPnl" in metrics) {
      this.lastGrossPnl = metrics.grossPnl;
    }
    if ("balanceDelta" in metrics) {
      this.lastBalanceDelta = metrics.balanceDelta;
    }
    if ("feeEstimate" in metrics) {
      this.lastFeeEstimate = metrics.feeEstimate;
    }
    if ("netPnl" in metrics) {
      this.lastNetPnl = metrics.netPnl;
    }
  }

  getLastTradeMetrics(): { closedPositionId?: number; grossPnl?: number; balanceDelta?: number; feeEstimate?: number; netPnl?: number } {
    return {
      closedPositionId: this.lastClosedPositionId,
      grossPnl: this.lastGrossPnl,
      balanceDelta: this.lastBalanceDelta,
      feeEstimate: this.lastFeeEstimate,
      netPnl: this.lastNetPnl ?? this.lastBalanceDelta,
    };
  }

  clearLastTradeMetrics() {
    this.lastClosedPositionId = undefined;
    this.lastGrossPnl = undefined;
    this.lastBalanceDelta = undefined;
    this.lastFeeEstimate = undefined;
    this.lastNetPnl = undefined;
  }

  startOptimizationLoop() {
    this.optimizationLoop.start();
  }

  stopOptimizationLoop() {
    this.optimizationLoop.stop();
  }

  async optimizeLiveParams() {
    return this.optimizationLoop.optimizeLiveParams();
  }

  isBotGeneratedCloseOrder(clientOrderId?: string | null): boolean {
    if (!clientOrderId) return false;
    return this.botCloseOrderIds.has(clientOrderId);
  }

  trackCloseOrderId(clientOrderId: string) {
    if (clientOrderId) {
      this.botCloseOrderIds.add(clientOrderId);
    }
  }

  untrackCloseOrderId(clientOrderId: string) {
    if (clientOrderId) {
      this.botCloseOrderIds.delete(clientOrderId);
    }
  }
}

/**
 * Builds a serializable snapshot of the current bot state for persistence.
 * Used so each persisted action has the exact bot state at that moment.
 */
export function getTMOBBotStateSnapshot(bot: TrailMultiplierOptimizationBot): TMOBBotStateSnapshot {
  const currentStateName = bot.currentState?.constructor?.name ?? "Unknown";
  return {
    currentState: currentStateName,
    runId: bot.runId,
    runStartTs: bot.runStartTs?.toISOString(),
    symbol: bot.symbol,
    leverage: bot.leverage,
    margin: bot.margin,
    startQuoteBalance: bot.startQuoteBalance,
    currQuoteBalance: bot.currQuoteBalance,
    totalActualCalculatedProfit: bot.totalActualCalculatedProfit,
    numberOfTrades: bot.numberOfTrades,
    trailingStopMultiplier: bot.trailingStopMultiplier,
    currTrailMultiplier: bot.currTrailMultiplier,
    longTrigger: bot.longTrigger,
    shortTrigger: bot.shortTrigger,
    lastEntryTime: bot.lastEntryTime,
    lastExitTime: bot.lastExitTime,
    currActivePositionId: bot.currActivePosition?.id,
    hasEntryWsPrice: !!bot.entryWsPrice,
    hasResolveWsPrice: !!bot.resolveWsPrice,
  };
}

export default TrailMultiplierOptimizationBot;
