import crypto from "crypto";
import WebSocket from "ws";
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

type KrakenInstrument = {
  symbol: string;
  type?: string;
  tickSize?: number;
  contractSize?: number;
  minimumTradeSize?: number;
  maxPositionSize?: number;
  contractValueTradePrecision?: number;
};

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

type KrakenOrderStatusPayload = {
  order?: any;
  status?: string;
  updateReason?: string;
};

class KrakenExchange implements IExchangeInstance {
  private static readonly REST_BASE = "https://futures.kraken.com";
  private static readonly REST_PREFIX = "/derivatives/api/v3";
  private static readonly WS_URL = "wss://futures.kraken.com/ws/v1";

  private _apiKey: string;
  private _apiSecret: string;
  private _symbols: string[];

  private _publicWs?: WebSocket;
  private _privateWs?: WebSocket;
  private _publicWsReady = false;
  private _privateWsReady = false;
  private _pendingPublicSubscriptions: string[] = [];
  private _pendingPrivateFeeds: string[] = [];

  private _prices: Record<string, number> = {};
  private _subscribedSymbols: Record<string, boolean> = {};
  private _normalizedToOriginalSymbol: Record<string, string> = {};

  private _priceListenerCallbacks: Record<string, Record<string, TPriceListener>> = {};
  private _priceTimestampListenerCallbacks: Record<string, Record<string, TPriceTimestampListener>> = {};
  private _orderListenerCallbacks: Record<string, (order: IWSOrderUpdate) => void> = {};

  private _instrumentByNormalized: Map<string, KrakenInstrument> = new Map();
  private _instrumentBySymbol: Map<string, KrakenInstrument> = new Map();
  private _instrumentSymbolToOriginal: Map<string, string> = new Map();
  private _exchangeInfoPromise?: Promise<void>;

  private _symbolSideToPositionId: Map<string, number> = new Map();
  private _positionMetaById: Map<number, TPositionMeta> = new Map();
  private _closedPositionMetaById: Map<number, TPositionMeta> = new Map();
  private _recentClosedPositions: Map<number, IPosition> = new Map();

  private _trackedClientOrderIds = new Set<string>();
  private _orderPoller?: NodeJS.Timeout;
  private _lastOrderStatusByClientId = new Map<string, TOrderStatus>();
  private _orderFillsByOrderId = new Map<string, { avgPrice: number; qty: number; timestamp: number }>();

  private _wsChallenge?: string;
  private _wsSignedChallenge?: string;

  constructor(apiKey: string, secretKey: string, symbols: string[]) {
    this._apiKey = apiKey;
    this._apiSecret = secretKey;
    this._symbols = symbols;
  }

  async generateClientOrderId(): Promise<string> {
    return `kb-${generateRandomString(18)}`;
  }

  async prepare(): Promise<void> {
    await this._ensureInstrumentCache();
    this._connectPublicWs();
    this._connectPrivateWs();

    await Promise.all(
      this._symbols.map(async (symbol) => {
        const instrument = await this._resolveInstrument(symbol);
        this._instrumentSymbolToOriginal.set(instrument.symbol, symbol);
        return this._subscribeTicker(symbol);
      })
    );
  }

  async getBalances(): Promise<IBalanceInfo[]> {
    const data = await this._privateRequest("GET", "/accounts");

    if (data?.result === "error") {
      const detail = data?.error ?? data?.message ?? "unknown";
      throw new Error(`[KrakenExchange] getBalances failed: ${detail}`);
    }

    const accounts = data?.accounts ?? data?.result?.accounts ?? {};
    const balanceMap = new Map<string, IBalanceInfo>();

    const upsertBalance = (coin: string, free: number, frozen: number) => {
      const key = coin.toUpperCase();
      const existing = balanceMap.get(key);
      if (existing) {
        existing.free += free;
        existing.frozen += frozen;
      } else {
        balanceMap.set(key, { coin: key, free, frozen });
      }
    };

    if (Array.isArray(accounts)) {
      accounts.forEach((account: any) => {
        const currency =
          account?.currency ??
          account?.asset ??
          account?.collateralCurrency ??
          account?.unit ??
          account?.symbol ??
          account?.account;
        if (!currency) return;
        const available = Number(account?.available ?? account?.free ?? account?.quantity ?? account?.balance ?? 0);
        const total = Number(account?.balance ?? account?.equity ?? account?.quantity ?? available ?? 0);
        if (!Number.isFinite(available) && !Number.isFinite(total)) return;
        const frozen = Number.isFinite(total) && Number.isFinite(available) ? Math.max(total - available, 0) : 0;
        upsertBalance(currency, Number.isFinite(available) ? available : total, frozen);
      });
      return Array.from(balanceMap.values());
    }

    Object.values(accounts).forEach((account: any) => {
      if (account?.balances && typeof account.balances === "object") {
        Object.entries(account.balances).forEach(([currency, amount]) => {
          const parsed = Number(amount);
          if (!Number.isFinite(parsed)) return;
          upsertBalance(currency, parsed, 0);
        });
      }

      if (
        account?.currencies &&
        typeof account.currencies === "object" &&
        !Array.isArray(account.currencies)
      ) {
        Object.entries(account.currencies as Record<string, any>).forEach(([currency, item]) => {
          if (!currency) return;
          if (currency.toUpperCase() !== "USDT") return;
          if (typeof item === "number") {
            if (!Number.isFinite(item)) return;
            upsertBalance(currency, item, 0);
            return;
          }
          const available = Number(item?.available ?? item?.free ?? item?.quantity ?? item?.balance ?? 0);
          if (!Number.isFinite(available)) return;
          upsertBalance(currency, available, 0);
        });
      }

      if (Array.isArray(account?.currencies)) {
        account.currencies.forEach((item: any) => {
          const currency = item.currency || item.coin;
          if (!currency) return;
          const available = Number(item.available ?? item.free ?? item.quantity ?? 0);
          const total = Number(item.quantity ?? item.balance ?? available ?? 0);
          if (!Number.isFinite(available) && !Number.isFinite(total)) return;
          const frozen = Number.isFinite(total) && Number.isFinite(available) ? Math.max(total - available, 0) : 0;
          upsertBalance(currency, Number.isFinite(available) ? available : total, frozen);
        });
      }
    });

    return Array.from(balanceMap.values());
  }

