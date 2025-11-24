import type { IBalanceInfo, ICancelOrderResponse, ICandleInfo, IFeeRate, IGetPositionHistoryParams, IOrder, IPlaceOrderParams, IPlaceOrderResponse, IPosition, ISymbolInfo, ITrade, IWSOrderUpdate, TCandleResolution } from "./exchange-type";
import MexcExchange from "./mexc-exchange/mexc-exchange";
import BinanceExchange from "./binance-exchange/binance-exchange";


export interface IExchangeInstance {
  prepare: () => Promise<void>;
  getBalances: () => Promise<IBalanceInfo[]>,
  getCandles: (symbol: string, startDate: Date, endDate: Date, resolution: TCandleResolution) => Promise<ICandleInfo[]>
  setLeverage: (symbol: string, leverage: number) => Promise<boolean>,
  getPosition: (symbol: string) => Promise<IPosition | undefined>
  getOpenedPositions: () => Promise<IPosition[] | undefined>
  getPositionsHistory: (params: IGetPositionHistoryParams) => Promise<IPosition[]>
  getMarkPrice: (symbol: string) => Promise<number>
  getSymbolInfo: (symbol: string) => Promise<ISymbolInfo>;
  getFeeRate: (symbol: string) => Promise<IFeeRate>
  placeOrder: (params: IPlaceOrderParams) => Promise<IPlaceOrderResponse>;
  getActiveOrders: (symbol: string) => Promise<IOrder[]>;
  getTradeList: (symbol: string, clientOrderId: string) => Promise<ITrade[]>;
  getOrderDetail: (symbol: string, clientOrderId: string) => Promise<IOrder | undefined>;
  cancelOrder(symbol: string, clientOrderId: string): Promise<ICancelOrderResponse>;
  hookPriceListener: (symbol: string, callback: (price: number) => void) => () => void;
  hookPriceListenerWithTimestamp: (symbol: string, callback: (price: number, timestamp: number) => void) => () => void;
  hookOrderListener: (callback: (order: IWSOrderUpdate) => void) => () => void;
}

class ExchangeService {
  private static exchangeInstance: IExchangeInstance;

  static async configure(exchange: number, apiKey: string, secretKey: string, symbols: string[]) {
    if (exchange === 1) {
      this.exchangeInstance = new MexcExchange(apiKey, secretKey, symbols);
      await this.exchangeInstance.prepare()
    } else if (exchange === 2) {
      this.exchangeInstance = new BinanceExchange(apiKey, secretKey, symbols);
      await this.exchangeInstance.prepare();
    }
  }

  static async getBalances(): Promise<IBalanceInfo[]> {
    return await this.exchangeInstance.getBalances();
  }

  static async getCandles(symbol: string, startDate: Date, endDate: Date, resolution: TCandleResolution): Promise<ICandleInfo[]> {
    return await this.exchangeInstance.getCandles(symbol, startDate, endDate, resolution);
  }

  static async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    return await this.exchangeInstance.setLeverage(symbol, leverage);
  }

  static async getPosition(symbol: string): Promise<IPosition | undefined> {
    return await this.exchangeInstance.getPosition(symbol);
  }

  static async getOpenedPositions(): Promise<IPosition[] | undefined> {
    return await this.exchangeInstance.getOpenedPositions();
  }

  static async getPositionsHistory(params: IGetPositionHistoryParams): Promise<IPosition[]> {
    return await this.exchangeInstance.getPositionsHistory(params);
  }

  static async getMarkPrice(symbol: string): Promise<number> {
    return await this.exchangeInstance.getMarkPrice(symbol)
  }

  static async getFeeRate(symbol: string): Promise<IFeeRate> {
    return await this.exchangeInstance.getFeeRate(symbol);
  }

  static async placeOrder(params: IPlaceOrderParams): Promise<IPlaceOrderResponse> {
    return await this.exchangeInstance.placeOrder(params);
  }

  static async getSymbolInfo(symbol: string): Promise<ISymbolInfo> {
    return await this.exchangeInstance.getSymbolInfo(symbol);
  }

  static async getActiveOrders(symbol: string): Promise<IOrder[]> {
    return await this.exchangeInstance.getActiveOrders(symbol);
  }

  static async getOrderDetail(symbol: string, clientOrderId: string): Promise<IOrder | undefined> {
    return await this.exchangeInstance.getOrderDetail(symbol, clientOrderId);
  }

  static async getTradeList(symbol: string, clientOrderId: string): Promise<ITrade[]> {
    return await this.exchangeInstance.getTradeList(symbol, clientOrderId);
  }

  static async cancelOrder(symbol: string, clientOrderId: string): Promise<ICancelOrderResponse> {
    return await this.exchangeInstance.cancelOrder(symbol, clientOrderId);
  }

  static hookPriceListener(symbol: string, callback: (price: number) => void): () => void {
    return this.exchangeInstance.hookPriceListener(symbol, callback);
  }

  static hookPriceListenerWithTimestamp(symbol: string, callback: (price: number, timestamp: number) => void): () => void {
    return this.exchangeInstance.hookPriceListenerWithTimestamp(symbol, callback);
  }

  static hookOrderListener(callback: (item: IWSOrderUpdate) => void): () => void {
    return this.exchangeInstance.hookOrderListener(callback);
  }
}

export default ExchangeService;