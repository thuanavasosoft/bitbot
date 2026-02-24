export type TOrderStatus = 'open' | 'partially_filled' | 'partially_filled_canceled' | 'filled' | 'canceled' | 'unknown';
export type TOrderType = "market" | "limit";
export type TOrderSide = "buy" | "sell";

export interface IWSTradeTick {
  id: string;
  symbol: string;
  price: number;
  quantity: number;
  side: TOrderSide;
  timestamp: number;
}

export interface IPlaceOrderParams {
  symbol: string;
  clientOrderId: string;
  orderType: TOrderType;
  orderSide: TOrderSide;
  baseAmt?: number;
  quoteAmt?: number;
  orderPrice?: number;
}

export interface IPlaceOrderResponse {
  orderId: string;
  clientOrderId: string;
}

export interface IOrder {
  id: string;
  symbol: string;
  clientOrderId: string;
  status: TOrderStatus;
  type: TOrderType;
  side: TOrderSide
  avgPrice: number;
  orderQuantity: number;
  execQty: number;
  execValue: number;
  fee: IFee;
  createdTs: number;
  updateTs: number;
}

export interface ITrade {
  quantity: number;
  id: string;
  orderId: string;
  price: number;
  timestamp: number;
  type?: TOrderType;
  side: TOrderSide;
  symbol: string;
  takerOrMaker: 'taker' | 'maker';
  cost: number;
  fee: IFee;
}

export interface IFee {
  currency: string;
  amt: number;
}

export interface ICancelOrderResponse {
  isSuccess: boolean;
  description?: string;
  canceledOrderId?: string;
  canceledClientOrderId?: string;
}

export interface ICandleInfo {
  timestamp: number,
  openTime: number,
  closeTime: number,
  openPrice: number,
  highPrice: number,
  lowPrice: number,
  closePrice: number,
  volume: number
}

export interface IBalanceInfo {
  coin: string,
  free: number,
  frozen: number,
}

export type TCandleResolution =
  | "1Min"
  | "3Min"
  | "5Min"
  | "15Min"
  | "30Min"
  | "60Min"
  | "4Hour"
  | "8Hour"
  | "1Day"
  | "1Week"
  | "1Month";

export type TPositionSide = "long" | "short";
export type TPositionType = "isolated" | "cross";

export interface IPosition {
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

export interface ISymbolInfo {
  pricePrecision: number;
  basePrecision: number;
  quotePrecision: number;
  minNotionalValue: number;
  maxMktOrderQty: number;
  maxLimitOrderQty: number;
}

export interface IGetPositionHistoryParams {
  symbol?: string;
  page?: number, // Better not pass this from outside this meant to used as recursive helper
  limit?: number, // Better not pass this from outside this meant to used as recursive helper
  positionId?: number,
}

export interface IFeeRate {
  symbol: string
  takerFeeRate: string
  makerFeeRate: string
}

export interface IWSOrderUpdate {
  orderId: string;
  clientOrderId: string;
  orderStatus: TOrderStatus;
  symbol?: string;
  positionSide?: TPositionSide;
  realizedPnl?: number;
  executionPrice?: number;
  updateTime?: number;
}

/** Force order (liquidation or ADL auto-close) */
export interface IForceOrder {
  orderId: number;
  symbol: string;
  status: TOrderStatus;
  clientOrderId: string;
  side: TOrderSide;
  avgPrice: number;
  executedQty: number;
  cumQuote: number;
  time: number;
  updateTime: number;
}