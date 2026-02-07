import TMOBStartingState from "./tmob-states/tmob-starting.state";
import TMOBOptimizeTrailMultiplierState from "./tmob-states/tmob-optimize-trail-multiplier.state";
import TMOBWaitForResolveState from "./tmob-states/tmob-wait-for-resolve.state";
import TMOBWaitForSignalState from "./tmob-states/tmob-wait-for-signal.state";
import TMOBUtils from "./tmob-utils";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import { ICandleInfo, IPosition, ISymbolInfo, TPositionSide } from "@/services/exchange-service/exchange-type";
import TMOBCandleWatcher from "./tmob-candle-watcher";
import BBOrderWatcher from "../breakout-bot/bb-order-watcher";
import ExchangeService from "@/services/exchange-service/exchange-service";
import TelegramService, { ETGCommand } from "@/services/telegram.service";
import BigNumber from "bignumber.js";
import { isTransientError, withRetries } from "../breakout-bot/bb-retry";
import { FeeAwarePnLOptions, formatFeeAwarePnLLine, getPositionDetailMsg } from "@/utils/strings.util";
import { getRunDuration } from "@/utils/maths.util";
import { generatePnLProgressionChart } from "@/utils/image-generator.util";
import { toIsoMinutePlusOneSecond } from "../auto-adjust-bot/candle-utils";

export interface TMOBState {
  onEnter: () => Promise<void>;
  onExit: () => Promise<void>;
}


class TrailMultiplierOptimizationBot {
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

  // Position tracking
  currActivePosition?: IPosition;
  entryWsPrice?: { price: number; time: Date };
  resolveWsPrice?: { price: number; time: Date };
  bufferedExitLevels?: { support: number | null; resistance: number | null };

  // Trailing stop
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

  // Symbol info
  symbolInfo?: ISymbolInfo;
  pricePrecision!: number;
  tickSize: number = 0;

  // Order watching
  orderWatcher?: BBOrderWatcher;
  private botCloseOrderIds: Set<string> = new Set();
  lastOpenClientOrderId?: string;
  lastCloseClientOrderId?: string;

  // Optimization loop
  currTrailMultiplier?: number;
  private optimizationLoopAbort = false;
  private optimizationLoopPromise?: Promise<void>;
  lastOptimizationAtMs: number = 0;

  // Fee tracking
  lastClosedPositionId?: number;
  lastGrossPnl?: number;
  lastBalanceDelta?: number;
  lastFeeEstimate?: number;
  lastNetPnl?: number;

  // PnL history
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
  tmobUtils: TMOBUtils;
  startingState: TMOBStartingState;
  optimizeTrailMultiplierState: TMOBOptimizeTrailMultiplierState;
  waitForResolveState: TMOBWaitForResolveState;
  waitForSignalState: TMOBWaitForSignalState;
  currentState: TMOBState;

  constructor() {
    console.log("INITIATING TRAIL MULTIPLIER OPTIMIZATION BOT");

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

    // Initialize order watcher
    const defaultOrderTimeout = Number(process.env.TRAIL_MULTIPLIER_OPTIMIZATION_BOT_ORDER_TIMEOUT_MS || 60000);
    this.orderWatcher = new BBOrderWatcher({
      defaultTimeoutMs: Number.isFinite(defaultOrderTimeout) ? defaultOrderTimeout : 60000,
    });

    this.tmobUtils = new TMOBUtils(this);
    this.tmobCandleWatcher = new TMOBCandleWatcher(this);

    this.startingState = new TMOBStartingState(this);
    this.optimizeTrailMultiplierState = new TMOBOptimizeTrailMultiplierState(this);
    this.waitForResolveState = new TMOBWaitForResolveState(this);
    this.waitForSignalState = new TMOBWaitForSignalState(this);
    this.currentState = this.startingState;

    this._registerTgCmdHandlers();
  }

  async startMakeMoney() {
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

    await this.currentState.onEnter();
  }

  private _getFeeSummaryForDisplay(): FeeAwarePnLOptions | undefined {
    const metrics = this.getLastTradeMetrics();
    const net = typeof metrics.netPnl === "number" ? metrics.netPnl : metrics.balanceDelta;
    const hasValue = [metrics.grossPnl, metrics.feeEstimate, net].some(
      (value) => typeof value === "number" && Number.isFinite(value),
    );

    if (!hasValue) return undefined;

    return {
      grossPnl: metrics.grossPnl,
      feeEstimate: metrics.feeEstimate,
      netPnl: net,
    };
  }

