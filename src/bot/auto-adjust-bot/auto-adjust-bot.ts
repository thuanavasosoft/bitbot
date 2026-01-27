import ExchangeService from "@/services/exchange-service/exchange-service";
import { ICandleInfo, IPosition, ISymbolInfo, TPositionSide } from "@/services/exchange-service/exchange-type";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import TelegramService, { ETGCommand } from "@/services/telegram.service";
import AAStartingState from "./aa-states/aa-starting.state";
import AAOptimizeState from "./aa-states/aa-optimize.state";
import AASimulateState from "./aa-states/aa-simulate.state";
import AALiveStartingState from "./aa-states/aa-live-starting.state";
import AAWaitForEntryState from "./aa-states/aa-wait-for-entry.state";
import AAWaitForResolveState from "./aa-states/aa-wait-for-resolve.state";
import { optimizeTrailingAtrAndMultiplier2D, type OptimizationHistoryEntry } from "./optimizeTrailingAtrMultiplier2d";
import type { OptimizationWindowResult } from "./runOptimization";
import type { PnlHistoryPoint, SignalParams } from "./types";
import type { Candle } from "./types";
import BBOrderWatcher from "../breakout-bot/bb-order-watcher";
import AAUtil from "./aa-util";
import AATrendWatcher from "./aa-trend-watcher";
import BigNumber from "bignumber.js";
import { computeWarmupBars } from "./warmup";
import { getCandlesForBacktest } from "./getCandlesForBacktest";
import { sliceCandles, toIso } from "./candle-utils";
import { runBacktest } from "./runBacktest";
import { isTransientError, withRetries } from "../breakout-bot/bb-retry";
import { generatePnLProgressionChart } from "@/utils/image-generator.util";
import { FeeAwarePnLOptions, formatFeeAwarePnLLine, getPositionDetailMsg } from "@/utils/strings.util";
import { getRunDuration } from "@/utils/maths.util";

export interface AAState {
  onEnter: () => Promise<void>;
  onExit: () => Promise<void>;
}

const DEFAULT_SIGNAL_PARAMS: SignalParams = {
  N: 2880,
  atr_len: 14,
  K: 5,
  eps: 0.0005,
  m_atr: 0.25,
  roc_min: 0.0001,
  ema_period: 10,
  need_two_closes: false,
  vol_mult: 1.3,
};

class AutoAdjustBot {
  runStartTs: Date = new Date();

  liveMode: boolean;

  symbol: string;
  startTime: string;
  endTime: string;
  startMs: number;
  endMs: number;

  updateIntervalMinutes: number;
  optimizationWindowMinutes: number;
  updateIntervalMs: number;
  optimizationWindowMs: number;
  durationDays: number = 0;

  checkIntervalMinutes: number;
  intervalDelaySeconds: number;

  margin: number;
  leverage: number;
  bufferPercentage: number;
  trailConfirmBars: number;

  signalParams: SignalParams;

  totalEvaluations?: number;
  initialRandom?: number;
  numCandidates?: number;
  kappa?: number;
  atrBounds: { min: number; max: number };
  multiplierBounds: { min: number; max: number };

  symbolInfo?: ISymbolInfo;
  pricePrecision: number = 0;
  tickSize: number = 0;

  maxWarmupBars: number = 0;
  fetchStartMs: number = 0;
  fetchEndMs: number = 0;

  candles: Candle[] = [];
  candleByOpenTime: Map<number, Candle> = new Map();
  candleCount: number = 0;

  // Live trading state
  startQuoteBalance?: string;
  currQuoteBalance?: string;
  totalActualCalculatedProfit: number = 0;
  slippageAccumulation: number = 0;

  currActivePosition?: IPosition;
  entryWsPrice?: { price: number; time: Date };
  resolveWsPrice?: { price: number; time: Date };
  bufferedExitLevels?: { support: number | null; resistance: number | null };

