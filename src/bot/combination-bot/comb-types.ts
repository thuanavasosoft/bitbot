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
  exitReason: "atr_trailing" | "signal_change" | "end" | "liquidation_exit";
};

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
  eps?: number;
  m_atr?: number;
  roc_min?: number;
  ema_period?: number;
  need_two_closes?: boolean;
  vol_mult?: number;
}

export interface CombSignalResult {
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
}

/** Order fill update shape used by comb-order-executor. */
export interface IOrderFillUpdate {
  updateTime: number;
  executionPrice: number;
}

/** Event emitted by an instance so the general bot can notify the general channel. */
export type CombInstanceEvent =
  | { type: "position_opened"; position: IPosition; symbol: string }
  |     {
      type: "position_closed";
      closedPosition: IPosition;
      exitReason: "atr_trailing" | "signal_change" | "end" | "liquidation_exit";
      realizedPnl: number;
      /** Net PnL after fees (matches Total calculated PnL / wallet impact). */
      netPnl: number;
      symbol: string;
    };