  private _formatLastTradeSummaryBlock() {
    const metrics = this.getLastTradeMetrics();
    const feeSummary = this._getFeeSummaryForDisplay();
    const feeLine = feeSummary
      ? formatFeeAwarePnLLine(feeSummary)
      : formatFeeAwarePnLLine();
    const walletDelta = typeof metrics.balanceDelta === "number" && Number.isFinite(metrics.balanceDelta)
      ? metrics.balanceDelta.toFixed(4)
      : "N/A";

    return `Last closed position ID: ${metrics.closedPositionId ?? "N/A"}
${feeLine}
Wallet delta: ${walletDelta} USDT`;
  }

  private async _getFullUpdateDetailsMsg() {
    let details = "";
    if (this.currentState === this.startingState) {
      details = `Bot in starting state, preparing bot balances, symbols, leverage`;
    } else if (this.currentState === this.waitForSignalState) {
      details = `
Bot are in wait for entry state, waiting for breakout signal (Up/Down)`.trim();
    } else if (this.currentState === this.waitForResolveState) {
      let position = await withRetries(
        () => ExchangeService.getPosition(this.symbol),
        {
          label: "[TMOB] getPosition",
          retries: 5,
          minDelayMs: 5000,
          isTransientError,
          onRetry: ({ attempt, delayMs, error, label }) => {
            console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
          },
        }
      );
      if (!position) {
        const closedPositions = await withRetries(
          () => ExchangeService.getPositionsHistory({ positionId: this.currActivePosition?.id! }),
          {
            label: "[TMOB] getPositionsHistory",
            retries: 5,
            minDelayMs: 5000,
            isTransientError,
            onRetry: ({ attempt, delayMs, error, label }) => {
              console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
            },
          }
        );
        if (closedPositions?.length > 1) position = closedPositions[0];
      }
      details = `
Bot are in wait for resolve state, monitoring price for exit

${!!position && getPositionDetailMsg(position, { feeSummary: this._getFeeSummaryForDisplay() })}`.trim();
    }

    if (!details) {
      details = `Bot state details unavailable`;
    }

    const lastTradeSummary = this._formatLastTradeSummaryBlock();
    return `${details}

${lastTradeSummary}`;
  }

