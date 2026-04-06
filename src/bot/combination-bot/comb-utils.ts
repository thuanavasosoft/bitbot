import ExchangeService from "@/services/exchange-service/exchange-service";
import { runBacktestPool } from "@/bot/trail-multiplier-optimization-bot/tmob-backtest-worker-pool";
import type { TMOBRunBacktestArgs } from "@/bot/trail-multiplier-optimization-bot/tmob-types";
import { withRetries, isTransientError } from "./comb-retry";
import BigNumber from "bignumber.js";
import { formatFeeAwarePnLLine } from "@/utils/strings.util";
import type CombBotInstance from "./comb-bot-instance";
import type { CombSignalParams } from "./comb-types";

export const COMB_DEFAULT_SIGNAL_PARAMS: Omit<CombSignalParams, "N"> = {
  atr_len: 14,
  K: 5,
  eps: 0.0005,
  m_atr: 0.25,
  roc_min: 0.0001,
  ema_period: 10,
  need_two_closes: false,
  vol_mult: 1.3,
};

const MS_PER_MINUTE_COMB_OPT = 60_000;

/**
 * Remaining ms until the optimization loop's next wake (matches comb-optimization-loop runLoop:
 * nextDueMs + 1000 relative to now).
 */
export function getCombNextOptimizationRemainingMs(
  lastOptimizationAtMs: number,
  updateIntervalMinutes: number,
  nowMs: number
): number {
  const nextDueMs =
    lastOptimizationAtMs > 0
      ? (Math.floor(lastOptimizationAtMs / MS_PER_MINUTE_COMB_OPT) + updateIntervalMinutes) * MS_PER_MINUTE_COMB_OPT
      : Math.ceil(nowMs / MS_PER_MINUTE_COMB_OPT) * MS_PER_MINUTE_COMB_OPT;
  const nextFireMs = nextDueMs + 1000;
  return Math.max(0, nextFireMs - nowMs);
}

