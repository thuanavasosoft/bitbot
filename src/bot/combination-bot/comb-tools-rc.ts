import type CombBotInstance from "./comb-bot-instance";
import type { TrailMultiplierOptimizationRunCreateBody } from "@/services/backtest-dashboard.service";

/** Tag format: RC_DD-MM-YYYY in UTC. */
export function formatToolsRcTag(now: Date = new Date()): string {
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = String(now.getUTCFullYear());
  return `RC_${dd}-${mm}-${yyyy}`;
}

/**
 * Build a trail-multiplier optimization run body from a live CombBotInstance.
 * Does not include reoptDelay* fields (live preventReoptClose is unrelated).
 */
export function buildToolsRcRunRequest(
  inst: CombBotInstance,
  now: Date = new Date()
): TrailMultiplierOptimizationRunCreateBody {
  const endMs = now.getTime();
  const startMs =
    inst.runStartTs?.getTime() ??
    endMs - Math.max(1, inst.optimizationWindowMinutes) * 60_000;
  if (!(startMs < endMs)) {
    throw new Error(
      `${inst.symbol}: invalid time range (start must be before end). runStartTs may be missing or too recent.`
    );
  }

  const trailMin = Math.max(1, Math.round(inst.trailMultiplierBounds.min));
  const trailMax = Math.max(trailMin, Math.round(inst.trailMultiplierBounds.max));
  const stepSize =
    Number.isFinite(inst.trailBoundStepSize) && inst.trailBoundStepSize > 0
      ? inst.trailBoundStepSize
      : 1;
  const signalN = Math.max(1, Math.round(inst.nSignal));
  const trailingAtrLength = Math.max(1, Math.round(inst.trailingAtrLength || inst.nSignal));

  const body: TrailMultiplierOptimizationRunCreateBody = {
    symbol: inst.symbol,
    startTime: new Date(startMs).toISOString(),
    endTime: new Date(endMs).toISOString(),
    updateIntervalMinutes: Math.max(1, Math.round(inst.updateIntervalMinutes)),
    optimizationWindowMinutes: Math.max(1, Math.round(inst.optimizationWindowMinutes)),
    trailingAtrLength,
    trailMultiplierMin: trailMin,
    trailMultiplierMax: trailMax,
    stepSize,
    margin: Math.max(inst.margin, Number.EPSILON),
    leverage: Math.max(1, Math.round(inst.leverage)),
    signalParams: { N: signalN },
    triggerBufferPercentage: inst.triggerBufferPercentage,
    tag: formatToolsRcTag(now),
  };

  if (inst.tradeMarginMode === "percent_balance") {
    if (
      inst.marginPercentOfBalance != null &&
      Number.isFinite(inst.marginPercentOfBalance) &&
      inst.marginPercentOfBalance > 0
    ) {
      body.marginPercentOfBalance = Math.min(inst.marginPercentOfBalance, 100);
      body.marginPercentBasis = inst.marginPercentBasis ?? "natural";
    }
    const starting =
      (inst.startingBalance != null && inst.startingBalance > 0
        ? inst.startingBalance
        : undefined) ??
      (inst.equity != null && inst.equity > 0 ? inst.equity : undefined);
    if (starting != null) body.startingBalance = starting;
  } else if (inst.startingBalance != null && inst.startingBalance > 0) {
    body.startingBalance = inst.startingBalance;
  }

  if (inst.isMarginStopLossEnabled() && inst.marginStopLossPercent != null) {
    body.stopLossPercentage = inst.marginStopLossPercent;
  }
  if (inst.isHardTakeProfitEnabled() && inst.hardTakeProfitPercent != null) {
    body.takeProfitPercentage = inst.hardTakeProfitPercent;
  }

  if (inst.badEntryLongRocHighThreshold != null && inst.badEntryLongRocHighThreshold > 0) {
    body.badEntryLongROCHighThreshold = inst.badEntryLongRocHighThreshold;
  }
  if (inst.badEntryShortRocLowThreshold != null && inst.badEntryShortRocLowThreshold !== 0) {
    // Dashboard accepts either sign; normalize to negative fraction like the UI.
    body.badEntryShortROCLowThreshold = -Math.abs(inst.badEntryShortRocLowThreshold);
  }
  if (inst.badEntryMinUnrealizedPnlPercent != null && Number.isFinite(inst.badEntryMinUnrealizedPnlPercent)) {
    body.badEntryMinUnrealizedPnlPercent = inst.badEntryMinUnrealizedPnlPercent;
  }

  if (inst.isTrailCutEnabled() && inst.trailCutPercent != null) {
    body.trailTightenCutPercent = inst.trailCutPercent;
    body.trailTightenCutMode = inst.trailCutMode;
    if (inst.trailCutMinMfePercent != null) {
      body.trailTightenMinMfePercent = inst.trailCutMinMfePercent;
    }
    if (inst.trailCutStallMinutes != null && inst.trailCutStallMinutes > 0) {
      body.trailTightenMinStallMinutes = inst.trailCutStallMinutes;
    }
    if (inst.trailCutMaxRocClose != null) {
      body.trailTightenMaxRocClose = inst.trailCutMaxRocClose;
    }
  }

  return body;
}
