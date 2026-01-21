import bn from "bignumber.js";

import { calculateBreakoutSignal } from "./breakout-helpers";
import { calculateSharpeRatio } from "./sharpe";
import type { BacktestRunSummary, Candle, SignalParams, Side } from "./types";

export type RunBacktestArgs = {
  symbol: string;
  interval?: "1m";
  requestedStartTime: string;
  requestedEndTime: string;
  margin?: number;
  leverage?: number;
  candles: Candle[];
  endCandle?: Candle;
  trailingAtrLength: number;
  highestLookback: number;
  trailMultiplier: number;
  trailConfirmBars: number;
  signalParams: SignalParams;
  tickSize?: number;
  pricePrecision?: number;
  bufferPercentage?: number;
};

type RefPosition = { side: Side; entryPrice: number } | null;

type RefPnlPoint = {
  timestamp: Date;
  side: Side;
  totalPnL: number;
  entryTimestamp: Date | null;
  entryTimestampMs: number | null;
  entryFillPrice: number | null;
  exitTimestamp: Date;
  exitTimestampMs: number;
  exitFillPrice: number;
  tradePnL: number;
  exitReason: "atr_trailing" | "signal_change" | "end" | "liquidation_exit";
};

type RefEvent =
  | {
      type: "entry";
      side: Side;
      tsMs: number;
      fillPrice: number;
    }
  | {
      type: "exit";
      side: Side;
      tsMs: number;
      fillPrice: number;
      reason: "atr_trailing" | "signal_change" | "end" | "liquidation_exit";
    };

type RefTracePoint = {
  i: number;
  tsMs: number;
  positionSide: Side | "flat";
  entryTsMs: number | null;
  entryFillPrice: number | null;
  trailingStop: number | null;
  confirmCount: number;
  exitTsMs: number | null;
  exitFillPrice: number | null;
};

type RefStrategyConfig = {
  margin: number;
  leverage: number;
  tickSize: number;
  pricePrecision: number;
  slippageUnit: number;
  sleepTimeAfterLiquidationInMinutes: number;
  shouldFlipWhenUnprofitable: boolean;
  flipAccumulatedPnl: number;
  feeRate: number;
  trailingAtrLength: number;
  highestLookback: number;
  trailMultiplier: number;
  trailConfirmBars: number;
  signalParams: SignalParams;
  bufferPercentage: number;
};

