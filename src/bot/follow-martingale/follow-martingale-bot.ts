import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import BigNumber from "bignumber.js";
import type {
  IPosition,
  ISymbolInfo,
  TCandleResolution,
  TPositionSide,
} from "@/services/exchange-service/exchange-type";
import ExchangeService from "@/services/exchange-service/exchange-service";
import TelegramService from "@/services/telegram.service";
import { EEventBusEventType } from "@/utils/event-bus.util";
import { formatFeeAwarePnLLine, getPositionDetailMsg } from "@/utils/strings.util";
import { generatePnLProgressionChart } from "@/utils/image-generator.util";
import { AsyncMutex } from "@/utils/async-mutex.util";
import FMCandles from "./fm-candles";
import FMOrderExecutor from "./fm-order-executor";
import FMOrderWatcher from "./fm-order-watcher";
import FMCandleWatcher from "./fm-candle-watcher";
import FMStartingState from "./fm-states/fm-starting.state";
import FMWaitForEntryState from "./fm-states/fm-wait-for-entry.state";
import FMInPositionState from "./fm-states/fm-in-position.state";
import FMTelegramHandler from "./fm-telegram-handler";
import { isTransientError, withRetries } from "./fm-retry";
import type {
  FMCloseReason,
  FMLeg,
  FMPnlHistoryPoint,
  FMPositionSnapshot,
  FMState,
  FMTradeFill,
  FMTradeMetrics,
  FMSide,
} from "./fm-types";

class FollowMartingaleBot {
  runId = randomUUID();
  runStartTs?: Date;

  symbol: string;
  leverage: number;
  fixedMarginUsdt?: number;
  signalN: number;
  maxLegs: number;
  sizeMultiplier: number;
  takeProfitPct: number;
  bufferPct: number;
  stopLossPercent: number;
  maintenanceDiscountPct: number;
  candleResolution: TCandleResolution;
  loopIntervalMs: number;
  orderTimeoutMs: number;

  stateBus = new EventEmitter();
  currentState: FMState;

  symbolInfo?: ISymbolInfo;
  pricePrecision = 0;
  tickSize = 0;

  currentSupport: number | null = null;
  currentResistance: number | null = null;
  currentLongTrigger: number | null = null;
  currentShortTrigger: number | null = null;
  lastSignalUpdateTime = 0;
  currentCycleSide?: FMSide;

  currActivePosition?: IPosition;
  latestTradePrice?: number;
  latestTradeTimeMs?: number;
  entryWsPrice?: FMTradeFill;
  lastEntryFillWsPrice?: FMTradeFill;
  resolveWsPrice?: FMTradeFill;

  legs: FMLeg[] = [];
  /** Wall-clock ms after the last successful leg-1 open or add-leg (not derived from `legs`). Used for add cooldown. */
  lastEntryOrAddAtMs?: number;
  cycleWalletAtOpenUsdt?: number;
  cycleEntryClientOrderIds: string[] = [];

  activeTpClientOrderId?: string;
  activeTpPrice?: number;
  activeTpQty?: number;
  private tpRefreshPromise: Promise<void> = Promise.resolve();

  totalActualCalculatedProfit = 0;
  slippageAccumulation = 0;
  numberOfTrades = 0;
  startTotalBalance?: string;
  currTotalBalance?: string;

  lastOpenClientOrderId?: string;
  /** Set while a martingale add-leg market order may be in flight (for reconcile after partial failure). */
  lastAddLegClientOrderId?: string;
  lastCloseClientOrderId?: string;
  lastClosedPositionId?: number;
  lastGrossPnl?: number;
  lastBalanceDelta?: number;
  lastFeeEstimate?: number;
  lastNetPnl?: number;

  pnlHistory: FMPnlHistoryPoint[] = [];

  isClosingPosition = false;
  isFinalizingPosition = false;
  isAddInFlight = false;
  isStopped = false;

  private signalRefreshMutex = new AsyncMutex();

  orderWatcher: FMOrderWatcher;
  candles: FMCandles;
  orderExecutor: FMOrderExecutor;
  candleWatcher: FMCandleWatcher;
  telegramHandler: FMTelegramHandler;
  startingState: FMStartingState;
  waitForEntryState: FMWaitForEntryState;
  inPositionState: FMInPositionState;

