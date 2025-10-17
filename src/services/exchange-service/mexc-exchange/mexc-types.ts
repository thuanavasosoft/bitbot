export interface IMexcApiResponse<T> {
  success: boolean,
  code: number,
  data: T,
}

export interface IMexcGetBalanceResp {
  currency: string,
  positionMargin: number,
  availableBalance: number,
  cashBalance: number,
  frozenBalance: number,
  equity: number,
  unrealized: number,
  bonus: number,
  availableCash: number,
  availableOpen: number,
}

export interface IMexcSetLeverageParams {
  positionId?: number // required:	true,	position id
  leverage: number // required:	true,	leverage
  symbol: string // required:	true,	equired when there is no position，symbol
  openType?: number // required:	false,	Required when there is no position, openType, 1: isolated position, 2: full position
  positionType?: number // required:	false,	equired when there is no position, positionType: number // 1 Long 2:short
}

export type TMexcKlineResolution =
  | "Min1"
  | "Min5"
  | "Min15"
  | "Min30"
  | "Min60"
  | "Hour4"
  | "Hour8"
  | "Day1"
  | "Week1"
  | "Month1";

export interface IMexcKlineResponse {
  open: number[],
  close: number[],
  high: number[],
  low: number[],
  time: number[],
}

export interface IMexcPosition {
  positionId: 877186169,
  symbol: string,
  positionType: number // 1,
  openType: number // 1,
  state: number // 1,
  holdVol: number // 18,
  frozenVol: number // 0,
  closeVol: number // 0,
  holdAvgPrice: number // 107626.4,
  holdAvgPriceFullyScale: string,
  openAvgPrice: number // 107626.4,
  openAvgPriceFullyScale: string,
  closeAvgPrice: number // 0,
  liquidatePrice: number // 96967.1,
  oim: number // 19.450243008,
  im: number // 19.450243008,
  holdFee: number // 0,
  realised: number // -0.0774,
  leverage: number // 10,
  marginRatio: number // 0.0139,
  createTime: number // 1748498495030,
  updateTime: number // 1748498495030,
  autoAddIm: boolean // false,
  version: number // 1,
  profitRatio: number // 0,
  newOpenAvgPrice: number // 107626.4,
  newCloseAvgPrice: number // 0,
  closeProfitLoss: number // 0,
  fee: number // -0.0774,
  deductFeeList: [],
  totalFee: number // 0.0774,
  zeroSaveTotalFeeBinance: number // 0,
  zeroTradeTotalFeeBinance: number // 0.0774,
}

export interface IMexcWSTickerMessage {
  symbol: string;
  data: {
    symbol: string;
    lastPrice: number;
    riseFallRate: number;
    fairPrice: number;
    indexPrice: number;
    volume24: number;
    amount24: number;
    maxBidPrice: number;
    minAskPrice: number;
    lower24Price: number;
    high24Price: number;
    timestamp: number;
    bid1: number;
    ask1: number;
    holdVol: number;
    riseFallValue: number;
    fundingRate: number;
    zone: string;
    riseFallRates: number[];
    riseFallRatesOfTimezone: number[];
  };
  channel: "push.ticker";
  ts: number;
}

export type IWSMessageData =
  | IMexcWSTickerMessage
