/**
 * Combination-bot breakout signal calculation only (no full backtest engine).
 * Independent copy of dashboard `breakout-helpers` (S/R, ATR%, ROC high/low, stddev, consolidation).
 */
import { ICandleInfo } from "@/services/exchange-service/exchange-type";
import type { CombSignalParams, CombSignalResult } from "./comb-types";

export type CombConsolidationAfterBreakoutCheck = {
  /** Only bars with openTime >= this timestamp are used for impulse/vol peaks. */
  maximumConsolidationBarsCheckTs: number;
  side: "long" | "short";
};

const CONSOLIDATION_IMPULSE_ROC_LONG = 0.006;
const CONSOLIDATION_IMPULSE_ROC_SHORT = 0.006;
const CONSOLIDATION_ROC_FLAT = 0.001;
const CONSOLIDATION_STD_CONTRACT_RATIO = 0.65;
const CONSOLIDATION_ATR_CONTRACT_RATIO = 0.7;
const CONSOLIDATION_MIN_BARS_AFTER_IMPULSE = 3;

function calculateTrueRange(candles: ICandleInfo[]): number[] {
  if (!candles?.length) return [];
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      tr.push(candles[i].highPrice - candles[i].lowPrice);
    } else {
      const hl = candles[i].highPrice - candles[i].lowPrice;
      const hc = Math.abs(candles[i].highPrice - candles[i - 1].closePrice);
      const lc = Math.abs(candles[i].lowPrice - candles[i - 1].closePrice);
      tr.push(Math.max(hl, hc, lc));
    }
  }
  return tr;
}

function computeAtrPercentAt(tr: number[], endIdx: number, atrLen: number): number | null {
  if (endIdx < atrLen - 1) return null;
  const slice = tr.slice(endIdx - atrLen + 1, endIdx + 1);
  return (slice.reduce((sum, val) => sum + val, 0) / atrLen) * 100;
}

function computePercentCloseStandardDeviationByMean(
  candles: ICandleInfo[],
  period: number,
): number | null {
  if (!Number.isInteger(period) || period <= 0 || candles.length < period) {
    return null;
  }

  const closes = candles.slice(-period).map((candle) => candle.closePrice);
  const mean = closes.reduce((total, close) => total + close, 0) / closes.length;
  const variance =
    closes.reduce((total, close) => total + (close - mean) ** 2, 0) / closes.length;
  const stdDev = Math.sqrt(variance);
  return (stdDev / mean) * 100;
}

export function computeIsConsolidationAfterBreakout(
  check: CombConsolidationAfterBreakoutCheck,
  params: CombSignalParams,
  candles: ICandleInfo[],
): boolean {
  const { maximumConsolidationBarsCheckTs, side } = check;
  const K = params.K || 5;
  const atrLen = params.atr_len || 14;
  const impulseRocLong = params.consolidation_impulse_roc_long ?? CONSOLIDATION_IMPULSE_ROC_LONG;
  const impulseRocShort = params.consolidation_impulse_roc_short ?? CONSOLIDATION_IMPULSE_ROC_SHORT;
  const rocFlat = params.consolidation_roc_flat ?? CONSOLIDATION_ROC_FLAT;
  const stdContractRatio = params.consolidation_std_contract_ratio ?? CONSOLIDATION_STD_CONTRACT_RATIO;
  const atrContractRatio = params.consolidation_atr_contract_ratio ?? CONSOLIDATION_ATR_CONTRACT_RATIO;
  const minBarsAfterImpulse =
    params.consolidation_min_bars_after_impulse ?? CONSOLIDATION_MIN_BARS_AFTER_IMPULSE;

  if (!candles.length) return false;

  const tr = calculateTrueRange(candles);
  const lastIdx = candles.length - 1;

  const sinceIndices = candles
    .map((candle, i) => (candle.openTime >= maximumConsolidationBarsCheckTs ? i : -1))
    .filter((i) => i >= 0);

  if (sinceIndices.length < K + 2) return false;

  let peakRoc = side === "long" ? -Infinity : Infinity;
  let peakRocBarIdx = -1;
  let peakStdDev = -Infinity;
  let peakStdBarIdx = -1;
  let peakAtr = -Infinity;
  let peakAtrBarIdx = -1;

  let rocNow: number | null = null;
  let stdNow: number | null = null;
  let atrNow: number | null = null;

  for (const i of sinceIndices) {
    if (i < K) continue;

    const rocStartClose = candles[i - K].closePrice;
    if (rocStartClose === 0) continue;

    const rocHigh = candles[i].highPrice / rocStartClose - 1;
    const rocLow = candles[i].lowPrice / rocStartClose - 1;
    const rocClose = candles[i].closePrice / rocStartClose - 1;

    if (side === "long" && rocHigh > peakRoc) {
      peakRoc = rocHigh;
      peakRocBarIdx = i;
    } else if (side === "short" && rocLow < peakRoc) {
      peakRoc = rocLow;
      peakRocBarIdx = i;
    }

    const stdPeriod = Math.min(atrLen, i + 1);
    const std = computePercentCloseStandardDeviationByMean(candles.slice(0, i + 1), stdPeriod);
    if (std !== null && std > peakStdDev) {
      peakStdDev = std;
      peakStdBarIdx = i;
    }

    const atr = computeAtrPercentAt(tr, i, atrLen);
    if (atr !== null && atr > peakAtr) {
      peakAtr = atr;
      peakAtrBarIdx = i;
    }

    if (i === lastIdx) {
      rocNow = rocClose;
      stdNow = std;
      atrNow = atr;
    }
  }

  if (
    rocNow === null ||
    stdNow === null ||
    atrNow === null ||
    peakRocBarIdx < 0 ||
    peakStdBarIdx < 0 ||
    peakAtrBarIdx < 0 ||
    !Number.isFinite(peakStdDev) ||
    !Number.isFinite(peakAtr)
  ) {
    return false;
  }

  const hadImpulse = side === "long" ? peakRoc >= impulseRocLong : peakRoc <= -impulseRocShort;
  const rocFlattened = Math.abs(rocNow) <= rocFlat;
  const volContracting =
    stdNow <= peakStdDev * stdContractRatio && atrNow <= peakAtr * atrContractRatio;
  const sequenceValid =
    peakRocBarIdx < lastIdx &&
    peakStdBarIdx < lastIdx &&
    peakAtrBarIdx < lastIdx &&
    lastIdx - peakRocBarIdx >= minBarsAfterImpulse;

  return hadImpulse && rocFlattened && volContracting && sequenceValid;
}