function createReferenceBreakoutExitTrailingAtrEngine(
  allCandles: Candle[],
  cfg: RefStrategyConfig
): {
  step: (candle: Candle, i: number) => void;
  closeAtEnd: (lastCandle: Candle) => void;
  getState: () => {
    numberOfTrades: number;
    current_position: RefPosition;
    currentTotalPnl: number;
    pnlHistory: RefPnlPoint[];
    liquidationCount: number;
    totalFeesPaid: number;
    perBarReturns: number[];
    trailingStop: number | null;
    trailingStopBreachCount: number;
    lastEntryTsMs: number | null;
    lastEntryFillPrice: number | null;
    lastExitTsMs: number | null;
    lastExitFillPrice: number | null;
    trace: RefTracePoint[];
    events: RefEvent[];
    slippageAccumulation: number;
  };
} {
  const {
    margin,
    leverage,
    tickSize,
    pricePrecision,
    slippageUnit,
    sleepTimeAfterLiquidationInMinutes,
    shouldFlipWhenUnprofitable,
    flipAccumulatedPnl,
    feeRate,
    trailingAtrLength,
    highestLookback,
    trailMultiplier,
    trailConfirmBars,
    signalParams,
    bufferPercentage,
  } = cfg;

  const minTrailConfirmBars = Math.max(1, trailConfirmBars);

  const minCandlesForSignal = Math.max(
    (signalParams.N || 2) + 1,
    signalParams.atr_len || 14,
    signalParams.K || 5,
    signalParams.ema_period || 10
  );

  let numberOfTrades = 0;
  let current_position: RefPosition = null;
  let currentTotalPnl = 0;
  const pnlHistory: RefPnlPoint[] = [];
  const perBarReturns: number[] = [];
  let previousEquity = margin;

  let baseAmt = 0;
  let liquidationPrice: number | null = null;
  let liquidationCount = 0;
  let liquidationTimestamp: Date | null = null;

  let currentSupport: number | null = null;
  let currentResistance: number | null = null;
  let accumulatedNegativePnl = 0;
  let isFlippedMode = false;

  let totalFeesPaid = 0;
  let slippageAccumulation = 0;

  let atrTrSum = 0;
  let atrTrCount = 0;
  let atrTrHead = 0;
  const atrTrWindow: number[] = new Array(trailingAtrLength);
  let prevAtrCandle: Candle | null = null;

  let closesSinceEntry: number[] = new Array(highestLookback);
  let closesHead = 0;
  let closesCount = 0;
  let closesSeq = 0;
  type DequeEntry = { idx: number; value: number };
  let maxCloseDeque: DequeEntry[] = [];
  let minCloseDeque: DequeEntry[] = [];
  let trailingStop: number | null = null;
  let trailingStopBreachCount = 0;

  let lastEntryTsMs: number | null = null;
  let lastEntryFillPrice: number | null = null;
  let lastExitTsMs: number | null = null;
  let lastExitFillPrice: number | null = null;
  const trace: RefTracePoint[] = [];
  const events: RefEvent[] = [];

  const _applyFee = (notionalValue: number): void => {
    const fee = new bn(notionalValue).times(feeRate).toNumber();
    totalFeesPaid = new bn(totalFeesPaid).plus(fee).toNumber();
    currentTotalPnl = new bn(currentTotalPnl).minus(fee).toNumber();
    accumulatedNegativePnl = new bn(accumulatedNegativePnl).minus(fee).toNumber();
  };

  type TickRoundMode = "up" | "down" | "nearest";
  const _quantizeToTick = (price: number, mode: TickRoundMode): number => {
    if (!Number.isFinite(price)) return price;
    if (!Number.isFinite(tickSize) || tickSize <= 0) return price;
    const p = new bn(price);
    const t = new bn(tickSize);
    const q = p.div(t);
    const rounded =
      mode === "up"
        ? q.integerValue(bn.ROUND_CEIL)
        : mode === "down"
          ? q.integerValue(bn.ROUND_FLOOR)
          : q.integerValue(bn.ROUND_HALF_UP);
    return rounded.times(t).toNumber();
  };

  const _roundToPrecision = (value: number, mode: "up" | "down"): number => {
    if (!Number.isFinite(value) || !Number.isFinite(pricePrecision)) return value;
    const multiplier = Math.pow(10, pricePrecision);
    return mode === "up"
      ? Math.ceil(value * multiplier) / multiplier
      : Math.floor(value * multiplier) / multiplier;
  };

  const _calcLongTrigger = (resistance: number | null): number | null => {
    if (resistance === null) return null;
    const bufferMultiplier = new bn(1).minus(bufferPercentage);
    const longTriggerRaw = new bn(resistance).times(bufferMultiplier).toNumber();
    return _roundToPrecision(longTriggerRaw, "down");
  };

  const _calcShortTrigger = (support: number | null): number | null => {
    if (support === null) return null;
    const bufferMultiplier = new bn(1).plus(bufferPercentage);
    const shortTriggerRaw = new bn(support).times(bufferMultiplier).toNumber();
    return _roundToPrecision(shortTriggerRaw, "up");
  };

  const _updateSlippageAccumulation = (slippage: number | null) => {
    if (!Number.isFinite(slippage as number)) return;
    const numeric = slippage as number;
    if (numeric > 0) {
      slippageAccumulation += Math.abs(numeric);
    } else if (numeric < 0) {
      slippageAccumulation -= Math.abs(numeric);
    }
  };

  const _resetTrailingState = (): void => {
    closesSinceEntry = new Array(highestLookback);
    closesHead = 0;
    closesCount = 0;
    closesSeq = 0;
    maxCloseDeque = [];
    minCloseDeque = [];
    trailingStop = null;
    trailingStopBreachCount = 0;
  };

  const _isInSleepPeriod = (currentTime: Date): boolean => {
    if (!liquidationTimestamp) return false;
    const elapsedMinutes =
      (currentTime.getTime() - liquidationTimestamp.getTime()) / (60 * 1000);
    return elapsedMinutes < sleepTimeAfterLiquidationInMinutes;
  };

  const _checkLiquidationOrDoubled = (candle: Candle, currentTime: Date): boolean => {
    if (!current_position || !liquidationPrice) return false;
    const position = current_position;

    const priceBreached =
      position.side === "long"
        ? candle.low <= liquidationPrice
        : candle.high >= liquidationPrice;

    if (priceBreached) {
      const liquidationPnl =
        position.side === "long"
          ? -new bn(margin).toNumber()
          : -new bn(margin).toNumber();

      currentTotalPnl = new bn(currentTotalPnl).plus(liquidationPnl).toNumber();

      pnlHistory.push({
        timestamp: currentTime,
        side: position.side,
        totalPnL: currentTotalPnl,
        entryTimestamp: lastEntryTsMs ? new Date(lastEntryTsMs) : null,
        entryTimestampMs: lastEntryTsMs,
        entryFillPrice: lastEntryFillPrice,
        exitTimestamp: currentTime,
        exitTimestampMs: currentTime.getTime(),
        exitFillPrice: liquidationPrice,
        tradePnL: liquidationPnl,
        exitReason: "liquidation_exit",
      });

      accumulatedNegativePnl = new bn(accumulatedNegativePnl).plus(liquidationPnl).toNumber();

      const liquidationNotional = new bn(margin).times(leverage).toNumber();
      _applyFee(liquidationNotional);

      lastExitTsMs = currentTime.getTime();
      lastExitFillPrice = liquidationPrice;
      events.push({
        type: "exit",
        side: position.side,
        tsMs: lastExitTsMs,
        fillPrice: lastExitFillPrice,
        reason: "liquidation_exit",
      });

      current_position = null;
      baseAmt = 0;
      liquidationPrice = null;
      liquidationCount++;
      liquidationTimestamp = currentTime;
      _resetTrailingState();
      return true;
    }

    return false;
  };

  const _updateTrailingStructures = (close: number, atrValue: number | null): void => {
    if (!current_position || !Number.isFinite(close)) return;
    const numericClose = Number(close);

    if (closesCount < highestLookback) {
      closesSinceEntry[(closesHead + closesCount) % highestLookback] = numericClose;
      closesCount++;
      closesSeq++;
    } else {
      const idx = closesHead;
      closesSinceEntry[idx] = numericClose;
      closesHead = (closesHead + 1) % highestLookback;
      closesSeq++;
    }

    const barIndex = closesSeq - 1;
    while (maxCloseDeque.length && maxCloseDeque[maxCloseDeque.length - 1].value <= numericClose) {
      maxCloseDeque.pop();
    }
    maxCloseDeque.push({ idx: barIndex, value: numericClose });
    while (minCloseDeque.length && minCloseDeque[minCloseDeque.length - 1].value >= numericClose) {
      minCloseDeque.pop();
    }
    minCloseDeque.push({ idx: barIndex, value: numericClose });

    const windowStart = barIndex - (highestLookback - 1);
    if (maxCloseDeque.length && maxCloseDeque[0].idx < windowStart) {
      maxCloseDeque.shift();
    }
    if (minCloseDeque.length && minCloseDeque[0].idx < windowStart) {
      minCloseDeque.shift();
    }

    if (atrValue === null || !Number.isFinite(atrValue)) {
      return;
    }

    if (current_position.side === "long") {
      const highestClose = maxCloseDeque.length ? maxCloseDeque[0].value : numericClose;
      const candidateStop = highestClose - atrValue * trailMultiplier;
      if (candidateStop > 0 && (trailingStop === null || candidateStop > trailingStop)) {
        trailingStop = _quantizeToTick(candidateStop, "up");
      }
    } else {
      const lowestClose = minCloseDeque.length ? minCloseDeque[0].value : numericClose;
      const candidateStop = lowestClose + atrValue * trailMultiplier;
      if (candidateStop > 0 && (trailingStop === null || candidateStop < trailingStop)) {
        trailingStop = _quantizeToTick(candidateStop, "down");
      }
    }
  };

  const _enterPosition = (
    side: Side,
    referenceLevel: number | null,
    entryBasisPrice: number,
    time: Date
  ): void => {
    numberOfTrades++;
    _resetTrailingState();
    const slippageValue = new bn(slippageUnit).times(tickSize).toNumber();
    const bufferedEntryPrice =
      side === "long"
        ? new bn(entryBasisPrice).plus(slippageValue)
        : new bn(entryBasisPrice).minus(slippageValue);

    const entryFill =
      side === "long"
        ? _quantizeToTick(bufferedEntryPrice.toNumber(), "up")
        : _quantizeToTick(bufferedEntryPrice.toNumber(), "down");

    if (referenceLevel !== null) {
      const slippage =
        side === "long"
          ? new bn(entryFill).minus(referenceLevel).toNumber()
          : new bn(referenceLevel).minus(entryFill).toNumber();
      _updateSlippageAccumulation(slippage);
    }

    liquidationPrice =
      side === "long"
        ? _quantizeToTick(
            new bn(entryFill).times(new bn(1).minus(new bn(1).div(leverage))).toNumber(),
            "up"
          )
        : _quantizeToTick(
            new bn(entryFill).times(new bn(1).plus(new bn(1).div(leverage))).toNumber(),
            "down"
          );

    current_position = { side, entryPrice: entryFill };
    baseAmt = new bn(margin).times(leverage).div(entryFill).toNumber();

    const entryNotional = new bn(margin).times(leverage).toNumber();
    _applyFee(entryNotional);

    lastEntryTsMs = time.getTime();
    lastEntryFillPrice = entryFill;
    events.push({
      type: "entry",
      side,
      tsMs: lastEntryTsMs,
      fillPrice: lastEntryFillPrice,
    });
  };

  const _closePositionIfAny = (
    currentPrice: number,
    endDate: Date,
    reason: "atr_trailing" | "signal_change" | "end" | "liquidation_exit" = "signal_change"
  ): void => {
    if (!current_position) return;

    const closeSide = current_position.side;
    numberOfTrades++;
    const slippageValue = new bn(slippageUnit).times(tickSize).toNumber();
    const bufferedExitPrice =
      current_position.side === "long"
        ? new bn(currentPrice).minus(slippageValue)
        : new bn(currentPrice).plus(slippageValue);

    const exitFill =
      current_position.side === "long"
        ? _quantizeToTick(bufferedExitPrice.toNumber(), "down")
        : _quantizeToTick(bufferedExitPrice.toNumber(), "up");

    const exitValue = new bn(baseAmt).times(exitFill);
    const entryValue = new bn(margin).times(leverage);
    const pnl =
      current_position.side === "long" ? exitValue.minus(entryValue) : entryValue.minus(exitValue);
    const pnlNumber = pnl.toNumber();

    currentTotalPnl = new bn(currentTotalPnl).plus(pnl).toNumber();

    const exitNotional = exitValue.toNumber();
    _applyFee(exitNotional);

    const srLevel =
      current_position.side === "long" ? currentSupport : currentResistance;
    if (srLevel !== null) {
      const slippage =
        current_position.side === "short"
          ? new bn(exitFill).minus(srLevel).toNumber()
          : new bn(srLevel).minus(exitFill).toNumber();
      _updateSlippageAccumulation(slippage);
    }

    pnlHistory.push({
      timestamp: endDate,
      side: closeSide,
      totalPnL: currentTotalPnl,
      entryTimestamp: lastEntryTsMs ? new Date(lastEntryTsMs) : null,
      entryTimestampMs: lastEntryTsMs,
      entryFillPrice: lastEntryFillPrice,
      exitTimestamp: endDate,
      exitTimestampMs: endDate.getTime(),
      exitFillPrice: exitFill,
      tradePnL: pnlNumber,
      exitReason: reason,
    });

    if (pnlNumber < 0) {
      accumulatedNegativePnl = new bn(accumulatedNegativePnl).plus(pnlNumber).toNumber();
    } else if (pnlNumber > 0) {
      accumulatedNegativePnl = new bn(accumulatedNegativePnl).plus(pnlNumber).toNumber();
      if (accumulatedNegativePnl >= 0) {
        accumulatedNegativePnl = 0;
      }
    }

    lastExitTsMs = endDate.getTime();
    lastExitFillPrice = exitFill;
    events.push({
      type: "exit",
      side: closeSide,
      tsMs: lastExitTsMs,
      fillPrice: lastExitFillPrice,
      reason,
    });

    current_position = null;
    baseAmt = 0;
    liquidationPrice = null;
    _resetTrailingState();
  };

  const step = (candle: Candle, i: number): void => {
    const currentTime = new Date(candle.openTime);

    let currentAtr: number | null = null;
    if (prevAtrCandle) {
      const currentHigh = Number(candle.high);
      const currentLow = Number(candle.low);
      const previousClose = Number(prevAtrCandle.close);
      const highLow = currentHigh - currentLow;
      const highPrevClose = Math.abs(currentHigh - previousClose);
      const lowPrevClose = Math.abs(currentLow - previousClose);
      const trueRange = Math.max(highLow, highPrevClose, lowPrevClose);

      if (trailingAtrLength > 0) {
        if (atrTrCount < trailingAtrLength) {
          atrTrWindow[(atrTrHead + atrTrCount) % trailingAtrLength] = trueRange;
          atrTrCount++;
          atrTrSum += trueRange;
        } else {
          atrTrSum -= atrTrWindow[atrTrHead];
          atrTrWindow[atrTrHead] = trueRange;
          atrTrHead = (atrTrHead + 1) % trailingAtrLength;
          atrTrSum += trueRange;
        }

        if (atrTrCount >= trailingAtrLength) {
          currentAtr = atrTrSum / trailingAtrLength;
        }
      }
    }
    prevAtrCandle = candle;

    const positionAtBarStart = current_position !== null;
    let enteredThisBar = false;

    if (_isInSleepPeriod(currentTime)) {
      if (i >= minCandlesForSignal) {
        const candleWindow = allCandles.slice(Math.max(0, i - minCandlesForSignal + 1), i + 1);
        const signalResult = calculateBreakoutSignal(candleWindow, signalParams);
        currentSupport = signalResult.support;
        currentResistance = signalResult.resistance;
      }
      trace.push({
        i,
        tsMs: currentTime.getTime(),
        positionSide: current_position ? current_position.side : "flat",
        entryTsMs: lastEntryTsMs,
        entryFillPrice: lastEntryFillPrice,
        trailingStop,
        confirmCount: trailingStopBreachCount,
        exitTsMs: lastExitTsMs,
        exitFillPrice: lastExitFillPrice,
      });
      return;
    }

    const wasClosedByLiqOrDouble = _checkLiquidationOrDoubled(candle, currentTime);
    if (wasClosedByLiqOrDouble) {
      if (i >= minCandlesForSignal) {
        const candleWindow = allCandles.slice(Math.max(0, i - minCandlesForSignal + 1), i + 1);
        const signalResult = calculateBreakoutSignal(candleWindow, signalParams);
        currentSupport = signalResult.support;
        currentResistance = signalResult.resistance;
      }
      trace.push({
        i,
        tsMs: currentTime.getTime(),
        positionSide: current_position ? current_position.side : "flat",
        entryTsMs: lastEntryTsMs,
        entryFillPrice: lastEntryFillPrice,
        trailingStop,
        confirmCount: trailingStopBreachCount,
        exitTsMs: lastExitTsMs,
        exitFillPrice: lastExitFillPrice,
      });
      return;
    }

    if (positionAtBarStart && current_position) {
      if (trailingStop !== null) {
        const stopBreached =
          current_position.side === "long"
            ? candle.low <= trailingStop
            : candle.high >= trailingStop;
        if (stopBreached) {
          trailingStopBreachCount++;
        } else {
          trailingStopBreachCount = 0;
        }

        if (trailingStopBreachCount >= minTrailConfirmBars) {
          _closePositionIfAny(candle.close, currentTime, "atr_trailing");
        }
      } else {
        trailingStopBreachCount = 0;
      }
    }

    if (shouldFlipWhenUnprofitable && accumulatedNegativePnl <= flipAccumulatedPnl) {
      isFlippedMode = !isFlippedMode;
      accumulatedNegativePnl = 0;
    }

    const longTrigger = _calcLongTrigger(currentResistance);
    if (longTrigger !== null && candle.high >= longTrigger) {
      const entrySide: Side = isFlippedMode ? "short" : "long";
      if (!current_position) {
        _enterPosition(entrySide, currentResistance, longTrigger, currentTime);
        enteredThisBar = true;
      }
    } else {
      const shortTrigger = _calcShortTrigger(currentSupport);
      if (shortTrigger !== null && candle.low <= shortTrigger) {
        const entrySide: Side = isFlippedMode ? "long" : "short";
        if (!current_position) {
          _enterPosition(entrySide, currentSupport, shortTrigger, currentTime);
          enteredThisBar = true;
        }
      }
    }

    if (enteredThisBar && current_position) {
      _updateTrailingStructures(candle.close, currentAtr);
      trailingStopBreachCount = 0;
    }

    if (i >= minCandlesForSignal) {
      const candleWindow = allCandles.slice(Math.max(0, i - minCandlesForSignal + 1), i + 1);
      const signalResult = calculateBreakoutSignal(candleWindow, signalParams);
      currentSupport = signalResult.support;
      currentResistance = signalResult.resistance;
    }

    const currentEquity = margin + currentTotalPnl;
    if (previousEquity > 0) {
      const barReturn = new bn(currentEquity).minus(previousEquity).toNumber();
      perBarReturns.push(barReturn);
    }
    previousEquity = currentEquity;

    trace.push({
      i,
      tsMs: currentTime.getTime(),
      positionSide: current_position ? current_position.side : "flat",
      entryTsMs: lastEntryTsMs,
      entryFillPrice: lastEntryFillPrice,
      trailingStop,
      confirmCount: trailingStopBreachCount,
      exitTsMs: lastExitTsMs,
      exitFillPrice: lastExitFillPrice,
    });
  };

  const closeAtEnd = (lastCandle: Candle): void => {
    if (current_position && lastCandle) {
      _closePositionIfAny(lastCandle.close, new Date(lastCandle.closeTime), "end");
    }
  };

  const getState = () => ({
    numberOfTrades,
    current_position,
    currentTotalPnl,
    pnlHistory,
    liquidationCount,
    totalFeesPaid,
    perBarReturns,
    trailingStop,
    trailingStopBreachCount,
    lastEntryTsMs,
    lastEntryFillPrice,
    lastExitTsMs,
    lastExitFillPrice,
    trace,
    events,
    slippageAccumulation,
  });

  return { step, closeAtEnd, getState };
}

