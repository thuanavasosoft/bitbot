import ExchangeService from "@/services/exchange-service/exchange-service";
import { getCandlesForBacktest } from "./getCandlesForBacktest";
import { optimizeTrailingAtrAndMultiplier2D } from "./optimizeTrailingAtrMultiplier2d";
import { runBacktest, runBacktestWithReturns } from "./runBacktest";
import type { BacktestRunSummary, Candle, PnlHistoryPoint, SignalParams } from "./types";
import { computeWarmupBars } from "./warmup";
import { calculateSharpeRatio } from "./sharpe";
import bn from "bignumber.js";
import { sliceCandles, toIso } from "./candle-utils";

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

const DEFAULT_TRAIL_CONFIRM_BARS = 1;

const ATR_BOUNDS = { min: 10, max: 5000 };
const MULTIPLIER_BOUNDS = { min: 1, max: 50 };

const buildDurationString = (startMs: number, endMs: number) => {
  const durationMs = Math.max(0, endMs - startMs);
  const durationDays = Math.floor(durationMs / (24 * 60 * 60 * 1000));
  const durationHours = Math.floor((durationMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const durationMinutes = Math.floor((durationMs % (60 * 60 * 1000)) / (60 * 1000));
  return `${durationDays}D${durationHours}H${durationMinutes}m`;
};

export type OptimizationRunParams = {
  symbol: string;
  startTime: string;
  endTime: string;
  updateIntervalMinutes: number;
  optimizationWindowMinutes: number;
  margin?: number;
  leverage?: number;
  signalParams?: SignalParams;
  totalEvaluations?: number;
  initialRandom?: number;
  numCandidates?: number;
  kappa?: number;
  bufferPercentage?: number;
};

export type OptimizationWindowResult = {
  stepIndex: number;
  windowStartTime: string;
  windowEndTime: string;
  intervalStartTime: string;
  intervalEndTime: string;
  bestParams: { trailingAtrLength: number; trailMultiplier: number };
  bestValue: number;
  evaluationCount: number;
  history: Array<{ params: { trailingAtrLength: number; trailMultiplier: number }; value: number }>;
  intervalSummary: BacktestRunSummary;
  fitDurationMs: number;
};

export type OptimizationRunResult = {
  windowResults: OptimizationWindowResult[];
  finalParams: { trailingAtrLength: number; trailMultiplier: number } | null;
  bestValue: number;
  overallResult: BacktestRunSummary;
  pnlHistory: PnlHistoryPoint[];
  candleCount: number;
};

export async function runOptimizationRun(params: OptimizationRunParams): Promise<OptimizationRunResult> {
  const {
    symbol,
    startTime,
    endTime,
    updateIntervalMinutes,
    optimizationWindowMinutes,
    margin,
    leverage,
    signalParams,
    totalEvaluations,
    initialRandom,
    numCandidates,
    kappa,
    bufferPercentage,
  } = params;

  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new Error("Invalid time range");
  }

  const intervalMs = 60_000;
  const updateIntervalMs = updateIntervalMinutes * 60_000;
  const optimizationWindowMs = optimizationWindowMinutes * 60_000;
  if (updateIntervalMs <= 0 || optimizationWindowMs <= 0) {
    throw new Error("Invalid optimization interval/window");
  }

  const normalizedSymbol = symbol.trim().toUpperCase();
  const mergedSignalParams: SignalParams = {
    ...DEFAULT_SIGNAL_PARAMS,
    ...(signalParams ?? {}),
  };
  const maxWarmupBars = computeWarmupBars(mergedSignalParams, ATR_BOUNDS.max);
  const fetchStartMs = Math.max(0, startMs - maxWarmupBars * intervalMs);
  const fetchEndMs = endMs + intervalMs;
  const { candles } = await getCandlesForBacktest({
    symbol: normalizedSymbol,
    interval: "1m",
    fetchStartMs,
    endMs: fetchEndMs,
  });

  if (!candles.length) {
    throw new Error("No candles available for optimization");
  }

  const symbolInfo = await ExchangeService.getSymbolInfo(normalizedSymbol);
  const tickSize = Math.pow(10, -(symbolInfo.pricePrecision || 0));
  const candleCount = sliceCandles(candles, startMs, endMs).length;
  if (candleCount === 0) {
    throw new Error("No candles available for the requested range");
  }

  const durationMs = endMs - startMs;
  const durationDays = Math.floor(durationMs / (24 * 60 * 60 * 1000));
  const baseSteps = Math.floor(durationMs / updateIntervalMs);
  const optimizationSteps = Math.max(1, baseSteps);

  const windowResults: OptimizationWindowResult[] = [];
  const candleByOpenTime = new Map<number, Candle>(candles.map((c) => [c.openTime, c]));
  let overallPnL = 0;
  let totalFeesPaid = 0;
  let numberOfTrades = 0;
  let liquidationCount = 0;
  const pnlHistory: PnlHistoryPoint[] = [];
  const perBarReturns: number[] = [];

  let lastBestParams: { trailingAtrLength: number; trailMultiplier: number } | null = null;
  let lastBestValue = 0;

  for (let stepIndex = 0; stepIndex < optimizationSteps; stepIndex++) {
    const intervalStartMs = startMs + stepIndex * updateIntervalMs;
    const intervalEndMs =
      stepIndex === optimizationSteps - 1 ? endMs : startMs + (stepIndex + 1) * updateIntervalMs;
    const windowEndMs = intervalStartMs;
    const windowStartMs = Math.max(fetchStartMs, windowEndMs - optimizationWindowMs);

    if (windowEndMs <= windowStartMs) {
      throw new Error("Optimization window is empty");
    }

    const objective = async (candidate: { trailingAtrLength: number; trailMultiplier: number }) => {
      const warmupBars = computeWarmupBars(mergedSignalParams, candidate.trailingAtrLength);
      const warmupStartMs = Math.max(0, windowStartMs - warmupBars * intervalMs);
      const objectiveCandles = sliceCandles(candles, warmupStartMs, windowEndMs);
      const requestedCount = objectiveCandles.filter(
        (c) => c.openTime >= windowStartMs && c.openTime < windowEndMs
      ).length;
      if (requestedCount === 0) return -Infinity;

      const summary = runBacktest({
        symbol: normalizedSymbol,
        interval: "1m",
        requestedStartTime: toIso(windowStartMs),
        requestedEndTime: toIso(windowEndMs),
        margin: margin,
        leverage: leverage,
        candles: objectiveCandles,
        endCandle: candleByOpenTime.get(windowEndMs),
        trailingAtrLength: candidate.trailingAtrLength,
        highestLookback: candidate.trailingAtrLength,
        trailMultiplier: candidate.trailMultiplier,
        trailConfirmBars: DEFAULT_TRAIL_CONFIRM_BARS,
        signalParams: mergedSignalParams,
        tickSize,
        pricePrecision: symbolInfo.pricePrecision,
        bufferPercentage,
      });

      return summary.totalPnL;
    };

    const fitStartMs = Date.now();
    const optimizationResult = await optimizeTrailingAtrAndMultiplier2D({
      objective,
      bounds: { trailingAtrLength: ATR_BOUNDS, trailMultiplier: MULTIPLIER_BOUNDS },
      totalEvaluations,
      initialRandom,
      numCandidates,
      kappa,
    });
    const fitDurationMs = Date.now() - fitStartMs;

    lastBestParams = optimizationResult.bestParams;
    lastBestValue = optimizationResult.bestValue;

    const intervalWarmupBars = computeWarmupBars(mergedSignalParams, lastBestParams.trailingAtrLength);
    const intervalWarmupStartMs = Math.max(0, intervalStartMs - intervalWarmupBars * intervalMs);
    const intervalCandles = sliceCandles(candles, intervalWarmupStartMs, intervalEndMs);
    const intervalRequestedCount = intervalCandles.filter(
      (c) => c.openTime >= intervalStartMs && c.openTime < intervalEndMs
    ).length;
    if (intervalRequestedCount === 0) {
      throw new Error("No candles available for interval simulation");
    }

    const { summary: intervalSummary, perBarReturns: intervalReturns } = runBacktestWithReturns({
      symbol: normalizedSymbol,
      interval: "1m",
      requestedStartTime: toIso(intervalStartMs),
      requestedEndTime: toIso(intervalEndMs),
      margin: margin,
      leverage: leverage,
      candles: intervalCandles,
      endCandle: candleByOpenTime.get(intervalEndMs),
      trailingAtrLength: lastBestParams.trailingAtrLength,
      highestLookback: lastBestParams.trailingAtrLength,
      trailMultiplier: lastBestParams.trailMultiplier,
      trailConfirmBars: DEFAULT_TRAIL_CONFIRM_BARS,
      signalParams: mergedSignalParams,
      tickSize,
      pricePrecision: symbolInfo.pricePrecision,
      bufferPercentage,
    });

    const pnlOffset = overallPnL;
    for (const point of intervalSummary.pnlHistory) {
      pnlHistory.push({ ...point, totalPnL: point.totalPnL + pnlOffset });
    }

    overallPnL += intervalSummary.totalPnL;
    totalFeesPaid += intervalSummary.totalFeesPaid;
    numberOfTrades += intervalSummary.numberOfTrades;
    liquidationCount += intervalSummary.liquidationCount;
    perBarReturns.push(...intervalReturns);

    windowResults.push({
      stepIndex,
      windowStartTime: toIso(windowStartMs),
      windowEndTime: toIso(windowEndMs),
      intervalStartTime: toIso(intervalStartMs),
      intervalEndTime: toIso(intervalEndMs),
      bestParams: optimizationResult.bestParams,
      bestValue: optimizationResult.bestValue,
      evaluationCount: optimizationResult.history.length,
      history: optimizationResult.history,
      intervalSummary,
      fitDurationMs,
    });
  }

  const dailyPnL = durationDays > 0 ? overallPnL / durationDays : 0;
  const projectedYearlyPnL = dailyPnL * 365;
  const apyPercent = margin && margin > 0 ? (projectedYearlyPnL / margin) * 100 : 0;
  const sharpeRatio = calculateSharpeRatio(perBarReturns);

  const overallResult: BacktestRunSummary = {
    symbol: normalizedSymbol,
    interval: "1m",
    requestedStartTime: startTime,
    requestedEndTime: endTime,
    actualStartTime: toIso(startMs),
    actualEndTime: toIso(endMs),
    candleCount,
    duration: buildDurationString(startMs, endMs),
    margin: margin ?? 100,
    leverage: leverage ?? 20,
    tickSize,
    pricePrecision: symbolInfo.pricePrecision,
    numberOfTrades,
    liquidationCount,
    feeRate: new bn(0.05).div(100).toNumber(),
    totalFeesPaid,
    totalPnL: overallPnL,
    pnlHistory,
    dailyPnL,
    projectedYearlyPnL,
    apyPercent,
    sharpeRatio,
  };

  return {
    windowResults,
    finalParams: lastBestParams,
    bestValue: lastBestValue,
    overallResult,
    pnlHistory,
    candleCount,
  };
}
