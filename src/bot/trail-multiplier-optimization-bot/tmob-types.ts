import { ICandleInfo } from "@/services/exchange-service/exchange-type";
import { Side } from "../auto-adjust-bot/types";

export type TMOBRefTracePoint = {
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

export type TMOBBacktestRunSummary = {
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
  pnlHistory: TMOBPnlHistoryPoint[];
  dailyPnL: number;
  projectedYearlyPnL: number;
  apyPercent: number;
  sharpeRatio: number;
};


export type TMOBPnlHistoryPoint = {
  timestamp: string; // ISO string of timestamp
  timestampMs: number; // ms (position close timestamp)
  side: "long" | "short";
  totalPnL: number; // cumulative after fees
  entryTimestamp: string | null;
  entryTimestampMs: number | null;
  entryFillPrice: number | null;
  exitTimestamp: string;
  exitTimestampMs: number;
  exitFillPrice: number;
  tradePnL: number;
  exitReason: "atr_trailing" | "signal_change" | "end" | "liquidation_exit";
};

export type TMOBRunBacktestArgs = {
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
  signalParams: SignalParams;
  tickSize?: number;
  pricePrecision?: number;
};

export interface TMOBSignalParams {
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
export interface TMOBSignalResult {
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

export type TMOBRefPosition = { side: Side; entryPrice: number } | null;

export type TMOBRefPnlPoint = {
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
  exitReason: "atr_trailing" | "signal_change" | "end" | "liquidation_exit";
};

export type TMOBRefEvent =
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

export type TMOBRefStrategyConfig = {
  margin: number;
  leverage: number;
  tickSize: number;
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
};

export type SignalParams = {
  N: number;
  atr_len?: number;
  K?: number;
  eps?: number;
  m_atr?: number;
  roc_min?: number;
  ema_period?: number;
  need_two_closes?: boolean;
  vol_mult?: number;
};