import TelegramService from "@/services/telegram.service";
import TrailMultiplierOptimizationBot from "./trail-multiplier-optimization-bot";
import { isTransientError, withRetries } from "../breakout-bot/bb-retry";
import ExchangeService from "@/services/exchange-service/exchange-service";
import { runBacktestPool } from "./tmob-backtest-worker-pool";
import { TMOBRunBacktestArgs, TMOBSignalParams } from "./tmob-types";
import BigNumber from "bignumber.js";
import { formatFeeAwarePnLLine } from "@/utils/strings.util";
import { toIso } from "../auto-adjust-bot/candle-utils";

export const TMOB_DEFAULT_SIGNAL_PARAMS: Omit<TMOBSignalParams, 'N'> = {
  atr_len: 14,
  K: 5,
  eps: 0.0005,
  m_atr: 0.25,
  roc_min: 0.0001,
  ema_period: 10,
  need_two_closes: false,
  vol_mult: 1.3,
};

class TMOBUtils {
  constructor(private bot: TrailMultiplierOptimizationBot) { }

  async updateCurrTrailMultiplier() {
    const startOptimizationDate = new Date();
    const endFetchCandles = new Date();
    TelegramService.queueMsg(`🚂 Updating current trail multiplier... at ${toIso(startOptimizationDate.getTime())}`);
    endFetchCandles.setSeconds(0);
    endFetchCandles.setMilliseconds(0);
    this.bot.lastOptimizationAtMs = endFetchCandles.getTime();
    const optimizationWindowStartDate = new Date(endFetchCandles.getTime() - (this.bot.optimizationWindowMinutes + this.bot.nSignal + this.bot.trailConfirmBars) * 60 * 1000);

    await this.bot.tmobCandles.ensurePopulated();
    const filteredCandles = await this.bot.tmobCandles.getCandles(optimizationWindowStartDate, endFetchCandles);

    const { min: multMin, max: multMax } = this.bot.trailMultiplierBounds;
    const step = Number.isFinite(this.bot.trailBoundStepSize) && this.bot.trailBoundStepSize > 0
      ? this.bot.trailBoundStepSize
      : 1;
    const numSteps = Math.max(1, Math.floor((multMax - multMin) / step) + 1);
    const trailMultipliers = Array.from({ length: numSteps }, (_, i) =>
      Math.min(multMin + i * step, multMax)
    );

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
      signalParams: { N: this.bot.nSignal, ...TMOB_DEFAULT_SIGNAL_PARAMS },
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

    TelegramService.queueMsg(`🚇 Updated Current Trail Multiplier at ${toIso(finishedOptimizationDate.getTime())}:
New trail multiplier: ${this.bot.currTrailMultiplier} 
Total pnl: ${bestTotalPnL.toFixed(3)} USDT
Candles used: ${filteredCandles.length} (from ${toIso(filteredCandles[0].openTime)} to ${toIso(filteredCandles[filteredCandles.length - 1].openTime)})
Optimization duration: ${(finishedOptimizationDate.getTime() - startOptimizationDate.getTime()).toLocaleString()} ms
`);
  }

