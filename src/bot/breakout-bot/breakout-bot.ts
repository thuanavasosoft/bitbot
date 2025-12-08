import ExchangeService from "@/services/exchange-service/exchange-service";
import { ICandleInfo, IPosition, ISymbolInfo, TPositionSide } from "@/services/exchange-service/exchange-type";
import { generateRandomString } from "@/utils/strings.util";
import BigNumber from "bignumber.js";
import BBUtil from "./bb-util";
import BBStartingState from "./bb-states/bb-starting.state";
import BBWaitForEntryState from "./bb-states/bb-wait-for-entry.state";
import BBWaitForResolveState from "./bb-states/bb-wait-for-resolve.state";
import BBTrendWatcher from "./bb-trend-watcher";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import BBTgCmdHandler from "./bb-tg-cmd-handler";
import { SignalParams } from "./breakout-helpers";
import BBOrderWatcher from "./bb-order-watcher";

export interface BBState {
  onEnter: () => Promise<void>;
  onExit: () => Promise<void>;
}

export interface BBTradeMetrics {
  closedPositionId?: number;
  grossPnl?: number;
  balanceDelta?: number;
  feeEstimate?: number;
  netPnl?: number;
}

class BreakoutBot {
  runStartTs: Date = new Date();

  symbol: string;
  leverage: number;

  startQuoteBalance!: string;
  currQuoteBalance!: string;
  totalActualCalculatedProfit: number = 0;

  sleepDurationAfterLiquidation: string;
  liquidationSleepFinishTs?: number;

  checkIntervalMinutes: number;

  isSleeping: boolean = false;
  betSize: number;
  signalParams: SignalParams;
  symbolInfo?: ISymbolInfo;
  pricePrecision?: number;

  currActivePosition?: IPosition;
  entryWsPrice?: { price: number, time: Date };
  resolveWsPrice?: { price: number, time: Date };
  bufferedExitLevels?: { support: number | null; resistance: number | null };

  slippageAccumulation: number = 0;
  numberOfTrades: number = 0;
  pnlHistory: Array<{ timestamp: number; totalPnL: number }> = [];

  // Current signal state
  currentSignal: "Up" | "Down" | "Kangaroo" = "Kangaroo";
  currentSupport: number | null = null;
  currentResistance: number | null = null;
  longTrigger: number | null = null; // Trigger price for long entry (resistance adjusted down by buffer)
  shortTrigger: number | null = null; // Trigger price for short entry (support adjusted down by buffer)
  bufferPercentage: number; // Buffer percentage for trigger adjustments
  lastSRUpdateTime: number = 0; // Timestamp of last support/resistance update
  lastExitTime: number = 0; // Timestamp of last position exit
  lastEntryTime: number = 0; // Timestamp of last position entry

  clientOrderPrefix: string;
  lastClosedPositionId?: number;
  lastGrossPnl?: number;
  lastBalanceDelta?: number;
  lastFeeEstimate?: number;
  lastNetPnl?: number;

  // Trailing stop configuration/state
  trailingAtrLength: number;
  trailingHighestLookback: number;
  trailingStopMultiplier: number;
  trailingStopConfirmTicks: number;
  trailingAtrWindow: ICandleInfo[] = [];
  trailingCloseWindow: number[] = [];
  trailingStopTargets?: { side: TPositionSide; rawLevel: number; bufferedLevel: number; updatedAt: number };
  lastTrailingStopUpdateTime: number = 0;
  trailingStopBreachCount: number = 0;

  bbUtil: BBUtil;
  bbTrendWatcher: BBTrendWatcher;
  bbTgCmdHandler: BBTgCmdHandler;
  orderWatcher: BBOrderWatcher;

  startingState: BBStartingState;
  waitForEntryState: BBWaitForEntryState;
  waitForResolveState: BBWaitForResolveState;
  currentState: BBState;

