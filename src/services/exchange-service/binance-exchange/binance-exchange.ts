import { USDMClient, WebsocketClient } from "binance";
import type { Kline, KlineInterval, SymbolLotSizeFilter, SymbolMarketLotSizeFilter } from "binance/lib/types/shared";
import type {
  FuturesSymbolExchangeInfo,
  FuturesSymbolMinNotionalFilter,
  NewFuturesOrderParams,
  FuturesPositionTrade,
} from "binance/lib/types/futures";
import type {
  IBalanceInfo,
  ICancelOrderResponse,
  ICandleInfo,
  IFeeRate,
  IGetPositionHistoryParams,
  IOrder,
  IPlaceOrderParams,
  IPlaceOrderResponse,
  IPosition,
  ISymbolInfo,
  ITrade,
  IWSOrderUpdate,
  TCandleResolution,
  TOrderSide,
  TOrderStatus,
  TOrderType,
  TPositionSide,
  TPositionType,
} from "../exchange-type";
import { generateRandomString } from "@/utils/strings.util";
import type { IExchangeInstance } from "../exchange-service";

type TPriceListener = (price: number) => void;
type TPriceTimestampListener = (price: number, timestamp: number) => void;

type TPositionMeta = {
  symbol: string;
  side: TPositionSide;
  leverage: number;
  marginMode: TPositionType;
  liquidationPrice: number;
  maintenanceMargin: number;
  initialMargin: number;
  notional: number;
  size: number;
  avgPrice: number;
  createTime: number;
};

class BinanceExchange implements IExchangeInstance {
  private _client: USDMClient;
  private _wsClient: WebsocketClient;
  private _symbols: string[];

  private _prices: Record<string, number> = {};
  private _subscribedSymbols: Record<string, boolean> = {};
  private _normalizedToOriginalSymbol: Record<string, string> = {};

  private _priceListenerCallbacks: Record<string, Record<string, TPriceListener>> = {};
  private _priceTimestampListenerCallbacks: Record<string, Record<string, TPriceTimestampListener>> = {};
  private _orderListenerCallbacks: Record<string, (order: IWSOrderUpdate) => void> = {};

  private _symbolSideToPositionId: Map<string, number> = new Map();
  private _positionMetaById: Map<number, TPositionMeta> = new Map();
  private _closedPositionMetaById: Map<number, TPositionMeta> = new Map();
  private _recentClosedPositions: Map<number, IPosition> = new Map();
  private _symbolInfoCache: Map<string, FuturesSymbolExchangeInfo> = new Map();
  private _exchangeInfoPromise?: Promise<void>;

  constructor(apiKey: string, secretKey: string, symbols: string[]) {
    this._symbols = symbols;

    this._client = new USDMClient({
      api_key: apiKey,
      api_secret: secretKey,
    });

    this._wsClient = new WebsocketClient({
      api_key: apiKey,
      api_secret: secretKey,
      beautify: true,
    });

    this._mapWsEvents();
  }

  async prepare(): Promise<void> {
    await Promise.all([
      ...this._symbols.map((symbol) => this._subscribeMarkPrice(symbol)),
      this._wsClient.subscribeUsdFuturesUserDataStream("usdm"),
    ]);
  }

  async getBalances(): Promise<IBalanceInfo[]> {
    const balances = await this._client.getBalanceV3();

    return balances.map((balance) => ({
      coin: balance.asset,
      free: Number(balance.availableBalance),
      frozen: Number(balance.balance) - Number(balance.availableBalance),
    }));
  }

