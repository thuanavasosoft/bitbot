import crypto from 'crypto';
import type { IMexcApiResponse, IMexcGetBalanceResp, IMexcKlineResponse, IMexcPosition, IMexcSetLeverageParams, IWSMessageData, TMexcKlineResolution } from './mexc-types';
import type { IBalanceInfo, ICancelOrderResponse, ICandleInfo, IFeeRate, IGetPositionHistoryParams, IOrder, IPlaceOrderParams, IPlaceOrderResponse, IPosition, ISymbolInfo, ITrade, IWSOrderUpdate, TCandleResolution, TPositionSide, TPositionType } from '../exchange-type';
import BigNumber from 'bignumber.js';
import { generateRandomString } from '@/utils/strings.util';
import type { IExchangeInstance } from '@/services/exchange-service/exchange-service';

class MexcExchange implements IExchangeInstance {
  private _baseUrl = "https://contract.mexc.com"

  private _apiKey: string;
  private _secretKey: string;

  private _symbols: string[];

  private _wsClient!: WebSocket;
  private _prices: { [symbol: string]: number } = {}
  private _subscribedTickerSymbols: { [symbol: string]: boolean } = {};
  private _pingerTimer?: NodeJS.Timeout;

  private _priceListenerCallbacks: { [symbol: string]: { [id: string]: (price: number) => void } } = {};

  constructor(apiKey: string, secretKey: string, symbols: string[]) {
    this._apiKey = apiKey;
    this._secretKey = secretKey;
    this._symbols = symbols;

    this._setupWsClient();
  }

  cancelOrder(symbol: string, clientOrderId: string): Promise<ICancelOrderResponse> {
    throw new Error('Method not implemented.');
  }

  async prepare() {
    console.log("MEXC Prepare function");
  }

  private _setupWsClient() {
    console.log("[MEXC WS] Setting up WS client");

    if (!!this._pingerTimer) clearInterval(this._pingerTimer);
    this._prices = {};
    this._subscribedTickerSymbols = {};

    console.log("[MEXC WS] Initiating WS client");
    this._wsClient = new WebSocket("wss://contract.mexc.com/edge");
    this._mapWsClientListener();
    for (const symbol of this._symbols) {
      console.log("[MEXC WS] First subscribe ws ticker");
      this._subscribeTicker(symbol);
    }
  }

  private _startSendPingEvery10Seconds() {
    if (!!this._pingerTimer) clearInterval(this._pingerTimer);

    this._pingerTimer = setInterval(() => {
      if (this._wsClient.OPEN) {
        this._wsClient.send(JSON.stringify({
          method: "ping"
        }));
      } else if (this._wsClient.readyState === this._wsClient.CLOSED || this._wsClient.readyState === this._wsClient.CLOSING) {
        // Force reconnect
        this._setupWsClient();
      }
    }, 10 * 1000)
  }

  private isWsClientReady(): boolean {
    return this._wsClient.readyState === this._wsClient.OPEN;
  }

  private _mapWsClientListener() {
    console.log("[MEXC WS]: Map WS Client Listener");

    this._wsClient.addEventListener("message", (msg) => {
      const data = JSON.parse(msg.data) as IWSMessageData;

      if (data.channel === "push.ticker" && !!data.data.lastPrice) {
        this._prices[data.data.symbol] = data.data.lastPrice;
        if (!!this._priceListenerCallbacks[data.data.symbol]) {
          for (const id in this._priceListenerCallbacks[data.data.symbol]) {
            const callback = this._priceListenerCallbacks[data.data.symbol][id];
            callback(data.data.lastPrice);
          }
        }
      }
    });

    this._wsClient.addEventListener("open", () => {
      console.log("[MEXC WS] WS CLIENT CONNECTION OPENED: ");
      this._startSendPingEvery10Seconds();
    });

    this._wsClient.addEventListener("close", () => {
      console.log("[MEXC WS] WS CLIENT CONNECTION CLOSED: ");
      this._setupWsClient();
    });
  }