/** E.g. `11h59m` — same style as "Last optimized" lines. */
export function formatDurationAsHoursMinutes(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h${minutes}m`;
}

/**
 * Candle/info line: last optimization age plus countdown to next reoptimization (e.g. 11h59m).
 * `nowForAgeMs` should match the chart message timestamp (typically minute-floored `Date` used elsewhere in the watcher).
 */
export function formatCombOptimizationAgeMessage(bot: CombBotInstance, nowForAgeMs: number): string {
  const remainingMs = getCombNextOptimizationRemainingMs(
    bot.lastOptimizationAtMs,
    bot.updateIntervalMinutes,
    Date.now()
  );
  const nextIn = formatDurationAsHoursMinutes(Math.floor(remainingMs / 1000));
  if (bot.lastOptimizationAtMs > 0) {
    const elapsedMs = nowForAgeMs - bot.lastOptimizationAtMs;
    const totalSeconds = Math.floor(elapsedMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `\nLast optimized: ${hours}h${minutes}m\nNext reoptimization in: ${nextIn}`;
  }
  return `\nLast optimized: N/A\nNext reoptimization in: ${nextIn}`;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

export type CombTickRoundMode = "up" | "down" | "half";

/** Quantize a price to `pricePrecision` decimal places (exchange price precision, not tick grid). */
export function quantizePriceByPrecision(price: number, pricePrecision: number, mode: CombTickRoundMode = "half"): number {
  if (!Number.isFinite(price)) return price;
  if (!Number.isFinite(pricePrecision) || pricePrecision < 0) return price;
  const p = new BigNumber(price);
  const rm =
    mode === "up"
      ? BigNumber.ROUND_CEIL
      : mode === "down"
        ? BigNumber.ROUND_FLOOR
        : BigNumber.ROUND_HALF_UP;
  return p.decimalPlaces(pricePrecision, rm).toNumber();
}

/** Last traded price when available; falls back to mark price (e.g. when LTP is not implemented). */
export async function getLtpOrMarkPrice(symbol: string): Promise<number> {
  try {
    return await ExchangeService.getLTPPrice(symbol);
  } catch {
    return await ExchangeService.getMarkPrice(symbol);
  }
}

class CombUtils {
  constructor(private bot: CombBotInstance) { }

  async updateCurrTrailMultiplier(): Promise<void> {
    const startOptimizationDate = new Date();
    this.bot.queueMsg(`🚂 Updating current trail multiplier... at ${toIso(startOptimizationDate.getTime())}`);

    const endFetchCandles = new Date();
    endFetchCandles.setSeconds(0);
    endFetchCandles.setMilliseconds(0);
    this.bot.lastOptimizationAtMs = endFetchCandles.getTime();
    const optimizationWindowStartDate = new Date(
      endFetchCandles.getTime() - (this.bot.optimizationWindowMinutes + this.bot.nSignal + this.bot.trailConfirmBars) * 60 * 1000
    );

    await this.bot.combCandles.ensurePopulated();
    const filteredCandles = await this.bot.combCandles.getCandles(optimizationWindowStartDate, endFetchCandles);

    const { min: multMin, max: multMax } = this.bot.trailMultiplierBounds;
    const step = Number.isFinite(this.bot.trailBoundStepSize) && this.bot.trailBoundStepSize > 0 ? this.bot.trailBoundStepSize : 1;
    const numSteps = Math.max(1, Math.floor((multMax - multMin) / step) + 1);
    const trailMultipliers = Array.from({ length: numSteps }, (_, i) => Math.min(multMin + i * step, multMax));

    const formattedCandles = filteredCandles.map(c => ({
      openTime: c.openTime,
      closeTime: c.closeTime,
      open: c.openPrice,
      high: c.highPrice,
      low: c.lowPrice,
      close: c.closePrice,
      volume: c.volume,
    }));
    const sharedArgs: Omit<TMOBRunBacktestArgs, "trailMultiplier"> = {
      margin: this.bot.margin,
      leverage: this.bot.leverage,
      symbol: this.bot.symbol,
      interval: "1m" as const,
      requestedStartTime: optimizationWindowStartDate.toISOString(),
      requestedEndTime: endFetchCandles.toISOString(),
      candles: formattedCandles,
      endCandle: formattedCandles[formattedCandles.length - 1],
      trailingAtrLength: this.bot.trailingAtrLength,
      highestLookback: this.bot.trailingHighestLookback,
      trailConfirmBars: this.bot.trailConfirmBars,
      signalParams: { N: this.bot.nSignal, ...COMB_DEFAULT_SIGNAL_PARAMS } as CombSignalParams,
      tickSize: this.bot.tickSize,
      pricePrecision: this.bot.pricePrecision,
      triggerBufferPercentage: this.bot.triggerBufferPercentage,
    };

    const results = await runBacktestPool(sharedArgs, trailMultipliers);

    let bestTrailMultiplier = multMin;
    let bestTotalPnL = Number.NEGATIVE_INFINITY;
    for (const { trailMultiplier, totalPnL } of results) {
      if (totalPnL > bestTotalPnL) {
        bestTotalPnL = totalPnL;
        bestTrailMultiplier = trailMultiplier;
      }
    }

    this.bot.currTrailMultiplier = bestTrailMultiplier;

    const finishedOptimizationDate = new Date();
    const durationMs = finishedOptimizationDate.getTime() - startOptimizationDate.getTime();
    console.log(
      `[COMB] updateCurrTrailMultiplier done symbol=${this.bot.symbol} candles=${filteredCandles.length} steps=${trailMultipliers.length} bestMult=${bestTrailMultiplier} bestPnL=${bestTotalPnL.toFixed(3)} durationMs=${durationMs}`
    );
    this.bot.queueMsg(`🚇 Updated Current Trail Multiplier at ${toIso(finishedOptimizationDate.getTime())}:
New trail multiplier: ${this.bot.currTrailMultiplier}
Total pnl: ${bestTotalPnL.toFixed(3)} USDT
Candles used: ${filteredCandles.length}
Optimization duration: ${(finishedOptimizationDate.getTime() - startOptimizationDate.getTime()).toLocaleString()} ms`);
  }

  async getExchFreeUsdtBalance(): Promise<BigNumber> {
    const balances = await withRetries(
      () => ExchangeService.getBalances(),
      {
        label: "[COMB] getBalances",
        retries: 5,
        minDelayMs: 5000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) =>
          console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
      }
    );
    const usdt = balances.find((item) => item.coin === "USDT");
    return new BigNumber(usdt?.free ?? 0);
  }

  /** USDT balance including frozen (free + frozen). */
  async getExchTotalUsdtBalance(): Promise<BigNumber> {
    const balances = await withRetries(
      () => ExchangeService.getBalances(),
      {
        label: "[COMB] getBalances",
        retries: 5,
        minDelayMs: 5000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) =>
          console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
      }
    );
    const usdt = balances.find((item) => item.coin === "USDT");
    const free = usdt?.free ?? 0;
    const frozen = usdt?.frozen ?? 0;
    return new BigNumber(free).plus(frozen);
  }

  private async _getOrderFees(symbol: string, clientOrderId?: string): Promise<BigNumber | null> {
    if (!clientOrderId) return null;
    const trades = await withRetries(
      () => ExchangeService.getTradeList(symbol, clientOrderId),
      {
        label: "[COMB] getTradeList",
        retries: 3,
        minDelayMs: 2000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) =>
          console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
      }
    );
    if (!trades?.length) return null;
    return trades.reduce((sum, t) => sum.plus(t.fee?.amt ?? 0), new BigNumber(0));
  }

  /**
   * Fetches close-order trades from /fapi/v1/userTrades and derives gross PnL + fees.
   * Returns null when trades unavailable or realizedPnl not present (e.g. non-Binance).
   */
  private async _getPnLAndFeesFromCloseTrades(
    symbol: string,
    clientOrderId: string
  ): Promise<{ grossPnl: BigNumber; closeFees: BigNumber } | null> {
    const trades = await withRetries(
      () => ExchangeService.getTradeList(symbol, clientOrderId),
      {
        label: "[COMB] getTradeList (close)",
        retries: 3,
        minDelayMs: 2000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) =>
          console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
      }
    );
    if (!trades?.length) return null;
    const hasRealizedPnl = trades.some((t) => t.realizedPnl != null);
    if (!hasRealizedPnl) return null;

    const grossPnl = trades.reduce(
      (sum, t) => sum.plus(t.realizedPnl ?? 0),
      new BigNumber(0)
    );
    const closeFees = trades.reduce(
      (sum, t) => sum.plus(t.fee?.amt ?? 0),
      new BigNumber(0)
    );
    return { grossPnl, closeFees };
  }

  async broadcastToCopyTraders(msg: string): Promise<void> {
    try {
      console.log("broadcastToCopyTraders: ", msg);
      this.bot.queueMsg(`🚀 broadcastToCopyTraders async: ${msg}`);
      await this.bot.combinationBot.combWsServerService.broadcastMsg(msg);
      await this.bot.combinationBot.combMsgBrokerService.publishFanout(msg);
    } catch (error) {
      console.log(error);
      this.bot.queueMsg(`[COMB] broadcastToCopyTraders error: ${String(error)}`);
    }
  }

  async handlePnL(
    PnL: number,
    _isLiquidated: boolean,
    icon?: string,
    slippage?: number,
    timeDiffMs?: number,
    closedPositionId?: number,
  ): Promise<number> {
    if (this.bot.isPnlRecorded) {
      const msg = `⚠️ [${this.bot.symbol}] Duplicate PnL recording blocked for position ${closedPositionId ?? "N/A"} — PnL was already recorded by a concurrent close trigger. Only the first close counts.`;
      console.log(`[COMB] handlePnL skipped: isPnlRecorded=true for ${this.bot.symbol} closedPositionId=${closedPositionId ?? "N/A"}`);
      this.bot.queueMsg(msg);
      return this.bot.lastNetPnl ?? 0;
    }
    this.bot.isPnlRecorded = true;

    const fallbackGrossPnl = new BigNumber(PnL);
    const openFees = await this._getOrderFees(this.bot.symbol, this.bot.lastOpenClientOrderId);

    let grossPnl: BigNumber;
    let closeFees: BigNumber;

    const fromTrades = this.bot.lastCloseClientOrderId
      ? await this._getPnLAndFeesFromCloseTrades(this.bot.symbol, this.bot.lastCloseClientOrderId)
      : null;
    if (_isLiquidated) {
      grossPnl = new BigNumber(-this.bot.margin); // liquidated position is always negative margin
      closeFees = openFees ?? new BigNumber(0);
    } else if (fromTrades) {
      grossPnl = fromTrades.grossPnl;
      closeFees = fromTrades.closeFees;
    } else {
      grossPnl = fallbackGrossPnl;
      closeFees = (await this._getOrderFees(this.bot.symbol, this.bot.lastCloseClientOrderId)) ?? new BigNumber(0);
    }

    const tradeFees = (openFees ?? new BigNumber(0)).plus(closeFees);
    const feeEstimate = tradeFees;
    const netPnl = grossPnl.minus(tradeFees);

    const normalize = (v: BigNumber) =>
      !v.isFinite() ? undefined : v.abs().lt(1e-8) ? 0 : v.decimalPlaces(6, BigNumber.ROUND_HALF_UP).toNumber();

    const roundedGross = normalize(grossPnl);
    const roundedFees = normalize(feeEstimate);
    const roundedNet = normalize(netPnl);

    this.bot.updateLastTradeMetrics({
      closedPositionId,
      grossPnl: roundedGross,
      feeEstimate: roundedFees,
      netPnl: roundedNet,
    });

    this.bot.totalActualCalculatedProfit = new BigNumber(this.bot.totalActualCalculatedProfit).plus(netPnl).toNumber();

    const feeAwareLine = formatFeeAwarePnLLine({
      grossPnl: roundedGross,
      feeEstimate: roundedFees,
      netPnl: roundedNet,
    });

    const msg = `
🏁 PnL Information
Total calculated PnL: ${this.bot.totalActualCalculatedProfit >= 0 ? "🟩" : "🟥"} ${this.bot.totalActualCalculatedProfit.toFixed(4)}
--
${closedPositionId ? `Closed position id: ${closedPositionId}\n` : ""}${feeAwareLine}
--
Note: Funding/interest is ignored in calculated PnL.
${icon != null && slippage != null && timeDiffMs != null ? `-- Close Slippage: --
Time Diff: ${timeDiffMs}ms
Price Diff (pips): ${icon} ${slippage}` : ""}`;

    console.log(
      `[COMB] handlePnL symbol=${this.bot.symbol} closedPositionId=${closedPositionId ?? "N/A"} grossPnl=${grossPnl.toFixed(4)} netPnl=${netPnl.toFixed(4)} fees=${tradeFees.toFixed(4)} totalCalculatedProfit=${this.bot.totalActualCalculatedProfit.toFixed(4)}`
    );
    this.bot.queueMsg(msg);

    return netPnl.toNumber();
  }
}

export default CombUtils;
