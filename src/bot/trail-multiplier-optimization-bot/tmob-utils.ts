import TelegramService from "@/services/telegram.service";
import TrailMultiplierOptimizationBot from "./trail-multiplier-optimization-bot";
import { isTransientError, withRetries } from "../breakout-bot/bb-retry";
import ExchangeService from "@/services/exchange-service/exchange-service";
import { tmobRunBacktest } from "./tmob-backtest";
import { TMOBSignalParams } from "./tmob-types";
import { Candle } from "../auto-adjust-bot/types";
import BigNumber from "bignumber.js";

const DEFAULT_SIGNAL_PARAMS: TMOBSignalParams = {
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


class TMOBUtils {
  constructor(private bot: TrailMultiplierOptimizationBot) { }

  async updateCurrTrailMultiplier() {
    console.log("[TMOB UTILS] Updating curr trail multiplier...");
    TelegramService.queueMsg(`🚂 Updating current trail multiplier...`);

    // Fetch more into the past
    const optimizationWindowStartDate = new Date(Date.now() - (this.bot.optimizationWindowMinutes + this.bot.nSignal) * 60 * 1000);
    const now = new Date();

    console.log("optimizationWindowStartDate: ", optimizationWindowStartDate);

    const candles = await withRetries(
      () => ExchangeService.getCandles(this.bot.symbol, optimizationWindowStartDate, now, "1Min"),
      {
        label: "[TMOBUtils] getCandles",
        retries: 5,
        minDelayMs: 5000,
        isTransientError,
      }
    );

    let filteredCandles = candles.filter((candle) => candle.timestamp >= optimizationWindowStartDate.getTime()).map(c => {
      const candle: Candle = {
        openTime: c.openTime,
        closeTime: c.closeTime,
        open: c.openPrice,
        high: c.highPrice,
        low: c.lowPrice,
        close: c.closePrice,
        volume: 0,
      };
      return candle;
    });
    if (filteredCandles.length > this.bot.optimizationWindowMinutes) {
      filteredCandles = filteredCandles.slice(filteredCandles.length - this.bot.optimizationWindowMinutes);
    }

    let bestTrailMultiplier = 0;
    let bestTotalPnL = 0;
    for (let i = this.bot.trailMultiplierBounds.min; i <= this.bot.trailMultiplierBounds.max; i++) {
      const trailMultiplier = i;
      const backtestResult = tmobRunBacktest({
        symbol: this.bot.symbol,
        interval: "1m",
        requestedStartTime: optimizationWindowStartDate.toISOString(),
        requestedEndTime: now.toISOString(),
        candles: filteredCandles,
        trailingAtrLength: this.bot.trailingAtrLength,
        highestLookback: this.bot.trailingAtrLength,
        trailMultiplier: trailMultiplier,
        trailConfirmBars: this.bot.trailConfirmBars,
        signalParams: DEFAULT_SIGNAL_PARAMS,
        tickSize: this.bot.basePrecisiion,
        pricePrecision: this.bot.pricePrecision,
      });

      console.log("trailMultiplier: ", trailMultiplier);
      console.log("backtestResult.summary.totalPnL: ", backtestResult.summary.totalPnL);

      if (backtestResult.summary.totalPnL > bestTotalPnL) {
        console.log("new best total pnl: ", backtestResult.summary.totalPnL);
        console.log("new best trail multiplier: ", trailMultiplier);
        console.log("--------------------------------");
        bestTotalPnL = backtestResult.summary.totalPnL;
        bestTrailMultiplier = trailMultiplier;
      }

    }

    this.bot.currTrailMultiplier = bestTrailMultiplier;

    const finishedTs = new Date();
    TelegramService.queueMsg(`🚇 Updated Current Trail Multiplier: 
      New trail multiplier: ${this.bot.currTrailMultiplier} 
      Total pnl: ${bestTotalPnL.toFixed(3)} USDT
      Candles used: ${filteredCandles.length}
      Optimization duration: ${(finishedTs.getTime() - now.getTime()).toLocaleString()} ms
      `);
  }

  public async getExchFreeUsdtBalance(): Promise<BigNumber> {
    const balances = await withRetries(
      ExchangeService.getBalances,
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
}

export default TMOBUtils;