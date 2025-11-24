import bn from "bignumber.js";
import { fetchAllHistoricalKlines, Candle } from "./binance-api";
import { calculateBreakoutSignal, SignalParams } from "./breakout-helpers";
import { generateImageOfPnl, PnLPoint } from "@/ai-trend/image-generator";

/**
 * Breakout Strategy Backtest
 * 
 * 1. Fetch candles from Binance API
 * 2. Calculate breakout signals (Up/Down/Kangaroo) with support/resistance levels
 * 3. Entry: Long at resistance on "Up" signal, Short at support on "Down" signal
 * 4. Exit: Long exits at support, Short exits at resistance (using OHLC data)
 * 5. Track PnL, liquidations, and generate performance chart
 */

// ============ PARAMETERS ============
const symbol = "SUIUSDT";
const interval = "1m";
const startTime = new Date("2024-01-01T00:00:00Z");
const endTime = new Date("2025-11-20T00:00:00Z");
const margin = 200;
const leverage = 20;
const pipSize = 0.0001;
const slippageUnit = 0;
const sleepTimeAfterLiquidationInMinutes = 0;
const pnlDilute = 1;
const shouldFlipWhenUnprofitable = false;
const flipAccumulatedPnl = -300;
const feesPercentage = 0.04; // Binance 0.04%
const feeRate = feesPercentage / 100; // Convert to decimal (0.0004)
const fractional_stop_loss = 0.5;

let numberOfTrades = 0;

// Breakout signal parameters
const signalParams: SignalParams = {
  N: 720 * 4,
  atr_len: 14,
  K: 5,
  eps: 0.0005,
  m_atr: 0.25,
  roc_min: 0.0001,
  ema_period: 10,
  need_two_closes: false,
  vol_mult: 1.3
};

// Minimum candles needed for signal calculation
const minCandlesForSignal = Math.max(
  (signalParams.N || 2) + 1,
  signalParams.atr_len || 14,
  signalParams.K || 5,
  signalParams.ema_period || 10
);

// ============ MAIN LOGIC ============

