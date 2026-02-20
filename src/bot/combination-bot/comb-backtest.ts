/**
 * Combination-bot breakout signal calculation only (no full backtest engine).
 * Independent copy for combination-bot; no import from other bots.
 */
import { ICandleInfo } from "@/services/exchange-service/exchange-type";
import type { CombSignalParams, CombSignalResult } from "./comb-types";

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

interface EMAPoint { time: number; value: number | null; }

function calculateEMA(candles: ICandleInfo[], period: number): EMAPoint[] {
  if (!candles?.length || period < 1) return [];
  const result: EMAPoint[] = [];
  const multiplier = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < candles.length; i++) {
    ema = i === 0 ? candles[i].closePrice : (candles[i].closePrice - ema) * multiplier + ema;
    result.push({ time: Math.floor(candles[i].openTime / 1000), value: ema });
  }
  return result;
}

/**
 * Breakout signal from candle window and params.
 * Returns "Up" / "Down" / "Kangaroo" plus resistance/support/atr/roc/slope.
 */
export function calculateBreakoutSignal(
  candles: ICandleInfo[],
  params: CombSignalParams,
): CombSignalResult {
  if (!candles?.length) {
    return { signal: "Kangaroo", resistance: null, support: null, atr: null, roc: null, slope: null };
  }
  const N = params.N || 2;
  const atr_len = params.atr_len || 14;
  const K = params.K || 5;
  const eps = params.eps !== undefined ? params.eps : 0.0005;
  const m_atr = params.m_atr !== undefined ? params.m_atr : 0.25;
  const roc_min = params.roc_min !== undefined ? params.roc_min : 0.001;
  const ema_period = params.ema_period || 10;
  const need_two_closes = params.need_two_closes || false;
  const vol_mult = params.vol_mult !== undefined ? params.vol_mult : 1.3;

  const minRequired = Math.max(N + 1, atr_len, K, ema_period);
  if (candles.length < minRequired) {
    return { signal: "Kangaroo", resistance: null, support: null, atr: null, roc: null, slope: null };
  }

  const tr = calculateTrueRange(candles);
  const atrValues = tr.slice(-atr_len);
  const ATR = atrValues.reduce((s, v) => s + v, 0) / atr_len;

  const lookbackStart = Math.max(0, candles.length - N - 1);
  const lookbackEnd = candles.length - 1;
  let resistance = -Infinity;
  let support = Infinity;
  for (let i = lookbackStart; i < lookbackEnd; i++) {
    if (candles[i].highPrice > resistance) resistance = candles[i].highPrice;
    if (candles[i].lowPrice < support) support = candles[i].lowPrice;
  }

  const currentIdx = candles.length - 1;
  const prevIdx = currentIdx - 1;
  const currentClose = candles[currentIdx].closePrice;
  const rocStartIdx = Math.max(0, currentIdx - K);
  const ROC = candles[rocStartIdx].closePrice !== 0 ? currentClose / candles[rocStartIdx].closePrice - 1 : 0;

  const ema = calculateEMA(candles, ema_period);
  const slope = ema.length >= 2 && ema[ema.length - 1].value != null && ema[ema.length - 2].value != null
    ? ema[ema.length - 1].value! - ema[ema.length - 2].value!
    : 0;

  const recentTr = tr.slice(-11, -1);
  recentTr.sort((a, b) => a - b);
  const medianTr = recentTr.length > 0 ? recentTr[Math.floor(recentTr.length / 2)] : 0;
  const currentTr = tr[currentIdx];

  let vol_ok_up = true;
  const volumeStart = Math.max(0, candles.length - 21);
  const volumeEnd = candles.length - 1;
  let volumeSum = 0;
  let volumeCount = 0;
  for (let i = volumeStart; i < volumeEnd; i++) {
    volumeSum += candles[i].volume;
    volumeCount++;
  }
  const avgVolume = volumeCount > 0 ? volumeSum / volumeCount : 0;
  vol_ok_up = avgVolume === 0 || candles[currentIdx].volume > vol_mult * avgVolume;
  const vol_ok_dn = vol_ok_up;

  const up_lvl = currentClose > resistance * (1 + eps);
  const up_size = currentClose - resistance > m_atr * ATR;
  const up_momo = ROC > roc_min || slope > 0 || currentTr > medianTr;
  const dn_lvl = currentClose < support * (1 - eps);
  const dn_size = support - currentClose > m_atr * ATR;
  const dn_momo = ROC < -roc_min || slope < 0 || currentTr > medianTr;

  let up_lvl_confirmed = up_lvl;
  let dn_lvl_confirmed = dn_lvl;
  if (need_two_closes && candles.length >= 2) {
    const prevCloseValue = candles[prevIdx].closePrice;
    up_lvl_confirmed = up_lvl && prevCloseValue > resistance * (1 + eps);
    dn_lvl_confirmed = dn_lvl && prevCloseValue < support * (1 - eps);
  }

  let signal: "Up" | "Down" | "Kangaroo" = "Kangaroo";
  if (up_lvl_confirmed && up_size && up_momo && vol_ok_up) signal = "Up";
  else if (dn_lvl_confirmed && dn_size && dn_momo && vol_ok_dn) signal = "Down";

  return {
    signal,
    resistance,
    support,
    atr: ATR,
    roc: ROC,
    slope,
    currentClose,
    up_lvl: up_lvl_confirmed,
    up_size,
    up_momo,
    dn_lvl: dn_lvl_confirmed,
    dn_size,
    dn_momo,
  };
}