  constructor() {
    this._verifyEnvs();

    this.runStartTs = new Date();

    this.symbol = process.env.SYMBOL!;
    this.leverage = Number(process.env.BREAKOUT_BOT_LEVERAGE!);
    this.clientOrderPrefix = process.env.BINANCE_CLIENT_PREFIX || "";
    this.sleepDurationAfterLiquidation = process.env.BREAKOUT_BOT_SLEEP_DURATION_AFTER_LIQUIDATION!;
    this.betSize = Number(process.env.BREAKOUT_BOT_BET_SIZE!);
    this.checkIntervalMinutes = Number(process.env.BREAKOUT_BOT_CHECK_INTERVAL_MINUTES!);
    this.bufferPercentage = Number(process.env.BREAKOUT_BOT_BUFFER_PERCENTAGE || 0) / 100; // Convert percentage to decimal
    this.trailingAtrLength = Number(process.env.BREAKOUT_BOT_TRAIL_ATR_LENGTH || 720 * 4);
    this.trailingHighestLookback = Number(process.env.BREAKOUT_BOT_TRAIL_LOOKBACK || 720 * 4);
    this.trailingStopMultiplier = Number(process.env.BREAKOUT_BOT_TRAIL_MULTIPLIER || 25);
    this.trailingStopConfirmTicks = Math.max(1, Number(process.env.BREAKOUT_BOT_TRAIL_CONFIRM_TICKS || 1));

    // Signal parameters with defaults from backtest
    this.signalParams = {
      N: Number(process.env.BREAKOUT_BOT_SIGNAL_N || 2),
      atr_len: Number(process.env.BREAKOUT_BOT_SIGNAL_ATR_LEN || 14),
      K: Number(process.env.BREAKOUT_BOT_SIGNAL_K || 5),
      eps: Number(process.env.BREAKOUT_BOT_SIGNAL_EPS || 0.0005),
      m_atr: Number(process.env.BREAKOUT_BOT_SIGNAL_M_ATR || 0.25),
      roc_min: Number(process.env.BREAKOUT_BOT_SIGNAL_ROC_MIN || 0.001),
      ema_period: Number(process.env.BREAKOUT_BOT_SIGNAL_EMA_PERIOD || 10),
      need_two_closes: process.env.BREAKOUT_BOT_SIGNAL_NEED_TWO_CLOSES === "true",
      vol_mult: Number(process.env.BREAKOUT_BOT_SIGNAL_VOL_MULT || 1.3),
    };

    this.bbUtil = new BBUtil(this);
    this.bbTrendWatcher = new BBTrendWatcher(this);

    const defaultOrderTimeout = Number(process.env.BREAKOUT_BOT_ORDER_TIMEOUT_MS || 60000);
    this.orderWatcher = new BBOrderWatcher({
      defaultTimeoutMs: Number.isFinite(defaultOrderTimeout) ? defaultOrderTimeout : 60000,
    });

    this.bbTgCmdHandler = new BBTgCmdHandler(this);
    this.bbTgCmdHandler.handleTgMsgs();

    this.startingState = new BBStartingState(this);
    this.waitForEntryState = new BBWaitForEntryState(this);
    this.waitForResolveState = new BBWaitForResolveState(this);
    this.currentState = this.startingState;
  }

  private _verifyEnvs() {
    const necessaryEnvKeys = [
      "SYMBOL",
      "BREAKOUT_BOT_LEVERAGE",
      "BREAKOUT_BOT_SLEEP_DURATION_AFTER_LIQUIDATION",
      "BREAKOUT_BOT_BET_SIZE",
      "BREAKOUT_BOT_CHECK_INTERVAL_MINUTES",
    ];

    for (const envKey of necessaryEnvKeys) {
      const envVal = process.env[envKey];
      if (!envVal) {
        console.log(`Could not run breakout bot, ${envKey} (${process.env[envKey]}) is not valid please check`);
        process.exit(-1);
      }

      if (envKey === "BREAKOUT_BOT_SLEEP_DURATION_AFTER_LIQUIDATION") {
        const durationRegex = /^(?:(\d+h)(\d+m)?|\d+m)$/;
        if (!durationRegex.test(envVal)) {
          console.error(`Invalid time format: "${envVal}". Must be like "12h", "10h30m", or "24m".`);
          process.exit(-1);
        }
      }
    }
  }

  async triggerOpenSignal(posDir: TPositionSide, openBalanceAmt: string): Promise<IPosition> {
    await this._ensureSymbolInfoLoaded();

    const quoteAmt = Number(openBalanceAmt);
    if (!Number.isFinite(quoteAmt) || quoteAmt <= 0) {
      throw new Error(`Invalid quote amount supplied for open signal: ${openBalanceAmt}`);
    }

    const sanitizedQuoteAmt = this._sanitizeQuoteAmount(quoteAmt);
    const rawMarkPrice = await ExchangeService.getMarkPrice(this.symbol);
    const markPrice = this._formatPrice(rawMarkPrice) || rawMarkPrice;
    const baseAmt = this._calcBaseQtyFromQuote(sanitizedQuoteAmt, markPrice);

    if (!Number.isFinite(baseAmt) || baseAmt <= 0) {
      throw new Error(`[BreakoutBot] Invalid base amount (${baseAmt}) calculated from quote ${sanitizedQuoteAmt}`);
    }

    const orderSide = posDir === "long" ? "buy" : "sell";
    const clientOrderId = this._buildClientOrderId("open");
    console.log(`[BreakoutBot] Placing ${orderSide.toUpperCase()} market order (quote: ${sanitizedQuoteAmt}, base: ${baseAmt}) for ${this.symbol}`);
    await ExchangeService.placeOrder({
      symbol: this.symbol,
      orderType: "market",
      orderSide,
      baseAmt,
      clientOrderId,
    });

    const fillUpdate = await this.orderWatcher.waitForFill(clientOrderId);
    const openedPosition = await ExchangeService.getPosition(this.symbol);
    if (!openedPosition || openedPosition.side !== posDir) {
      throw new Error(`[BreakoutBot] Position not detected after ${orderSide} order submission`);
    }

    const fillPrice = fillUpdate.executionPrice ?? openedPosition.avgPrice;
    const fillTime = fillUpdate.updateTime ? new Date(fillUpdate.updateTime) : new Date();
    this.entryWsPrice = {
      price: fillPrice,
      time: fillTime,
    };

    return openedPosition;
  }

