import { ICandleInfo, IPosition } from "@/services/exchange-service/exchange-type";

/** Minimal candles interface to avoid circular deps (comb-utils uses this). */
export interface ICombCandles {
  ensurePopulated(): Promise<void>;
  getCandles(startDate: Date, endDate: Date): Promise<ICandleInfo[]>;
}

/** State interface for combination-bot instance (one symbol). */
export interface CombState {
  onEnter: () => Promise<void>;
  onExit: () => Promise<void>;
}

export type CombSide = "long" | "short";

export type CombBacktestRunSummary = {
  symbol: string;
  interval: "1m";
  requestedStartTime: string;
  requestedEndTime: string;
  actualStartTime: string;
  actualEndTime: string;
  candleCount: number;
  duration: string;
  margin: number;
  leverage: number;
  tickSize: number;
  pricePrecision: number;
  numberOfTrades: number;
  liquidationCount: number;
  feeRate: number;
  totalFeesPaid: number;
  totalPnL: number;
  pnlHistory: CombPnlHistoryPoint[];
  dailyPnL: number;
  projectedYearlyPnL: number;
  apyPercent: number;
  sharpeRatio: number;
};

export type CombPnlHistoryPoint = {
  timestamp: string;
  timestampMs: number;
  side: CombSide;
  totalPnL: number;
  entryTimestamp: string | null;
  entryTimestampMs: number | null;
  entryFillPrice: number | null;
  exitTimestamp: string;
  exitTimestampMs: number;
  exitFillPrice: number;
  tradePnL: number;
  exitReason: "atr_trailing" | "signal_change" | "end" | "liquidation_exit" | "close_command" | "tp_pullback" | "minority_prevention" | "margin_stop_loss" | "bad_signal" | "hard_take_profit";
};

/** Indicates position was closed but state should be preserved until trailing stop triggers. */
export type JustManuallyClosedBy = "close_pos" | "tp_pb" | "minority_prevention" | "margin_stop_loss" | "bad_signal" | "hard_take_profit";

export type CombRunBacktestArgs = {
  symbol: string;
  interval?: "1m";
  requestedStartTime: string;
  requestedEndTime: string;
  margin?: number;
  leverage?: number;
  candles: ICandleInfo[];
  endCandle?: ICandleInfo;
  trailingAtrLength: number;
  highestLookback: number;
  trailMultiplier: number;
  trailConfirmBars: number;
  signalParams: CombSignalParams;
  tickSize?: number;
  pricePrecision?: number;
};

export interface CombSignalParams {
  N: number;
  atr_len?: number;
  K?: number;
  /** Kept for TMOB optimization warmup compatibility. */
  ema_period?: number;
  /** Min |rocHigh| since entry to count as impulse (long). Default 0.006. */
  consolidation_impulse_roc_long?: number;
  /** Min |rocLow| since entry to count as impulse (short). Default 0.006. */
  consolidation_impulse_roc_short?: number;
  /** |rocClose| at or below this = momentum flattened. Default 0.001. */
  consolidation_roc_flat?: number;
  /** stdDev now must be <= peak × this to count as contracting. Default 0.65. */
  consolidation_std_contract_ratio?: number;
  /** ATR now must be <= peak × this to count as contracting. Default 0.70. */
  consolidation_atr_contract_ratio?: number;
  /** Min bars between impulse peak and current bar. Default 3. */
  consolidation_min_bars_after_impulse?: number;
}

export interface CombSignalResult {
  resistance: number | null;
  support: number | null;
  atr: number | null;
  supportCandleTsMs?: number | null;
  resistanceCandleTsMs?: number | null;
  roc: { rocHigh: number; rocLow: number } | null;
  stdDev?: number | null;
  entryCandle?: ICandleInfo;
  /** True when impulse ROC since entry peaked, ROC flattened, and vol contracted from peak. */
  isConsolidationAfterBreakout?: boolean;
}

/**
 * Config for one combination-bot instance. Keys match env names (COMB_BOT_N_<KEY>).
 */
export interface CombInstanceConfig {
  SYMBOL: string;
  LEVERAGE: number;
  MARGIN: number;
  TRIGGER_BUFFER_PERCENTAGE: number;
  N_SIGNAL_AND_ATR_LENGTH: number;
  UPDATE_INTERVAL_MINUTES: number;
  OPTIMIZATION_WINDOW_MINUTES: number;
  TRAIL_CONFIRM_BARS: number;
  TRAIL_BOUND_STEP_SIZE: number;
  TRAIL_MULTIPLIER_BOUNDS_MIN: number;
  TRAIL_MULTIPLIER_BOUNDS_MAX: number;
  TELEGRAM_CHAT_ID: string;
  /** Max loss as % of margin before stop-loss price triggers. Undefined = disabled. */
  MARGIN_STOP_LOSS?: number;
  /** Hard take profit as % of margin (ROM), same semantics as dashboard takeProfitPercentage. Undefined = disabled. */
  HARD_TAKE_PROFIT_PCT?: number;
  /** Long bad-entry if rocHigh exceeds this fraction (e.g. 0.006 = 0.6%). Undefined = disabled. */
  BAD_ENTRY_LONG_ROC_HIGH_THRESHOLD_PCT?: number;
  /** Short bad-entry if rocLow is below -abs(this) fraction. Undefined = disabled. */
  BAD_ENTRY_SHORT_ROC_LOW_THRESHOLD_PCT?: number;
}

/** Order fill update shape used by comb-order-executor. */
export interface IOrderFillUpdate {
  updateTime: number;
  executionPrice: number;
}

export type CombClosedExitReason = "atr_trailing" | "signal_change" | "end" | "liquidation_exit" | "close_command" | "tp_pullback" | "minority_prevention" | "margin_stop_loss" | "bad_signal" | "hard_take_profit";

/** Event emitted by an instance so the general bot can notify the general channel. */
export type CombInstanceEvent =
  | { type: "position_opened"; position: IPosition; symbol: string }
  | {
    type: "position_closed";
    closedPosition: IPosition;
    exitReason: CombClosedExitReason;
    realizedPnl: number;
    /** Net PnL after fees (matches Total calculated PnL / wallet impact). */
    netPnl: number;
    symbol: string;
  };



export interface IOpenPositionMsgToCopyTrader {
  id: string;
  symbol: string;
  side: string;
  msgType: "OPEN_POSITION";
  timestamp: number;
}

export interface IClosePositionMsgToCopyTrader {
  id: string;
  symbol: string;
  msgType: "CLOSE_POSITION";
  timestamp: number;
}