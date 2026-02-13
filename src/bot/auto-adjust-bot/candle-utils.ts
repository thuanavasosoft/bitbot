import { ICandleInfo } from "@/services/exchange-service/exchange-type";
import { Candle } from "./types";

const ONE_MINUTE_MS = 60_000;

const normalizeTimestamp = (ts: number): number => {
  if (!Number.isFinite(ts)) return ts;
  return ts < 1_000_000_000_000 ? ts * 1000 : ts;
};

export const toCandle = (candle: ICandleInfo): Candle => {
  const openTime = normalizeTimestamp(candle.timestamp);
  return {
    openTime,
    closeTime: openTime + ONE_MINUTE_MS,
    open: candle.openPrice,
    high: candle.highPrice,
    low: candle.lowPrice,
    close: candle.closePrice,
    volume: 0,
  };
};

export const normalizeCandles = (candles: ICandleInfo[]): Candle[] => {
  const map = new Map<number, Candle>();
  for (const candle of candles) {
    const normalized = toCandle(candle);
    if (!Number.isFinite(normalized.openTime)) continue;
    map.set(normalized.openTime, normalized);
  }
  return Array.from(map.values()).sort((a, b) => a.openTime - b.openTime);
};

export const sliceCandles = (candles: Candle[], startMs: number, endMs: number) =>
  candles.filter((c) => c.openTime >= startMs && c.openTime < endMs);

export const toIso = (ms: number) => new Date(ms).toISOString();