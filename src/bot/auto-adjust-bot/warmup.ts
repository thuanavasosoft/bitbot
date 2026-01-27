import { SignalParams } from "./types";

export function computeWarmupBars(
  signalParams: SignalParams,
  trailingAtrLength: number,
  highestLookback: number = trailingAtrLength
): number {
  const minCandlesForSignal = Math.max(
    (signalParams.N || 2) + 1,
    signalParams.atr_len || 14,
    signalParams.K || 5,
    signalParams.ema_period || 10
  );
  const minTrailing = Math.max(trailingAtrLength + 1, trailingAtrLength, highestLookback);
  return Math.max(minCandlesForSignal, minTrailing);
}
