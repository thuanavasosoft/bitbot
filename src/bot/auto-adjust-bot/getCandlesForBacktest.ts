import ExchangeService from "@/services/exchange-service/exchange-service";
import { ICandleInfo } from "@/services/exchange-service/exchange-type";
import { isTransientError, withRetries } from "../breakout-bot/bb-retry";
import { normalizeCandles } from "./candle-utils";
import { Candle } from "./types";

export async function getCandlesForBacktest(args: {
  symbol: string;
  interval: "1m";
  fetchStartMs: number;
  endMs: number;
}): Promise<{ candles: Candle[]; fetchedCandles: ICandleInfo[] }> {
  const { symbol, fetchStartMs, endMs } = args;
  const startDate = new Date(fetchStartMs);
  const endDate = new Date(endMs);

  const fetchedCandles = await withRetries(
    () => ExchangeService.getCandles(symbol, startDate, endDate, "1Min"),
    {
      label: "[AutoAdjustBot] getCandlesForBacktest",
      retries: 5,
      minDelayMs: 5000,
      isTransientError,
      onRetry: ({ attempt, delayMs, error, label }) => {
        console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
      },
    }
  );

  const candles = normalizeCandles(fetchedCandles);
  return { candles, fetchedCandles };
}