export function isCombBadEntrySignal(
  signal: CombSignalResult | null | undefined,
  side: "long" | "short",
  longRocHighThreshold?: number,
  shortRocLowThreshold?: number,
): boolean {
  if (!signal) return false;
  if (longRocHighThreshold && side === "long" && (signal.roc?.rocHigh ?? 0) > longRocHighThreshold) {
    return true;
  }
  if (
    shortRocLowThreshold &&
    side === "short" &&
    (signal.roc?.rocLow ?? 0) < -Math.abs(shortRocLowThreshold)
  ) {
    return true;
  }
  return false;
}

/**
 * Support/resistance, ATR%, ROC high/low, stddev, and optional consolidation-after-breakout.
 * Lookback for S/R is bars `[len - N - 1, len - 2]` (current bar excluded).
 */
export function calculateBreakoutSignal(
  candles: ICandleInfo[],
  params: CombSignalParams,
  consolidationCheck?: CombConsolidationAfterBreakoutCheck,
): CombSignalResult {
  if (!candles?.length) {
    return {
      resistance: null,
      resistanceCandleTsMs: null,
      support: null,
      supportCandleTsMs: null,
      atr: null,
      roc: null,
    };
  }

  const N = params.N || 2;
  const atr_len = params.atr_len || 14;
  const K = params.K || 5;
  const minRequired = Math.max(N + 1, atr_len, K);
  if (candles.length < minRequired) {
    return {
      resistance: null,
      resistanceCandleTsMs: null,
      support: null,
      supportCandleTsMs: null,
      atr: null,
      roc: null,
    };
  }

  const tr = calculateTrueRange(candles);
  const atrValues = tr.slice(-atr_len);
  const ATR = (atrValues.reduce((sum, val) => sum + val, 0) / atr_len) * 100;

  const lookbackStart = Math.max(0, candles.length - N - 1);
  const lookbackEnd = candles.length - 1;
  let resistance = -Infinity;
  let support = Infinity;
  let resistanceIdx: number | null = null;
  let supportIdx: number | null = null;

  for (let i = lookbackStart; i < lookbackEnd; i++) {
    if (candles[i].highPrice > resistance) {
      resistance = candles[i].highPrice;
      resistanceIdx = i;
    }
    if (candles[i].lowPrice < support) {
      support = candles[i].lowPrice;
      supportIdx = i;
    }
  }

  const resistanceCandleTsMs =
    resistanceIdx !== null ? candles[resistanceIdx].openTime : null;
  const supportCandleTsMs = supportIdx !== null ? candles[supportIdx].openTime : null;

  const currentIdx = candles.length - 1;
  const currentHigh = candles[currentIdx].highPrice;
  const currentLow = candles[currentIdx].lowPrice;
  const rocStartIdx = Math.max(0, currentIdx - K);
  const rocStartClose = candles[rocStartIdx].closePrice;
  const ROC =
    rocStartClose !== 0
      ? {
          rocHigh: currentHigh / rocStartClose - 1,
          rocLow: currentLow / rocStartClose - 1,
        }
      : null;

  const stdDev = computePercentCloseStandardDeviationByMean(candles.slice(-atr_len), atr_len);

  let isConsolidationAfterBreakout = false;
  if (consolidationCheck) {
    const { maximumConsolidationBarsCheckTs } = consolidationCheck;
    let entryIdx = candles.length - 1;
    while (entryIdx > 0 && candles[entryIdx - 1].openTime >= maximumConsolidationBarsCheckTs) {
      entryIdx--;
    }
    if (candles[entryIdx].openTime < maximumConsolidationBarsCheckTs) {
      entryIdx = -1;
    }
    const resolvedEntryIdx = entryIdx >= 0 ? entryIdx : candles.length - 1;
    const warmupStart = Math.max(0, resolvedEntryIdx - atr_len + 1);
    const slicedCandles = candles.slice(warmupStart);
    isConsolidationAfterBreakout = computeIsConsolidationAfterBreakout(
      consolidationCheck,
      params,
      slicedCandles,
    );
  }

  return {
    resistance,
    resistanceCandleTsMs,
    support,
    supportCandleTsMs,
    atr: ATR,
    roc: ROC,
    stdDev,
    entryCandle: candles[currentIdx],
    isConsolidationAfterBreakout,
  };
}