  currentSignal: "Up" | "Down" | "Kangaroo" = "Kangaroo";
  currentSupport: number | null = null;
  currentResistance: number | null = null;
  longTrigger: number | null = null;
  shortTrigger: number | null = null;
  lastSRUpdateTime: number = 0;
  lastExitTime: number = 0;
  lastEntryTime: number = 0;

  trailingAtrLength: number = 0;
  trailingHighestLookback: number = 0;
  trailingStopMultiplier: number = 0;
  trailingStopConfirmTicks: number = 0;
  trailingAtrWindow: ICandleInfo[] = [];
  trailingCloseWindow: number[] = [];
  trailingStopTargets?: { side: TPositionSide; rawLevel: number; bufferedLevel: number; updatedAt: number };
  lastTrailingStopUpdateTime: number = 0;
  trailingStopBreachCount: number = 0;

  orderWatcher?: BBOrderWatcher;
  private botCloseOrderIds: Set<string> = new Set();
  lastOpenClientOrderId?: string;
  lastCloseClientOrderId?: string;

  aaUtil?: AAUtil;
  aaTrendWatcher?: AATrendWatcher;

  private optimizationLoopAbort = false;
  private optimizationLoopPromise?: Promise<void>;

  optimizationSteps: number = 0;
  stepIndex: number = 0;

  lastBestParams: { trailingAtrLength: number; trailMultiplier: number } | null = null;
  lastBestValue: number = 0;
  lastOptimizationHistory: OptimizationHistoryEntry[] = [];
  lastFitDurationMs: number = 0;
  lastOptimizationAtMs: number = 0;

  windowResults: OptimizationWindowResult[] = [];
  pnlHistory: PnlHistoryPoint[] = [];
  perBarReturns: number[] = [];
  overallPnL: number = 0;
  totalFeesPaid: number = 0;
  numberOfTrades: number = 0;
  liquidationCount: number = 0;

  isFinished: boolean = false;

  startingState: AAStartingState;
  optimizeState: AAOptimizeState;
  simulateState: AASimulateState;
  currentState: AAState;

  liveStartingState?: AALiveStartingState;
  waitForEntryState?: AAWaitForEntryState;
  waitForResolveState?: AAWaitForResolveState;
  currentLiveState?: AAState;

