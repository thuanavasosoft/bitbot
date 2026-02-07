export type Side = "long" | "short";

export type Candle = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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

export type PnlHistoryPoint = {
  timestamp: string;
  timestampMs: number;
  side: Side;
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

export type BacktestRunSummary = {
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
  pnlHistory: PnlHistoryPoint[];
  dailyPnL: number;
  projectedYearlyPnL: number;
  apyPercent: number;
  sharpeRatio: number;
  slippageAccumulation?: number;
};
