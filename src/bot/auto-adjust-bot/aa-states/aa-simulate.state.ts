import TelegramService from "@/services/telegram.service";
import { generateImageOfCandles } from "@/utils/image-generator.util";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import AutoAdjustBot, { AAState } from "../auto-adjust-bot";
import { runBacktestWithReturns } from "../runBacktest";
import { computeWarmupBars } from "../warmup";
import { sliceCandles, toIso } from "../candle-utils";
import { calculateSharpeRatio } from "../sharpe";

class AASimulateState implements AAState {
  constructor(private bot: AutoAdjustBot) {}

  async onEnter() {
    const stepIndex = this.bot.stepIndex;
    const intervalStartMs = this.bot.getIntervalStartMs(stepIndex);
    const intervalEndMs = this.bot.getIntervalEndMs(stepIndex);

    if (!this.bot.lastBestParams) {
      throw new Error("Best params not set before simulation");
    }

    const intervalWarmupBars = computeWarmupBars(
      this.bot.signalParams,
      this.bot.lastBestParams.trailingAtrLength
    );
    const intervalWarmupStartMs = Math.max(0, intervalStartMs - intervalWarmupBars * 60_000);
    const intervalCandles = sliceCandles(this.bot.candles, intervalWarmupStartMs, intervalEndMs);
    const intervalRequestedCount = intervalCandles.filter(
      (c) => c.openTime >= intervalStartMs && c.openTime < intervalEndMs
    ).length;
    if (intervalRequestedCount === 0) {
      throw new Error("No candles available for interval simulation");
    }

    const { summary: intervalSummary, perBarReturns: intervalReturns } = runBacktestWithReturns({
      symbol: this.bot.symbol,
      interval: "1m",
      requestedStartTime: toIso(intervalStartMs),
      requestedEndTime: toIso(intervalEndMs),
      margin: this.bot.margin,
      leverage: this.bot.leverage,
      candles: intervalCandles,
      endCandle: this.bot.candleByOpenTime.get(intervalEndMs),
      trailingAtrLength: this.bot.lastBestParams.trailingAtrLength,
      highestLookback: this.bot.lastBestParams.trailingAtrLength,
      trailMultiplier: this.bot.lastBestParams.trailMultiplier,
      trailConfirmBars: this.bot.trailConfirmBars,
      signalParams: this.bot.signalParams,
      tickSize: this.bot.tickSize,
      pricePrecision: this.bot.pricePrecision,
      bufferPercentage: this.bot.bufferPercentage,
    });

    const pnlOffset = this.bot.overallPnL;
    for (const point of intervalSummary.pnlHistory) {
      this.bot.pnlHistory.push({ ...point, totalPnL: point.totalPnL + pnlOffset });
    }

    this.bot.overallPnL += intervalSummary.totalPnL;
    this.bot.totalFeesPaid += intervalSummary.totalFeesPaid;
    this.bot.numberOfTrades += intervalSummary.numberOfTrades;
    this.bot.liquidationCount += intervalSummary.liquidationCount;
    this.bot.perBarReturns.push(...intervalReturns);

    this.bot.windowResults.push({
      stepIndex,
      windowStartTime: toIso(this.bot.getWindowStartMs(stepIndex)),
      windowEndTime: toIso(this.bot.getWindowEndMs(stepIndex)),
      intervalStartTime: toIso(intervalStartMs),
      intervalEndTime: toIso(intervalEndMs),
      bestParams: this.bot.lastBestParams,
      bestValue: this.bot.lastBestValue,
      evaluationCount: this.bot.lastOptimizationHistory.length,
      history: this.bot.lastOptimizationHistory,
      intervalSummary,
      fitDurationMs: this.bot.lastFitDurationMs,
    });

    const sharpeRatio = calculateSharpeRatio(this.bot.perBarReturns);
    const dailyPnL =
      this.bot.durationDays > 0 ? this.bot.overallPnL / this.bot.durationDays : 0;
    const projectedYearlyPnL = dailyPnL * 365;
    const apyPercent = this.bot.margin > 0 ? (projectedYearlyPnL / this.bot.margin) * 100 : 0;

    const msg =
      `✅ Step ${stepIndex + 1}/${this.bot.optimizationSteps} completed\n` +
      `Interval: ${toIso(intervalStartMs)} → ${toIso(intervalEndMs)}\n` +
      `Interval PnL: ${intervalSummary.totalPnL.toFixed(4)} | Cumulative PnL: ${this.bot.overallPnL.toFixed(4)}\n` +
      `Trades: +${intervalSummary.numberOfTrades} (total ${this.bot.numberOfTrades})\n` +
      `Fees: +${intervalSummary.totalFeesPaid.toFixed(4)} (total ${this.bot.totalFeesPaid.toFixed(4)})\n` +
      `Sharpe: ${sharpeRatio.toFixed(4)} | APY: ${apyPercent.toFixed(2)}%`;
    console.log(msg);
    TelegramService.queueMsg(msg);

    const intervalChartCandles = intervalCandles.filter(
      (c) => c.openTime >= intervalStartMs && c.openTime < intervalEndMs
    );
    if (intervalChartCandles.length >= 2) {
      try {
        const chartData = intervalChartCandles.map((c) => ({
          timestamp: c.openTime,
          openPrice: c.open,
          highPrice: c.high,
          lowPrice: c.low,
          closePrice: c.close,
        }));
        const intervalChart = await generateImageOfCandles(
          this.bot.symbol,
          chartData,
          false,
          new Date(intervalEndMs)
        );
        TelegramService.queueMsg(intervalChart);
        TelegramService.queueMsg(
          `📈 Auto-adjust interval chart (${toIso(intervalStartMs)} → ${toIso(intervalEndMs)})`
        );
      } catch (error) {
        console.error("[AutoAdjustBot] Failed to generate interval chart:", error);
        TelegramService.queueMsg(
          `⚠️ Failed to generate auto-adjust interval chart: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    this.bot.stepIndex += 1;

    if (this.bot.stepIndex >= this.bot.optimizationSteps) {
      const finalMsg =
        `🏁 Optimization completed\n` +
        `Range: ${toIso(this.bot.startMs)} → ${toIso(this.bot.endMs)}\n` +
        `Total PnL: ${this.bot.overallPnL.toFixed(4)}\n` +
        `Trades: ${this.bot.numberOfTrades}, Liquidations: ${this.bot.liquidationCount}\n` +
        `Final best params: ATR=${this.bot.lastBestParams.trailingAtrLength}, Mult=${this.bot.lastBestParams.trailMultiplier.toFixed(4)}`;
      console.log(finalMsg);
      TelegramService.queueMsg(finalMsg);
      this.bot.isFinished = true;
      const queueDrained = await TelegramService.waitForQueueIdle();
      if (!queueDrained) {
        console.warn("[AutoAdjustBot] Telegram queue not drained before shutdown.");
      }
      setTimeout(() => process.exit(0), 250);
      return;
    }

    eventBus.emit(EEventBusEventType.StateChange);
  }

  async onExit() {
    console.log("Exiting AA Simulate State");
  }
}

export default AASimulateState;