  async triggerCloseSignal(position?: IPosition): Promise<IPosition> {
    await this._ensureSymbolInfoLoaded();

    const targetPosition = position || this.currActivePosition || await ExchangeService.getPosition(this.symbol);
    if (!targetPosition) {
      throw new Error("[BreakoutBot] No active position found to close");
    }

    const baseAmt = this._sanitizeBaseQty(Math.abs(targetPosition.size));
    if (!Number.isFinite(baseAmt) || baseAmt <= 0) {
      throw new Error("[BreakoutBot] Target position size is zero, cannot close position");
    }

    const orderSide = targetPosition.side === "long" ? "sell" : "buy";
    const clientOrderId = this._buildClientOrderId("close");
    console.log(`[BreakoutBot] Placing ${orderSide.toUpperCase()} market order (base: ${baseAmt}) to close position ${targetPosition.id}`);
    await ExchangeService.placeOrder({
      symbol: targetPosition.symbol,
      orderType: "market",
      orderSide,
      baseAmt,
      clientOrderId,
    });

    const fillUpdate = await this.orderWatcher.waitForFill(clientOrderId);
    const closedPosition = await this.fetchClosedPositionSnapshot(targetPosition.id);
    if (!closedPosition || typeof closedPosition.closePrice !== "number") {
      throw new Error(`[BreakoutBot] Failed to retrieve closed position snapshot for id ${targetPosition.id}`);
    }

    const resolvePrice = fillUpdate.executionPrice ?? closedPosition.closePrice ?? closedPosition.avgPrice;
    const resolveTime = fillUpdate.updateTime ? new Date(fillUpdate.updateTime) : new Date();
    this.resolveWsPrice = {
      price: resolvePrice,
      time: resolveTime,
    };

    return closedPosition;
  }

  async loadSymbolInfo() {
    this.symbolInfo = await ExchangeService.getSymbolInfo(this.symbol);
    this.pricePrecision = this.symbolInfo?.pricePrecision;
    console.log(`[BreakoutBot] Loaded symbol info for ${this.symbol}:`, this.symbolInfo);
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
      console.warn(`[BreakoutBot] Quote amount ${sanitized} is below min notional ${minNotional}, adjusting to min.`);
      sanitized = minNotional;
    }
    return this._formatQuoteAmount(sanitized);
  }

  private _sanitizeBaseQty(rawBaseAmt: number) {
    let sanitized = this._formatBaseAmount(rawBaseAmt);
    const maxMarketQty = this.symbolInfo?.maxMktOrderQty;
    if (maxMarketQty && sanitized > maxMarketQty) {
      console.warn(`[BreakoutBot] Base quantity ${sanitized} exceeds max market qty ${maxMarketQty}, capping value.`);
      sanitized = maxMarketQty;
    }
    return sanitized;
  }

  private _calcBaseQtyFromQuote(quoteAmt: number, price: number) {
    if (price <= 0) {
      throw new Error(`[BreakoutBot] Invalid price (${price}) when calculating base quantity from quote ${quoteAmt}`);
    }
    const baseQty = new BigNumber(quoteAmt).div(price).toNumber();
    return this._sanitizeBaseQty(baseQty);
  }

  async startMakeMoney() {
    console.log("Start making money");

    eventBus.addListener(EEventBusEventType.StateChange, async () => {
      console.log("State change triggered, changing state");

      await this.currentState.onExit();

      if (this.currentState === this.startingState) {
        console.log("Current state is starting, next state is waiting for entry");
        this.currentState = this.waitForEntryState;
      } else if (this.currentState === this.waitForEntryState) {
        console.log("Current state is waiting for entry, next state is waiting for resolve");
        this.currentState = this.waitForResolveState;
      } else if (this.currentState === this.waitForResolveState) {
        console.log("Current state is waiting for resolve, next state is starting");
        this.currentState = this.startingState;
      }

      await this.currentState.onEnter();
    });

    await this.currentState.onEnter();
  }

  async fetchClosedPositionSnapshot(positionId: number): Promise<IPosition | undefined> {
    const history = await ExchangeService.getPositionsHistory({ positionId });
    if (!history.length) return undefined;
    return history[0];
  }

  updateLastTradeMetrics(metrics: BBTradeMetrics = {}) {
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

  getLastTradeMetrics(): BBTradeMetrics {
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

  resetTrailingStopTracking() {
    this.trailingAtrWindow = [];
    this.trailingCloseWindow = [];
    this.trailingStopTargets = undefined;
    this.lastTrailingStopUpdateTime = 0;
    this.trailingStopBreachCount = 0;
  }

  private _buildClientOrderId(action: "open" | "close") {
    const prefix = this.clientOrderPrefix || "";
    return `${prefix}bb-${action}-${generateRandomString(10)}`;
  }
}

export default BreakoutBot;