  constructor() {
    this._verifyEnvs();

    this.runStartTs = new Date();
    this.liveMode = process.env.AUTO_ADJUST_BOT_LIVE === "true";
    this.symbol = process.env.SYMBOL!;
    this.updateIntervalMinutes = Number(process.env.AUTO_ADJUST_BOT_UPDATE_INTERVAL_MINUTES!);
    const optimizationWindowEnv =
      process.env.AUTO_ADJUST_BOT_OPTIMIZATION_WINDOW_MINUTES ??
      process.env.AUTO_ADJUST_BOT_UPDATE_OPTIMIZATION_WINDOW_MINUTES;
    this.optimizationWindowMinutes = Number(optimizationWindowEnv!);
    this.updateIntervalMs = this.updateIntervalMinutes * 60_000;
    this.optimizationWindowMs = this.optimizationWindowMinutes * 60_000;

    this.checkIntervalMinutes = Number(process.env.AUTO_ADJUST_BOT_CHECK_INTERVAL_MINUTES || 1);
    this.intervalDelaySeconds = Number(process.env.AUTO_ADJUST_BOT_INTERVAL_DELAY_SECONDS ?? 0);

    const now = new Date();
    now.setSeconds(0, 0);
    const fallbackEndMs = now.getTime();
    const fallbackStartMs = fallbackEndMs - this.updateIntervalMs;

    this.startTime = process.env.AUTO_ADJUST_BOT_START_TIME ?? new Date(fallbackStartMs).toISOString();
    this.endTime = process.env.AUTO_ADJUST_BOT_END_TIME ?? new Date(fallbackEndMs).toISOString();
    this.startMs = new Date(this.startTime).getTime();
    this.endMs = new Date(this.endTime).getTime();
    if (!Number.isFinite(this.startMs) || !Number.isFinite(this.endMs) || this.endMs <= this.startMs) {
      console.error(
        `[AutoAdjustBot] Invalid time range start=${this.startTime} end=${this.endTime}`
      );
      process.exit(-1);
    }

    this.margin = Number(process.env.AUTO_ADJUST_BOT_MARGIN || 100);
    this.leverage = Number(process.env.AUTO_ADJUST_BOT_LEVERAGE || 20);
    this.bufferPercentage = Number(process.env.AUTO_ADJUST_BOT_BUFFER_PERCENTAGE || 0) / 100;
    this.trailConfirmBars = Math.max(1, Number(process.env.AUTO_ADJUST_BOT_TRAIL_CONFIRM_BARS || 1));
    this.trailingStopConfirmTicks = this.trailConfirmBars;

    this.signalParams = {
      ...DEFAULT_SIGNAL_PARAMS,
      N: Number(process.env.AUTO_ADJUST_BOT_SIGNAL_N || DEFAULT_SIGNAL_PARAMS.N),
      atr_len: Number(process.env.AUTO_ADJUST_BOT_SIGNAL_ATR_LEN || DEFAULT_SIGNAL_PARAMS.atr_len),
      K: Number(process.env.AUTO_ADJUST_BOT_SIGNAL_K || DEFAULT_SIGNAL_PARAMS.K),
      eps: Number(process.env.AUTO_ADJUST_BOT_SIGNAL_EPS || DEFAULT_SIGNAL_PARAMS.eps),
      m_atr: Number(process.env.AUTO_ADJUST_BOT_SIGNAL_M_ATR || DEFAULT_SIGNAL_PARAMS.m_atr),
      roc_min: Number(process.env.AUTO_ADJUST_BOT_SIGNAL_ROC_MIN || DEFAULT_SIGNAL_PARAMS.roc_min),
      ema_period: Number(process.env.AUTO_ADJUST_BOT_SIGNAL_EMA_PERIOD || DEFAULT_SIGNAL_PARAMS.ema_period),
      need_two_closes: process.env.AUTO_ADJUST_BOT_SIGNAL_NEED_TWO_CLOSES === "true",
      vol_mult: Number(process.env.AUTO_ADJUST_BOT_SIGNAL_VOL_MULT || DEFAULT_SIGNAL_PARAMS.vol_mult),
    };

    this.totalEvaluations = process.env.AUTO_ADJUST_BOT_OPT_TOTAL_EVALUATIONS
      ? Number(process.env.AUTO_ADJUST_BOT_OPT_TOTAL_EVALUATIONS)
      : undefined;
    this.initialRandom = process.env.AUTO_ADJUST_BOT_OPT_INITIAL_RANDOM
      ? Number(process.env.AUTO_ADJUST_BOT_OPT_INITIAL_RANDOM)
      : undefined;
    this.numCandidates = process.env.AUTO_ADJUST_BOT_OPT_NUM_CANDIDATES
      ? Number(process.env.AUTO_ADJUST_BOT_OPT_NUM_CANDIDATES)
      : undefined;
    this.kappa = process.env.AUTO_ADJUST_BOT_OPT_KAPPA
      ? Number(process.env.AUTO_ADJUST_BOT_OPT_KAPPA)
      : undefined;

    const atrMin = Number(process.env.AUTO_ADJUST_BOT_OPT_ATR_MIN || 10);
    const atrMax = Number(process.env.AUTO_ADJUST_BOT_OPT_ATR_MAX || 5000);
    const multMin = Number(process.env.AUTO_ADJUST_BOT_OPT_MULT_MIN || 1);
    const multMax = Number(process.env.AUTO_ADJUST_BOT_OPT_MULT_MAX || 50);
    this.atrBounds = { min: atrMin, max: atrMax };
    this.multiplierBounds = { min: multMin, max: multMax };

    this.startingState = new AAStartingState(this);
    this.optimizeState = new AAOptimizeState(this);
    this.simulateState = new AASimulateState(this);
    this.currentState = this.startingState;

    if (this.liveMode) {
      const defaultOrderTimeout = Number(process.env.AUTO_ADJUST_BOT_ORDER_TIMEOUT_MS || 60000);
      this.orderWatcher = new BBOrderWatcher({
        defaultTimeoutMs: Number.isFinite(defaultOrderTimeout) ? defaultOrderTimeout : 60000,
      });
      this.aaUtil = new AAUtil(this);
      this.aaTrendWatcher = new AATrendWatcher(this);
      this.liveStartingState = new AALiveStartingState(this);
      this.waitForEntryState = new AAWaitForEntryState(this);
      this.waitForResolveState = new AAWaitForResolveState(this);
      this.currentLiveState = this.liveStartingState;
    }

    this._registerTgCmdHandlers();
  }

