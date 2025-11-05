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
const startTime = new Date("2025-01-01T00:00:00Z");
const endTime = new Date("2025-01-02T00:00:00Z");
const margin = 1000;
const leverage = 20;
const pipSize = 0.0001;
const slippageUnit = 1;
const sleepTimeAfterLiquidationInMinutes = 0;
const pnlDilute = 1;
let numberOfTrades = 0;

// Breakout signal parameters
const signalParams: SignalParams = {
  N: 2,
  atr_len: 14,
  K: 5,
  eps: 0.0005,
  m_atr: 0.25,
  roc_min: 0.001,
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
  console.log(`Period: ${startTime.toISOString()} to ${endTime.toISOString()}`);
  console.log(`Margin: $${margin}, Leverage: ${leverage}x`);
  console.log(`Signal Params:`, signalParams);
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
  let doubledCount = 0;
  const pnlHistory: PnLPoint[] = [];
  let liquidationTimestamp: Date | null = null;
  let currentSupport: number | null = null;
  let currentResistance: number | null = null;
  let currentSignal: "Up" | "Down" | "Kangaroo" = "Kangaroo";

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
    const icon = pnl.gt(0) ? "🟩" : "🟥";
    currentTotalPnl = new bn(currentTotalPnl).plus(pnl).toNumber();
    pnlHistory.push({ value: currentTotalPnl, timestamp: endDate });
    console.log(`${icon} [exit ${reason}] - pnl: $${pnl.toFixed(2)} - [current total pnl: $${currentTotalPnl.toFixed(2)}] - price: ${currentPrice} - time: ${endDate.toISOString()}`);
    
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
      currentTotalPnl = new bn(currentTotalPnl).minus(new bn(margin)).toNumber();
      pnlHistory.push({ value: currentTotalPnl, timestamp: currentTime });
      console.log(`❌ Liquidated (-$${margin}) ${position.side} position at ${liquidationPrice} - total: $${currentTotalPnl.toFixed(2)}`);
      current_position = null;
      baseAmt = 0;
      liquidationPrice = null;
      liquidationCount++;
      liquidationTimestamp = currentTime;
      console.log(`😴 Starting ${sleepTimeAfterLiquidationInMinutes}-minute sleep period after liquidation`);
      return true;
    }

    // Check doubled using high/low
    const liquidationGap = new bn(position.entryPrice).minus(liquidationPrice).abs();
    const doubledPrice = position.side === "long" ? 
      new bn(position.entryPrice).plus(liquidationGap).toNumber() : 
      new bn(position.entryPrice).minus(liquidationGap).toNumber();
    
    const isDoubled = position.side === "long" ? 
      candle.high >= doubledPrice : 
      candle.low <= doubledPrice;
    
    if (isDoubled) {
      currentTotalPnl = new bn(currentTotalPnl).plus(new bn(margin)).toNumber();
      pnlHistory.push({ value: currentTotalPnl, timestamp: currentTime });
      console.log(`💵 Doubled (+$${margin}) ${position.side} position at ${doubledPrice} - total: $${currentTotalPnl.toFixed(2)}`);
      current_position = null;
      baseAmt = 0;
      liquidationPrice = null;
      doubledCount++;
      return true;
    }

    return false;
  };

  // Main loop through candles
  for (let i = 0; i < allCandles.length; i++) {
    const candle = allCandles[i];
    console.log(`(${i}) high:[${candle.high}] - low:[${candle.low}] - close:[${candle.close}] - close time: ${new Date(candle.closeTime).toISOString()}`);
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
    if (current_position && currentSupport !== null && currentResistance !== null) {
      const pos: { side: "long" | "short", entryPrice: number } = current_position;
      if (pos.side === "long" && candle.low <= currentSupport) {
        // Long position hits support - exit at support
        _closePositionIfAny(currentSupport, currentTime, "support");
      } else if (pos.side === "short" && candle.high >= currentResistance) {
        // Short position hits resistance - exit at resistance
        _closePositionIfAny(currentResistance, currentTime, "resistance");
      }
    }

    // Entry logic based on previous signal
    if (currentSignal === "Up" && currentResistance !== null) {
      if (!current_position) {
        // No position, enter long at resistance
        _enterPosition("long", currentResistance, currentTime);
      } else {
        const pos: { side: "long" | "short", entryPrice: number } = current_position;
        if (pos.side === "short") {
          // In short position, close it and enter long
          _closePositionIfAny(candle.close, currentTime, "signal_change");
          _enterPosition("long", currentResistance, currentTime);
        }
        // If already long, do nothing
      }
    } else if (currentSignal === "Down" && currentSupport !== null) {
      if (!current_position) {
        // No position, enter short at support
        _enterPosition("short", currentSupport, currentTime);
      } else {
        const pos: { side: "long" | "short", entryPrice: number } = current_position;
        if (pos.side === "long") {
          // In long position, close it and enter short
          _closePositionIfAny(candle.close, currentTime, "signal_change");
          _enterPosition("short", currentSupport, currentTime);
        }
        // If already short, do nothing
      }
    }
    // For "Kangaroo" signal, keep existing position (don't close or open)

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
  console.log(`Doubled Count: ${doubledCount}`);
  console.log(`Daily PnL: $${dailyPnl.toFixed(2)}`);
  console.log(`Projected Yearly PnL: $${projectedYearlyPnL.toFixed(2)}`);
  console.log(`APY: ${apy.toFixed(2)}%`);
  console.log(`Current Total PnL: $${currentTotalPnl.toFixed(2)}`);
  console.log(`Number of Trades: ${numberOfTrades} (enter + exit)`);
  console.log(`---`);
  console.log(`Slippage Unit: ${slippageUnit} pip(s)`);
  console.log(`Pip Size: ${pipSize}`);
  console.log(`Amount Loss To Slippage: -$${amountLossToSlippage.toFixed(2)}`);
  console.log("=".repeat(60));

  // Generate PnL chart
  if (pnlHistory.length > 0) {
    const filename = `breakout_${symbol}_${interval}_${durationString}_N${signalParams.N}_${sleepTimeAfterLiquidationInMinutes}min.png`;
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

