import type { IOrder, IPosition, TPositionSide } from "@/services/exchange-service/exchange-type";

/** Action types persisted for Trail Multiplier Optimization Bot. */
export const TMOB_ACTION_TYPE = {
  STARTING: "STARTING",
  WAITING_FOR_SIGNAL: "WAITING_FOR_SIGNAL",
  ENTERED_POSITION: "ENTERED_POSITION",
  CLOSED_POSITION: "CLOSED_POSITION",
  TRAIL_MULTIPLIER_OPTIMIZED: "TRAIL_MULTIPLIER_OPTIMIZED",
  RESTARTING: "RESTARTING",
  ERROR: "ERROR",
} as const;

export type TMOBActionType = (typeof TMOB_ACTION_TYPE)[keyof typeof TMOB_ACTION_TYPE];

/**
 * Snapshot of the bot state at the time of an action.
 * Stored in meta.botState so we know exactly the current bot state on each action.
 */
export interface TMOBBotStateSnapshot {
  currentState: string;
  runId: string;
  runStartTs?: string;
  symbol: string;
  leverage: number;
  margin: number;
  startQuoteBalance?: string;
  currQuoteBalance?: string;
  totalActualCalculatedProfit: number;
  numberOfTrades: number;
  trailingStopMultiplier: number;
  currTrailMultiplier?: number;
  longTrigger: number | null;
  shortTrigger: number | null;
  lastEntryTime: number;
  lastExitTime: number;
  currActivePositionId?: number;
  hasEntryWsPrice: boolean;
  hasResolveWsPrice: boolean;
}

/** Serializable order snapshot for persistence. */
export interface TMOBOrderSnapshot {
  id: string;
  symbol: string;
  clientOrderId: string;
  status: string;
  type: string;
  side: string;
  avgPrice: number;
  orderQuantity: number;
  execQty: number;
  execValue: number;
  fee: { currency: string; amt: number };
  createdTs: number;
  updateTs: number;
}

/** Serializable position snapshot for persistence. */
export interface TMOBPositionSnapshot {
  id: number;
  symbol: string;
  size: number;
  side: TPositionSide;
  notional: number;
  leverage: number;
  unrealizedPnl: number;
  realizedPnl: number;
  avgPrice: number;
  closePrice?: number;
  liquidationPrice: number;
  maintenanceMargin: number;
  initialMargin: number;
  marginMode: string;
  createTime: number;
  updateTime: number;
}

export interface TMOBEnteredPositionActionData {
  order: TMOBOrderSnapshot | null;
  position: TMOBPositionSnapshot;
  entryWsPrice?: { price: number; time: string };
}

export type TMOBExitReason = "atr_trailing" | "signal_change" | "end" | "liquidation_exit";

export interface TMOBClosedPositionActionData {
  order: TMOBOrderSnapshot | null;
  position: TMOBPositionSnapshot;
  exitReason?: TMOBExitReason;
  isLiquidation?: boolean;
  triggerTimestamp?: number;
  fillTimestamp?: number;
  entryWsPrice?: { price: number; time: string };
}

export interface TMOBErrorActionData {
  message: string;
  context?: string;
  stack?: string;
  [key: string]: unknown;
}

/** Build a serializable order snapshot from IOrder. */
export function orderToSnapshot(order: IOrder | undefined | null): TMOBOrderSnapshot | null {
  if (!order) return null;
  return {
    id: order.id,
    symbol: order.symbol,
    clientOrderId: order.clientOrderId,
    status: order.status,
    type: order.type,
    side: order.side,
    avgPrice: order.avgPrice,
    orderQuantity: order.orderQuantity,
    execQty: order.execQty,
    execValue: order.execValue,
    fee: order.fee ? { currency: order.fee.currency, amt: order.fee.amt } : { currency: "", amt: 0 },
    createdTs: order.createdTs,
    updateTs: order.updateTs,
  };
}

/** Build a serializable position snapshot from IPosition. */
export function positionToSnapshot(position: IPosition): TMOBPositionSnapshot {
  return {
    id: position.id,
    symbol: position.symbol,
    size: position.size,
    side: position.side,
    notional: position.notional,
    leverage: position.leverage,
    unrealizedPnl: position.unrealizedPnl,
    realizedPnl: position.realizedPnl,
    avgPrice: position.avgPrice,
    closePrice: position.closePrice,
    liquidationPrice: position.liquidationPrice,
    maintenanceMargin: position.maintenanceMargin,
    initialMargin: position.initialMargin,
    marginMode: position.marginMode,
    createTime: position.createTime,
    updateTime: position.updateTime,
  };
}
