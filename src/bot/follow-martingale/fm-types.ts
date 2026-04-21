import type { IPosition, TPositionSide } from "@/services/exchange-service/exchange-type";

export type FMSide = "long" | "short";

export type FMCloseReason =
  | "tp_limit"
  | "stop_loss"
  | "manual_close"
  | "end"
  | "liquidation_exit";

export interface FMLeg {
  index: number;
  baseQty: number;
  entryPrice: number;
  enteredAtMs: number;
  clientOrderId: string;
}

export interface FMTradeFill {
  price: number;
  time: Date;
}

export interface FMState {
  onEnter(): Promise<void>;
  onExit(): Promise<void>;
}

export interface FMTradeMetrics {
  closedPositionId?: number;
  grossPnl?: number;
  feeEstimate?: number;
  netPnl?: number;
  balanceDelta?: number;
}

export interface FMPnlHistoryPoint {
  timestamp: string;
  timestampMs: number;
  side: TPositionSide;
  totalPnL: number;
  entryTimestamp: string | null;
  entryTimestampMs: number | null;
  entryFillPrice: number | null;
  exitTimestamp: string;
  exitTimestampMs: number;
  exitFillPrice: number;
  tradePnL: number;
  exitReason: FMCloseReason;
}

export interface FMPositionSnapshot {
  position: IPosition;
  triggerTimestamp: number;
  fillTimestamp: number;
  exitReason: FMCloseReason;
  isLiquidation: boolean;
  slippage?: number;
  slippageIcon?: string;
  slippageTimeDiffMs?: number;
}