  private _verifyEnvs() {
    const necessaryEnvKeys = [
      "SYMBOL",
      "AUTO_ADJUST_BOT_UPDATE_INTERVAL_MINUTES",
    ];

    for (const envKey of necessaryEnvKeys) {
      const envVal = process.env[envKey];
      if (!envVal) {
        console.log(
          `Could not run auto-adjust bot, ${envKey} (${process.env[envKey]}) is not valid please check`
        );
        process.exit(-1);
      }
    }

    const optimizationWindowEnv =
      process.env.AUTO_ADJUST_BOT_OPTIMIZATION_WINDOW_MINUTES ??
      process.env.AUTO_ADJUST_BOT_UPDATE_OPTIMIZATION_WINDOW_MINUTES;
    if (!optimizationWindowEnv) {
      console.log(
        "Could not run auto-adjust bot, AUTO_ADJUST_BOT_OPTIMIZATION_WINDOW_MINUTES (or AUTO_ADJUST_BOT_UPDATE_OPTIMIZATION_WINDOW_MINUTES) is not valid please check"
      );
      process.exit(-1);
    }

    const liveMode = process.env.AUTO_ADJUST_BOT_LIVE === "true";
    if (liveMode) {
      // Optional live-mode envs are validated by defaults in constructor.
    }
  }

  initializeRunState() {
    const durationMs = this.endMs - this.startMs;
    this.durationDays = Math.floor(durationMs / (24 * 60 * 60 * 1000));
    const baseSteps = Math.floor(durationMs / this.updateIntervalMs);
    this.optimizationSteps = Math.max(1, baseSteps);
    this.stepIndex = 0;
    this.windowResults = [];
    this.pnlHistory = [];
    this.perBarReturns = [];
    this.overallPnL = 0;
    this.totalFeesPaid = 0;
    this.numberOfTrades = 0;
    this.liquidationCount = 0;
    this.lastBestParams = null;
    this.lastBestValue = 0;
    this.lastOptimizationHistory = [];
    this.lastFitDurationMs = 0;
    this.isFinished = false;
  }

  getIntervalStartMs(stepIndex: number) {
    return this.startMs + stepIndex * this.updateIntervalMs;
  }

  getIntervalEndMs(stepIndex: number) {
    return stepIndex === this.optimizationSteps - 1
      ? this.endMs
      : this.startMs + (stepIndex + 1) * this.updateIntervalMs;
  }

  getWindowEndMs(stepIndex: number) {
    return this.getIntervalStartMs(stepIndex);
  }

  getWindowStartMs(stepIndex: number) {
    const windowEndMs = this.getWindowEndMs(stepIndex);
    return Math.max(this.fetchStartMs, windowEndMs - this.optimizationWindowMs);
  }

  async startMakeMoney() {
    console.log("Start auto-adjust bot");
    if (this.liveMode) {
      await this.startLiveTrading();
      return;
    }

    eventBus.addListener(EEventBusEventType.StateChange, () => {
      if (this.isFinished) return;
      void (async () => {
        await this.currentState.onExit();

        if (this.currentState === this.startingState) {
          this.currentState = this.optimizeState;
        } else if (this.currentState === this.optimizeState) {
          this.currentState = this.simulateState;
        } else if (this.currentState === this.simulateState) {
          this.currentState = this.optimizeState;
        }

        await this.currentState.onEnter();
      })().catch((error) => {
        console.error("[AutoAdjustBot] Unhandled error during state transition:", error);
      });
    });

    await this.currentState.onEnter();
  }