  constructor() {
    this.verifyEnvs();

    this.symbol = process.env.SYMBOL!;
    this.leverage = Number(process.env.LEVERAGE!);
    this.fixedMarginUsdt = process.env.FM_MARGIN_USDT ? Number(process.env.FM_MARGIN_USDT) : undefined;
    this.signalN = Number(process.env.FM_SIGNAL_N!);
    this.maxLegs = Number(process.env.FM_MAX_LEGS!);
    this.sizeMultiplier = Number(process.env.FM_SIZE_MULTIPLIER!);
    this.takeProfitPct = Number(process.env.FM_TAKE_PROFIT_PCT!);
    this.bufferPct = Number(process.env.FM_BUFFER_PCT || 0);
    this.stopLossPercent = Number(process.env.FM_STOP_LOSS_PERCENT || 100);
    this.maintenanceDiscountPct = Number(process.env.FM_MAINTENANCE_DISCOUNT_PCT || 5);
    this.candleResolution = (process.env.FM_CANDLE_RESOLUTION || "1Min") as TCandleResolution;
    this.loopIntervalMs = Number(process.env.FM_LOOP_INTERVAL_MS || 10_000);
    this.orderTimeoutMs = Number(process.env.FM_ORDER_TIMEOUT_MS || 60_000);

    this.orderWatcher = new FMOrderWatcher({ defaultTimeoutMs: this.orderTimeoutMs });
    this.candles = new FMCandles(this);
    this.orderExecutor = new FMOrderExecutor(this);
    this.candleWatcher = new FMCandleWatcher(this);
    this.telegramHandler = new FMTelegramHandler(this);
    this.startingState = new FMStartingState(this);
    this.waitForEntryState = new FMWaitForEntryState(this);
    this.inPositionState = new FMInPositionState(this);
    this.currentState = this.startingState;

    this.telegramHandler.register();
  }