  async getCandles(symbol: string, startDate: Date, endDate: Date, resolution: TCandleResolution): Promise<ICandleInfo[]> {
    const instrument = await this._resolveInstrument(symbol);
    const resolutionValue = this._mapResolution(resolution);
    const from = Math.floor(startDate.getTime() / 1000);
    const to = Math.floor(endDate.getTime() / 1000);

    const response = await this._publicRequest("GET", "/charts/ohlc", {
      tick_type: "mark",
      symbol: instrument.symbol,
      resolution: resolutionValue,
      from,
      to,
    });

    const candles = response?.candles ?? response?.result?.candles ?? [];

    return candles.map((candle: any) => ({
      timestamp: Number(candle.time ?? candle.timestamp ?? 0),
      openPrice: Number(candle.open ?? candle.o ?? 0),
      highPrice: Number(candle.high ?? candle.h ?? 0),
      lowPrice: Number(candle.low ?? candle.l ?? 0),
      closePrice: Number(candle.close ?? candle.c ?? 0),
    }));
  }

  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    const instrument = await this._resolveInstrument(symbol);
    try {
      await this._privateRequest("PUT", "/leveragepreferences", {
        symbol: instrument.symbol,
        maxLeverage: leverage,
      });
      return true;
    } catch (error) {
      console.error(`[KrakenExchange] Failed to set leverage for ${symbol}`, error);
      return false;
    }
  }

  async setMarginMode(symbol: string, marginMode: TPositionType): Promise<boolean> {
    const instrument = await this._resolveInstrument(symbol);
    try {
      if (marginMode === "cross") {
        await this._privateRequest("PUT", "/leveragepreferences", {
          symbol: instrument.symbol,
        });
      } else {
        await this._privateRequest("PUT", "/leveragepreferences", {
          symbol: instrument.symbol,
          maxLeverage: 1,
        });
      }
      return true;
    } catch (error) {
      console.error(`[KrakenExchange] Failed to set margin mode for ${symbol}`, error);
      return false;
    }
  }

  async getPosition(symbol: string): Promise<IPosition | undefined> {
    const instrument = await this._resolveInstrument(symbol);
    const data = await this._privateRequest("GET", "/openpositions", {
      symbol: instrument.symbol,
    });
    const positions = data?.openPositions ?? data?.positions ?? data?.result?.openPositions ?? [];
    const position = positions.find((pos: any) => {
      const size = Math.abs(Number(pos.size ?? pos.qty ?? pos.positionSize ?? 0));
      return size > 0;
    });

    if (!position) return undefined;

    return this._mapPosition(position, symbol, instrument);
  }

  async getOpenedPositions(): Promise<IPosition[] | undefined> {
    const data = await this._privateRequest("GET", "/openpositions");
    const positions = data?.openPositions ?? data?.positions ?? data?.result?.openPositions ?? [];
    const mapped = positions
      .map((pos: any) => {
        const originalSymbol = this._toOriginalSymbol(pos.symbol ?? pos.product_id ?? pos.productId ?? pos.instrument);
        const instrument = this._instrumentBySymbol.get(pos.symbol ?? pos.product_id ?? pos.productId ?? pos.instrument);
        return this._mapPosition(pos, originalSymbol, instrument);
      })
      .filter((pos: IPosition | undefined): pos is IPosition => !!pos);
    return mapped;
  }

  async getPositionsHistory(params: IGetPositionHistoryParams): Promise<IPosition[]> {
    const { positionId } = params;

    if (positionId) {
      const cached = this._recentClosedPositions.get(positionId);
      if (cached) return [cached];
      return [];
    }

    return Array.from(this._recentClosedPositions.values()).sort((a, b) => b.updateTime - a.updateTime);
  }

  async getMarkPrice(symbol: string): Promise<number> {
    await this._subscribeTicker(symbol);

    while (typeof this._prices[symbol] !== "number") {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return this._prices[symbol];
  }

  async getSymbolInfo(symbol: string): Promise<ISymbolInfo> {
    const instrument = await this._resolveInstrument(symbol);
    const tickSize = Number(instrument.tickSize ?? 0);
    const minTradeSize = Number(instrument.minimumTradeSize ?? 0);
    const contractSize = Number(instrument.contractSize ?? 1);

    const pricePrecision = this._decimalPlaces(tickSize);
    const basePrecision = this._decimalPlaces(minTradeSize || contractSize);

    return {
      pricePrecision,
      basePrecision,
      quotePrecision: pricePrecision,
      minNotionalValue: 0,
      maxMktOrderQty: Number(instrument.maxPositionSize ?? 0),
      maxLimitOrderQty: Number(instrument.maxPositionSize ?? 0),
    };
  }

  async getFeeRate(symbol: string): Promise<IFeeRate> {
    return {
      symbol,
      takerFeeRate: "0",
      makerFeeRate: "0",
    };
  }

  async placeOrder(params: IPlaceOrderParams): Promise<IPlaceOrderResponse> {
    const instrument = await this._resolveInstrument(params.symbol);
    const payload: Record<string, any> = {
      symbol: instrument.symbol,
      side: params.orderSide,
      orderType: this._mapOrderType(params.orderType),
      cliOrdId: params.clientOrderId,
    };

    if (typeof params.baseAmt === "number") {
      payload.size = params.baseAmt;
    } else if (typeof params.quoteAmt === "number") {
      const markPrice = await this.getMarkPrice(params.symbol);
      if (markPrice > 0) {
        payload.size = Number((params.quoteAmt / markPrice).toFixed(6));
      }
    }

    if (typeof params.orderPrice === "number") {
      payload.limitPrice = params.orderPrice;
    }

    const response = await this._privateRequest("POST", "/sendorder", payload);
    const orderId = response?.order_id ?? response?.orderId ?? response?.result?.order_id ?? params.clientOrderId;

    this._trackClientOrder(params.clientOrderId);

    return {
      orderId: orderId?.toString() || params.clientOrderId,
      clientOrderId: params.clientOrderId,
    };
  }

  async getActiveOrders(symbol: string): Promise<IOrder[]> {
    const instrument = await this._resolveInstrument(symbol);
    const response = await this._privateRequest("GET", "/openorders");
    const orders = response?.openOrders ?? response?.result?.openOrders ?? [];
    return orders
      .filter((order: any) => order.symbol === instrument.symbol)
      .map((order: any) => this._mapOrder(order, symbol));
  }

  async getTradeList(symbol: string, clientOrderId: string): Promise<ITrade[]> {
    const instrument = await this._resolveInstrument(symbol);
    const response = await this._privateRequest("GET", "/fills", {
      symbol: instrument.symbol,
    });
    const fills = response?.fills ?? response?.result?.fills ?? [];

    return fills
      .filter((fill: any) => {
        const cliOrdId = fill.cliOrdId ?? fill.cli_ord_id ?? fill.clientOrderId;
        return cliOrdId === clientOrderId;
      })
      .map((fill: any) => this._mapTrade(fill, symbol));
  }

  async getOrderDetail(symbol: string, clientOrderId: string): Promise<IOrder | undefined> {
    const response = await this._privateRequest("POST", "/orders/status", {
      cliOrdIds: clientOrderId,
    });
    const orders = response?.orders ?? response?.result?.orders ?? [];
    const match = orders.find((order: any) => {
      const payload = order.order ?? order;
      const cliOrdId = payload.cliOrdId ?? payload.cli_ord_id ?? payload.clientOrderId;
      return cliOrdId === clientOrderId;
    });
    if (!match) return undefined;
    const payload = match.order ?? match;
    return this._mapOrder(payload, symbol, match.status ?? payload.status);
  }

  async cancelOrder(symbol: string, clientOrderId: string): Promise<ICancelOrderResponse> {
    try {
      const response = await this._privateRequest("POST", "/cancelorder", {
        cliOrdId: clientOrderId,
      });
      return {
        isSuccess: true,
        description: response?.result ?? "success",
        canceledClientOrderId: clientOrderId,
      };
    } catch (error) {
      console.error(`[KrakenExchange] Failed to cancel order ${clientOrderId}`, error);
      return {
        isSuccess: false,
        description: (error as Error)?.message,
        canceledClientOrderId: clientOrderId,
      };
    }
  }

  hookPriceListener(symbol: string, callback: TPriceListener): () => void {
    const id = generateRandomString(4);
    if (!this._priceListenerCallbacks[symbol]) this._priceListenerCallbacks[symbol] = {};
    this._priceListenerCallbacks[symbol][id] = callback;

    void this._subscribeTicker(symbol);

    return () => {
      delete this._priceListenerCallbacks[symbol][id];
    };
  }

  hookPriceListenerWithTimestamp(symbol: string, callback: TPriceTimestampListener): () => void {
    const id = generateRandomString(4);
    if (!this._priceTimestampListenerCallbacks[symbol]) this._priceTimestampListenerCallbacks[symbol] = {};
    this._priceTimestampListenerCallbacks[symbol][id] = callback;

    void this._subscribeTicker(symbol);

    return () => {
      delete this._priceTimestampListenerCallbacks[symbol][id];
    };
  }

  hookOrderListener(callback: (order: IWSOrderUpdate) => void): () => void {
    const id = generateRandomString(4);
    this._orderListenerCallbacks[id] = callback;
    this._ensureOrderPoller();
    return () => {
      delete this._orderListenerCallbacks[id];
    };
  }

  private _connectPublicWs() {
    if (this._publicWs) return;
    this._publicWs = new WebSocket(KrakenExchange.WS_URL);

    this._publicWs.on("open", () => {
      this._publicWsReady = true;
      this._pendingPublicSubscriptions.splice(0).forEach((symbol) => this._sendPublicSubscribe(symbol));
    });

    this._publicWs.on("message", (data) => {
      this._handlePublicWsMessage(data.toString());
    });

    this._publicWs.on("close", () => {
      this._publicWsReady = false;
      this._publicWs = undefined;
      setTimeout(() => this._connectPublicWs(), 1000);
    });

    this._publicWs.on("error", (error) => {
      console.error("[KrakenExchange] Public WS error:", error);
    });
  }

  private _connectPrivateWs() {
    if (this._privateWs) return;
    this._privateWs = new WebSocket(KrakenExchange.WS_URL);

    this._privateWs.on("open", () => {
      this._privateWsReady = true;
      this._requestWsChallenge();
    });

    this._privateWs.on("message", (data) => {
      this._handlePrivateWsMessage(data.toString());
    });

    this._privateWs.on("close", () => {
      this._privateWsReady = false;
      this._privateWs = undefined;
      this._wsChallenge = undefined;
      this._wsSignedChallenge = undefined;
      setTimeout(() => this._connectPrivateWs(), 1000);
    });

    this._privateWs.on("error", (error) => {
      console.error("[KrakenExchange] Private WS error:", error);
    });
  }

  private _requestWsChallenge() {
    if (!this._privateWsReady || !this._privateWs) return;
    this._privateWs.send(JSON.stringify({ event: "challenge", api_key: this._apiKey }));
  }

  private async _subscribeTicker(symbol: string): Promise<void> {
    if (this._subscribedSymbols[symbol]) return;
    this._subscribedSymbols[symbol] = true;
    await this._ensureInstrumentCache();

    if (!this._publicWsReady) {
      this._pendingPublicSubscriptions.push(symbol);
      this._connectPublicWs();
      return;
    }

    this._sendPublicSubscribe(symbol);
  }

  private _sendPublicSubscribe(symbol: string) {
    const instrument = this._resolveInstrumentSync(symbol);
    if (!instrument || !this._publicWs) return;
    this._publicWs.send(
      JSON.stringify({
        event: "subscribe",
        feed: "ticker",
        product_ids: [instrument.symbol],
      })
    );
  }

  private _subscribePrivateFeed(feed: string) {
    if (!this._privateWsReady || !this._privateWs) return;
    if (!this._wsChallenge || !this._wsSignedChallenge) {
      this._pendingPrivateFeeds.push(feed);
      this._requestWsChallenge();
      return;
    }

    this._privateWs.send(
      JSON.stringify({
        event: "subscribe",
        feed,
        api_key: this._apiKey,
        original_challenge: this._wsChallenge,
        signed_challenge: this._wsSignedChallenge,
      })
    );
  }

  private _handlePublicWsMessage(raw: string) {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.feed === "ticker") {
      const productId = message.product_id ?? message.productId ?? message.symbol;
      const originalSymbol = this._toOriginalSymbol(productId);
      const markPrice = Number(message.markPrice ?? message.mark_price ?? message.mark_price ?? message.markPrice);
      if (!Number.isFinite(markPrice)) return;
      this._prices[originalSymbol] = markPrice;
      const timestamp = Number(message.timestamp ?? message.time ?? Date.now());
      this._emitPrice(originalSymbol, markPrice, timestamp);
    }
  }

  private _handlePrivateWsMessage(raw: string) {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.event === "challenge") {
      const challenge = message.message;
      if (typeof challenge === "string") {
        this._wsChallenge = challenge;
        this._wsSignedChallenge = this._signWsChallenge(challenge);
        const pending = this._pendingPrivateFeeds.splice(0);
        if (!pending.length) {
          this._subscribePrivateFeed("open_orders");
          this._subscribePrivateFeed("fills");
          return;
        }
        pending.forEach((feed) => this._subscribePrivateFeed(feed));
      }
      return;
    }

    const feed = message.feed;
    if (feed === "open_orders") {
      const orders = message.orders || message.order || message.data || [];
      const updates = Array.isArray(orders) ? orders : [orders];
      updates.forEach((order: any) => this._handleOrderUpdate(order));
      return;
    }

    if (feed === "fills") {
      const fills = message.fills || message.fill || message.data || [];
      const fillList = Array.isArray(fills) ? fills : [fills];
      fillList.forEach((fill: any) => this._handleFillUpdate(fill));
      return;
    }
  }

  private _handleFillUpdate(fill: any) {
    const orderId = fill.order_id ?? fill.orderId ?? fill.order_id ?? fill.orderId;
    if (!orderId) return;
    const price = Number(fill.price ?? fill.execPrice ?? 0);
    const size = Number(fill.size ?? fill.qty ?? 0);
    const timestamp = new Date(fill.fillTime ?? fill.timestamp ?? Date.now()).getTime();
    if (!Number.isFinite(price) || !Number.isFinite(size)) return;

    const existing = this._orderFillsByOrderId.get(orderId);
    if (!existing) {
      this._orderFillsByOrderId.set(orderId, { avgPrice: price, qty: size, timestamp });
      return;
    }
    const totalQty = existing.qty + size;
    const avgPrice = totalQty ? (existing.avgPrice * existing.qty + price * size) / totalQty : price;
    this._orderFillsByOrderId.set(orderId, {
      avgPrice,
      qty: totalQty,
      timestamp: Math.max(existing.timestamp, timestamp),
    });
  }

  private _handleOrderUpdate(order: any, statusOverride?: string) {
    const clientOrderId = order.cliOrdId ?? order.cli_ord_id ?? order.clientOrderId;
    if (!clientOrderId) return;

    const orderId = order.order_id ?? order.orderId ?? clientOrderId;
    const status = statusOverride ?? order.status ?? order.orderStatus ?? "";
    const reason = order.reason ?? order.updateReason ?? "";
    const isCancel = Boolean(order.is_cancel ?? order.isCancel ?? false);

    const mappedStatus = this._mapOrderStatus(status, reason, isCancel);
    const symbol = order.symbol ?? order.product_id ?? order.productId ?? order.instrument;
    const originalSymbol = symbol ? this._toOriginalSymbol(symbol) : undefined;
    const side = (order.side ?? order.direction ?? "").toLowerCase() as TOrderSide;

    const fillMeta = this._orderFillsByOrderId.get(orderId);
    const executionPrice = Number(order.avgPrice ?? order.price ?? order.limitPrice ?? fillMeta?.avgPrice ?? 0);
    const updateTime = new Date(order.lastUpdateTime ?? order.lastUpdateTimestamp ?? order.timestamp ?? Date.now()).getTime();

    const update: IWSOrderUpdate = {
      orderId: orderId.toString(),
      clientOrderId: clientOrderId.toString(),
      orderStatus: mappedStatus,
      symbol: originalSymbol,
      executionPrice: Number.isFinite(executionPrice) ? executionPrice : undefined,
      updateTime,
    };

    const positionSide = this._inferPositionSide(originalSymbol, side);
    if (positionSide) update.positionSide = positionSide;

    if (mappedStatus === "filled") {
      const closed = this._tryClosePosition(update, order, executionPrice, updateTime);
      if (closed) {
        update.realizedPnl = closed.realizedPnl;
      }
    }

    Object.values(this._orderListenerCallbacks).forEach((callback) => callback(update));
  }

  private _tryClosePosition(
    update: IWSOrderUpdate,
    order: any,
    executionPrice: number,
    updateTime: number
  ): IPosition | undefined {
    if (!update.symbol || !update.positionSide) return;
    const key = this._symbolSideKey(update.symbol, update.positionSide);
    const positionId = this._symbolSideToPositionId.get(key);
    if (!positionId) return;

    const meta = this._positionMetaById.get(positionId);
    if (!meta) return;

    const reduceOnly = Boolean(order.reduceOnly ?? order.reduce_only ?? false);
    const isClosingOrder =
      reduceOnly ||
      (meta.side === "long" && (order.side ?? order.direction ?? "").toLowerCase() === "sell") ||
      (meta.side === "short" && (order.side ?? order.direction ?? "").toLowerCase() === "buy");

    if (!isClosingOrder) return;

    const instrument = this._instrumentBySymbol.get(order.symbol ?? order.product_id ?? order.productId ?? "");
    const contractSize = Number(instrument?.contractSize ?? 1);
    const priceDiff = (executionPrice - meta.avgPrice) * (meta.side === "long" ? 1 : -1);
    const realizedPnl = priceDiff * meta.size * contractSize;

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
      closePrice: executionPrice,
      liquidationPrice: meta.liquidationPrice,
      maintenanceMargin: meta.maintenanceMargin,
      initialMargin: meta.initialMargin,
      marginMode: meta.marginMode,
      createTime: meta.createTime,
      updateTime,
    };

    this._recentClosedPositions.set(positionId, closedPosition);
    this._trimClosedPositionsCache();
    this._symbolSideToPositionId.delete(key);
    this._positionMetaById.delete(positionId);
    this._closedPositionMetaById.set(positionId, meta);

    return closedPosition;
  }

  private _emitPrice(symbol: string, price: number, timestamp: number) {
    if (this._priceListenerCallbacks[symbol]) {
      Object.values(this._priceListenerCallbacks[symbol]).forEach((callback) => callback(price));
    }
    if (this._priceTimestampListenerCallbacks[symbol]) {
      Object.values(this._priceTimestampListenerCallbacks[symbol]).forEach((callback) => callback(price, timestamp));
    }
  }

  private async _ensureInstrumentCache(): Promise<void> {
    if (this._exchangeInfoPromise) return this._exchangeInfoPromise;
    this._exchangeInfoPromise = this._publicRequest("GET", "/instruments").then((data) => {
      const instruments: KrakenInstrument[] = data?.instruments ?? data?.result?.instruments ?? [];
      instruments.forEach((instrument) => {
        if (!instrument?.symbol) return;
        let symbol = instrument.symbol;
        if (instrument.type === "flexible_futures" && !symbol.startsWith("PF_")) {
          symbol = `PF_${symbol}`;
        }
        const normalized = this._normalizeInstrumentPair(symbol);
        const mappedInstrument = symbol === instrument.symbol ? instrument : { ...instrument, symbol };
        this._instrumentBySymbol.set(symbol, mappedInstrument);
        if (symbol !== instrument.symbol) {
          this._instrumentBySymbol.set(instrument.symbol, mappedInstrument);
        }
        if (normalized) {
          this._instrumentByNormalized.set(normalized, mappedInstrument);
        }
      });
    });
    return this._exchangeInfoPromise;
  }

  private async _resolveInstrument(symbol: string): Promise<KrakenInstrument> {
    await this._ensureInstrumentCache();
    const resolved = this._resolveInstrumentSync(symbol);
    if (!resolved) {
      throw new Error(`[KrakenExchange] Unable to map symbol ${symbol} to Kraken instrument`);
    }
    this._instrumentSymbolToOriginal.set(resolved.symbol, symbol);
    return resolved;
  }

  private _resolveInstrumentSync(symbol: string): KrakenInstrument | undefined {
    const normalized = this._normalizeSymbol(symbol);
    if (this._instrumentByNormalized.has(normalized)) {
      return this._instrumentByNormalized.get(normalized);
    }
    const fallback = normalized.replace(/USDT$/, "USD");
    if (fallback !== normalized && this._instrumentByNormalized.has(fallback)) {
      return this._instrumentByNormalized.get(fallback);
    }
    return undefined;
  }

  private _mapPosition(position: any, originalSymbol: string, instrument?: KrakenInstrument): IPosition | undefined {
    const sizeRaw = Number(position.size ?? position.qty ?? position.positionSize ?? 0);
    const size = Math.abs(sizeRaw);
    if (!size) return undefined;

    const side: TPositionSide = (position.side ?? position.direction ?? "").toLowerCase() === "short" || sizeRaw < 0 ? "short" : "long";
    const notional = Math.abs(Number(position.notionalValue ?? position.notional ?? position.positionValue ?? 0));
    const initialMargin = Number(position.initialMargin ?? position.initialMarginWithOrders ?? 0);
    const maintenanceMargin = Number(position.maintenanceMargin ?? 0);
    const leverage = initialMargin ? Math.abs(notional / initialMargin) : Number(position.leverage ?? 0);
    const marginMode: TPositionType = (position.marginType ?? position.marginMode ?? "cross").toLowerCase() === "isolated" ? "isolated" : "cross";
    const avgPrice = Number(position.entryPrice ?? position.avgPrice ?? position.avgEntryPrice ?? 0);
    const liquidationPrice = Number(position.liquidationThreshold ?? position.liquidationPrice ?? 0);
    const createTime = new Date(position.openTime ?? position.openTimestamp ?? position.timestamp ?? Date.now()).getTime();
    const updateTime = new Date(position.updateTime ?? position.lastUpdateTime ?? Date.now()).getTime();

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
      unrealizedPnl: Number(position.unrealizedPnl ?? position.pnl ?? 0),
      realizedPnl: Number(position.realizedPnl ?? 0),
      avgPrice,
      closePrice: undefined,
      liquidationPrice,
      maintenanceMargin,
      initialMargin,
      marginMode,
      createTime,
      updateTime,
    };

    this._positionMetaById.set(id, {
      symbol: originalSymbol,
      side,
      leverage,
      marginMode,
      liquidationPrice,
      maintenanceMargin,
      initialMargin,
      notional,
      size,
      avgPrice,
      createTime,
    });

    return mapped;
  }

  private _mapOrderType(type: TOrderType): string {
    return type === "market" ? "mkt" : "lmt";
  }

  private _mapOrderStatus(status: string, reason?: string, isCancel?: boolean): TOrderStatus {
    const normalized = `${status}`.toLowerCase();
    const normalizedReason = `${reason ?? ""}`.toLowerCase();
    if (normalized.includes("filled") || normalizedReason.includes("full_fill")) return "filled";
    if (normalized.includes("partial") || normalizedReason.includes("partial_fill")) {
      return isCancel ? "partially_filled_canceled" : "partially_filled";
    }
    if (normalized.includes("cancel") || normalizedReason.includes("cancel") || normalized.includes("expired")) return "canceled";
    if (normalized.includes("open") || normalized.includes("untouched") || normalized.includes("entered_book")) return "open";
    return "unknown";
  }

  private _mapOrder(order: any, originalSymbol: string, statusOverride?: string): IOrder {
    return {
      id: order.order_id?.toString() || order.orderId?.toString() || order.cliOrdId,
      symbol: originalSymbol,
      clientOrderId: order.cliOrdId ?? order.cli_ord_id ?? order.clientOrderId,
      status: this._mapOrderStatus(statusOverride ?? order.status ?? ""),
      type: (order.orderType ?? order.type ?? "lmt").toLowerCase() === "mkt" ? "market" : "limit",
      side: (order.side ?? order.direction ?? "buy").toLowerCase() as TOrderSide,
      avgPrice: Number(order.avgPrice ?? order.price ?? 0),
      orderQuantity: Number(order.size ?? order.quantity ?? order.orderQty ?? 0),
      execQty: Number(order.filledSize ?? order.filled ?? 0),
      execValue: Number(order.value ?? order.quote ?? 0),
      fee: {
        currency: order.feeCurrency ?? "USD",
        amt: Number(order.fee ?? 0),
      },
      createdTs: new Date(order.createTime ?? order.receivedTime ?? order.timestamp ?? Date.now()).getTime(),
      updateTs: new Date(order.updateTime ?? order.lastUpdateTime ?? order.timestamp ?? Date.now()).getTime(),
    };
  }

  private _mapTrade(fill: any, originalSymbol: string): ITrade {
    return {
      quantity: Number(fill.size ?? fill.qty ?? 0),
      id: fill.fill_id?.toString() || fill.id?.toString(),
      orderId: fill.order_id?.toString() || fill.orderId?.toString(),
      price: Number(fill.price ?? 0),
      timestamp: new Date(fill.fillTime ?? fill.timestamp ?? Date.now()).getTime(),
      side: (fill.side ?? "buy").toLowerCase() as TOrderSide,
      symbol: originalSymbol,
      takerOrMaker: (fill.fillType ?? fill.liquidityType ?? "taker").toLowerCase().includes("maker") ? "maker" : "taker",
      cost: Number(fill.price ?? 0) * Number(fill.size ?? fill.qty ?? 0),
      fee: {
        currency: fill.feeCurrency ?? "USD",
        amt: Number(fill.fee ?? 0),
      },
    };
  }

  private _normalizeSymbol(symbol: string): string {
    const normalized = symbol.replace(/[_\s-]/g, "").toUpperCase();
    if (!this._normalizedToOriginalSymbol[normalized]) {
      this._normalizedToOriginalSymbol[normalized] = symbol;
    }
    return normalized;
  }

  private _toOriginalSymbol(normalized: string): string {
    if (!normalized) return normalized;
    const direct = this._instrumentSymbolToOriginal.get(normalized);
    if (direct) return direct;
    const cleaned = normalized.replace(/[_\s-]/g, "").toUpperCase();
    return this._normalizedToOriginalSymbol[cleaned] || normalized;
  }

  private _normalizeInstrumentPair(symbol: string): string | undefined {
    if (!symbol) return undefined;
    let stripped = symbol;
    stripped = stripped.replace(/^(PF_|PI_|FI_)/, "");
    stripped = stripped.replace(/_\d+$/, "");
    stripped = stripped.replace(/_/g, "");
    return stripped.toUpperCase();
  }

  private _symbolSideKey(symbol: string, side: TPositionSide): string {
    return `${symbol.toUpperCase()}::${side}`;
  }

  private _decimalPlaces(value?: number): number {
    if (!value || !Number.isFinite(value)) return 0;
    const str = value.toString();
    if (str.includes("e-")) {
      const [, exp] = str.split("e-");
      return Number(exp);
    }
    const parts = str.split(".");
    return parts[1]?.length ?? 0;
  }

  private _inferPositionSide(symbol: string | undefined, orderSide: TOrderSide): TPositionSide | undefined {
    if (!symbol) return undefined;
    const originalKeyLong = this._symbolSideKey(symbol, "long");
    const originalKeyShort = this._symbolSideKey(symbol, "short");
    if (this._symbolSideToPositionId.has(originalKeyLong)) return "long";
    if (this._symbolSideToPositionId.has(originalKeyShort)) return "short";

    const normalized = this._normalizeSymbol(symbol);
    const normalizedKeyLong = `${normalized}::long`;
    const normalizedKeyShort = `${normalized}::short`;
    if (this._symbolSideToPositionId.has(normalizedKeyLong)) return "long";
    if (this._symbolSideToPositionId.has(normalizedKeyShort)) return "short";
    if (orderSide === "buy") return "long";
    if (orderSide === "sell") return "short";
    return undefined;
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

  private _ensureOrderPoller() {
    if (this._orderPoller) return;
    this._orderPoller = setInterval(() => {
      void this._pollOrderStatuses();
    }, 3000);
  }

  private _trackClientOrder(clientOrderId: string) {
    if (!clientOrderId) return;
    this._trackedClientOrderIds.add(clientOrderId);
    this._ensureOrderPoller();
  }

  private async _pollOrderStatuses() {
    if (!this._trackedClientOrderIds.size) return;
    const ids = Array.from(this._trackedClientOrderIds);
    const batches: string[][] = [];
    while (ids.length) {
      batches.push(ids.splice(0, 20));
    }

    for (const batch of batches) {
      try {
        const response = await this._privateRequest("POST", "/orders/status", {
          cliOrdIds: batch,
        });
        const orders: KrakenOrderStatusPayload[] = response?.orders ?? response?.result?.orders ?? [];
        orders.forEach((entry) => {
          const payload = entry.order ?? entry;
          const clientOrderId = payload.cliOrdId ?? payload.cli_ord_id ?? payload.clientOrderId;
          if (!clientOrderId) return;
          const mappedStatus = this._mapOrderStatus(entry.status ?? payload.status ?? "", entry.updateReason ?? payload.updateReason);
          const prevStatus = this._lastOrderStatusByClientId.get(clientOrderId);
          if (prevStatus === mappedStatus) return;
          this._lastOrderStatusByClientId.set(clientOrderId, mappedStatus);
          this._handleOrderUpdate(payload, entry.status ?? payload.status);

          if (mappedStatus === "filled" || mappedStatus === "canceled" || mappedStatus === "partially_filled_canceled") {
            this._trackedClientOrderIds.delete(clientOrderId);
          }
        });
      } catch (error) {
        console.warn("[KrakenExchange] Failed polling order status:", error);
      }
    }
  }

  private async _publicRequest(method: string, path: string, params?: Record<string, any>): Promise<Record<string, any>> {
    const url = new URL(`${KrakenExchange.REST_BASE}${KrakenExchange.REST_PREFIX}${path}`);
    if (params && method === "GET") {
      Object.entries(params).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        url.searchParams.append(key, value.toString());
      });
    }

    const response = await fetch(url.toString(), { method });
    if (!response.ok) {
      throw new Error(`[KrakenExchange] Public request failed: ${response.status}`);
    }
    return response.json() as Promise<Record<string, any>>;
  }

  private async _privateRequest(method: string, path: string, params?: Record<string, any>): Promise<Record<string, any>> {
    const endpointPath = `${KrakenExchange.REST_PREFIX}${path}`;
    const url = new URL(`${KrakenExchange.REST_BASE}${endpointPath}`);
    const bodyParams = new URLSearchParams();

    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        if (Array.isArray(value)) {
          value.forEach((item) => bodyParams.append(key, item.toString()));
        } else {
          bodyParams.append(key, value.toString());
        }
      });
    }

    if (method === "GET" && bodyParams.toString()) {
      bodyParams.forEach((value, key) => {
        url.searchParams.append(key, value);
      });
    }

    const nonce = Date.now().toString();
    const postData = method === "GET" ? url.searchParams.toString() : bodyParams.toString();
    const signature = this._signRequest(postData, nonce, endpointPath);

    const headers: Record<string, string> = {
      APIKey: this._apiKey,
      Authent: signature,
      Nonce: nonce,
    };

    if (method !== "GET") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    console.log("---- Request: -----");
    console.log("headers", headers);
    console.log("url", url.toString());
    console.log("postData", postData);
    console.log("method", method);

    const response = await fetch(url.toString(), {
      method,
      headers,
      body: method === "GET" ? undefined : postData,
    });

    const rawText = await response.text();
    console.log("---- Raw Response: -----");
    console.log(rawText);

    if (!response.ok) {
      throw new Error(`[KrakenExchange] Private request failed (${response.status}): ${rawText}`);
    }

    try {
      return JSON.parse(rawText) as Record<string, any>;
    } catch (error) {
      throw new Error(
        `[KrakenExchange] Failed to parse response JSON (${response.status}): ${(error as Error).message}`
      );
    }
  }

  private _signRequest(postData: string, nonce: string, endpointPath: string): string {
    const normalizedPath = endpointPath.replace("/derivatives", "");
    const sha256 = crypto.createHash("sha256").update(postData + nonce + normalizedPath).digest();
    const secret = Buffer.from(this._apiSecret, "base64");
    return crypto.createHmac("sha512", secret).update(sha256).digest("base64");
  }

  private _signWsChallenge(challenge: string): string {
    const sha256 = crypto.createHash("sha256").update(challenge).digest();
    const secret = Buffer.from(this._apiSecret, "base64");
    return crypto.createHmac("sha512", secret).update(sha256).digest("base64");
  }

  private _mapResolution(resolution: TCandleResolution): string {
    const mapping: Record<TCandleResolution, string> = {
      "1Min": "1m",
      "3Min": "5m",
      "5Min": "5m",
      "15Min": "15m",
      "30Min": "1h",
      "60Min": "1h",
      "4Hour": "4h",
      "8Hour": "12h",
      "1Day": "1d",
      "1Week": "1w",
      "1Month": "1w",
    };
    return mapping[resolution];
  }
}

export default KrakenExchange;