  private async startLiveTrading() {
    if (!this.currentLiveState || !this.liveStartingState || !this.waitForEntryState || !this.waitForResolveState) {
      throw new Error("[AutoAdjustBot] Live mode states not initialized");
    }

    eventBus.addListener(EEventBusEventType.StateChange, () => {
      void (async () => {
        await this.currentLiveState!.onExit();

        if (this.currentLiveState === this.liveStartingState) {
          this.currentLiveState = this.waitForEntryState;
        } else if (this.currentLiveState === this.waitForEntryState) {
          this.currentLiveState = this.waitForResolveState;
        } else if (this.currentLiveState === this.waitForResolveState) {
          this.currentLiveState = this.liveStartingState;
        }

        await this.currentLiveState!.onEnter();
      })().catch((error) => {
        console.error("[AutoAdjustBot] Unhandled error during live state transition:", error);
      });
    });

    await this.currentLiveState.onEnter();
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
    if (this.liveMode) {
      if (this.currentLiveState === this.liveStartingState) {
        details = `Bot in starting state, preparing bot balances, symbols, leverage`;
      } else if (this.currentLiveState === this.waitForEntryState) {
        details = `
Bot are in wait for entry state, waiting for breakout signal (Up/Down)`.trim();
      } else if (this.currentLiveState === this.waitForResolveState) {
        let position = await withRetries(
          () => ExchangeService.getPosition(this.symbol),
          {
            label: "[AutoAdjustBot] getPosition",
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
              label: "[AutoAdjustBot] getPositionsHistory",
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
    } else {
      if (this.currentState === this.startingState) {
        details = `Bot in starting state, preparing backtest data.`;
      } else if (this.currentState === this.optimizeState) {
        details = `Bot are in optimization state, searching best parameters for the next window.`;
      } else if (this.currentState === this.simulateState) {
        details = `Bot are in simulation state, running backtest with current parameters.`;
      }
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

      const { runDurationInDays, runDurationDisplay } = getRunDuration(new Date(this.runStartTs))
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

      const bestAtrLength = this.lastBestParams?.trailingAtrLength ?? "N/A";
      const bestMultiplier = this.lastBestParams?.trailMultiplier ?? "N/A";
      const bestValue = Number.isFinite(this.lastBestValue) ? this.lastBestValue.toFixed(4) : "N/A";
      const fitDuration = this.lastFitDurationMs > 0 ? `${this.lastFitDurationMs} ms` : "N/A";

      const msg = `
=== GENERAL ===
Symbol: ${this.symbol}
Leverage: X${this.leverage}
Margin size: ${this.margin} USDT
Buffer percentage: ${(this.bufferPercentage * 100).toFixed(2)}%
Trail confirm bars: ${this.trailConfirmBars}

Signal check interval: ${this.checkIntervalMinutes} minutes
Optimization window: ${this.optimizationWindowMinutes} minutes
Update interval: ${this.updateIntervalMinutes} minutes
Interval delay: ${this.intervalDelaySeconds} seconds

Signal Parameters:
N: ${this.signalParams.N}
ATR Length: ${this.signalParams.atr_len}

=== OPTIMIZED PARAMS ===
Current trailing ATR Length: ${this.trailingAtrLength}
Current trailing lookback: ${this.trailingHighestLookback}
Current trailing multiplier: ${this.trailingStopMultiplier}
Last best ATR Length: ${bestAtrLength}
Last best multiplier: ${bestMultiplier}
Last best objective: ${bestValue}
Last fit duration: ${fitDuration}

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
        label: "[AutoAdjustBot] getSymbolInfo",
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
        label: "[AutoAdjustBot] getMarkPrice (open)",
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
      throw new Error(`[AutoAdjustBot] Invalid base amount (${baseAmt}) calculated from quote ${sanitizedQuoteAmt}`);
    }

    const orderSide = posDir === "long" ? "buy" : "sell";
    const clientOrderId = await ExchangeService.generateClientOrderId();
    this.lastOpenClientOrderId = clientOrderId;
    const orderHandle = this.orderWatcher?.preRegister(clientOrderId);
    try {
      console.log(
        `[AutoAdjustBot] Placing ${orderSide.toUpperCase()} market order (quote: ${sanitizedQuoteAmt}, base: ${baseAmt}) for ${this.symbol}`
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
                  `[AutoAdjustBot] placeOrder failed but order exists (clientOrderId=${clientOrderId}), continuing.`
                );
                return;
              }
            } catch (lookupErr) {
              console.warn(
                `[AutoAdjustBot] Failed to verify order existence (clientOrderId=${clientOrderId}):`,
                lookupErr
              );
            }
            throw error;
          }
        },
        {
          label: "[AutoAdjustBot] placeOrder (open)",
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
          label: "[AutoAdjustBot] getPosition (open)",
          retries: 5,
          minDelayMs: 5000,
          isTransientError,
          onRetry: ({ attempt, delayMs, error, label }) => {
            console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
          },
        }
      );
      if (!openedPosition || openedPosition.side !== posDir) {
        throw new Error(`[AutoAdjustBot] Position not detected after ${orderSide} order submission`);
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
        label: "[AutoAdjustBot] getPosition (close)",
        retries: 5,
        minDelayMs: 5000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) => {
          console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
        },
      }
    ));
    if (!targetPosition) {
      throw new Error("[AutoAdjustBot] No active position found to close");
    }

    const baseAmt = this._sanitizeBaseQty(Math.abs(targetPosition.size));
    if (!Number.isFinite(baseAmt) || baseAmt <= 0) {
      throw new Error("[AutoAdjustBot] Target position size is zero, cannot close position");
    }

    const orderSide = targetPosition.side === "long" ? "sell" : "buy";
    const clientOrderId = await ExchangeService.generateClientOrderId();
    this.lastCloseClientOrderId = clientOrderId;
    const orderHandle = this.orderWatcher?.preRegister(clientOrderId);
    this._trackCloseOrderId(clientOrderId);
    try {
      console.log(
        `[AutoAdjustBot] Placing ${orderSide.toUpperCase()} market order (base: ${baseAmt}) to close position ${targetPosition.id}`
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
                  `[AutoAdjustBot] close placeOrder failed but order exists (clientOrderId=${clientOrderId}), continuing.`
                );
                return;
              }
            } catch (lookupErr) {
              console.warn(
                `[AutoAdjustBot] Failed to verify close order existence (clientOrderId=${clientOrderId}):`,
                lookupErr
              );
            }
            throw error;
          }
        },
        {
          label: "[AutoAdjustBot] placeOrder (close)",
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
        throw new Error(`[AutoAdjustBot] Failed to retrieve closed position snapshot for id ${targetPosition.id}`);
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

    await this.aaUtil?.handlePnL(
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
      try {
        await this.optimizeLiveParams();
      } catch (error) {
        console.error("[AutoAdjustBot] Live optimization loop error:", error);
      }
      if (this.optimizationLoopAbort) break;
      const waitMs = this._msUntilNextOptimization();
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    this.optimizationLoopPromise = undefined;
  }

  private _msUntilNextOptimization(): number {
    const nowMs = Date.now();
    const intervalMs = this.updateIntervalMs;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 200;
    const nextMs = Math.ceil(nowMs / intervalMs) * intervalMs;
    return Math.max(200, nextMs - nowMs);
  }

  async optimizeLiveParams() {
    if (!this.aaTrendWatcher) return;
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
    const now = new Date();
    now.setSeconds(0, 0);
    const windowEndMs = now.getTime();
    const windowStartMs = windowEndMs - this.optimizationWindowMs;
    const warmupBars = computeWarmupBars(this.signalParams, this.atrBounds.max);
    const fetchStartMs = Math.max(0, windowStartMs - warmupBars * 60_000);
    const { candles } = await getCandlesForBacktest({
      symbol: this.symbol,
      interval: "1m",
      fetchStartMs,
      endMs: windowEndMs,
    });
    if (!candles.length) {
      console.warn("[AutoAdjustBot] Live optimization skipped: no candles");
      return;
    }

    const objective = async (candidate: { trailingAtrLength: number; trailMultiplier: number }) => {
      const candidateWarmup = computeWarmupBars(this.signalParams, candidate.trailingAtrLength);
      const warmupStartMs = Math.max(0, windowStartMs - candidateWarmup * 60_000);
      const objectiveCandles = sliceCandles(candles, warmupStartMs, windowEndMs);
      const requestedCount = objectiveCandles.filter(
        (c) => c.openTime >= windowStartMs && c.openTime < windowEndMs
      ).length;
      if (requestedCount === 0) return -Infinity;

      const summary = runBacktest({
        symbol: this.symbol,
        interval: "1m",
        requestedStartTime: toIso(windowStartMs),
        requestedEndTime: toIso(windowEndMs),
        margin: this.margin,
        leverage: this.leverage,
        candles: objectiveCandles,
        endCandle: objectiveCandles[objectiveCandles.length - 1],
        trailingAtrLength: candidate.trailingAtrLength,
        highestLookback: candidate.trailingAtrLength,
        trailMultiplier: candidate.trailMultiplier,
        trailConfirmBars: this.trailConfirmBars,
        signalParams: this.signalParams,
        tickSize: this.tickSize,
        pricePrecision: this.pricePrecision,
        bufferPercentage: this.bufferPercentage,
      });
      return summary.totalPnL;
    };

    const fitStartMs = Date.now();
    const optimizationResult = await optimizeTrailingAtrAndMultiplier2D({
      objective,
      bounds: { trailingAtrLength: this.atrBounds, trailMultiplier: this.multiplierBounds },
      totalEvaluations: this.totalEvaluations,
      initialRandom: this.initialRandom,
      numCandidates: this.numCandidates,
      kappa: this.kappa,
    });
    const fitDurationMs = Date.now() - fitStartMs;

    this.lastBestParams = optimizationResult.bestParams;
    this.lastBestValue = optimizationResult.bestValue;
    this.lastOptimizationHistory = optimizationResult.history;
    this.lastFitDurationMs = fitDurationMs;
    this.lastOptimizationAtMs = Date.now();

    this.trailingAtrLength = optimizationResult.bestParams.trailingAtrLength;
    this.trailingHighestLookback = optimizationResult.bestParams.trailingAtrLength;
    this.trailingStopMultiplier = optimizationResult.bestParams.trailMultiplier;

    TelegramService.queueMsg(
      `✅ Optimization updated\n` +
      `Trailing ATR Length: ${this.trailingAtrLength}\n` +
      `Trailing Multiplier: ${this.trailingStopMultiplier}\n` +
      `Objective: ${this.lastBestValue.toFixed(4)}\n` +
      `Fit duration: ${this.lastFitDurationMs} ms`
    );
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
      console.warn(`[AutoAdjustBot] Quote amount ${sanitized} is below min notional ${minNotional}, adjusting to min.`);
      sanitized = minNotional;
    }
    return this._formatQuoteAmount(sanitized);
  }

  private _sanitizeBaseQty(rawBaseAmt: number) {
    let sanitized = this._formatBaseAmount(rawBaseAmt);
    const maxMarketQty = this.symbolInfo?.maxMktOrderQty;
    if (maxMarketQty && sanitized > maxMarketQty) {
      console.warn(`[AutoAdjustBot] Base quantity ${sanitized} exceeds max market qty ${maxMarketQty}, capping value.`);
      sanitized = maxMarketQty;
    }
    return sanitized;
  }

  private _calcBaseQtyFromQuote(quoteAmt: number, price: number) {
    if (price <= 0) {
      throw new Error(`[AutoAdjustBot] Invalid price (${price}) when calculating base quantity from quote ${quoteAmt}`);
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

  lastClosedPositionId?: number;
  lastGrossPnl?: number;
  lastBalanceDelta?: number;
  lastFeeEstimate?: number;
  lastNetPnl?: number;
}

export default AutoAdjustBot;
