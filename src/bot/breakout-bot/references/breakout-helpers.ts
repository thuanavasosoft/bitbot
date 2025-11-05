/**
 * Breakout signal calculation and helper functions
 */

import { Candle } from "./binance-api";

export interface SignalParams {
  N?: number;
  atr_len?: number;
  K?: number;
  eps?: number;
  m_atr?: number;
  roc_min?: number;
  ema_period?: number;
  need_two_closes?: boolean;
  vol_mult?: number;
}

export interface SignalResult {
  signal: 'Up' | 'Down' | 'Kangaroo';
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

/**
 * Calculate True Range
 * @param candles - Array of candle objects with high, low, close
 * @returns Array of true range values
 */
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

/**
 * Calculate Exponential Moving Average (EMA)
 * @param candles - Array of candle objects with close price
 * @param period - Period for EMA calculation
 * @returns Array of { time, value } objects aligned with candles
 */
export function calculateEMA(candles: Candle[], period: number): EMAPoint[] {
  if (!candles || candles.length === 0 || period < 1) {
    return [];
  }

  const result: EMAPoint[] = [];
  const multiplier = 2 / (period + 1);
  let ema: number | null = null;

  for (let i = 0; i < candles.length; i++) {
    if (i === 0) {
      // First value is just the close price
      ema = candles[i].close;
    } else {
      // EMA = (Close - Previous EMA) * Multiplier + Previous EMA
      ema = (candles[i].close - ema!) * multiplier + ema!;
    }

    result.push({
      time: Math.floor(candles[i].openTime / 1000),
      value: ema
    });
  }

  return result;
}

/**
 * Calculate Breakout Signal
 * Determines if price has broken out above resistance ("Up"), 
 * broken down below support ("Down"), or is still ranging ("Kangaroo")
 * 
 * @param candles - Array of candle objects with openTime, open, high, low, close, volume
 * @param params - Parameters object
 * @returns Object with signal, resistance, support, and other metrics
 */
export function calculateBreakoutSignal(candles: Candle[], params: SignalParams = {}): SignalResult {
  if (!candles || candles.length === 0) {
    return {
      signal: 'Kangaroo',
      resistance: null,
      support: null,
      atr: null,
      roc: null,
      slope: null
    };
  }

  // Extract parameters with defaults
  const N = params.N || 2; // default is 2
  const atr_len = params.atr_len || 14;
  const K = params.K || 5;
  const eps = params.eps !== undefined ? params.eps : 0.0005;
  const m_atr = params.m_atr !== undefined ? params.m_atr : 0.25;
  const roc_min = params.roc_min !== undefined ? params.roc_min : 0.001;
  const ema_period = params.ema_period || 10;
  const need_two_closes = params.need_two_closes || false;
  const vol_mult = params.vol_mult !== undefined ? params.vol_mult : 1.3;

  // Need enough candles for calculations
  const minRequired = Math.max(N + 1, atr_len, K, ema_period);
  if (candles.length < minRequired) {
    return {
      signal: 'Kangaroo',
      resistance: null,
      support: null,
      atr: null,
      roc: null,
      slope: null
    };
  }

  // Calculate True Range
  const tr = calculateTrueRange(candles);
  
  // Calculate ATR (Average True Range)
  const atrValues = tr.slice(-atr_len);
  const ATR = atrValues.reduce((sum, val) => sum + val, 0) / atr_len;

  // Calculate support and resistance from lookback window (exclude current bar)
  // Use last N bars excluding the current (last) bar
  const lookbackStart = Math.max(0, candles.length - N - 1);
  const lookbackEnd = candles.length - 1; // Exclude current bar
  
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

  // Get current and previous candle indices
  const currentIdx = candles.length - 1;
  const prevIdx = currentIdx - 1;
  const currentClose = candles[currentIdx].close;
  const prevClose = candles.length > 1 ? candles[prevIdx].close : currentClose;

  // Calculate ROC (Rate of Change)
  const rocStartIdx = Math.max(0, currentIdx - K);
  const rocStartClose = candles[rocStartIdx].close;
  const ROC = rocStartClose !== 0 ? (currentClose / rocStartClose) - 1 : 0;

  // Calculate EMA for slope
  const ema = calculateEMA(candles, ema_period);
  const slope = ema.length >= 2 && 
                ema[ema.length - 1].value !== null && 
                ema[ema.length - 2].value !== null
    ? ema[ema.length - 1].value - ema[ema.length - 2].value
    : 0;

  // Calculate median of recent true ranges for momentum confirmation
  const recentTr = tr.slice(-11, -1); // Last 10 TR values (excluding current)
  recentTr.sort((a, b) => a - b);
  const medianTr = recentTr.length > 0 
    ? recentTr[Math.floor(recentTr.length / 2)] 
    : 0;
  const currentTr = tr[currentIdx];

  // Volume check (optional confirmation)
  let vol_ok_up = true;
  let vol_ok_dn = true;
  
  if (candles[0].volume !== undefined && candles[0].volume !== null) {
    // Calculate average volume from last 20 bars (excluding current)
    const volumeStart = Math.max(0, candles.length - 21);
    const volumeEnd = candles.length - 1;
    let volumeSum = 0;
    let volumeCount = 0;
    
    for (let i = volumeStart; i < volumeEnd; i++) {
      if (candles[i].volume !== undefined && candles[i].volume !== null) {
        volumeSum += candles[i].volume;
        volumeCount++;
      }
    }
    
    const avgVolume = volumeCount > 0 ? volumeSum / volumeCount : 0;
    const currentVolume = candles[currentIdx].volume || 0;
    
    vol_ok_up = avgVolume === 0 || currentVolume > vol_mult * avgVolume;
    vol_ok_dn = vol_ok_up;
  }

  // Bull breakout tests
  const up_lvl = currentClose > resistance * (1 + eps);
  const up_size = (currentClose - resistance) > m_atr * ATR;
  const up_momo = (ROC > roc_min) || (slope > 0) || (currentTr > medianTr);

  // Bear breakdown tests
  const dn_lvl = currentClose < support * (1 - eps);
  const dn_size = (support - currentClose) > m_atr * ATR;
  const dn_momo = (ROC < -roc_min) || (slope < 0) || (currentTr > medianTr);

  // Apply two closes requirement if needed
  let up_lvl_confirmed = up_lvl;
  let dn_lvl_confirmed = dn_lvl;
  
  if (need_two_closes && candles.length >= 2) {
    const prevCloseValue = candles[prevIdx].close;
    up_lvl_confirmed = up_lvl && (prevCloseValue > resistance * (1 + eps));
    dn_lvl_confirmed = dn_lvl && (prevCloseValue < support * (1 - eps));
  }

  // Determine signal
  let signal: 'Up' | 'Down' | 'Kangaroo' = 'Kangaroo';
  if (up_lvl_confirmed && up_size && up_momo && vol_ok_up) {
    signal = 'Up';
  } else if (dn_lvl_confirmed && dn_size && dn_momo && vol_ok_dn) {
    signal = 'Down';
  }

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
    dn_momo
  };
}