async function run() {
  console.log("=".repeat(60));
  console.log("Breakout Strategy Backtest");
  console.log("=".repeat(60));
  console.log(`Symbol: ${symbol}`);
  console.log(`Interval: ${interval}`);
  console.log(`Should Flip When Unprofitable: ${shouldFlipWhenUnprofitable}`);
  console.log(`Flip Accumulated PnL: ${flipAccumulatedPnl}`);
  console.log(`Period: ${startTime.toISOString()} to ${endTime.toISOString()}`);
  console.log(`Margin: $${margin}, Leverage: ${leverage}x`);
  console.log(`Signal Params:`, JSON.stringify(signalParams, null, 2));
  console.log(`Fractional Stop Loss: ${fractional_stop_loss}`);
  console.log("=".repeat(60));

  // Fetch all historical candles
  console.log("\nFetching candles from Binance...");
  const allCandles = await fetchAllHistoricalKlines(
    symbol,
    interval,
    startTime.getTime(),
    endTime.getTime()
  );

  if (allCandles.length === 0) {
    console.error("No candles fetched. Exiting.");
    process.exit(1);
  }

  console.log(`Loaded ${allCandles.length} candles`);
  console.log(`First candle: ${new Date(allCandles[0].openTime).toISOString()}`);
  console.log(`Last candle: ${new Date(allCandles[allCandles.length - 1].openTime).toISOString()}`);
  console.log("\nStarting backtest...\n");

  // State variables
  let current_position: { side: "long" | "short", entryPrice: number } | null = null;
  let currentTotalPnl = 0;
  let baseAmt = 0;
  let liquidationPrice: number | null = null;
  let liquidationCount = 0;
  const pnlHistory: PnLPoint[] = [];
  let liquidationTimestamp: Date | null = null;
  let currentSupport: number | null = null;
  let currentResistance: number | null = null;
  let currentSignal: "Up" | "Down" | "Kangaroo" = "Kangaroo";
  let accumulatedNegativePnl = 0;
  let isFlippedMode = false;
  let totalFeesPaid = 0;

  const _applyFee = (notionalValue: number, timestamp: Date, tradeType: string): void => {
    const fee = new bn(notionalValue).times(feeRate).toNumber();
    totalFeesPaid = new bn(totalFeesPaid).plus(fee).toNumber();
    currentTotalPnl = new bn(currentTotalPnl).minus(fee).toNumber();
    
    // Update accumulated negative PnL tracking (fees are always negative)
    accumulatedNegativePnl = new bn(accumulatedNegativePnl).minus(fee).toNumber();
    
    // Update PnL history with fee impact
    pnlHistory.push({ value: currentTotalPnl, timestamp });
    
    console.log(`💰 Fee (${tradeType}): -$${fee.toFixed(4)} (${(feeRate * 100).toFixed(2)}% of $${notionalValue.toFixed(2)})`);
  };

  const _enterPosition = (side: 'long' | 'short', currentPrice: number, time: Date) => {
    numberOfTrades++;
    let slippageValue = new bn(slippageUnit).times(pipSize).toNumber();
    let bufferedEntryPrice = side === "long" ?
      new bn(currentPrice).plus(slippageValue) :
      new bn(currentPrice).minus(slippageValue);

    liquidationPrice = side === "long" ?
      new bn(bufferedEntryPrice).times(new bn(1).minus(new bn(1).div(leverage))).toNumber() :
      new bn(bufferedEntryPrice).times(new bn(1).plus(new bn(1).div(leverage))).toNumber();
      
    console.log(`[🚀 enter ${side}] Price: ${currentPrice} - buffered: ${bufferedEntryPrice.toNumber()} - time: ${time.toISOString()}`);
    
    if (side === "long") {
      current_position = { side: "long", entryPrice: bufferedEntryPrice.toNumber() };
      baseAmt = new bn(margin).times(leverage).div(bufferedEntryPrice).toNumber();
    } else {
      current_position = { side: "short", entryPrice: bufferedEntryPrice.toNumber() };
      baseAmt = new bn(margin).times(leverage).div(bufferedEntryPrice).toNumber();
    }
    
    // Apply entry fee (based on notional value: margin * leverage)
    const entryNotional = new bn(margin).times(leverage).toNumber();
    _applyFee(entryNotional, time, "entry");
  };

  const _closePositionIfAny = (currentPrice: number, endDate: Date, reason: string = "signal") => {
    if (!current_position) return;

    numberOfTrades++;
    let slippageValue = new bn(slippageUnit).times(pipSize).toNumber();
    let bufferedExitPrice = current_position.side === "long" ?
      new bn(currentPrice).minus(slippageValue) :
      new bn(currentPrice).plus(slippageValue);

    let exitValue = new bn(baseAmt).times(bufferedExitPrice);
    let entryValue = new bn(margin).times(leverage);
    let pnl = current_position.side === "long" ? exitValue.minus(entryValue) : entryValue.minus(exitValue);
    const pnlNumber = pnl.toNumber();
    const icon = pnl.gt(0) ? "🟩" : "🟥";
    currentTotalPnl = new bn(currentTotalPnl).plus(pnl).toNumber();
    pnlHistory.push({ value: currentTotalPnl, timestamp: endDate });
    
    // Apply exit fee (based on notional value: baseAmt * exitPrice)
    const exitNotional = exitValue.toNumber();
    _applyFee(exitNotional, endDate, "exit");
    
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
    
    console.log(`${icon} [exit ${reason}] - pnl: $${pnl.toFixed(2)} - [accumulated negative pnl: $${accumulatedNegativePnl.toFixed(5)}] - [current total pnl: $${currentTotalPnl.toFixed(2)}] - price: ${currentPrice} - time: ${endDate.toISOString()}`);
    
    current_position = null;
    baseAmt = 0;
    liquidationPrice = null;
  };

  const _isInSleepPeriod = (currentTime: Date): boolean => {
    if (!liquidationTimestamp) return false;
    const sleepEndTime = new Date(liquidationTimestamp.getTime() + sleepTimeAfterLiquidationInMinutes * 60 * 1000);
    const isInSleep = currentTime < sleepEndTime;
    
    if (!isInSleep && liquidationTimestamp) {
      console.log(`🌅 Sleep period ended - resuming trading at ${currentTime.toISOString()}`);
      liquidationTimestamp = null;
    }
    
    return isInSleep;
  };

  const _checkLiquidationOrDoubled = (candle: Candle, currentTime: Date): boolean => {
    if (!current_position) return false;
    if (!liquidationPrice) return false;

    const position = current_position; // Capture for type safety

    // Check liquidation using high/low
    const isLiquidation = position.side === "long" ? 
      candle.low <= liquidationPrice : 
      candle.high >= liquidationPrice;
    
    if (isLiquidation) {
      const liquidationPnl = -margin;
      currentTotalPnl = new bn(currentTotalPnl).plus(liquidationPnl).toNumber();
      pnlHistory.push({ value: currentTotalPnl, timestamp: currentTime });
      
      // Update accumulated negative PnL tracking (liquidation is always negative)
      accumulatedNegativePnl = new bn(accumulatedNegativePnl).plus(liquidationPnl).toNumber();
      
      // Apply exit fee for liquidation (based on notional value: margin * leverage)
      const liquidationNotional = new bn(margin).times(leverage).toNumber();
      _applyFee(liquidationNotional, currentTime, "liquidation_exit");
      
      console.log(`❌ Liquidated (-$${margin}) ${position.side} position at ${liquidationPrice} - total: $${currentTotalPnl.toFixed(2)}`);
      current_position = null;
      baseAmt = 0;
      liquidationPrice = null;
      liquidationCount++;
      liquidationTimestamp = currentTime;
      console.log(`😴 Starting ${sleepTimeAfterLiquidationInMinutes}-minute sleep period after liquidation`);
      return true;
    }

    return false;
  };

  const _checkStopLoss = (candle: Candle, currentTime: Date): boolean => {
    if (!current_position) return false;
    if (currentSupport === null || currentResistance === null) return false;

    const position = current_position;
    const distanceBetweenSupportResistance = new bn(currentResistance).minus(currentSupport).toNumber();
    
    if (distanceBetweenSupportResistance <= 0) return false; // Invalid support/resistance levels

    const stopLossThreshold = new bn(fractional_stop_loss).times(distanceBetweenSupportResistance).toNumber();

    if (position.side === "long") {
      // For long: check if price moved down from resistance by more than threshold
      // Stop loss level = resistance - fractional_stop_loss * (resistance - support)
      const stopLossLevel = new bn(currentResistance).minus(stopLossThreshold).toNumber();
      
      // Check if candle.low breached the stop loss level
      if (candle.low <= stopLossLevel) {
        // Exit at the calculated stop loss price
        _closePositionIfAny(stopLossLevel, currentTime, "stop_loss");
        return true;
      }
    } else {
      // For short: check if price moved up from support by more than threshold
      // Stop loss level = support + fractional_stop_loss * (resistance - support)
      const stopLossLevel = new bn(currentSupport).plus(stopLossThreshold).toNumber();
      
      // Check if candle.high breached the stop loss level
      if (candle.high >= stopLossLevel) {
        // Exit at the calculated stop loss price
        _closePositionIfAny(stopLossLevel, currentTime, "stop_loss");
        return true;
      }
    }

    return false;
  };

  // Main loop through candles
  for (let i = 0; i < allCandles.length; i++) {
    const candle = allCandles[i];
    console.log(`(${i}) [r: ${currentResistance} - s: ${currentSupport}] [h: ${candle.high}] - l: ${candle.low}] - close:[${candle.close}] - close time: ${new Date(candle.closeTime).toISOString()}`);
    const currentTime = new Date(candle.openTime);

    // Check if in sleep period
    if (_isInSleepPeriod(currentTime)) {
      // Still calculate signal for next iteration even during sleep
      if (i >= minCandlesForSignal) {
        const candleWindow = allCandles.slice(Math.max(0, i - minCandlesForSignal + 1), i + 1);
        const signalResult = calculateBreakoutSignal(candleWindow, signalParams);
        currentSignal = signalResult.signal;
        currentSupport = signalResult.support;
        currentResistance = signalResult.resistance;
      }
      continue;
    }

    // Always check liquidation/doubled first using OHLC data (using previous signal's levels)
    const wasClosedByLiqOrDouble = _checkLiquidationOrDoubled(candle, currentTime);
    if (wasClosedByLiqOrDouble) {
      // Still calculate signal for next iteration
      if (i >= minCandlesForSignal) {
        const candleWindow = allCandles.slice(Math.max(0, i - minCandlesForSignal + 1), i + 1);
        const signalResult = calculateBreakoutSignal(candleWindow, signalParams);
        currentSignal = signalResult.signal;
        currentSupport = signalResult.support;
        currentResistance = signalResult.resistance;
      }
      continue;
    }

    // Check if we should exit based on previous signal's support/resistance levels
    // Check stop loss and support/resistance exits with same priority
    if (current_position && currentSupport !== null && currentResistance !== null) {
      const pos: { side: "long" | "short", entryPrice: number } = current_position;
      
      // Check stop loss first
      const wasClosedByStopLoss = _checkStopLoss(candle, currentTime);
      if (wasClosedByStopLoss) {
        // Position was closed by stop loss, continue to next candle
        // Still calculate signal for next iteration
        if (i >= minCandlesForSignal) {
          const candleWindow = allCandles.slice(Math.max(0, i - minCandlesForSignal + 1), i + 1);
          const signalResult = calculateBreakoutSignal(candleWindow, signalParams);
          currentSignal = signalResult.signal;
          currentSupport = signalResult.support;
          currentResistance = signalResult.resistance;
        }
        continue;
      }
      
      // Check support/resistance exits
      if (pos.side === "long" && candle.low <= currentSupport) {
        // Long position hits support - exit at support
        _closePositionIfAny(candle.close, currentTime, "support");
      } else if (pos.side === "short" && candle.high >= currentResistance) {
        // Short position hits resistance - exit at resistance
        _closePositionIfAny(candle.close, currentTime, "resistance");
      }
    }

    // Entry logic based on breakout detection
    // Check if we should flip mode based on accumulated negative PnL
    if (shouldFlipWhenUnprofitable && accumulatedNegativePnl <= flipAccumulatedPnl) {
      isFlippedMode = !isFlippedMode;
      accumulatedNegativePnl = 0;
      console.log(`🔄 Flipped mode: ${isFlippedMode ? "REVERSED" : "NORMAL"} - Reset accumulated PnL`);
    }

    if (currentResistance !== null && candle.high >= currentResistance) {
      // Breakout above resistance
      const entrySide = isFlippedMode ? "short" : "long"; // Flipped: enter short, Normal: enter long
      if (!current_position) {
        // No position, enter at resistance
        _enterPosition(entrySide, currentResistance, currentTime);
      } else {
        const pos: { side: "long" | "short", entryPrice: number } = current_position;
        if (pos.side !== entrySide) {
          // In opposite position, close it and enter new position
          _closePositionIfAny(candle.close, currentTime, "signal_change");
          _enterPosition(entrySide, currentResistance, currentTime);
        }
        // If already in correct position, do nothing
      }
    } else if (currentSupport !== null && candle.low <= currentSupport) {
      // Breakout below support
      const entrySide = isFlippedMode ? "long" : "short"; // Flipped: enter long, Normal: enter short
      if (!current_position) {
        // No position, enter at support
        _enterPosition(entrySide, currentSupport, currentTime);
      } else {
        const pos: { side: "long" | "short", entryPrice: number } = current_position;
        if (pos.side !== entrySide) {
          // In opposite position, close it and enter new position
          _closePositionIfAny(candle.close, currentTime, "signal_change");
          _enterPosition(entrySide, currentSupport, currentTime);
        }
        // If already in correct position, do nothing
      }
    }

    // Calculate signal for NEXT iteration (after all checks and trades for current candle)
    if (i >= minCandlesForSignal) {
      const candleWindow = allCandles.slice(Math.max(0, i - minCandlesForSignal + 1), i + 1);
      const signalResult = calculateBreakoutSignal(candleWindow, signalParams);
      currentSignal = signalResult.signal;
      currentSupport = signalResult.support;
      currentResistance = signalResult.resistance;
    }

    // Log progress every 1000 candles
    // if (i % 1000 === 0) {
    //   console.log(`Progress: ${i}/${allCandles.length} candles processed (${(i/allCandles.length*100).toFixed(1)}%)`);
    // }
  }

  // Close any remaining position at the end
  if (current_position && allCandles.length > 0) {
    const lastCandle = allCandles[allCandles.length - 1];
    _closePositionIfAny(lastCandle.close, new Date(lastCandle.closeTime), "end");
  }

  // ============ RESULTS ============
  const actualStartTime = new Date(allCandles[0].openTime);
  const actualEndTime = new Date(allCandles[allCandles.length - 1].closeTime);
  const durationMs = actualEndTime.getTime() - actualStartTime.getTime();
  const durationDays = Math.floor(durationMs / (24 * 60 * 60 * 1000));
  const durationHours = Math.floor((durationMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const durationMinutes = Math.floor((durationMs % (60 * 60 * 1000)) / (60 * 1000));
  const durationString = `${durationDays}D${durationHours}H${durationMinutes}m`;

  const dailyPnl = durationDays > 0 ? currentTotalPnl / durationDays : 0;
  const projectedYearlyPnL = dailyPnl * 365;
  const apy = margin > 0 ? (projectedYearlyPnL / margin * 100) : 0;

  const amountLossToSlippage = new bn(numberOfTrades).times(slippageUnit).times(pipSize).toNumber();

  console.log("\n" + "=".repeat(60));
  console.log("BACKTEST RESULTS");
  console.log("=".repeat(60));
  console.log(`Simulation Duration: ${durationString}`);
  console.log(`Liquidation Count: ${liquidationCount}`);
  console.log(`Daily PnL: $${dailyPnl.toFixed(2)}`);
  console.log(`Projected Yearly PnL: $${projectedYearlyPnL.toFixed(2)}`);
  console.log(`APY: ${apy.toFixed(2)}%`);
  console.log(`Current Total PnL (after fees): $${currentTotalPnl.toFixed(2)}`);
  console.log(`Number of Trades: ${numberOfTrades} (enter + exit)`);
  console.log(`---`);
  console.log(`Fee Rate: ${(feeRate * 100).toFixed(2)}%`);
  console.log(`Total Fees Paid: -$${totalFeesPaid.toFixed(2)}`);
  console.log(`Slippage Unit: ${slippageUnit} pip(s)`);
  console.log(`Pip Size: ${pipSize}`);
  console.log(`Amount Loss To Slippage: -$${amountLossToSlippage.toFixed(2)}`);
  console.log("=".repeat(60));

  // Generate PnL chart
  if (pnlHistory.length > 0) {
    const filename = `breakout_${symbol}_${fractional_stop_loss}_${interval}_${durationString}_N${signalParams.N}_${sleepTimeAfterLiquidationInMinutes}min_${shouldFlipWhenUnprofitable ? "flip" : "no-flip"}_${flipAccumulatedPnl}pnl`;
    await generateImageOfPnl(pnlHistory, true, pnlDilute, filename);
    console.log(`\nPnL chart saved to: ${filename}`);
  }

  process.exit(0);
}

// Run the backtest
run().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});