  public async getExchFreeUsdtBalance(): Promise<BigNumber> {
    const balances = await withRetries(
      () => ExchangeService.getBalances(),
      {
        label: "[TMOBUtils] getBalances",
        retries: 5,
        minDelayMs: 5000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) => {
          console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
        },
      }
    );
    const usdtBalanceFromExchange = balances.find((item) => item.coin === "USDT");
    return new BigNumber(usdtBalanceFromExchange?.free || 0);
  }

  private async updateBalance() {
    const thisRunCurrQuoteBalance = this.bot.currQuoteBalance;
    const currExchFreeUsdtBalance = await this.getExchFreeUsdtBalance();
    this.bot.currQuoteBalance = currExchFreeUsdtBalance.decimalPlaces(4, BigNumber.ROUND_DOWN).toString();
    return { thisRunCurrQuoteBalance, currExchFreeUsdtBalance };
  }

  private async _getOrderFees(symbol: string, clientOrderId?: string): Promise<BigNumber | null> {
    if (!clientOrderId) return null;
    const trades = await withRetries(
      () => ExchangeService.getTradeList(symbol, clientOrderId),
      {
        label: "[TMOBUtils] getTradeList",
        retries: 3,
        minDelayMs: 2000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) => {
          console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
        },
      }
    );
    if (!trades?.length) return null;
    return trades.reduce((sum, trade) => sum.plus(trade.fee?.amt ?? 0), new BigNumber(0));
  }

  private async _estimateTradeFees(symbol: string): Promise<BigNumber | null> {
    const [openFees, closeFees] = await Promise.all([
      this._getOrderFees(symbol, this.bot.lastOpenClientOrderId),
      this._getOrderFees(symbol, this.bot.lastCloseClientOrderId),
    ]);
    if (openFees === null && closeFees === null) return null;
    return (openFees ?? new BigNumber(0)).plus(closeFees ?? new BigNumber(0));
  }

  public async handlePnL(
    PnL: number,
    isLiquidated: boolean,
    icon?: string,
    slippage?: number,
    timeDiffMs?: number,
    closedPositionId?: number,
  ) {
    if (isLiquidated) {
      // Note: liquidationCount is not tracked in TMOB yet, but can be added if needed
    }

    const iterationPnL = new BigNumber(PnL);
    const { thisRunCurrQuoteBalance, currExchFreeUsdtBalance } = await this.updateBalance();
    const prevBalance = new BigNumber(thisRunCurrQuoteBalance || 0);
    const balanceDelta = currExchFreeUsdtBalance.minus(prevBalance);
    const tradeFees = await this._estimateTradeFees(this.bot.symbol);

    let feeEstimate = tradeFees;
    let grossPnl = tradeFees ? balanceDelta.plus(tradeFees) : iterationPnL;
    if (!feeEstimate) {
      feeEstimate = iterationPnL.minus(balanceDelta);
      if (iterationPnL.abs().lt(1e-8) && balanceDelta.abs().gt(1e-8)) {
        grossPnl = balanceDelta;
        feeEstimate = new BigNumber(0);
      }
    }

    const normalize = (value: BigNumber) => {
      if (!value.isFinite()) return undefined;
      if (value.abs().lt(1e-8)) return 0;
      return value.decimalPlaces(6, BigNumber.ROUND_HALF_UP).toNumber();
    };

    const roundedGross = normalize(grossPnl);
    const roundedDelta = normalize(balanceDelta);
    const roundedFees = normalize(feeEstimate);

    this.bot.updateLastTradeMetrics({
      closedPositionId,
      grossPnl: roundedGross,
      balanceDelta: roundedDelta,
      feeEstimate: roundedFees,
      netPnl: roundedDelta,
    });

    this.bot.totalActualCalculatedProfit = new BigNumber(this.bot.totalActualCalculatedProfit)
      .plus(balanceDelta)
      .toNumber();

    const feeAwareLine = formatFeeAwarePnLLine({
      grossPnl: roundedGross,
      feeEstimate: roundedFees,
      netPnl: roundedDelta,
    });

    const msg = `
🏁 PnL Information
Total calculated PnL: ${this.bot.totalActualCalculatedProfit >= 0 ? "🟩" : "🟥"} ${this.bot.totalActualCalculatedProfit.toFixed(4)}

This run quote balance: ${thisRunCurrQuoteBalance} USDT
Next run quote balance: ${currExchFreeUsdtBalance.toFixed(4)} USDT
Wallet delta this resolve: ${balanceDelta.gt(0) ? "🟩" : "🟥"} ${balanceDelta.toFixed(4)} USDT
--
${closedPositionId ? `Closed position id: ${closedPositionId}\n` : ""}${feeAwareLine}
--
${!!icon && !!slippage && !!timeDiffMs ? `-- Close Slippage: --
Time Diff: ${timeDiffMs}ms
Price Diff (pips): ${icon} ${slippage}` : ""}`;

    console.log(msg);
    TelegramService.queueMsg(msg);
  }
}

export default TMOBUtils;