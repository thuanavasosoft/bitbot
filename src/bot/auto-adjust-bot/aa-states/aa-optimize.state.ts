import TelegramService from "@/services/telegram.service";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import AutoAdjustBot, { AAState } from "../auto-adjust-bot";
import { optimizeTrailingAtrAndMultiplier2D } from "../optimizeTrailingAtrMultiplier2d";
import { computeWarmupBars } from "../warmup";
import { runBacktest } from "../runBacktest";
import { sliceCandles, toIso } from "../candle-utils";

class AAOptimizeState implements AAState {
  constructor(private bot: AutoAdjustBot) {}

  async onEnter() {
    const stepIndex = this.bot.stepIndex;
    const intervalStartMs = this.bot.getIntervalStartMs(stepIndex);
    const windowEndMs = intervalStartMs;
    const windowStartMs = Math.max(this.bot.fetchStartMs, windowEndMs - this.bot.optimizationWindowMs);

    if (windowEndMs <= windowStartMs) {
      throw new Error("Optimization window is empty");
    }

    const objective = async (candidate: { trailingAtrLength: number; trailMultiplier: number }) => {
      const warmupBars = computeWarmupBars(this.bot.signalParams, candidate.trailingAtrLength);
      const warmupStartMs = Math.max(0, windowStartMs - warmupBars * 60_000);
      const objectiveCandles = sliceCandles(this.bot.candles, warmupStartMs, windowEndMs);
      const requestedCount = objectiveCandles.filter(
        (c) => c.openTime >= windowStartMs && c.openTime < windowEndMs
      ).length;
      if (requestedCount === 0) return -Infinity;

      const summary = runBacktest({
        symbol: this.bot.symbol,
        interval: "1m",
        requestedStartTime: toIso(windowStartMs),
        requestedEndTime: toIso(windowEndMs),
        margin: this.bot.margin,
        leverage: this.bot.leverage,
        candles: objectiveCandles,
        endCandle: this.bot.candleByOpenTime.get(windowEndMs),
        trailingAtrLength: candidate.trailingAtrLength,
        highestLookback: candidate.trailingAtrLength,
        trailMultiplier: candidate.trailMultiplier,
        trailConfirmBars: this.bot.trailConfirmBars,
        signalParams: this.bot.signalParams,
        tickSize: this.bot.tickSize,
        pricePrecision: this.bot.pricePrecision,
        bufferPercentage: this.bot.bufferPercentage,
      });

      return summary.totalPnL;
    };

    const fitStartMs = Date.now();
    const optimizationResult = await optimizeTrailingAtrAndMultiplier2D({
      objective,
      bounds: { trailingAtrLength: this.bot.atrBounds, trailMultiplier: this.bot.multiplierBounds },
      totalEvaluations: this.bot.totalEvaluations,
      initialRandom: this.bot.initialRandom,
      numCandidates: this.bot.numCandidates,
      kappa: this.bot.kappa,
    });
    const fitDurationMs = Date.now() - fitStartMs;

    this.bot.lastBestParams = optimizationResult.bestParams;
    this.bot.lastBestValue = optimizationResult.bestValue;
    this.bot.lastFitDurationMs = fitDurationMs;
    this.bot.lastOptimizationHistory = optimizationResult.history;

    const msg =
      `🧮 Fit completed for step ${stepIndex + 1}/${this.bot.optimizationSteps}\n` +
      `Window: ${toIso(windowStartMs)} → ${toIso(windowEndMs)}\n` +
      `Best params: ATR=${optimizationResult.bestParams.trailingAtrLength}, Mult=${optimizationResult.bestParams.trailMultiplier.toFixed(4)}\n` +
      `Best value: ${optimizationResult.bestValue.toFixed(4)}\n` +
      `Fit duration: ${fitDurationMs} ms`;
    console.log(msg);
    TelegramService.queueMsg(msg);

    eventBus.emit(EEventBusEventType.StateChange);
  }

  async onExit() {
    console.log("Exiting AA Optimize State");
  }
}

export default AAOptimizeState;
