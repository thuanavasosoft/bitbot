/**
 * Breakout signal calculation and helper functions
 *
 * Ported from: references/breakout-helpers.txt
 */

import { Candle, SignalParams } from "./types";

export interface SignalResult {
  signal: "Up" | "Down" | "Kangaroo";
  resistance: number | null;
  support: number | null;
  atr: number | null;
  roc: number | null;
  slope: number | null;
  currentClose?: number;
  up_lvl?: boolean;
  up_size?: boolean;
  up_momo?: boolean;
  dn_lvl?: boolean;
  dn_size?: boolean;
  dn_momo?: boolean;
}

export interface EMAPoint {
  time: number;
  value: number;
}

export function calculateTrueRange(candles: Candle[]): number[] {
  if (!candles || candles.length === 0) {
    return [];
  }

  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      tr.push(candles[i].high - candles[i].low);
    } else {
      const hl = candles[i].high - candles[i].low;
      const hc = Math.abs(candles[i].high - candles[i - 1].close);
      const lc = Math.abs(candles[i].low - candles[i - 1].close);
      tr.push(Math.max(hl, hc, lc));
    }
  }
  return tr;
}

export function calculateEMA(candles: Candle[], period: number): EMAPoint[] {
  if (!candles || candles.length === 0 || period < 1) {
    return [];
  }

  const result: EMAPoint[] = [];
  const multiplier = 2 / (period + 1);
  let ema: number | null = null;

  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      ema = candles[i].close;
    } else {
      ema = (candles[i].close - ema!) * multiplier + ema!;
    }

    result.push({
      time: Math.floor(candles[i].openTime / 1000),
      value: ema,
    });
  }

  return result;
}

export function calculateBreakoutSignal(
  candles: Candle[],
  params: SignalParams = {}
): SignalResult {
  if (!candles || candles.length === 0) {
    return {
      signal: "Kangaroo",
      resistance: null,
      support: null,
      atr: null,
      roc: null,
      slope: null,
    };
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
    return {
      signal: "Kangaroo",
      resistance: null,
      support: null,
      atr: null,
      roc: null,
      slope: null,
    };
  }

  const tr = calculateTrueRange(candles);
  const atrValues = tr.slice(-atr_len);
  const ATR = atrValues.reduce((sum, val) => sum + val, 0) / atr_len;

  const lookbackStart = Math.max(0, candles.length - N - 1);
  const lookbackEnd = candles.length - 1;

  let resistance = -Infinity;
  let support = Infinity;

  for (let i = lookbackStart; i < lookbackEnd; i++) {
    if (candles[i].high > resistance) {
      resistance = candles[i].high;
    }
    if (candles[i].low < support) {
      support = candles[i].low;
    }
  }

  const currentIdx = candles.length - 1;
  const prevIdx = currentIdx - 1;
  const currentClose = candles[currentIdx].close;

  const rocStartIdx = Math.max(0, currentIdx - K);
  const rocStartClose = candles[rocStartIdx].close;
  const ROC = rocStartClose !== 0 ? currentClose / rocStartClose - 1 : 0;

  const ema = calculateEMA(candles, ema_period);
  const slope =
    ema.length >= 2 &&
    ema[ema.length - 1].value !== null &&
    ema[ema.length - 2].value !== null
      ? ema[ema.length - 1].value - ema[ema.length - 2].value
      : 0;

  const recentTr = tr.slice(-11, -1);
  recentTr.sort((a, b) => a - b);
  // const medianTr = recentTr.length > 0 ? recentTr[Math.floor(recentTr.length / 2)] : 0;
  const currentTr = tr[currentIdx];

  let vol_ok_up = true;
  let vol_ok_dn = true;

  const volumeStart = Math.max(0, candles.length - 21);
  const volumeEnd = candles.length - 1;
  let volumeSum = 0;
  let volumeCount = 0;

  for (let i = volumeStart; i < volumeEnd; i++) {
    volumeSum += candles[i].volume;
    volumeCount++;
  }

  const avgVolume = volumeCount > 0 ? volumeSum / volumeCount : 0;
  const currentVolume = candles[currentIdx].volume;

  vol_ok_up = avgVolume === 0 || currentVolume > vol_mult * avgVolume;
  vol_ok_dn = vol_ok_up;

  const up_lvl_confirmed = currentClose > resistance;
  const dn_lvl_confirmed = currentClose < support;

  const up_size = currentTr > ATR * m_atr;
  const dn_size = currentTr > ATR * m_atr;

  const up_momo = ROC > roc_min && slope > eps && currentClose > candles[prevIdx].close + ATR * eps;
  const dn_momo = ROC < -roc_min && slope < -eps && currentClose < candles[prevIdx].close - ATR * eps;

  if (need_two_closes) {
    const previousClose = candles[prevIdx].close;
    if (up_lvl_confirmed && up_size && up_momo && vol_ok_up && previousClose > resistance) {
      return {
        signal: "Up",
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
    } else if (dn_lvl_confirmed && dn_size && dn_momo && vol_ok_dn && previousClose < support) {
      return {
        signal: "Down",
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
    } else {
      return {
        signal: "Kangaroo",
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
  }

  if (up_lvl_confirmed && up_size && up_momo && vol_ok_up) {
    return {
      signal: "Up",
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
  } else if (dn_lvl_confirmed && dn_size && dn_momo && vol_ok_dn) {
    return {
      signal: "Down",
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

  return {
    signal: "Kangaroo",
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