  async getCandles(symbol: string, startDate: Date, endDate: Date, resolution: TCandleResolution): Promise<ICandleInfo[]> {
    const normalizedSymbol = this._normalizeSymbol(symbol);
    const interval = this._mapResolution(resolution);

    const klines = (await this._client.getKlines({
      symbol: normalizedSymbol,
      interval,
      startTime: startDate.getTime(),
      endTime: endDate.getTime(),
      limit: 1500,
    })) as Kline[];

    return klines.map(([openTime, openPrice, highPrice, lowPrice, closePrice]) => ({
      timestamp: openTime,
      openPrice: Number(openPrice),
      highPrice: Number(highPrice),
      lowPrice: Number(lowPrice),
      closePrice: Number(closePrice),
    }));
  }

  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    const normalizedSymbol = this._normalizeSymbol(symbol);
    await this._client.setLeverage({ symbol: normalizedSymbol, leverage });
    return true;
  }

  async getPosition(symbol: string): Promise<IPosition | undefined> {
    const normalizedSymbol = this._normalizeSymbol(symbol);
    const positions = await this._client.getPositionsV3({ symbol: normalizedSymbol });
    const position = positions.find((pos) => Math.abs(Number(pos.positionAmt)) > 0);

    if (!position) return undefined;

    return this._mapBinancePosition(position, symbol);
  }

  async getOpenedPositions(): Promise<IPosition[]> {
    const positions = await this._client.getPositionsV3();

    const mapped = positions
      .filter((pos) => Math.abs(Number(pos.positionAmt)) > 0)
      .map((pos) => {
        const originalSymbol = this._toOriginalSymbol(pos.symbol);
        return this._mapBinancePosition(pos, originalSymbol);
      })
      .filter((pos): pos is IPosition => !!pos);

    return mapped;
  }

  async getPositionsHistory(params: IGetPositionHistoryParams): Promise<IPosition[]> {
    const { positionId } = params;

    if (positionId) {
      const cached = this._recentClosedPositions.get(positionId);
      if (cached) return [cached];
      const reconstructed = await this._buildClosedPositionFromRest(positionId);
      return reconstructed ? [reconstructed] : [];
    }

    return Array.from(this._recentClosedPositions.values()).sort((a, b) => b.updateTime - a.updateTime);
  }

  async getMarkPrice(symbol: string): Promise<number> {
    await this._subscribeMarkPrice(symbol);

    while (typeof this._prices[symbol] !== "number") {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return this._prices[symbol];
  }

  async getSymbolInfo(symbol: string): Promise<ISymbolInfo> {
    const info = await this._getSymbolExchangeInfo(symbol);
    const lotSizeFilter = info.filters.find((filter): filter is SymbolLotSizeFilter => filter.filterType === "LOT_SIZE");
    const marketLotSizeFilter = info.filters.find(
      (filter): filter is SymbolMarketLotSizeFilter => filter.filterType === "MARKET_LOT_SIZE"
    );
    const minNotionalFilter = info.filters.find(
      (filter): filter is FuturesSymbolMinNotionalFilter => filter.filterType === "MIN_NOTIONAL"
    );

    return {
      pricePrecision: info.pricePrecision,
      basePrecision: info.quantityPrecision,
      minNotionalValue: Number(minNotionalFilter?.notional || 0),
      maxMktOrderQty: Number(marketLotSizeFilter?.maxQty || 0),
      maxLimitOrderQty: Number(lotSizeFilter?.maxQty || 0),
    };
  }

  async getFeeRate(symbol: string): Promise<IFeeRate> {
    const normalizedSymbol = this._normalizeSymbol(symbol);
    const feeInfo = await this._client.getAccountCommissionRate({ symbol: normalizedSymbol });

    return {
      symbol,
      takerFeeRate: feeInfo.takerCommissionRate.toString(),
      makerFeeRate: feeInfo.makerCommissionRate.toString(),
    };
  }

  async placeOrder(params: IPlaceOrderParams): Promise<IPlaceOrderResponse> {
    const normalizedSymbol = this._normalizeSymbol(params.symbol);

    const payload: NewFuturesOrderParams<number> = {
      symbol: normalizedSymbol,
      side: this._mapOrderSide(params.orderSide),
      type: this._mapOrderType(params.orderType),
      newClientOrderId: params.clientOrderId,
    };

    let orderQuantity = typeof params.baseAmt === "number" ? params.baseAmt : undefined;

    if (typeof orderQuantity !== "number" && typeof params.quoteAmt === "number") {
      const markPrice = await this.getMarkPrice(params.symbol);
      if (markPrice > 0) {
        orderQuantity = Number((params.quoteAmt / markPrice).toFixed(6));
      }
    }

    if (typeof orderQuantity === "number") {
      payload.quantity = orderQuantity;
    }

    if (typeof params.orderPrice === "number") {
      payload.price = params.orderPrice;
    }

    const response = await this._client.submitNewOrder(payload);

    return {
      orderId: response.orderId?.toString() || response.clientOrderId,
      clientOrderId: response.clientOrderId,
    };
  }

  async getActiveOrders(symbol: string): Promise<IOrder[]> {
    const normalizedSymbol = this._normalizeSymbol(symbol);
    const orders = await this._client.getAllOpenOrders({ symbol: normalizedSymbol });
    return orders.map((order) => this._mapOrder(order, symbol));
  }

  async getTradeList(symbol: string, clientOrderId: string): Promise<ITrade[]> {
    const normalizedSymbol = this._normalizeSymbol(symbol);

    const order = await this._client.getOrder({
      symbol: normalizedSymbol,
      origClientOrderId: clientOrderId,
    });

    const trades = await this._client.getAccountTrades({
      symbol: normalizedSymbol,
      orderId: order.orderId,
    });

    return trades.map((trade) => this._mapTrade(trade, symbol));
  }

  async getOrderDetail(symbol: string, clientOrderId: string): Promise<IOrder | undefined> {
    const normalizedSymbol = this._normalizeSymbol(symbol);
    const order = await this._client.getOrder({
      symbol: normalizedSymbol,
      origClientOrderId: clientOrderId,
    });

    if (!order) return undefined;

    return this._mapOrder(order, symbol);
  }

  async cancelOrder(symbol: string, clientOrderId: string): Promise<ICancelOrderResponse> {
    const normalizedSymbol = this._normalizeSymbol(symbol);
    const response = await this._client.cancelOrder({
      symbol: normalizedSymbol,
      origClientOrderId: clientOrderId,
    });

    return {
      isSuccess: true,
      canceledOrderId: response.orderId?.toString(),
      canceledClientOrderId: response.clientOrderId,
    };
  }

  hookPriceListener(symbol: string, callback: TPriceListener): () => void {
    const id = generateRandomString(4);
    if (!this._priceListenerCallbacks[symbol]) this._priceListenerCallbacks[symbol] = {};
    this._priceListenerCallbacks[symbol][id] = callback;

    void this._subscribeMarkPrice(symbol);

    return () => {
      delete this._priceListenerCallbacks[symbol][id];
    };
  }

  hookPriceListenerWithTimestamp(symbol: string, callback: TPriceTimestampListener): () => void {
    const id = generateRandomString(4);
    if (!this._priceTimestampListenerCallbacks[symbol]) this._priceTimestampListenerCallbacks[symbol] = {};
    this._priceTimestampListenerCallbacks[symbol][id] = callback;

    void this._subscribeMarkPrice(symbol);

    return () => {
      delete this._priceTimestampListenerCallbacks[symbol][id];
    };
  }

  hookOrderListener(callback: (order: IWSOrderUpdate) => void): () => void {
    const id = generateRandomString(4);
    this._orderListenerCallbacks[id] = callback;

    return () => {
      delete this._orderListenerCallbacks[id];
    };
  }

  private async _subscribeMarkPrice(symbol: string): Promise<void> {
    if (this._subscribedSymbols[symbol]) return;
    this._subscribedSymbols[symbol] = true;

    const normalizedSymbol = this._normalizeSymbol(symbol);
    await this._wsClient.subscribeMarkPrice(normalizedSymbol, "usdm", 1000);
  }

  private _normalizeSymbol(symbol: string): string {
    const normalized = symbol.replace(/[_\s-]/g, "").toUpperCase();
    if (!this._normalizedToOriginalSymbol[normalized]) {
      this._normalizedToOriginalSymbol[normalized] = symbol;
    }
    return normalized;
  }

  private _toOriginalSymbol(normalized: string): string {
    return this._normalizedToOriginalSymbol[normalized] || normalized;
  }

  private _mapResolution(resolution: TCandleResolution): KlineInterval {
    const mapping: Record<TCandleResolution, KlineInterval> = {
      "1Min": "1m",
      "3Min": "3m",
      "5Min": "5m",
      "15Min": "15m",
      "30Min": "30m",
      "60Min": "1h",
      "4Hour": "4h",
      "8Hour": "8h",
      "1Day": "1d",
      "1Week": "1w",
      "1Month": "1M",
    };

    return mapping[resolution];
  }

  private _mapBinancePosition(position: any, originalSymbol: string): IPosition | undefined {
    const size = Math.abs(Number(position.positionAmt));
    if (!size) return undefined;

    const side: TPositionSide = position.positionSide?.toLowerCase() === "short" ? "short" : "long";
    const notional = Math.abs(Number(position.notional));
    const initialMargin = Number(position.initialMargin || position.positionInitialMargin || 0);
    const leverage = initialMargin ? Math.abs(notional / initialMargin) : 0;
    const marginMode: TPositionType = Number(position.isolatedMargin) > 0 ? "isolated" : "cross";

    const key = this._symbolSideKey(originalSymbol, side);
    let id = this._symbolSideToPositionId.get(key);
    if (!id) {
      id = Date.now();
      this._symbolSideToPositionId.set(key, id);
    }

    const mapped: IPosition = {
      id,
      symbol: originalSymbol,
      size,
      side,
      notional,
      leverage,
      unrealizedPnl: Number(position.unRealizedProfit || 0),
      realizedPnl: 0,
      avgPrice: Number(position.entryPrice),
      closePrice: undefined,
      liquidationPrice: Number(position.liquidationPrice || 0),
      maintenanceMargin: Number(position.maintMargin || 0),
      initialMargin,
      marginMode,
      createTime: position.updateTime,
      updateTime: position.updateTime,
    };

    this._positionMetaById.set(id, {
      symbol: originalSymbol,
      side,
      leverage,
      marginMode,
      liquidationPrice: mapped.liquidationPrice,
      maintenanceMargin: mapped.maintenanceMargin,
      initialMargin,
      notional,
      size,
      avgPrice: mapped.avgPrice,
      createTime: mapped.createTime,
    });

    return mapped;
  }

  private _mapOrderSide(side: TOrderSide): "BUY" | "SELL" {
    return side === "buy" ? "BUY" : "SELL";
  }

  private _mapOrderType(type: TOrderType) {
    return type === "market" ? "MARKET" : "LIMIT";
  }

  private _mapOrderStatus(status: string): TOrderStatus {
    const map: Record<string, TOrderStatus> = {
      NEW: "open",
      PARTIALLY_FILLED: "partially_filled",
      FILLED: "filled",
      CANCELED: "canceled",
      REJECTED: "canceled",
      EXPIRED: "canceled",
      EXPIRED_IN_MATCH: "canceled",
    };

    return map[status] || "unknown";
  }

  private _mapOrder(order: any, originalSymbol: string): IOrder {
    return {
      id: order.orderId?.toString() || order.clientOrderId,
      symbol: originalSymbol,
      clientOrderId: order.clientOrderId,
      status: this._mapOrderStatus(order.status || order.orderStatus),
      type: order.type?.toLowerCase() as TOrderType || "limit",
      side: (order.side?.toLowerCase() || "buy") as TOrderSide,
      avgPrice: Number(order.avgPrice || order.price || 0),
      orderQuantity: Number(order.origQty || order.quantity || 0),
      execQty: Number(order.executedQty || order.executedQuantity || 0),
      execValue: Number(order.cumQuote || order.cumulativeQuote || 0),
      fee: {
        currency: order.commissionAsset || "USDT",
        amt: Number(order.commission || 0),
      },
      createdTs: order.updateTime || order.time || Date.now(),
    };
  }

  private _mapTrade(trade: any, originalSymbol: string): ITrade {
    return {
      quantity: Number(trade.qty),
      id: trade.id.toString(),
      orderId: trade.orderId.toString(),
      price: Number(trade.price),
      timestamp: trade.time,
      side: trade.side?.toLowerCase() as TOrderSide,
      symbol: originalSymbol,
      takerOrMaker: trade.maker ? "maker" : "taker",
      cost: Number(trade.quoteQty),
      fee: {
        currency: trade.commissionAsset,
        amt: Number(trade.commission),
      },
    };
  }

  private _mapWsEvents() {
    this._wsClient.on("formattedMessage", (event: any) => {
      if (!event?.eventType) return;

      if (event.eventType === "markPriceUpdate") {
        this._handleMarkPriceEvent(event);
      } else if (event.eventType === "ORDER_TRADE_UPDATE") {
        this._handleOrderTradeEvent(event);
      }
    });
  }

  private _handleMarkPriceEvent(event: any) {
    const originalSymbol = this._toOriginalSymbol(event.symbol);
    const markPrice = Number(event.markPrice);
    this._prices[originalSymbol] = markPrice;

    const timestamp = event.eventTime || Date.now();

    if (this._priceListenerCallbacks[originalSymbol]) {
      Object.values(this._priceListenerCallbacks[originalSymbol]).forEach((callback) => callback(markPrice));
    }

    if (this._priceTimestampListenerCallbacks[originalSymbol]) {
      Object.values(this._priceTimestampListenerCallbacks[originalSymbol]).forEach((callback) => callback(markPrice, timestamp));
    }
  }

  private _handleOrderTradeEvent(event: any) {
    const order = event.order;
    if (!order) return;

    const originalSymbol = this._toOriginalSymbol(order.symbol);
    const positionSide: TPositionSide = order.positionSide?.toLowerCase() === "short" ? "short" : "long";
    const key = this._symbolSideKey(originalSymbol, positionSide);
    const positionId = this._symbolSideToPositionId.get(key);

    const update: IWSOrderUpdate = {
      orderId: order.orderId.toString(),
      clientOrderId: order.clientOrderId,
      orderStatus: this._mapOrderStatus(order.orderStatus),
    };

    Object.values(this._orderListenerCallbacks).forEach((callback) => callback(update));

    if (!positionId) return;

    const meta = this._positionMetaById.get(positionId);
    if (!meta) return;

    const isClosingOrder =
      order.isReduceOnly ||
      (meta.side === "long" && order.orderSide === "SELL") ||
      (meta.side === "short" && order.orderSide === "BUY");

    if (!isClosingOrder || order.orderStatus !== "FILLED") return;

    const closedPosition: IPosition = {
      id: positionId,
      symbol: meta.symbol,
      size: meta.size,
      side: meta.side,
      notional: meta.notional,
      leverage: meta.leverage,
      unrealizedPnl: 0,
      realizedPnl: Number(order.realisedProfit || 0),
      avgPrice: Number(order.averagePrice || order.lastFilledPrice || meta.avgPrice),
      closePrice: Number(order.averagePrice || order.lastFilledPrice || meta.avgPrice),
      liquidationPrice: meta.liquidationPrice,
      maintenanceMargin: meta.maintenanceMargin,
      initialMargin: meta.initialMargin,
      marginMode: meta.marginMode,
      createTime: meta.createTime,
      updateTime: order.orderTradeTime || Date.now(),
    };

    this._recentClosedPositions.set(positionId, closedPosition);
    this._trimClosedPositionsCache();

    this._symbolSideToPositionId.delete(key);
    const metaSnapshot = { ...meta };
    this._positionMetaById.delete(positionId);
    this._closedPositionMetaById.set(positionId, metaSnapshot);
  }

  private _trimClosedPositionsCache() {
    const MAX_CACHE = 100;
    if (this._recentClosedPositions.size <= MAX_CACHE) return;

    const sortedKeys = Array.from(this._recentClosedPositions.values())
      .sort((a, b) => b.updateTime - a.updateTime)
      .map((pos) => pos.id);

    while (this._recentClosedPositions.size > MAX_CACHE) {
      const key = sortedKeys.pop();
      if (typeof key === "number") {
        this._recentClosedPositions.delete(key);
      } else {
        break;
      }
    }
  }

  private _symbolSideKey(symbol: string, side: TPositionSide): string {
    return `${symbol.toUpperCase()}::${side}`;
  }

  private async _getSymbolExchangeInfo(symbol: string): Promise<FuturesSymbolExchangeInfo> {
    const normalizedSymbol = this._normalizeSymbol(symbol);
    if (this._symbolInfoCache.has(normalizedSymbol)) {
      return this._symbolInfoCache.get(normalizedSymbol)!;
    }

    if (!this._exchangeInfoPromise) {
      this._exchangeInfoPromise = this._client.getExchangeInfo().then((info) => {
        info.symbols.forEach((item) => {
          this._symbolInfoCache.set(item.symbol, item);
        });
      });
    }

    await this._exchangeInfoPromise;
    const cached = this._symbolInfoCache.get(normalizedSymbol);
    if (!cached) throw new Error(`No exchange info found for ${symbol}`);
    return cached;
  }

  private async _buildClosedPositionFromRest(positionId: number): Promise<IPosition | undefined> {
    const meta = this._closedPositionMetaById.get(positionId) || this._positionMetaById.get(positionId);
    if (!meta) return undefined;

    const normalizedSymbol = this._normalizeSymbol(meta.symbol);
    const trades = await this._client.getAccountTrades({
      symbol: normalizedSymbol,
      limit: 50,
      startTime: meta.createTime,
    });

    const relevantTrades = trades
      .filter((trade: FuturesPositionTrade) => {
        if (!trade.positionSide || trade.positionSide === "BOTH") return true;
        return trade.positionSide.toLowerCase() === meta.side;
      })
      .sort((a, b) => a.time - b.time);

    if (!relevantTrades.length) return undefined;

    const realizedPnl = relevantTrades.reduce((sum, trade) => sum + Number(trade.realizedPnl || 0), 0);
    const finalTrade = relevantTrades[relevantTrades.length - 1];
    const closePrice = Number(finalTrade.price);

    const closedPosition: IPosition = {
      id: positionId,
      symbol: meta.symbol,
      size: meta.size,
      side: meta.side,
      notional: meta.notional,
      leverage: meta.leverage,
      unrealizedPnl: 0,
      realizedPnl,
      avgPrice: meta.avgPrice,
      closePrice,
      liquidationPrice: meta.liquidationPrice,
      maintenanceMargin: meta.maintenanceMargin,
      initialMargin: meta.initialMargin,
      marginMode: meta.marginMode,
      createTime: meta.createTime,
      updateTime: finalTrade.time,
    };

    this._recentClosedPositions.set(positionId, closedPosition);
    this._trimClosedPositionsCache();
    this._closedPositionMetaById.set(positionId, meta);

    return closedPosition;
  }
}

export default BinanceExchange;

