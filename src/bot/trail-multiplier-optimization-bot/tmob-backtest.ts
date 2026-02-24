import bn from "bignumber.js";
import { BacktestRunSummary, Candle, SignalParams } from "../auto-adjust-bot/types";
import { calculateSharpeRatio } from "../auto-adjust-bot/sharpe";

type Side = "long" | "short";

export type TailMultRunBacktestArgs = {
  symbol: string;
  interval?: "1m";
  requestedStartTime: string;
  requestedEndTime: string;
  nextOptimizedMs?: number;
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
  maintenanceMarginRate?: number;
  withLogs: boolean;
  triggerBufferPercentage?: number;
};

type RefPosition = { side: Side; entryPrice: number } | null;

type RefPnlPoint = {
  timestamp: Date;
  side: Side;
  totalPnL: number; // cumulative after fees
  entryTimestamp: Date | null;
  entryTimestampMs: number | null;
  entryFillPrice: number | null;
  exitTimestamp: Date;
  exitTimestampMs: number;
  exitFillPrice: number;
  tradePnL: number;
  tradeFee: number;
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
  maintenanceMarginRate: number;
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
  tradeStartMs: number;
  withLogs: boolean;
  triggerBufferPercentage: number;
};

function createReferenceBreakoutExitTrailingAtrEngine(
  allCandles: Candle[],
  cfg: RefStrategyConfig,
): {
  step: (candle: Candle, i: number, withLogs?: boolean) => void;
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
  };
} {
  // === EXACT state machine & semantics copied from references/breakout-exit-trailing-atr.txt ===
  const {
    margin,
    leverage,
    tickSize,
    maintenanceMarginRate,
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
    tradeStartMs,
    triggerBufferPercentage,
    pricePrecision,
  } = cfg;

  const minTrailConfirmBars = Math.max(1, trailConfirmBars);

  // Minimum candles needed for signal calculation (reference semantics)
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

  // For internal consistency checks
  let lastEntryTsMs: number | null = null;
  let lastEntryFillPrice: number | null = null;
  let lastEntryFee = 0;
  let lastExitTsMs: number | null = null;
  let lastExitFillPrice: number | null = null;
  const trace: RefTracePoint[] = [];
  const events: RefEvent[] = [];

  const _applyFee = (notionalValue: number): void => {
    const fee = new bn(notionalValue).times(feeRate).toNumber();
    totalFeesPaid = new bn(totalFeesPaid).plus(fee).toNumber();
    currentTotalPnl = new bn(currentTotalPnl).minus(fee).toNumber();
    // Update accumulated negative PnL tracking (fees are always negative)
    accumulatedNegativePnl = new bn(accumulatedNegativePnl).minus(fee).toNumber();
  };

  type TickRoundMode = "up" | "down" | "nearest";
  const _quantizeToTick = (price: number, mode: TickRoundMode, withLogs?: boolean): number => {
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
    const tick = rounded.times(t).toNumber();
    return tick;
  };

  const _resetTrailingState = (): void => {
    trailingStop = null;
    trailingStopBreachCount = 0;
    closesSinceEntry = new Array(highestLookback);
    closesHead = 0;
    closesCount = 0;
    closesSeq = 0;
    maxCloseDeque = [];
    minCloseDeque = [];
  };

  const _pushCloseSinceEntry = (closeValue: number): void => {
    closesSeq++;
    if (!Number.isFinite(highestLookback) || highestLookback <= 0) {
      closesCount = 0;
      maxCloseDeque = [];
      minCloseDeque = [];
      return;
    }

    const insertIndex =
      closesCount < highestLookback ? (closesHead + closesCount) % highestLookback : closesHead;
    closesSinceEntry[insertIndex] = closeValue;

    if (closesCount < highestLookback) {
      closesCount++;
    } else {
      closesHead = (closesHead + 1) % highestLookback;
    }

    while (maxCloseDeque.length && maxCloseDeque[maxCloseDeque.length - 1].value <= closeValue) {
      maxCloseDeque.pop();
    }
    maxCloseDeque.push({ idx: closesSeq, value: closeValue });

    while (minCloseDeque.length && minCloseDeque[minCloseDeque.length - 1].value >= closeValue) {
      minCloseDeque.pop();
    }
    minCloseDeque.push({ idx: closesSeq, value: closeValue });

    const expireIdx = closesSeq - highestLookback;
    while (maxCloseDeque.length && maxCloseDeque[0].idx <= expireIdx) {
      maxCloseDeque.shift();
    }
    while (minCloseDeque.length && minCloseDeque[0].idx <= expireIdx) {
      minCloseDeque.shift();
    }
  };

  const _updateTrailingStructures = (closeValue: number, atrValue: number | null, withLogs?: boolean): void => {
    if (!current_position) return;

    const numericClose = Number(closeValue);

    // Compute trailing stop from finished candles only (exclude current bar) - matches live bot behavior
    if (atrValue !== null && closesCount > 0) {
      if (current_position.side === "long") {
        const highestClose = maxCloseDeque[0].value;
        const candidateStop = highestClose - atrValue * trailMultiplier;
        if (candidateStop > 0) {
          trailingStop = _quantizeToTick(candidateStop, "up", withLogs);
        }
      } else {
        const lowestClose = minCloseDeque[0].value;
        const candidateStop = lowestClose + atrValue * trailMultiplier;
        if (candidateStop > 0) {
          trailingStop = _quantizeToTick(candidateStop, "down", withLogs);
        }
      }
    }

    // Push current bar's close for next iteration (live uses only finished candles)
    _pushCloseSinceEntry(numericClose);
  };

  const _enterPosition = (side: Side, currentPrice: number, time: Date, withLogs: boolean): void => {
    numberOfTrades++;
    _resetTrailingState();
    const slippageValue = new bn(slippageUnit).times(tickSize).toNumber();
    const bufferedEntryPrice =
      side === "long"
        ? new bn(currentPrice).plus(slippageValue)
        : new bn(currentPrice).minus(slippageValue);

    const entryFill =
      side === "long"
        ? _quantizeToTick(bufferedEntryPrice.toNumber(), "up")
        : _quantizeToTick(bufferedEntryPrice.toNumber(), "down");

    const oneOverLev = new bn(1).div(leverage);
    const rawLiqLong = new bn(entryFill).times(new bn(1).minus(oneOverLev).plus(maintenanceMarginRate)).toNumber();
    const rawLiqShort = new bn(entryFill).times(new bn(1).plus(oneOverLev).minus(maintenanceMarginRate)).toNumber();
    liquidationPrice =
      side === "long"
        ? _quantizeToTick(rawLiqLong, "down")
        : _quantizeToTick(rawLiqShort, "up");

    // if (withLogs) {
    // }

    current_position = { side, entryPrice: entryFill };
    if (withLogs) {
      console.log("=====================ENTER POSITION======================");
      console.log("entryFill: ", entryFill);
      console.log("maintenanceMarginRate: ", maintenanceMarginRate);
      console.log("liquidationPrice: ", liquidationPrice);
      console.log("currentPosition: ", current_position);
      console.log("------------------------------------------------------------------------");
    }

    baseAmt = new bn(margin).times(leverage).div(entryFill).toNumber();

    // Apply entry fee (based on notional value: margin * leverage)
    const entryNotional = new bn(margin).times(leverage).toNumber();
    lastEntryFee = new bn(entryNotional).times(feeRate).toNumber();
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
    reason: "atr_trailing" | "signal_change" | "end" | "liquidation_exit" = "signal_change",
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

    // Apply exit fee (based on notional value: baseAmt * exitPrice)
    const exitNotional = exitValue.toNumber();
    const exitFee = new bn(exitNotional).times(feeRate).toNumber();

    _applyFee(exitNotional);

    const tradeFeeTotal = lastEntryFee + exitFee;

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
      tradeFee: tradeFeeTotal,
      exitReason: reason,
    });

    // Update accumulated negative PnL tracking
    if (pnlNumber < 0) {
      accumulatedNegativePnl = new bn(accumulatedNegativePnl).plus(pnlNumber).toNumber();
    } else if (pnlNumber > 0) {
      // Positive PnL reduces accumulated negative PnL (adds to it since it's negative)
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

  const _isInSleepPeriod = (currentTime: Date): boolean => {
    if (!liquidationTimestamp) return false;
    const sleepEndTime = new Date(
      liquidationTimestamp.getTime() + sleepTimeAfterLiquidationInMinutes * 60 * 1000
    );
    const isInSleep = currentTime < sleepEndTime;

    if (!isInSleep && liquidationTimestamp) {
      liquidationTimestamp = null;
    }

    return isInSleep;
  };

  const _checkLiquidationOrDoubled = (candle: Candle, currentTime: Date, withLogs: boolean): boolean => {
    if (!current_position) return false;
    if (!liquidationPrice) return false;

    const position = current_position;

    // Check liquidation using high/low
    const isLiquidation = position.side === "long" ? candle.low <= liquidationPrice : candle.high >= liquidationPrice;

    if (withLogs) {
      console.log("=====================LIQUIDATION CHECK======================");
      console.log("liquidationPrice: ", liquidationPrice);
      console.log("candle.low: ", candle.low);
      console.log("candle.high: ", candle.high);
      console.log("isLiquidation: ", isLiquidation);
      console.log("------------------------------------------------------------------------");
    }
    if (isLiquidation) {
      const liquidationPnl = -margin;
      currentTotalPnl = new bn(currentTotalPnl).plus(liquidationPnl).toNumber();
      // Apply exit fee for liquidation (based on notional value: margin * leverage)
      const liquidationNotional = new bn(margin).times(leverage).toNumber();
      const liquidationFee = new bn(liquidationNotional).times(feeRate).toNumber();
      _applyFee(liquidationNotional);

      const liquidationTradeFeeTotal = lastEntryFee + liquidationFee;

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
        tradeFee: liquidationTradeFeeTotal,
        exitReason: "liquidation_exit",
      });

      // Update accumulated negative PnL tracking (liquidation is always negative)
      accumulatedNegativePnl = new bn(accumulatedNegativePnl).plus(liquidationPnl).toNumber();

      // Record a synthetic exit fill (reference does not compute bufferedExitPrice here)
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

  const step = (candle: Candle, i: number, withLog?: boolean): void => {
    // Main loop through candles (reference order & timestamps)
    const currentTime = new Date(candle.openTime);
    const loggableDates: string[] = [
      "2026-02-22T00:42",
      // "2026-02-22T02:57",
      // "2026-02-22T08:41",
      // "2026-02-22T08:42",
    ]
    const withLogs = withLog && loggableDates.some(logable => toIso(currentTime.getTime()).startsWith(logable)) || false;
    withLogs && console.log(`=====================${toIso(currentTime.getTime())}=========================`);
    const isTradable = candle.openTime >= tradeStartMs;

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
    let closedByAtrThisBar = false;

    if (!isTradable) {
      // Warmup: update signal state but skip trading/performance accounting.
      if (i >= minCandlesForSignal) {
        const candleWindow = allCandles.slice(Math.max(0, i - minCandlesForSignal + 1), i + 1);
        const signalResult = calculateBreakoutSignal(candleWindow, signalParams);
        currentSupport = new bn(signalResult.support!).decimalPlaces(pricePrecision, bn.ROUND_UP).toNumber();
        currentResistance = new bn(signalResult.resistance!).decimalPlaces(pricePrecision, bn.ROUND_DOWN).toNumber();
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

    // Check if in sleep period
    if (_isInSleepPeriod(currentTime)) {
      // Still calculate signal for next iteration even during sleep
      if (i >= minCandlesForSignal) {
        const candleWindow = allCandles.slice(Math.max(0, i - minCandlesForSignal + 1), i + 1);
        const signalResult = calculateBreakoutSignal(candleWindow, signalParams);
        currentSupport = new bn(signalResult.support!).decimalPlaces(pricePrecision, bn.ROUND_UP).toNumber();
        currentResistance = new bn(signalResult.resistance!).decimalPlaces(pricePrecision, bn.ROUND_DOWN).toNumber();
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

    // Always check liquidation first using OHLC data (using previous signal's levels)
    const wasClosedByLiqOrDouble = _checkLiquidationOrDoubled(candle, currentTime, withLogs);
    if (wasClosedByLiqOrDouble) {
      // Still calculate signal for next iteration
      if (i >= minCandlesForSignal) {
        const candleWindow = allCandles.slice(Math.max(0, i - minCandlesForSignal + 1), i + 1);
        const signalResult = calculateBreakoutSignal(candleWindow, signalParams);
        currentSupport = new bn(signalResult.support!).decimalPlaces(pricePrecision, bn.ROUND_UP).toNumber();
        currentResistance = new bn(signalResult.resistance!).decimalPlaces(pricePrecision, bn.ROUND_DOWN).toNumber();
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
      _updateTrailingStructures(candle.close, currentAtr, withLogs);

      if (trailingStop !== null) {
        const bufferPct = (triggerBufferPercentage ?? 0.1) / 100 || 0;
        let exitTrigger = trailingStop;
        if (bufferPct > 0) {
          if (current_position.side === "long") {
            exitTrigger = trailingStop * (1 + bufferPct);
          } else {
            exitTrigger = trailingStop * (1 - bufferPct);
          }
        }
        // For longs: exit when price drops below stop
        // For shorts: exit when price rises above stop
        const isStopBreached =
          current_position.side === "long" ? candle.low <= exitTrigger : candle.high >= exitTrigger;

        if (isStopBreached) {
          trailingStopBreachCount++;
        } else {
          trailingStopBreachCount = 0;
        }

        if (withLogs) {
          console.log("=====================TRAILING STOP BREACH CHECK=======================");
          console.log("currentTime: ", toIso(currentTime.getTime()));
          console.log("candle.close: ", candle.close);
          console.log("trailMultiplier: ", trailMultiplier);
          console.log("currentAtr: ", currentAtr);
          console.log("trailingStop: ", trailingStop);
          console.log("exitTrigger: ", exitTrigger);
          console.log("candle.low: ", candle.low);
          console.log("candle.high: ", candle.high);
          console.log("minTrailConfirmBars: ", minTrailConfirmBars);
          console.log("isStopBreached: ", isStopBreached);
          console.log("trailingStopBreachCount: ", trailingStopBreachCount);

          console.log("------------------------------------------------------------------------");
        }

        if (trailingStopBreachCount >= minTrailConfirmBars) {
          _closePositionIfAny(trailingStop, currentTime, "atr_trailing");
          closedByAtrThisBar = true;
        }
      } else {
        trailingStopBreachCount = 0;
      }
    }

    // Entry logic based on breakout detection
    // Only open new position when flat. Existing positions are closed only by trailing stop or liquidation/optimization end.
    // Do not enter immediately after closing due to ATR trailing stop (wait for next bar)
    if (shouldFlipWhenUnprofitable && accumulatedNegativePnl <= flipAccumulatedPnl) {
      isFlippedMode = !isFlippedMode;
      accumulatedNegativePnl = 0;
    }

    if (!closedByAtrThisBar) {
      const bufferPct = (triggerBufferPercentage ?? 0.1) / 100 || 0;
      const longTrigger = currentResistance ? new bn(currentResistance * (1 - bufferPct)).decimalPlaces(pricePrecision, bn.ROUND_DOWN).toNumber() : null;
      const shortTrigger = currentSupport ? new bn(currentSupport * (1 + bufferPct)).decimalPlaces(pricePrecision, bn.ROUND_UP).toNumber() : null;
      if (withLogs) {
        console.log("pricePrecision: ", pricePrecision);
        console.log("bufferedPct: ", bufferPct);
        console.log("currentTime: ", toIso(currentTime.getTime()));
        console.log("candle.open: ", candle.open);
        console.log("--------------------------------");
        console.log("currentResistance: ", currentResistance);
        console.log("longTrigger: ", longTrigger);
        console.log("candle.high: ", candle.high);
        console.log(`candle.high >= longTrigger (${candle.high} >= ${longTrigger}) = ${candle.high >= longTrigger!}`);
        console.log("--------------------------------");
        console.log("currentSupport: ", currentSupport);
        console.log("shortTrigger: ", shortTrigger);
        console.log("candle.low: ", candle.low);
        console.log(`candle.low <= shortTrigger (${candle.low} <= ${shortTrigger}) = ${candle.low <= shortTrigger!}`);
      }
      if (longTrigger !== null && candle.high >= longTrigger) {
        // Breakout above resistance: enter long (or short if flipped) only when no position
        const entrySide: Side = isFlippedMode ? "short" : "long";
        if (!current_position) {
          _enterPosition(entrySide, currentResistance!, currentTime, withLogs);
          enteredThisBar = true;
        }
      } else if (shortTrigger !== null && candle.low <= shortTrigger) {
        // Breakout below support: enter short (or long if flipped) only when no position
        const entrySide: Side = isFlippedMode ? "long" : "short";
        if (!current_position) {
          _enterPosition(entrySide, currentSupport!, currentTime, withLogs);
          enteredThisBar = true;
        }
      }
    }

    if (enteredThisBar && current_position) {
      _updateTrailingStructures(candle.close, currentAtr, withLogs);
      trailingStopBreachCount = 0;
    }

    // Calculate signal for NEXT iteration (after all checks and trades for current candle)
    if (i >= minCandlesForSignal) {
      const candleWindow = allCandles.slice(Math.max(0, i - minCandlesForSignal + 1), i + 1);
      const signalResult = calculateBreakoutSignal(candleWindow, signalParams);
      currentSupport = new bn(signalResult.support!).decimalPlaces(pricePrecision, bn.ROUND_UP).toNumber();
      currentResistance = new bn(signalResult.resistance!).decimalPlaces(pricePrecision, bn.ROUND_DOWN).toNumber();
    }

    // Track per-bar return for Sharpe ratio calculation
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
      _closePositionIfAny(lastCandle.close, new Date(lastCandle.closeTime + 1), "end");
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
  });

  return { step, closeAtEnd, getState };
}

function formatTracePoint(tp: RefTracePoint): string {
  const pos = tp.positionSide;
  const entry = tp.entryTsMs === null ? "null" : `${tp.entryTsMs}@${tp.entryFillPrice}`;
  const exit = tp.exitTsMs === null ? "null" : `${tp.exitTsMs}@${tp.exitFillPrice}`;
  return `i=${tp.i} tsMs=${tp.tsMs} pos=${pos} entry=${entry} stop=${tp.trailingStop} confirm=${tp.confirmCount} exit=${exit}`;
}

function assertTracesEqual(a: RefTracePoint[], b: RefTracePoint[]): void {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const A = a[i];
    const B = b[i];
    if (!A || !B) {
      throw new Error(
        `Trace length mismatch at i=${i}. aLen=${a.length} bLen=${b.length}\n` +
        `a=${A ? formatTracePoint(A) : "missing"}\n` +
        `b=${B ? formatTracePoint(B) : "missing"}`
      );
    }
    const equal =
      A.positionSide === B.positionSide &&
      A.entryTsMs === B.entryTsMs &&
      A.entryFillPrice === B.entryFillPrice &&
      A.trailingStop === B.trailingStop &&
      A.confirmCount === B.confirmCount &&
      A.exitTsMs === B.exitTsMs &&
      A.exitFillPrice === B.exitFillPrice;
    if (!equal) {
      const windowStart = Math.max(0, i - 3);
      const windowEnd = Math.min(len - 1, i + 3);
      const contextA = a.slice(windowStart, windowEnd + 1).map(formatTracePoint).join("\n");
      const contextB = b.slice(windowStart, windowEnd + 1).map(formatTracePoint).join("\n");
      throw new Error(
        `State mismatch at bar i=${i}\n--- A (reference-engine direct) ---\n${contextA}\n--- B (runBacktest wrapper) ---\n${contextB}`
      );
    }
  }
}

/**
 * Internal no-framework consistency test.
 *
 * It runs:
 * - the reference engine directly
 * - the exported runBacktest wrapper (which must be a thin adapter)
 *
 * and asserts per-candle equality of:
 * position side, entry ts/price, trailing stop, confirm counter, exit ts/price.
 */
export function _runBacktestInternalConsistencyTest(): void {
  const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);
  const mk = (i: number, o: number, h: number, l: number, c: number): Candle => ({
    openTime: t0 + i * 60_000,
    closeTime: t0 + (i + 1) * 60_000 - 1,
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 100,
  });

  // Deterministic ~50 candles with a couple of ramps + pullbacks to exercise:
  // - breakout entries (via calculateBreakoutSignal)
  // - trailing stop tightening
  // - confirm bar counting
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < 50; i++) {
    const drift = i < 15 ? 0.3 : i < 30 ? -0.2 : 0.25;
    const noise = (i % 5) * 0.01;
    const open = price;
    const close = price + drift + noise;
    const high = Math.max(open, close) + 0.15;
    const low = Math.min(open, close) - 0.15;
    candles.push(mk(i, open, high, low, close));
    price = close;
  }

  const args: TailMultRunBacktestArgs = {
    symbol: "TESTUSDT",
    interval: "1m",
    requestedStartTime: new Date(candles[0].openTime).toISOString(),
    requestedEndTime: new Date(candles[candles.length - 1].closeTime).toISOString(),
    margin: 100,
    leverage: 20,
    candles,
    trailingAtrLength: 10,
    highestLookback: 10,
    trailMultiplier: 2,
    trailConfirmBars: 2,
    signalParams: {
      N: 10,
      atr_len: 5,
      K: 5,
      eps: 0.0005,
      m_atr: 0.25,
      roc_min: 0.0001,
      ema_period: 5,
      need_two_closes: false,
      vol_mult: 1.0,
    },
    withLogs: false
  };

  // A: reference engine direct (trace)
  const { trace: traceA } = runBacktestReferenceEngineTrace(args);

  // B: runBacktest wrapper (trace)
  const { trace: traceB } = runBacktestWithTrace(args);

  assertTracesEqual(traceA, traceB);
}

function runBacktestReferenceEngineTrace(args: TailMultRunBacktestArgs): { trace: RefTracePoint[] } {
  const {
    candles,
    trailingAtrLength,
    highestLookback,
    trailMultiplier,
    trailConfirmBars,
    signalParams,
    requestedStartTime,
    margin: marginArg,
    leverage: leverageArg,
    tickSize: tickSizeArg,
    pricePrecision: pricePrecisionArg,
    maintenanceMarginRate: maintenanceMarginRateArg,
    withLogs,
    triggerBufferPercentage = 0.1,
  } = args;
  if (!candles.length) throw new Error("No candles provided");

  const margin = Number.isFinite(marginArg as number) ? (marginArg as number) : 100;
  const leverage = Number.isFinite(leverageArg as number) ? (leverageArg as number) : 20;
  const tickSize = Number.isFinite(tickSizeArg as number) ? (tickSizeArg as number) : 0.0001;
  const pricePrecision = Number.isFinite(pricePrecisionArg as number) ? (pricePrecisionArg as number) : 4;
  const maintenanceMarginRate = Number.isFinite(maintenanceMarginRateArg as number) && (maintenanceMarginRateArg as number) >= 0
    ? (maintenanceMarginRateArg as number)
    : 0.01;
  const requestedStartMs = Date.parse(requestedStartTime);
  const tradeStartMs = Number.isFinite(requestedStartMs)
    ? Math.max(candles[0].openTime, requestedStartMs)
    : candles[0].openTime;
  const cfg: RefStrategyConfig = {
    margin,
    leverage,
    tickSize,
    pricePrecision,
    maintenanceMarginRate,
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
    tradeStartMs,
    withLogs,
    triggerBufferPercentage,
  };

  const engine = createReferenceBreakoutExitTrailingAtrEngine(candles, cfg);
  for (let i = 0; i < candles.length; i++) engine.step(candles[i], i, withLogs);
  engine.closeAtEnd(candles[candles.length - 1]);
  return { trace: engine.getState().trace };
}

function runBacktestWithTrace(
  args: TailMultRunBacktestArgs
): { summary: BacktestRunSummary; trace: RefTracePoint[]; perBarReturns: number[] } {
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
    maintenanceMarginRate: maintenanceMarginRateArg,
    withLogs,
    triggerBufferPercentage = 0.1,
  } = args;

  if (!candles.length) {
    throw new Error("No candles provided");
  }

  // Constants (reference defaults)
  const margin = Number.isFinite(marginArg as number) ? (marginArg as number) : 100;
  const leverage = Number.isFinite(leverageArg as number) ? (leverageArg as number) : 20;
  const tickSize = Number.isFinite(tickSizeArg as number) ? (tickSizeArg as number) : 0.0001;
  const pricePrecision = Number.isFinite(pricePrecisionArg as number) ? (pricePrecisionArg as number) : 4;
  const maintenanceMarginRate = Number.isFinite(maintenanceMarginRateArg as number) && (maintenanceMarginRateArg as number) >= 0
    ? (maintenanceMarginRateArg as number)
    : 0.01;

  const requestedStartMs = Date.parse(requestedStartTime);
  const tradeStartMs = Number.isFinite(requestedStartMs)
    ? Math.max(candles[0].openTime, requestedStartMs)
    : candles[0].openTime;
  const cfg: RefStrategyConfig = {
    margin,
    leverage,
    tickSize,
    pricePrecision,
    maintenanceMarginRate,
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
    tradeStartMs,
    withLogs,
    triggerBufferPercentage,
  };

  const runStartedAt = new Date();
  const engine = createReferenceBreakoutExitTrailingAtrEngine(candles, cfg);
  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    engine.step(candle, i, withLogs);
  }

  // Close any remaining position at the end (reference semantics: end uses closeTime Date)
  const endCandle = args.endCandle ?? candles[candles.length - 1];
  engine.closeAtEnd(endCandle);
  const runFinishedAt = new Date();
  const runDurationMs = runFinishedAt.getTime() - runStartedAt.getTime();

  const st = engine.getState();

  // Convert reference pnlHistory into API summary pnlHistory
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
    tradeFee: p.tradeFee,
    exitReason: p.exitReason,
  }));

  // ============ SUMMARY ============
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
    runStartedAt: runStartedAt.toISOString(),
    runFinishedAt: runFinishedAt.toISOString(),
    runDurationMs,
  };

  return { summary, trace: st.trace, perBarReturns: st.perBarReturns };
}