  private _registerTgCmdHandlers() {
    TelegramService.appendTgCmdHandler(ETGCommand.FullUpdate, async () => {
      const startQuoteBalance = new BigNumber(this.startQuoteBalance ?? 0);
      const currQuoteBalance = new BigNumber(this.currQuoteBalance ?? 0);
      const hasBalances = !!this.startQuoteBalance && !!this.currQuoteBalance;

      const totalProfit = new BigNumber(this.totalActualCalculatedProfit);

      const { runDurationInDays, runDurationDisplay } = getRunDuration(new Date(this.runStartTs!))
      const stratDaysWindows = new BigNumber(365).div(runDurationInDays);
      const stratEstimatedYearlyProfit = totalProfit.times(stratDaysWindows);
      const stratEstimatedROI = startQuoteBalance.lte(0) ? new BigNumber(0) : stratEstimatedYearlyProfit.div(startQuoteBalance).times(100);

      const avgSlippage = this.numberOfTrades > 0
        ? new BigNumber(this.slippageAccumulation).div(this.numberOfTrades).toFixed(5)
        : "0";

      const lastTradeSummary = this._formatLastTradeSummaryBlock();

      const startBalanceDisplay = hasBalances
        ? startQuoteBalance.toNumber().toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
        : "N/A";
      const currBalanceDisplay = hasBalances
        ? currQuoteBalance.toNumber().toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
        : "N/A";
      const balanceDiffDisplay = hasBalances
        ? new BigNumber(currQuoteBalance).minus(startQuoteBalance).toNumber().toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
        : "N/A";

      const msg = `
=== GENERAL ===
Symbol: ${this.symbol}
Leverage: X${this.leverage}
Margin size: ${this.margin} USDT
Buffer percentage: ${this.triggerBufferPercentage}%
Trail confirm bars: ${this.trailConfirmBars}

=== OPTIMIZED PARAMS ===
Optimization window: ${this.optimizationWindowMinutes} minutes
Update interval: ${this.updateIntervalMinutes} minutes
Current trailing ATR Length: ${this.trailingAtrLength} (fixed)
Current trailing multiplier: ${this.currTrailMultiplier}
Last optimized at: ${this.lastOptimizationAtMs > 0 ? toIsoMinutePlusOneSecond(this.lastOptimizationAtMs) : "N/A"}
Next optimization at: ${this.lastOptimizationAtMs > 0 ? toIsoMinutePlusOneSecond(this.lastOptimizationAtMs + this.updateIntervalMinutes * 60_000) : "N/A"}

=== DETAILS ===
${await this._getFullUpdateDetailsMsg()}

=== BUDGET ===
Start Quote Balance (100%): ${startBalanceDisplay} USDT
Current Quote Balance (100%): ${currBalanceDisplay} USDT

Balance current and start diff: ${balanceDiffDisplay} USDT
Calculated actual profit: ${this.totalActualCalculatedProfit.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} USDT

=== ROI ===
Run time: ${runDurationDisplay}
Total profit till now: ${totalProfit.isGreaterThanOrEqualTo(0) ? "🟩" : "🟥"} ${totalProfit.toNumber().toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} USDT (${startQuoteBalance.lte(0) ? 0 : totalProfit.div(startQuoteBalance).times(100).toNumber().toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%) / ${runDurationDisplay}
Estimated yearly profit: ${stratEstimatedYearlyProfit.toNumber().toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} USDT (${stratEstimatedROI.toNumber().toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%)

=== LAST TRADE ===
${lastTradeSummary}

=== SLIPPAGE ===
Slippage accumulation: ${this.slippageAccumulation} pip(s)
Number of trades: ${this.numberOfTrades}
Average slippage: ~${new BigNumber(avgSlippage).gt(0) ? "🟥" : "🟩"} ${avgSlippage} pip(s)
`;

      TelegramService.queueMsg(msg);
    });

    TelegramService.appendTgCmdHandler("pnl_graph", async (ctx) => {
      if (this.pnlHistory.length === 0) {
        const msg = `No PnL history recorded yet.`;
        console.log(msg);
        TelegramService.queueMsg(msg);
        return;
      }

      const rawText = ctx.text || "";
      const argsText = rawText.replace(/^\/\S+\s*/, "").trim();
      const args = argsText.length > 0 ? argsText.split(/\s+/) : [];

      let dilute = 1;
      let errorMsg: string | undefined;

      if (args.length > 0) {
        const diluteIdx = args.findIndex(arg => arg.toLowerCase() === "dilute");
        if (diluteIdx !== -1) {
          const value = args[diluteIdx + 1];
          if (!value) {
            errorMsg = `Please provide a positive number after "dilute".`;
          } else {
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed <= 0) {
              errorMsg = `"${value}" is not a valid positive number for dilute.`;
            } else {
              dilute = Math.max(1, Math.floor(parsed));
            }
          }
        } else {
          const maybeNumber = Number(args[0]);
          if (Number.isFinite(maybeNumber) && maybeNumber > 0) {
            dilute = Math.max(1, Math.floor(maybeNumber));
          } else {
            errorMsg = `Unsupported parameter(s). Use "/pnl_graph dilute <positive_number>".`;
          }
        }
      }

      if (!!errorMsg) {
        console.log(errorMsg);
        TelegramService.queueMsg(errorMsg);
        return;
      }

      const history = this.pnlHistory;
      const filteredHistory = history.filter((_, idx) => {
        if (history.length <= 2) return true;
        if (idx === 0 || idx === history.length - 1) return true;
        return idx % dilute === 0;
      });
      const chartHistory = filteredHistory.map((entry) => ({
        timestamp: Number.isFinite(entry.timestampMs) ? entry.timestampMs : new Date(entry.timestamp).getTime(),
        totalPnL: entry.totalPnL,
      }));

      try {
        const pnlChartImage = await generatePnLProgressionChart(chartHistory);
        TelegramService.queueMsg(pnlChartImage);
        TelegramService.queueMsg(
          `📈 Full PnL chart sent. Points used: ${filteredHistory.length}/${history.length}. Dilute factor: ${dilute}.`
        );
      } catch (error) {
        console.error("Error generating full PnL chart:", error);
        TelegramService.queueMsg(`⚠️ Failed to generate full PnL chart: ${error}`);
      }
    });
  }

  async loadSymbolInfo() {
    this.symbolInfo = await withRetries(
      () => ExchangeService.getSymbolInfo(this.symbol),
      {
        label: "[TMOB] getSymbolInfo",
        retries: 5,
        minDelayMs: 5000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) => {
          console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
        },
      }
    );
    this.pricePrecision = this.symbolInfo?.pricePrecision ?? 0;
    this.tickSize = Math.pow(10, -this.pricePrecision);
  }

  async triggerOpenSignal(posDir: TPositionSide, openBalanceAmt: string): Promise<IPosition> {
    await this._ensureSymbolInfoLoaded();

    const quoteAmt = Number(openBalanceAmt);
    if (!Number.isFinite(quoteAmt) || quoteAmt <= 0) {
      throw new Error(`Invalid quote amount supplied for open signal: ${openBalanceAmt}`);
    }

    const sanitizedQuoteAmt = this._sanitizeQuoteAmount(quoteAmt);
    const rawMarkPrice = await withRetries(
      () => ExchangeService.getMarkPrice(this.symbol),
      {
        label: "[TMOB] getMarkPrice (open)",
        retries: 5,
        minDelayMs: 5000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) => {
          console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
        },
      }
    );
    const markPrice = this._formatPrice(rawMarkPrice) || rawMarkPrice;
    const baseAmt = this._calcBaseQtyFromQuote(sanitizedQuoteAmt, markPrice);

    if (!Number.isFinite(baseAmt) || baseAmt <= 0) {
      throw new Error(`[TMOB] Invalid base amount (${baseAmt}) calculated from quote ${sanitizedQuoteAmt}`);
    }

    const orderSide = posDir === "long" ? "buy" : "sell";
    const clientOrderId = await ExchangeService.generateClientOrderId();
    this.lastOpenClientOrderId = clientOrderId;
    const orderHandle = this.orderWatcher?.preRegister(clientOrderId);
    try {
      console.log(
        `[TMOB] Placing ${orderSide.toUpperCase()} market order (quote: ${sanitizedQuoteAmt}, base: ${baseAmt}) for ${this.symbol}`
      );
      await withRetries(
        async () => {
          try {
            await ExchangeService.placeOrder({
              symbol: this.symbol,
              orderType: "market",
              orderSide,
              baseAmt,
              clientOrderId,
            });
            return;
          } catch (error) {
            try {
              const existing = await ExchangeService.getOrderDetail(this.symbol, clientOrderId);
              if (existing) {
                console.warn(
                  `[TMOB] placeOrder failed but order exists (clientOrderId=${clientOrderId}), continuing.`
                );
                return;
              }
            } catch (lookupErr) {
              console.warn(
                `[TMOB] Failed to verify order existence (clientOrderId=${clientOrderId}):`,
                lookupErr
              );
            }
            throw error;
          }
        },
        {
          label: "[TMOB] placeOrder (open)",
          retries: 5,
          minDelayMs: 5000,
          isTransientError,
          onRetry: ({ attempt, delayMs, error, label }) => {
            console.warn(
              `${label} retrying (attempt=${attempt}, delayMs=${delayMs}, clientOrderId=${clientOrderId}):`,
              error
            );
          },
        }
      );

      const fillUpdate = await orderHandle?.wait();
      const openedPosition = await withRetries(
        () => ExchangeService.getPosition(this.symbol),
        {
          label: "[TMOB] getPosition (open)",
          retries: 5,
          minDelayMs: 5000,
          isTransientError,
          onRetry: ({ attempt, delayMs, error, label }) => {
            console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
          },
        }
      );
      if (!openedPosition || openedPosition.side !== posDir) {
        throw new Error(`[TMOB] Position not detected after ${orderSide} order submission`);
      }

      const fillPrice = fillUpdate?.executionPrice ?? openedPosition.avgPrice;
      const fillTime = fillUpdate?.updateTime ? new Date(fillUpdate.updateTime) : new Date();
      this.entryWsPrice = { price: fillPrice, time: fillTime };
      return openedPosition;
    } catch (error) {
      orderHandle?.cancel();
      throw error;
    }
  }

  async triggerCloseSignal(position?: IPosition): Promise<IPosition> {
    await this._ensureSymbolInfoLoaded();
    const targetPosition = position || this.currActivePosition || (await withRetries(
      () => ExchangeService.getPosition(this.symbol),
      {
        label: "[TMOB] getPosition (close)",
        retries: 5,
        minDelayMs: 5000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) => {
          console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
        },
      }
    ));
    if (!targetPosition) {
      throw new Error("[TMOB] No active position found to close");
    }

    const baseAmt = this._sanitizeBaseQty(Math.abs(targetPosition.size));
    if (!Number.isFinite(baseAmt) || baseAmt <= 0) {
      throw new Error("[TMOB] Target position size is zero, cannot close position");
    }

    const orderSide = targetPosition.side === "long" ? "sell" : "buy";
    const clientOrderId = await ExchangeService.generateClientOrderId();
    this.lastCloseClientOrderId = clientOrderId;
    const orderHandle = this.orderWatcher?.preRegister(clientOrderId);
    this._trackCloseOrderId(clientOrderId);
    try {
      console.log(
        `[TMOB] Placing ${orderSide.toUpperCase()} market order (base: ${baseAmt}) to close position ${targetPosition.id}`
      );
      await withRetries(
        async () => {
          try {
            await ExchangeService.placeOrder({
              symbol: targetPosition.symbol,
              orderType: "market",
              orderSide,
              baseAmt,
              clientOrderId,
            });
            return;
          } catch (error) {
            try {
              const existing = await ExchangeService.getOrderDetail(targetPosition.symbol, clientOrderId);
              if (existing) {
                console.warn(
                  `[TMOB] close placeOrder failed but order exists (clientOrderId=${clientOrderId}), continuing.`
                );
                return;
              }
            } catch (lookupErr) {
              console.warn(
                `[TMOB] Failed to verify close order existence (clientOrderId=${clientOrderId}):`,
                lookupErr
              );
            }
            throw error;
          }
        },
        {
          label: "[TMOB] placeOrder (close)",
          retries: 5,
          minDelayMs: 5000,
          isTransientError,
          onRetry: ({ attempt, delayMs, error, label }) => {
            console.warn(
              `${label} retrying (attempt=${attempt}, delayMs=${delayMs}, clientOrderId=${clientOrderId}):`,
              error
            );
          },
        }
      );

      const fillUpdate = await orderHandle?.wait();
      const closedPosition = await this.fetchClosedPositionSnapshot(targetPosition.id);
      if (!closedPosition || typeof closedPosition.closePrice !== "number") {
        throw new Error(`[TMOB] Failed to retrieve closed position snapshot for id ${targetPosition.id}`);
      }

      const resolvePrice = fillUpdate?.executionPrice ?? closedPosition.closePrice ?? closedPosition.avgPrice;
      const resolveTime = fillUpdate?.updateTime ? new Date(fillUpdate.updateTime) : new Date();
      this.resolveWsPrice = { price: resolvePrice, time: resolveTime };
      return closedPosition;
    } catch (error) {
      orderHandle?.cancel();
      throw error;
    } finally {
      this._untrackCloseOrderId(clientOrderId);
    }
  }

  async fetchClosedPositionSnapshot(positionId: number, maxRetries = 5): Promise<IPosition | undefined> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const history = await ExchangeService.getPositionsHistory({ positionId });
      const position = history[0];
      if (position && typeof position.closePrice === "number") {
        return position;
      }
      if (attempt < maxRetries - 1) {
        const delayMs = 200 * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    return undefined;
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
    if (this.optimizationLoopPromise) return;
    this.optimizationLoopAbort = false;
    this.optimizationLoopPromise = this._runOptimizationLoop();
  }

  stopOptimizationLoop() {
    this.optimizationLoopAbort = true;
  }

  private async _runOptimizationLoop() {
    while (!this.optimizationLoopAbort) {
      const now = Date.now();
      const intervalMs = this.updateIntervalMinutes * 60_000;
      const elapsedSinceLastMs = this.lastOptimizationAtMs > 0 ? now - this.lastOptimizationAtMs : Infinity;
      const shouldRunOptimization = this.lastOptimizationAtMs === 0 || elapsedSinceLastMs >= intervalMs;

      if (shouldRunOptimization) {
        try {
          await this.optimizeLiveParams();
        } catch (error) {
          console.error("[TMOB] Live optimization loop error:", error);
        }
      }

      if (this.optimizationLoopAbort) break;
      const rawNextDueMs =
        this.lastOptimizationAtMs > 0
          ? this.lastOptimizationAtMs + intervalMs
          : now + intervalMs;
      //  Make it exactly one second after the minute
      const nextDueMs = Math.floor(rawNextDueMs / 1000) * 1000 + 1000;
      const waitMs = Math.max(200, nextDueMs - now);
      console.log("waitMs: ", waitMs);

      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    this.optimizationLoopPromise = undefined;
  }

  async optimizeLiveParams() {
    const intervalMs = this.updateIntervalMinutes * 60_000;
    const elapsedSinceLastMs = this.lastOptimizationAtMs > 0 ? Date.now() - this.lastOptimizationAtMs : Infinity;
    if (elapsedSinceLastMs < intervalMs) {
      console.log(`Not optimizing live params because it's been less than the update interval: ${elapsedSinceLastMs}ms < ${intervalMs}ms`);
      return;
    }

    if (this.currActivePosition) {
      const activePosition = this.currActivePosition;
      TelegramService.queueMsg(
        `⏱️ Optimization update due - closing open position before re-optimizing.\n` +
        `Position ID: ${activePosition.id} (${activePosition.side})`
      );
      const triggerTs = Date.now();
      const closedPosition = await this.triggerCloseSignal(activePosition);
      const fillTimestamp = this.resolveWsPrice?.time ? this.resolveWsPrice.time.getTime() : Date.now();
      await this.finalizeClosedPosition(closedPosition, {
        activePosition,
        triggerTimestamp: triggerTs,
        fillTimestamp,
      });
    }

    await this.tmobUtils.updateCurrTrailMultiplier();

    // Update the trailingStopMultiplier from currTrailMultiplier
    if (this.currTrailMultiplier !== undefined) {
      this.trailingStopMultiplier = this.currTrailMultiplier;

      const intervalMs = this.updateIntervalMinutes * 60_000;
      const nextOptimizationMs = this.lastOptimizationAtMs + intervalMs;

      TelegramService.queueMsg(
        `✅ Optimization updated\n` +
        `Trailing ATR Length: ${this.trailingAtrLength} (fixed)\n` +
        `Trailing Multiplier: ${this.trailingStopMultiplier}\n` +
        `Next optimization: ${toIsoMinutePlusOneSecond(nextOptimizationMs)}`
      );
    }
  }

  private async _ensureSymbolInfoLoaded() {
    if (this.symbolInfo) return;
    await this.loadSymbolInfo();
  }

  private _formatWithPrecision(value: number, precision?: number) {
    if (!Number.isFinite(value) || precision === undefined) return value;
    return new BigNumber(value).decimalPlaces(precision, BigNumber.ROUND_DOWN).toNumber();
  }

  private _formatPrice(value: number) {
    return this._formatWithPrecision(value, this.symbolInfo?.pricePrecision);
  }

  private _formatQuoteAmount(value: number) {
    return this._formatWithPrecision(value, this.symbolInfo?.quotePrecision);
  }

  private _formatBaseAmount(value: number) {
    return this._formatWithPrecision(value, this.symbolInfo?.basePrecision);
  }

  private _sanitizeQuoteAmount(rawQuoteAmt: number) {
    const minNotional = this.symbolInfo?.minNotionalValue;
    let sanitized = rawQuoteAmt;
    if (minNotional && sanitized < minNotional) {
      console.warn(`[TMOB] Quote amount ${sanitized} is below min notional ${minNotional}, adjusting to min.`);
      sanitized = minNotional;
    }
    return this._formatQuoteAmount(sanitized);
  }

  private _sanitizeBaseQty(rawBaseAmt: number) {
    let sanitized = this._formatBaseAmount(rawBaseAmt);
    const maxMarketQty = this.symbolInfo?.maxMktOrderQty;
    if (maxMarketQty && sanitized > maxMarketQty) {
      console.warn(`[TMOB] Base quantity ${sanitized} exceeds max market qty ${maxMarketQty}, capping value.`);
      sanitized = maxMarketQty;
    }
    return sanitized;
  }

  private _calcBaseQtyFromQuote(quoteAmt: number, price: number) {
    if (price <= 0) {
      throw new Error(`[TMOB] Invalid price (${price}) when calculating base quantity from quote ${quoteAmt}`);
    }
    const baseQty = new BigNumber(quoteAmt).div(price).toNumber();
    return this._sanitizeBaseQty(baseQty);
  }

  isBotGeneratedCloseOrder(clientOrderId?: string | null): boolean {
    if (!clientOrderId) return false;
    return this.botCloseOrderIds.has(clientOrderId);
  }

  private _trackCloseOrderId(clientOrderId: string) {
    if (clientOrderId) {
      this.botCloseOrderIds.add(clientOrderId);
    }
  }

  private _untrackCloseOrderId(clientOrderId: string) {
    if (clientOrderId) {
      this.botCloseOrderIds.delete(clientOrderId);
    }
  }
}

export default TrailMultiplierOptimizationBot;