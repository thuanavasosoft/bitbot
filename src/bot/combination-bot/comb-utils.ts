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

function toIso(ms: number): string {
  return new Date(ms).toISOString();
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

    await this.bot.tmobCandles.ensurePopulated();
    const filteredCandles = await this.bot.tmobCandles.getCandles(optimizationWindowStartDate, endFetchCandles);

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

  async handlePnL(
    PnL: number,
    _isLiquidated: boolean,
    icon?: string,
    slippage?: number,
    timeDiffMs?: number,
    closedPositionId?: number,
  ): Promise<void> {
    const tradePnL = new BigNumber(PnL);
    const openFees = await this._getOrderFees(this.bot.symbol, this.bot.lastOpenClientOrderId);
    const closeFees = await this._getOrderFees(this.bot.symbol, this.bot.lastCloseClientOrderId);
    const tradeFees = (openFees ?? new BigNumber(0)).plus(closeFees ?? new BigNumber(0));

    const feeEstimate = tradeFees;
    // Exchange "realizedPnl" is treated as realized PnL before fees.
    const grossPnl = tradePnL;
    const netPnl = tradePnL.minus(tradeFees);

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
      `[COMB] handlePnL symbol=${this.bot.symbol} closedPositionId=${closedPositionId ?? "N/A"} realizedPnl=${PnL.toFixed(4)} totalCalculatedProfit=${this.bot.totalActualCalculatedProfit.toFixed(4)}`
    );
    this.bot.queueMsg(msg);
  }
}

export default CombUtils;