export function runBacktestWithTrace(args: RunBacktestArgs): {
  summary: BacktestRunSummary;
  trace: RefTracePoint[];
  perBarReturns: number[];
} {
  const {
    symbol,
    interval = "1m",
    requestedStartTime,
    requestedEndTime,
    margin: marginArg,
    leverage: leverageArg,
    candles,
    trailingAtrLength,
    highestLookback,
    trailMultiplier,
    trailConfirmBars,
    signalParams,
    tickSize: tickSizeArg,
    pricePrecision: pricePrecisionArg,
    bufferPercentage: bufferPercentageArg,
  } = args;

  if (!candles.length) {
    throw new Error("No candles provided");
  }

  const margin = Number.isFinite(marginArg as number) ? (marginArg as number) : 100;
  const leverage = Number.isFinite(leverageArg as number) ? (leverageArg as number) : 20;
  const pricePrecision = Number.isFinite(pricePrecisionArg as number)
    ? (pricePrecisionArg as number)
    : 4;
  const tickSize = Number.isFinite(tickSizeArg as number)
    ? (tickSizeArg as number)
    : Math.pow(10, -pricePrecision);
  const bufferPercentage = Number.isFinite(bufferPercentageArg as number)
    ? Math.max(0, bufferPercentageArg as number)
    : 0;

  const cfg: RefStrategyConfig = {
    margin,
    leverage,
    tickSize,
    pricePrecision,
    slippageUnit: 0,
    sleepTimeAfterLiquidationInMinutes: 0,
    shouldFlipWhenUnprofitable: false,
    flipAccumulatedPnl: -300,
    feeRate: 0.05 / 100,
    trailingAtrLength,
    highestLookback,
    trailMultiplier,
    trailConfirmBars,
    signalParams,
    bufferPercentage,
  };

  const engine = createReferenceBreakoutExitTrailingAtrEngine(candles, cfg);
  for (let i = 0; i < candles.length; i++) {
    engine.step(candles[i], i);
  }

  const endCandle = args.endCandle ?? candles[candles.length - 1];
  engine.closeAtEnd(endCandle);

  const st = engine.getState();

  const pnlHistory: BacktestRunSummary["pnlHistory"] = st.pnlHistory.map((p) => ({
    timestamp: p.timestamp.toISOString(),
    timestampMs: p.timestamp.getTime(),
    side: p.side,
    totalPnL: p.totalPnL,
    entryTimestamp: p.entryTimestamp ? p.entryTimestamp.toISOString() : null,
    entryTimestampMs: p.entryTimestampMs,
    entryFillPrice: p.entryFillPrice,
    exitTimestamp: p.exitTimestamp.toISOString(),
    exitTimestampMs: p.exitTimestampMs,
    exitFillPrice: p.exitFillPrice,
    tradePnL: p.tradePnL,
    exitReason: p.exitReason,
  }));

  const actualStartTime = new Date(candles[0].openTime);
  const actualEndTime = new Date(endCandle.closeTime);
  const durationMs = actualEndTime.getTime() - actualStartTime.getTime();
  const durationDays = Math.floor(durationMs / (24 * 60 * 60 * 1000));
  const durationHours = Math.floor((durationMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const durationMinutes = Math.floor((durationMs % (60 * 60 * 1000)) / (60 * 1000));
  const durationString = `${durationDays}D${durationHours}H${durationMinutes}m`;

  const dailyPnL = durationDays > 0 ? st.currentTotalPnl / durationDays : 0;
  const projectedYearlyPnL = dailyPnL * 365;
  const apyPercent = margin > 0 ? (projectedYearlyPnL / margin) * 100 : 0;

  const sharpeRatio = calculateSharpeRatio(st.perBarReturns);

  const summary: BacktestRunSummary = {
    symbol,
    interval,
    requestedStartTime,
    requestedEndTime,
    actualStartTime: actualStartTime.toISOString(),
    actualEndTime: actualEndTime.toISOString(),
    candleCount: candles.length,
    duration: durationString,
    margin,
    leverage,
    tickSize,
    pricePrecision,
    numberOfTrades: st.numberOfTrades,
    liquidationCount: st.liquidationCount,
    feeRate: cfg.feeRate,
    totalFeesPaid: st.totalFeesPaid,
    totalPnL: st.currentTotalPnl,
    pnlHistory,
    dailyPnL,
    projectedYearlyPnL,
    apyPercent,
    sharpeRatio,
    slippageAccumulation: st.slippageAccumulation,
  };

  return { summary, trace: st.trace, perBarReturns: st.perBarReturns };
}

export function runBacktest(args: RunBacktestArgs): BacktestRunSummary {
  const { summary } = runBacktestWithTrace(args);
  return summary;
}

export function runBacktestWithReturns(args: RunBacktestArgs): {
  summary: BacktestRunSummary;
  perBarReturns: number[];
} {
  const { summary, perBarReturns } = runBacktestWithTrace(args);
  return { summary, perBarReturns };
}