  /**
   * Generates HMAC SHA256 hex signature
   *
   * @param inputStr - data to sign
   * @param key - secret key
   * @returns {string}
   */
  private _actualSignature(inputStr: string, key: string): string {
    try {
      return crypto
        .createHmac('sha256', key)
        .update(inputStr, 'utf8')
        .digest('hex');
    } catch (error: any) {
      throw new Error(`Error generating signature: ${error.message}`);
    }
  }

  /**
   * Generates the signature
   *
   * @param signVo - SignVo object
   * @returns {string}
   */
  private _sign(requestTs: number, requestParam: string = ""): string {
    const str = this._apiKey + requestTs + requestParam;
    return this._actualSignature(str, this._secretKey);
  }

  private _getPrivHeaders(requestParam?: string) {
    const requestTime = +new Date();
    const signature = this._sign(requestTime, requestParam);

    return {
      "ApiKey": this._apiKey,
      "Request-Time": requestTime + "",
      "Signature": signature,
      "Content-Type": "application/json",
    }
  }

  private _formatUrl(endpoint: string, urlParams?: URLSearchParams) {
    let url = `${this._baseUrl}/${endpoint}`;

    if (!!urlParams?.toString()) {
      url += `?${urlParams.toString()}`
    }

    return url;
  }

  private _convertEACandleResolutionToMexcCandleResolution(eaCandleResolution: TCandleResolution): TMexcKlineResolution {
    if (eaCandleResolution === "3Min") throw "MEXC_DOES_NOT_SUPPORT_3MIN_CANDLE"
    const resolutions: { [eaRes in TCandleResolution]: TMexcKlineResolution } = {
      "1Min": "Min1",
      "3Min": "Min5", // This will not returned anyway
      "5Min": "Min5",
      "15Min": "Min15",
      "30Min": "Min30",
      "60Min": "Min60",
      "4Hour": "Hour4",
      "8Hour": "Hour8",
      "1Day": "Day1",
      "1Week": "Week1",
      "1Month": "Month1",
    }

    return resolutions[eaCandleResolution];
  }