  private verifyEnvs(): void {
    const required = [
      "SYMBOL",
      "LEVERAGE",
      "FM_SIGNAL_N",
      "FM_MAX_LEGS",
      "FM_SIZE_MULTIPLIER",
      "FM_TAKE_PROFIT_PCT",
    ];
    const missing = required.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(`Missing required follow martingale env(s): ${missing.join(", ")}`);
    }
  }

  async startMakeMoney(): Promise<void> {
    this.stateBus.on(EEventBusEventType.StateChange, async (nextState?: FMState) => {
      await this.currentState.onExit();
      if (this.currentState === this.startingState) {
        this.currentState = this.waitForEntryState;
      } else if (this.currentState === this.waitForEntryState) {
        this.currentState = this.inPositionState;
      } else if (this.currentState === this.inPositionState) {
        this.currentState = nextState ?? this.waitForEntryState;
      }
      await this.currentState.onEnter();
    });

    await this.currentState.onEnter();
  }

  queueMsg(message: string | Buffer): void {
    TelegramService.queueMsg(message);
  }

  queueMsgPriority(message: string | Buffer): void {
    TelegramService.queueMsgPriority(message);
  }

  async ensureSymbolInfoLoaded(): Promise<void> {
    if (this.symbolInfo) return;
    this.symbolInfo = await withRetries(() => ExchangeService.getSymbolInfo(this.symbol), {
      label: "[FM] getSymbolInfo",
      retries: 5,
      minDelayMs: 5000,
      isTransientError,
      onRetry: ({ attempt, delayMs, error, label }) =>
        console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
    });
    this.pricePrecision = this.symbolInfo?.pricePrecision ?? 0;
    this.tickSize = Math.pow(10, -this.pricePrecision);
  }

  async getExchFreeUsdtBalance(): Promise<BigNumber> {
    const balances = await withRetries(() => ExchangeService.getBalances(), {
      label: "[FM] getBalances (free)",
      retries: 5,
      minDelayMs: 5000,
      isTransientError,
      onRetry: ({ attempt, delayMs, error, label }) =>
        console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
    });
    const usdt = balances.find((item) => item.coin === "USDT");
    return new BigNumber(usdt?.free ?? 0);
  }

  async getExchTotalUsdtBalance(): Promise<BigNumber> {
    const balances = await withRetries(() => ExchangeService.getBalances(), {
      label: "[FM] getBalances (total)",
      retries: 5,
      minDelayMs: 5000,
      isTransientError,
      onRetry: ({ attempt, delayMs, error, label }) =>
        console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
    });
    const usdt = balances.find((item) => item.coin === "USDT");
    return new BigNumber(usdt?.free ?? 0).plus(usdt?.frozen ?? 0);
  }

  geometricSum(): number {
    let total = 0;
    for (let i = 0; i < this.maxLegs; i++) {
      total += Math.pow(this.sizeMultiplier, i);
    }
    return total;
  }

  getEffectiveBalance(totalBalance: number): number {
    return new BigNumber(totalBalance)
      .times(new BigNumber(1).minus(new BigNumber(this.maintenanceDiscountPct).div(100)))
      .toNumber();
  }

  getLeg1MarginFromTotalBalance(totalBalance: number): number {
    return this.getEffectiveBalance(totalBalance) / this.geometricSum();
  }

  getLeg1QuoteFromTotalBalance(totalBalance: number): number {
    return new BigNumber(this.getLeg1MarginFromTotalBalance(totalBalance)).times(this.leverage).toNumber();
  }

  async getLeg1QuoteBudget(): Promise<number> {
    if (typeof this.fixedMarginUsdt === "number" && Number.isFinite(this.fixedMarginUsdt) && this.fixedMarginUsdt > 0) {
      return new BigNumber(this.fixedMarginUsdt).times(this.leverage).toNumber();
    }
    const totalBalance = await this.getExchTotalUsdtBalance();
    return this.getLeg1QuoteFromTotalBalance(totalBalance.toNumber());
  }

  /**
   * After triggerOpenSignal throws, the exchange may still show an open fill. Sync local state from REST
   * so we do not send another leg-1 market order while a position already exists.
   */
  async tryReconcileLeg1AfterFailedOpen(targetSide: FMSide, rawTrigger: number, triggerTimestamp: number): Promise<boolean> {
    await this.ensureSymbolInfoLoaded();
    let pos: IPosition | undefined;
    try {
      pos = await withRetries(() => ExchangeService.getPosition(this.symbol), {
        label: "[FM] getPosition (reconcile leg1)",
        retries: 5,
        minDelayMs: 5000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) =>
          console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
      });
    } catch (error) {
      console.error("[FM] Leg1 reconcile getPosition failed:", error);
      return false;
    }
    if (!pos || !Number.isFinite(pos.size) || Math.abs(pos.size) <= 0) return false;
    if (pos.side !== targetSide) {
      this.queueMsg(
        `🛑 Entry failed but the exchange shows a ${pos.side.toUpperCase()} position (expected ${targetSide.toUpperCase()}). Close or reconcile manually before continuing.`
      );
      return false;
    }

    this.currActivePosition = pos;
    this.currentCycleSide = targetSide;
    const enteredAtMs = pos.updateTime || Date.now();
    const fillPrice = pos.avgPrice;
    this.entryWsPrice = { price: fillPrice, time: new Date(enteredAtMs) };
    this.lastEntryFillWsPrice = this.entryWsPrice;
    const baseQty = Math.abs(pos.size);
    const legCoid = this.lastOpenClientOrderId ?? "reconciled-leg1";
    this.legs = [
      {
        index: 1,
        baseQty,
        entryPrice: fillPrice,
        enteredAtMs,
        clientOrderId: legCoid,
      },
    ];
    this.recordLastEntryOrAdd(enteredAtMs);
    this.cycleEntryClientOrderIds = [legCoid];
    try {
      this.cycleWalletAtOpenUsdt = (await this.getExchTotalUsdtBalance()).toNumber();
    } catch {
      // best-effort
    }
    this.recordEntrySlippage(
      targetSide,
      rawTrigger,
      fillPrice,
      `-- Open Slippage (reconciled): --\nTime Diff: ${enteredAtMs - triggerTimestamp} ms`
    );
    this.queueMsg(
      `🥳 Leg 1 entered (${targetSide.toUpperCase()}) — reconciled from exchange\nAvg Price: ${pos.avgPrice}\nQty: ${baseQty}\n` +
      (this.cycleWalletAtOpenUsdt !== undefined
        ? `Cycle wallet at open: ${this.cycleWalletAtOpenUsdt.toFixed(4)} USDT`
        : "")
    );
    await this.queueTakeProfitRefresh("initial entry (reconciled)", true);
    this.stateBus.emit(EEventBusEventType.StateChange);
    return true;
  }

  /**
   * After triggerAddSignal throws, the add may still have filled on the exchange. Sync legs + position from REST
   * so we do not send another add while size already increased.
   */
  async tryReconcileAddLegAfterFailedSignal(
    cycleSide: FMSide,
    legIndex: number,
    rawTrigger: number,
    triggerTimestamp: number,
    previousSizeAbs: number,
    expectedBaseQty: number
  ): Promise<boolean> {
    if (this.legs.length >= this.maxLegs) return false;
    if (legIndex > this.maxLegs) return false;

    await this.ensureSymbolInfoLoaded();
    const basePrec = this.symbolInfo?.basePrecision ?? 8;
    const eps = Math.max(1e-12, Math.pow(10, -basePrec) * 0.5);

    let pos: IPosition | undefined;
    try {
      pos = await withRetries(() => ExchangeService.getPosition(this.symbol), {
        label: "[FM] getPosition (reconcile add leg)",
        retries: 5,
        minDelayMs: 5000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) =>
          console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
      });
    } catch (error) {
      console.error("[FM] Add-leg reconcile getPosition failed:", error);
      return false;
    }
    if (!pos || !Number.isFinite(pos.size) || Math.abs(pos.size) <= 0) return false;
    if (pos.side !== cycleSide) {
      this.queueMsg(
        `🛑 Add leg failed but the exchange shows a ${pos.side.toUpperCase()} position (expected ${cycleSide.toUpperCase()}). Review manually.`
      );
      return false;
    }

    if (this.legs.some((l) => l.index === legIndex)) {
      this.currActivePosition = pos;
      await this.queueTakeProfitRefresh(`leg ${legIndex} position sync`, true);
      return true;
    }

    const newSizeAbs = Math.abs(pos.size);
    const deltaQtyRaw = newSizeAbs - previousSizeAbs;
    if (deltaQtyRaw <= eps) return false;

    const deltaQty = this.quantizeBaseQty(deltaQtyRaw);
    if (deltaQty <= 0) return false;

    const upper = expectedBaseQty * 1.5;
    if (Number.isFinite(expectedBaseQty) && expectedBaseQty > 0 && deltaQty > upper) {
      this.queueMsg(
        `⚠️ Add-leg reconcile: size increase ${deltaQty} is much larger than expected ${expectedBaseQty.toFixed(basePrec)} — skipping auto-sync; check the exchange.`
      );
      return false;
    }

    let fillPrice = pos.avgPrice;
    let fillTimeMs = pos.updateTime || Date.now();
    const coid = this.lastAddLegClientOrderId;
    if (coid) {
      try {
        const order = await withRetries(() => ExchangeService.getOrderDetail(this.symbol, coid), {
          label: "[FM] getOrderDetail (reconcile add leg)",
          retries: 5,
          minDelayMs: 5000,
          isTransientError,
          onRetry: ({ attempt, delayMs, error, label }) =>
            console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
        });
        if (order && Number.isFinite(order.avgPrice) && order.avgPrice > 0) {
          fillPrice = order.avgPrice;
          fillTimeMs = order.updateTs ?? fillTimeMs;
        }
      } catch (error) {
        console.warn("[FM] Add-leg reconcile getOrderDetail failed (using position avg):", error);
      }
    }

    this.currActivePosition = pos;
    this.currentCycleSide = cycleSide;
    this.lastEntryFillWsPrice = { price: fillPrice, time: new Date(fillTimeMs) };
    const legCoid = coid ?? `reconciled-leg${legIndex}`;
    this.legs.push({
      index: legIndex,
      baseQty: deltaQty,
      entryPrice: fillPrice,
      enteredAtMs: fillTimeMs,
      clientOrderId: legCoid,
    });
    this.recordLastEntryOrAdd(fillTimeMs);
    this.cycleEntryClientOrderIds.push(legCoid);

    this.recordEntrySlippage(
      cycleSide,
      rawTrigger,
      fillPrice,
      `-- Add Leg ${legIndex} Slippage (reconciled): --\nTime Diff: ${fillTimeMs - triggerTimestamp} ms`
    );
    await this.queueTakeProfitRefresh(`leg ${legIndex} entered (reconciled)`, true);
    this.queueMsg(
      `➕ Added leg ${legIndex}/${this.maxLegs} — reconciled from exchange\nFill: ${fillPrice}\nNew avg: ${pos.avgPrice}\n` +
      `Added qty (approx): ${deltaQty}\nPosition size: ${newSizeAbs}\nTP: ${this.activeTpPrice}`
    );
    return true;
  }

  quantizePrice(price: number): number {
    if (!Number.isFinite(price)) return price;
    return new BigNumber(price).decimalPlaces(this.pricePrecision, BigNumber.ROUND_HALF_UP).toNumber();
  }

  quantizeBaseQty(baseQty: number): number {
    if (!Number.isFinite(baseQty)) return baseQty;
    return new BigNumber(baseQty).decimalPlaces(this.symbolInfo?.basePrecision ?? 0, BigNumber.ROUND_DOWN).toNumber();
  }

  computeTpPrice(side: FMSide, avgPrice: number): number {
    const raw =
      side === "long"
        ? avgPrice * (1 + this.takeProfitPct)
        : avgPrice * (1 - this.takeProfitPct);
    return this.quantizePrice(raw);
  }

  computeBufferedTrigger(side: FMSide, rawTrigger: number): number {
    const raw =
      side === "long"
        ? rawTrigger * (1 + this.bufferPct)
        : rawTrigger * (1 - this.bufferPct);
    return this.quantizePrice(raw);
  }

  getEntryRawTrigger(side: FMSide): number | null {
    return side === "long" ? this.currentResistance : this.currentSupport;
  }

  getActiveCycleSide(): FMSide | undefined {
    if (this.currActivePosition?.side) return this.currActivePosition.side;
    return this.currentCycleSide;
  }

  getNextAddAllowedAtMs(): number | undefined {
    if (this.lastEntryOrAddAtMs === undefined) return undefined;
    return this.lastEntryOrAddAtMs + this.signalN * this.candles.intervalMs;
  }

  recordLastEntryOrAdd(atMs: number): void {
    this.lastEntryOrAddAtMs = atMs;
  }

  async lockSignalRefresh(): Promise<void> {
    await this.signalRefreshMutex.acquire();
  }

  releaseSignalRefresh(): void {
    this.signalRefreshMutex.release();
  }

  async refreshSignalLevels(): Promise<void> {
    await this.lockSignalRefresh();
    try {
      await this.candles.ensurePopulated();
      const candles = await this.candles.toArray();
      if (candles.length < this.signalN) return;

      const window = candles.slice(-this.signalN);
      this.currentResistance = Math.max(...window.map((c) => c.highPrice));
      this.currentSupport = Math.min(...window.map((c) => c.lowPrice));

      this.currentResistance = this.currentResistance
      this.currentSupport = this.currentSupport

      this.currentLongTrigger = this.currentResistance;
      this.currentShortTrigger = this.currentSupport;
      this.lastSignalUpdateTime = Date.now();
    } finally {
      this.releaseSignalRefresh();
    }
  }

  async queueTakeProfitRefresh(reason: string, force = false): Promise<void> {
    this.tpRefreshPromise = this.tpRefreshPromise
      .then(() => this.refreshTakeProfitLimit(reason, force))
      .catch((error) => {
        console.error("[FM] refreshTakeProfitLimit failed:", error);
        this.queueMsg(`⚠️ Failed to refresh TP limit: ${error instanceof Error ? error.message : String(error)}`);
      });
    await this.tpRefreshPromise;
  }

  async refreshTakeProfitLimit(reason: string, force = false): Promise<void> {
    if (!this.currActivePosition) return;

    const cycleSide = this.getActiveCycleSide();
    if (!cycleSide) return;
    const tpPrice = this.computeTpPrice(cycleSide, this.currActivePosition.avgPrice);
    const tpQty = this.quantizeBaseQty(Math.abs(this.currActivePosition.size));
    if (!Number.isFinite(tpQty) || tpQty <= 0) return;

    const samePrice = this.activeTpPrice !== undefined && Math.abs(this.activeTpPrice - tpPrice) < this.tickSize;
    const sameQty = this.activeTpQty !== undefined && Math.abs(this.activeTpQty - tpQty) < Math.pow(10, -(this.symbolInfo?.basePrecision ?? 0));

    if (!force && this.activeTpClientOrderId && samePrice && sameQty) return;

    const prevTpPrice = this.activeTpPrice;
    const prevTPId = this.activeTpClientOrderId;
    if (this.activeTpClientOrderId) {
      await this.cancelActiveTpOrder("replacing TP");
    }

    const clientOrderId = await this.orderExecutor.placeTakeProfitLimit(this.currActivePosition.side, tpQty, tpPrice);
    this.activeTpClientOrderId = clientOrderId;
    this.activeTpPrice = tpPrice;
    this.activeTpQty = tpQty;

    if (prevTpPrice !== undefined && prevTPId !== clientOrderId) {
      this.queueMsg(
        `🎯 TP limit updated (${reason})\nOld TP ID: $${prevTPId}\nOld Price: ${prevTpPrice} \nNew TP ID: ${clientOrderId}\nNew Price:${tpPrice}\nNewQty: ${tpQty}`
      );
    } else {
      this.queueMsg(`🎯 TP limit placed (${reason})\nClient ID: ${clientOrderId}\nPrice: ${tpPrice}\nQty: ${tpQty}`);
    }
  }

  async cancelActiveTpOrder(reason = "clearing TP"): Promise<void> {
    if (!this.activeTpClientOrderId) return;
    console.log(`Canceling active tp order (${this.activeTpClientOrderId}) reason: ${reason}`);
    const clientOrderId = this.activeTpClientOrderId;
    let shouldClearTpState = false;
    try {
      await withRetries(() => ExchangeService.cancelOrder(this.symbol, clientOrderId), {
        label: "[FM] cancelOrder (tp)",
        retries: 3,
        minDelayMs: 2000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) =>
          console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
      });
      this.queueMsg(`🧹 TP limit canceled (${reason})\nClient Order ID: ${clientOrderId}`);
      shouldClearTpState = true;
    } catch (error) {
      console.warn(`[FM] Failed to cancel TP ${clientOrderId}:`, error);
      try {
        const order = await withRetries(() => ExchangeService.getOrderDetail(this.symbol, clientOrderId), {
          label: "[FM] getOrderDetail (tp cancel verify)",
          retries: 2,
          minDelayMs: 2000,
          isTransientError,
          onRetry: ({ attempt, delayMs, error: verifyError, label }) =>
            console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, verifyError),
        });
        shouldClearTpState = order?.status === "canceled" || order?.status === "filled";
      } catch (verifyError) {
        console.warn(`[FM] Failed to verify TP status ${clientOrderId}:`, verifyError);
      }
    } finally {
      if (shouldClearTpState && this.activeTpClientOrderId === clientOrderId) {
        this.activeTpClientOrderId = undefined;
        this.activeTpPrice = undefined;
        this.activeTpQty = undefined;
      }
    }
  }

  setLastTradeMetrics(metrics: FMTradeMetrics): void {
    this.lastClosedPositionId = metrics.closedPositionId;
    this.lastGrossPnl = metrics.grossPnl;
    this.lastFeeEstimate = metrics.feeEstimate;
    this.lastNetPnl = metrics.netPnl;
    this.lastBalanceDelta = metrics.balanceDelta;
  }

  getLastTradeMetrics(): FMTradeMetrics {
    return {
      closedPositionId: this.lastClosedPositionId,
      grossPnl: this.lastGrossPnl,
      feeEstimate: this.lastFeeEstimate,
      netPnl: this.lastNetPnl,
      balanceDelta: this.lastBalanceDelta,
    };
  }

  private async getOrderFees(clientOrderId?: string): Promise<BigNumber | null> {
    if (!clientOrderId) return null;
    const trades = await withRetries(() => ExchangeService.getTradeList(this.symbol, clientOrderId), {
      label: "[FM] getTradeList",
      retries: 3,
      minDelayMs: 2000,
      isTransientError,
      onRetry: ({ attempt, delayMs, error, label }) =>
        console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
    });
    if (!trades?.length) return null;
    return trades.reduce((sum, trade) => sum.plus(trade.fee?.amt ?? 0), new BigNumber(0));
  }

  private async estimateCycleFees(): Promise<BigNumber | null> {
    const ids = [...this.cycleEntryClientOrderIds];
    if (this.lastCloseClientOrderId) ids.push(this.lastCloseClientOrderId);
    if (this.activeTpClientOrderId) ids.push(this.activeTpClientOrderId);
    const uniqueIds = [...new Set(ids)];
    const fees = await Promise.all(uniqueIds.map((id) => this.getOrderFees(id)));
    const valid = fees.filter((fee): fee is BigNumber => fee !== null);
    if (valid.length === 0) return null;
    return valid.reduce((sum, fee) => sum.plus(fee), new BigNumber(0));
  }

  private async updateTotalBalanceAfterResolve(): Promise<{ previousTotal: BigNumber; currentTotal: BigNumber }> {
    const previousTotal = new BigNumber(this.currTotalBalance || this.startTotalBalance || 0);
    const currentTotal = await this.getExchTotalUsdtBalance();
    if (!this.startTotalBalance) this.startTotalBalance = currentTotal.toFixed(4);
    this.currTotalBalance = currentTotal.toFixed(4);
    return { previousTotal, currentTotal };
  }

  async handlePnL(closedPosition: IPosition, snapshot: FMPositionSnapshot): Promise<number> {
    const { previousTotal, currentTotal } = await this.updateTotalBalanceAfterResolve();
    const balanceDelta = currentTotal.minus(previousTotal);
    const tradeFees = await this.estimateCycleFees();
    const realizedPnl = typeof closedPosition.realizedPnl === "number" ? closedPosition.realizedPnl : 0;

    let feeEstimate = tradeFees;
    let grossPnl = tradeFees ? balanceDelta.plus(tradeFees) : new BigNumber(realizedPnl);
    if (!feeEstimate) {
      feeEstimate = new BigNumber(realizedPnl).minus(balanceDelta);
      if (new BigNumber(realizedPnl).abs().lt(1e-8) && balanceDelta.abs().gt(1e-8)) {
        grossPnl = balanceDelta;
        feeEstimate = new BigNumber(0);
      }
    }

    const normalize = (value: BigNumber): number | undefined => {
      if (!value.isFinite()) return undefined;
      if (value.abs().lt(1e-8)) return 0;
      return value.decimalPlaces(6, BigNumber.ROUND_HALF_UP).toNumber();
    };

    const roundedGross = normalize(grossPnl);
    const roundedDelta = normalize(balanceDelta);
    const roundedFees = normalize(feeEstimate);

    this.setLastTradeMetrics({
      closedPositionId: closedPosition.id,
      grossPnl: roundedGross,
      balanceDelta: roundedDelta,
      feeEstimate: roundedFees,
      netPnl: roundedDelta,
    });

    this.totalActualCalculatedProfit = new BigNumber(this.totalActualCalculatedProfit).plus(balanceDelta).toNumber();

    const historyPoint: FMPnlHistoryPoint = {
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
      side: closedPosition.side,
      totalPnL: this.totalActualCalculatedProfit,
      entryTimestamp: this.entryWsPrice?.time ? this.entryWsPrice.time.toISOString() : null,
      entryTimestampMs: this.entryWsPrice?.time ? this.entryWsPrice.time.getTime() : null,
      entryFillPrice: this.entryWsPrice?.price ?? null,
      exitTimestamp: new Date(snapshot.fillTimestamp).toISOString(),
      exitTimestampMs: snapshot.fillTimestamp,
      exitFillPrice: closedPosition.closePrice ?? closedPosition.avgPrice,
      tradePnL: realizedPnl,
      exitReason: snapshot.exitReason,
    };
    this.pnlHistory.push(historyPoint);

    const rollingHistory = this.pnlHistory.slice(-500).map((item) => ({
      timestamp: item.timestampMs,
      totalPnL: item.totalPnL,
    }));

    if (rollingHistory.length >= 2) {
      try {
        const pnlChartImage = await generatePnLProgressionChart(rollingHistory);
        this.queueMsg(pnlChartImage);
        this.queueMsg(
          `📊 PnL Progression Chart (last ${rollingHistory.length} resolves, max 500)\n` +
          `Total resolves recorded: ${this.pnlHistory.length}\n` +
          `Current PnL: ${this.totalActualCalculatedProfit >= 0 ? "🟩" : "🟥"} ${this.totalActualCalculatedProfit.toFixed(4)} USDT`
        );
      } catch (error) {
        console.error("[FM] Failed to generate PnL chart:", error);
      }
    }

    const feeAwareLine = formatFeeAwarePnLLine({
      grossPnl: roundedGross,
      feeEstimate: roundedFees,
      netPnl: roundedDelta,
    });

    const slippageLine =
      typeof snapshot.slippage === "number"
        ? `-- Close Slippage: --\nTime Diff: ${snapshot.slippageTimeDiffMs ?? 0}ms\nPrice Diff (pips): ${snapshot.slippageIcon} ${snapshot.slippage}`
        : `-- Close Slippage: --\nPrice Diff (pips): 🟩 0`;

    this.queueMsg(
      `🏁 PnL Information
Total calculated PnL: ${this.totalActualCalculatedProfit >= 0 ? "🟩" : "🟥"} ${this.totalActualCalculatedProfit.toFixed(4)}

Previous run total balance: ${previousTotal.toFixed(4)} USDT
Current total balance: ${currentTotal.toFixed(4)} USDT
Wallet delta this resolve: ${balanceDelta.gte(0) ? "🟩" : "🟥"} ${balanceDelta.toFixed(4)} USDT
--
Closed position id: ${closedPosition.id}
${feeAwareLine}
--
${slippageLine}`
    );

    return roundedDelta ?? realizedPnl;
  }

  private getExitReferenceLevel(side: TPositionSide): number | null {
    return side === "long" ? this.currentSupport : this.currentResistance;
  }

  recordEntrySlippage(side: FMSide, triggerLevel: number, executionPrice: number, label: string): void {
    const priceDiff =
      side === "short"
        ? new BigNumber(triggerLevel).minus(executionPrice).toNumber()
        : new BigNumber(executionPrice).minus(triggerLevel).toNumber();
    const icon = priceDiff <= 0 ? "🟩" : "🟥";
    if (icon === "🟥") this.slippageAccumulation += Math.abs(priceDiff);
    else this.slippageAccumulation -= Math.abs(priceDiff);
    this.numberOfTrades += 1;
    this.queueMsg(`${label}
Price Diff (pips): ${icon} ${priceDiff}`);
  }

  buildExitSnapshot(
    closedPosition: IPosition,
    exitReason: FMCloseReason,
    triggerTimestamp: number,
    fillTimestamp: number,
    isLiquidation: boolean
  ): FMPositionSnapshot {
    const closedPrice = typeof closedPosition.closePrice === "number" ? closedPosition.closePrice : closedPosition.avgPrice;
    let slippage: number | undefined;
    let slippageIcon: string | undefined;
    let slippageTimeDiffMs: number | undefined;

    if (exitReason === "tp_limit") {
      this.numberOfTrades += 1;
      slippage = 0;
      slippageIcon = "🟩";
      slippageTimeDiffMs = fillTimestamp - triggerTimestamp;
    } else if (!isLiquidation) {
      const refLevel = this.getExitReferenceLevel(closedPosition.side);
      if (refLevel !== null) {
        slippage =
          closedPosition.side === "short"
            ? new BigNumber(closedPrice).minus(refLevel).toNumber()
            : new BigNumber(refLevel).minus(closedPrice).toNumber();
        slippageIcon = slippage <= 0 ? "🟩" : "🟥";
        if (slippageIcon === "🟥") this.slippageAccumulation += Math.abs(slippage);
        else this.slippageAccumulation -= Math.abs(slippage);
      }
      slippageTimeDiffMs = fillTimestamp - triggerTimestamp;
      this.numberOfTrades += 1;
    }

    return {
      position: closedPosition,
      triggerTimestamp,
      fillTimestamp,
      exitReason,
      isLiquidation,
      slippage,
      slippageIcon,
      slippageTimeDiffMs,
    };
  }

  async finalizeClosedPosition(snapshot: FMPositionSnapshot, suppressStateChange = false): Promise<void> {
    if (this.isFinalizingPosition) return;
    this.isFinalizingPosition = true;

    try {
      await this.cancelActiveTpOrder("position closed");
      this.resolveWsPrice = {
        price: snapshot.position.closePrice ?? snapshot.position.avgPrice,
        time: new Date(snapshot.fillTimestamp),
      };

      await this.handlePnL(snapshot.position, snapshot);

      this.currActivePosition = undefined;
      this.currentCycleSide = undefined;
      this.entryWsPrice = undefined;
      this.lastEntryFillWsPrice = undefined;
      this.resolveWsPrice = undefined;
      this.legs = [];
      this.cycleWalletAtOpenUsdt = undefined;
      this.cycleEntryClientOrderIds = [];
      this.isClosingPosition = false;
      this.isAddInFlight = false;

      if (!suppressStateChange) {
        this.stateBus.emit(EEventBusEventType.StateChange, this.waitForEntryState);
      }
    } finally {
      this.isFinalizingPosition = false;
    }
  }

  getCurrentPositionDetail(): string {
    if (!this.currActivePosition) return "No active position.";
    return getPositionDetailMsg(this.currActivePosition, {
      feeSummary: this.getLastTradeMetrics(),
    });
  }

  getAverageSlippageDisplay(): string {
    if (this.numberOfTrades <= 0) return "0";
    return new BigNumber(this.slippageAccumulation).div(this.numberOfTrades).toFixed(5);
  }
}

export default FollowMartingaleBot;