export function tmobRunBacktest(args: TailMultRunBacktestArgs): BacktestRunSummary {
  const { summary } = runBacktestWithTrace(args);
  return summary;
}

export function runBacktestWithReturns(args: TailMultRunBacktestArgs): {
  summary: BacktestRunSummary;
  perBarReturns: number[];
} {
  const { summary, perBarReturns } = runBacktestWithTrace(args);
  return { summary, perBarReturns };
}


function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

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
      value: ema,
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
      signal: "Kangaroo",
      resistance: null,
      support: null,
      atr: null,
      roc: null,
      slope: null,
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

  // Calculate ROC (Rate of Change)
  const rocStartIdx = Math.max(0, currentIdx - K);
  const rocStartClose = candles[rocStartIdx].close;
  const ROC = rocStartClose !== 0 ? currentClose / rocStartClose - 1 : 0;

  // Calculate EMA for slope
  const ema = calculateEMA(candles, ema_period);
  const slope =
    ema.length >= 2 &&
      ema[ema.length - 1].value !== null &&
      ema[ema.length - 2].value !== null
      ? ema[ema.length - 1].value - ema[ema.length - 2].value
      : 0;

  // Calculate median of recent true ranges for momentum confirmation
  const recentTr = tr.slice(-11, -1); // Last 10 TR values (excluding current)
  recentTr.sort((a, b) => a - b);
  const medianTr =
    recentTr.length > 0 ? recentTr[Math.floor(recentTr.length / 2)] : 0;
  const currentTr = tr[currentIdx];

  // Volume check (optional confirmation)
  let vol_ok_up = true;
  let vol_ok_dn = true;

  // Calculate average volume from last 20 bars (excluding current)
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

  // Bull breakout tests
  const up_lvl = currentClose > resistance * (1 + eps);
  const up_size = currentClose - resistance > m_atr * ATR;
  const up_momo = ROC > roc_min || slope > 0 || currentTr > medianTr;

  // Bear breakdown tests
  const dn_lvl = currentClose < support * (1 - eps);
  const dn_size = support - currentClose > m_atr * ATR;
  const dn_momo = ROC < -roc_min || slope < 0 || currentTr > medianTr;

  // Apply two closes requirement if needed
  let up_lvl_confirmed = up_lvl;
  let dn_lvl_confirmed = dn_lvl;

  if (need_two_closes && candles.length >= 2) {
    const prevCloseValue = candles[prevIdx].close;
    up_lvl_confirmed = up_lvl && prevCloseValue > resistance * (1 + eps);
    dn_lvl_confirmed = dn_lvl && prevCloseValue < support * (1 - eps);
  }

  // Determine signal
  let signal: "Up" | "Down" | "Kangaroo" = "Kangaroo";
  if (up_lvl_confirmed && up_size && up_momo && vol_ok_up) {
    signal = "Up";
  } else if (dn_lvl_confirmed && dn_size && dn_momo && vol_ok_dn) {
    signal = "Down";
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
    dn_momo,
  };
}