  private async _subscribeTicker(symbol: string): Promise<boolean> {
    if (!!this._subscribedTickerSymbols[symbol]) {
      console.log(`[MEXC WS]: Trying to subscribe  ${symbol} ticker, but it's already subscribed`);
      return true
    }
    this._subscribedTickerSymbols[symbol] = true;

    while (!this.isWsClientReady()) {
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[MEXC WS]: Success to subscribe ${symbol} ticker`);
    this._wsClient.send(JSON.stringify({
      "method": "sub.ticker",
      "param": {
        "symbol": symbol,
      }
    }));

    return true;
  }

  async getCandles(symbol: string, startDate: Date, endDate: Date, resolution: TCandleResolution): Promise<ICandleInfo[]> {
    const endpoint = `api/v1/contract/kline/${symbol}`;

    const params = new URLSearchParams({
      start: Math.floor(startDate.getTime() / 1000).toString(), // Unix timestamp in seconds
      end: Math.floor(endDate.getTime() / 1000).toString(),
      interval: this._convertEACandleResolutionToMexcCandleResolution(resolution),
    });

    const url = this._formatUrl(endpoint, params);
    const res = await fetch(url);
    const data = await res.json() as IMexcApiResponse<IMexcKlineResponse>;
    if (!data.data) console.error("Error response on fetching candles: ", data);

    const { open, close, high, low, time } = data.data;
    const length = Math.min(open.length, close.length, high.length, low.length, time.length);

    const candles: ICandleInfo[] = [];

    for (let i = 0; i < length; i++) {
      candles.push({
        timestamp: time[i] * 1000,
        openPrice: open[i],
        highPrice: high[i],
        lowPrice: low[i],
        closePrice: close[i],
      });

    }

    return candles.sort((a, b) => a.timestamp - b.timestamp); // adjust this line depending on the API response shape
  }

  async getBalances(): Promise<IBalanceInfo[]> {
    const endpoint = "api/v1/private/account/assets";
    const url = this._formatUrl(endpoint);

    const response = await fetch(url, {
      headers: this._getPrivHeaders(),
    });

    const data = await response.json() as IMexcApiResponse<IMexcGetBalanceResp[]>;
    if (!data.data) console.error("Error response on fetching get balances: ", data);

    const balancesInfo = data.data.map(d => {
      const balanceInfo: IBalanceInfo = {
        coin: d.currency,
        free: d.availableBalance,
        frozen: d.frozenBalance,
      }

      return balanceInfo;
    });

    return balancesInfo;
  }

  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    const endpoint = "api/v1/private/position/change_leverage";
    const url = this._formatUrl(endpoint);

    const paramsLong: IMexcSetLeverageParams = {
      "openType": 1,
      "positionType": 1,
      "symbol": symbol,
      "leverage": leverage,
    }
    const paramsShort: IMexcSetLeverageParams = {
      "openType": 1,
      "positionType": 2,
      "symbol": symbol,
      "leverage": leverage,
    }

    const jsonBodyLong = JSON.stringify(paramsLong);
    const responseLong = await fetch(url, {
      method: "POST",
      headers: this._getPrivHeaders(jsonBodyLong),
      body: jsonBodyLong,
    });

    const jsonBodyShort = JSON.stringify(paramsShort);
    const responseShort = await fetch(url, {
      method: "POST",
      headers: this._getPrivHeaders(jsonBodyShort),
      body: jsonBodyShort,
    });

    const dataLong = await responseLong.json() as IMexcApiResponse<null>;
    const dataShort = await responseShort.json() as IMexcApiResponse<null>;

    return dataLong.success && dataShort.success;
  }

  async getMarkPrice(symbol: string): Promise<number> {
    if (!this._symbols.includes(symbol)) {
      this._symbols.push(symbol);
    }

    if (!this._prices[symbol]) {
      await this._subscribeTicker(symbol);
    }

    while (!this._prices[symbol]) {
      await new Promise(r => setTimeout(r, 100));
    }

    return this._prices[symbol];
  }

  async getPosition(symbol: string): Promise<IPosition | undefined> {
    const endpoint = "api/v1/private/position/open_positions";
    const params = new URLSearchParams({
      symbol,
    });
    const url = this._formatUrl(endpoint, params);

    const resp = await fetch(url, {
      headers: this._getPrivHeaders(params.toString())
    });

    const data = await resp.json() as IMexcApiResponse<IMexcPosition[]>;
    if (!data.data) console.error("Error response on fetching get get position: ", data);

    const mexcPos = data.data.find(p => p.symbol === symbol);

    if (!mexcPos) return undefined;

    const notional = new BigNumber(mexcPos.im).times(mexcPos.leverage);
    const size = notional.div(mexcPos.holdAvgPrice);
    const maintenanceMargin = new BigNumber(mexcPos.im).times(mexcPos.marginRatio)

    const positionSide: { [val: number]: TPositionSide } = {
      1: "long",
      2: "short",
    }

    const positionType: { [val: number]: TPositionType } = {
      1: "isolated",
      2: "cross",
    }

    const currMarkPrice = await this.getMarkPrice(symbol);
    const priceDiff = mexcPos.positionType === 1 ? new BigNumber(currMarkPrice).minus(mexcPos.holdAvgPrice) : new BigNumber(mexcPos.holdAvgPrice).minus(currMarkPrice);
    const unrealizedPnl = priceDiff.times(size);

    const position: IPosition = {
      id: mexcPos.positionId,
      symbol: mexcPos.symbol,
      liquidationPrice: mexcPos.liquidatePrice,
      leverage: mexcPos.leverage,
      initialMargin: mexcPos.im,
      maintenanceMargin: maintenanceMargin.toNumber(),
      notional: notional.toNumber(),
      size: size.toNumber(),
      createTime: mexcPos.createTime,
      updateTime: mexcPos.updateTime,
      side: positionSide[mexcPos.positionType],
      marginMode: positionType[mexcPos.openType],
      avgPrice: mexcPos.holdAvgPrice,
      realizedPnl: mexcPos.realised,
      unrealizedPnl: unrealizedPnl.toNumber(),
    }

    return position;
  }

  async getOpenedPositions(): Promise<IPosition[]> {
    const endpoint = "api/v1/private/position/open_positions";
    const url = this._formatUrl(endpoint);

    const resp = await fetch(url, {
      headers: this._getPrivHeaders()
    });

    const data = await resp.json() as IMexcApiResponse<IMexcPosition[]>;
    if (!data.data) console.error("Error response on fetching get get opened position: ", data);

    if (!data.data.length) return [];

    const positions: IPosition[] = await Promise.all(data.data.map(async (mexcPos) => {
      const notional = new BigNumber(mexcPos.im).times(mexcPos.leverage);
      const size = notional.div(mexcPos.holdAvgPrice);
      const maintenanceMargin = new BigNumber(mexcPos.im).times(mexcPos.marginRatio)

      const positionSide: { [val: number]: TPositionSide } = {
        1: "long",
        2: "short",
      }

      const positionType: { [val: number]: TPositionType } = {
        1: "isolated",
        2: "cross",
      }

      const currMarkPrice = await this.getMarkPrice(mexcPos.symbol);
      const priceDiff = mexcPos.positionType === 1 ? new BigNumber(currMarkPrice).minus(mexcPos.holdAvgPrice) : new BigNumber(mexcPos.holdAvgPrice).minus(currMarkPrice);
      const unrealizedPnl = priceDiff.times(size);

      const position: IPosition = {
        id: mexcPos.positionId,
        symbol: mexcPos.symbol,
        liquidationPrice: mexcPos.liquidatePrice,
        leverage: mexcPos.leverage,
        initialMargin: mexcPos.im,
        maintenanceMargin: maintenanceMargin.toNumber(),
        notional: notional.toNumber(),
        size: size.toNumber(),
        createTime: mexcPos.createTime,
        updateTime: mexcPos.updateTime,
        side: positionSide[mexcPos.positionType],
        marginMode: positionType[mexcPos.openType],
        avgPrice: mexcPos.holdAvgPrice,
        realizedPnl: mexcPos.realised,
        unrealizedPnl: unrealizedPnl.toNumber(),
      }

      return position;
    }));

    return positions;
  }

  async getPositionsHistory(getParams: IGetPositionHistoryParams): Promise<IPosition[]> {
    const { page = 1, limit = 100, positionId } = getParams;

    console.log(`Fetching positions history | page:${page} limit: ${limit} positionId: ${positionId}`);

    const endpoint = "api/v1/private/position/list/history_positions";
    const params = new URLSearchParams();
    if (!!page) params.append("page_num", page.toString());
    if (!!limit) params.append("page_size", limit.toString());
    console.log("params: ", params);
    const url = this._formatUrl(endpoint, params);
    console.log("url: ", url);

    const resp = await fetch(url, {
      headers: this._getPrivHeaders(params.toString())
    });

    let data: IMexcApiResponse<IMexcPosition[]>;
    try {
      data = await resp.json() as IMexcApiResponse<IMexcPosition[]>;
      if (!data.data) console.error("Error response on fetching get get positions history: ", data);

    } catch (error) {
      console.error("Error parsing JSON response: ", error);
      return [];
    }

    if (!data.data.length) return [];
    console.log("data.data.length: ", data?.data?.length);

    const positions: IPosition[] = (await Promise.all(data.data.map(async (mexcPos) => {
      const notional = new BigNumber(mexcPos.im).times(mexcPos.leverage);
      const size = notional.div(mexcPos.holdAvgPrice);

      const positionSide: { [val: number]: TPositionSide } = {
        1: "long",
        2: "short",
      }

      const positionType: { [val: number]: TPositionType } = {
        1: "isolated",
        2: "cross",
      }

      const position: IPosition = {
        id: mexcPos.positionId,
        symbol: mexcPos.symbol,
        liquidationPrice: mexcPos.liquidatePrice,
        leverage: mexcPos.leverage,
        initialMargin: mexcPos.im,
        maintenanceMargin: 0,
        notional: notional.toNumber(),
        size: size.toNumber(),
        createTime: mexcPos.createTime,
        updateTime: mexcPos.updateTime,
        side: positionSide[mexcPos.positionType],
        marginMode: positionType[mexcPos.openType],
        avgPrice: mexcPos.holdAvgPrice,
        realizedPnl: mexcPos.realised,
        unrealizedPnl: 0,
      };

      if (mexcPos.state !== 3) {
        const currMarkPrice = await this.getMarkPrice(mexcPos.symbol);
        const priceDiff = mexcPos.positionType === 1 ? new BigNumber(currMarkPrice).minus(mexcPos.holdAvgPrice) : new BigNumber(mexcPos.holdAvgPrice).minus(currMarkPrice);
        const maintenanceMargin = new BigNumber(0);
        const unrealizedPnl = priceDiff.times(size);

        position.unrealizedPnl = unrealizedPnl.toNumber();
        position.maintenanceMargin = maintenanceMargin.toNumber();
      } else {
        position.closePrice = mexcPos.closeAvgPrice;
      }

      if (!!positionId && mexcPos.positionId !== positionId) return undefined;

      return position;
    }))).filter((pos): pos is IPosition => pos !== undefined);

    if (!!positionId && !positions.some(p => p.id === positionId) && data.data.length >= limit) {
      return this.getPositionsHistory({ page: page + 1, limit: limit, positionId })
    }

    return positions;
  }

  hookPriceListener(symbol: string, callback: (price: number) => void): () => void {
    const id = generateRandomString(4);
    console.log(`[MEXC]: Hook price listener ${symbol} ${id}`);

    if (!this._priceListenerCallbacks[symbol]) this._priceListenerCallbacks[symbol] = {};
    this._priceListenerCallbacks[symbol][id] = callback;
    console.log(`[MEXC]: Callbacks for ${symbol}: ${Object.keys(this._priceListenerCallbacks[symbol])}`);

    return () => {
      console.log(`[MEXC]: Finished hook price listener ${symbol} ${id}`);
      delete this._priceListenerCallbacks[symbol][id]
      console.log(`[MEXC]: Callbacks for ${symbol}: ${Object.keys(this._priceListenerCallbacks[symbol])}`);
    }
  }

  getSymbolInfo(symbol: string): Promise<ISymbolInfo> { throw "getSymbolInfo METHOD NOT IMPLEMENTED IN MEXC EXCHANGE" }
  getFeeRate(symbol: string): Promise<IFeeRate> { throw "getFeeRate METHOD NOT IMPLEMENTED IN MEXC EXCHANGE" }
  placeOrder(params: IPlaceOrderParams): Promise<IPlaceOrderResponse> { throw "placeOrder METHOD NOT IMPLEMENTED IN MEXC EXCHANGE" }
  getActiveOrders(symbol: string): Promise<IOrder[]> { throw "getActiveOrders METHOD NOT IMPLEMENTED IN MEXC EXCHANGE" }
  getTradeList(symbol: string, clientOrderId: string): Promise<ITrade[]> { throw "getTradeList METHOD NOT IMPLEMENTED IN MEXC EXCHANGE" }
  getOrderDetail(symbol: string, clientOrderId: string): Promise<IOrder | undefined> { throw "getOrderDetail METHOD NOT IMPLEMENTED IN MEXC EXCHANGE" }
  hookOrderListener(callback: (order: IWSOrderUpdate) => void): () => void { throw "hookOrderListener METHOD NOT IMPLEMENTED IN MEXC EXCHANGE" }
}

export default MexcExchange;