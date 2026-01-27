import dotenv from "dotenv";
import ExchangeService from "@/services/exchange-service/exchange-service";
// import type { TOrderSide, TOrderType } from "@/services/exchange-service/exchange-type";

dotenv.config();

const REQUIRED_ENVS = ["API_KEY", "API_SECRET", "SYMBOL"];

const nowIso = () => new Date().toISOString();
const log = (message: string) => {
  console.log(`[${nowIso()}] ${message}`);
};
const logJson = (label: string, data: unknown) => {
  console.log(`[${nowIso()}] ${label}`);
  console.log(JSON.stringify(data, null, 2));
};

// const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const maskSecret = (value: string) => {
  if (value.length <= 6) return "***";
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
};

// const parseNumber = (value: string | undefined, fallback?: number) => {
//   if (value === undefined || value === "") {
//     if (fallback !== undefined) return fallback;
//     throw new Error("Expected numeric value but got empty");
//   }
//   const num = Number(value);
//   if (Number.isNaN(num)) {
//     if (fallback !== undefined) return fallback;
//     throw new Error(`Invalid number: ${value}`);
//   }
//   return num;
// };

// const roundToPrecision = (value: number, precision: number) => {
//   const factor = Math.pow(10, precision);
//   return Math.round(value * factor) / factor;
// };

const normalizeSymbolList = (raw: string | undefined) => {
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

const assertEnv = () => {
  const missing = REQUIRED_ENVS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
};

// const buildOrderParams = (symbol: string, markPrice: number, pricePrecision: number) => {
//   const rawOrderType = (process.env.TEST_ORDER_TYPE || "limit").toLowerCase();
//   const rawOrderSide = (process.env.TEST_ORDER_SIDE || "buy").toLowerCase();
//   const orderType: TOrderType = rawOrderType === "market" ? "market" : "limit";
//   const orderSide: TOrderSide = rawOrderSide === "sell" ? "sell" : "buy";

//   const baseAmt = parseNumber(process.env.TEST_ORDER_BASE_AMT, 1);
//   const explicitPrice = process.env.TEST_ORDER_PRICE
//     ? parseNumber(process.env.TEST_ORDER_PRICE)
//     : undefined;
//   const offsetPct = parseNumber(process.env.TEST_ORDER_PRICE_OFFSET_PCT, 1);

//   let orderPrice: number | undefined = undefined;
//   if (orderType === "limit") {
//     const direction = orderSide === "buy" ? -1 : 1;
//     const computed = markPrice * (1 + direction * offsetPct / 100);
//     orderPrice = roundToPrecision(explicitPrice ?? computed, pricePrecision);
//   }

//   return {
//     orderType,
//     orderSide,
//     baseAmt,
//     orderPrice,
//   };
// };

const main = async () => {
  log("Starting Kraken Futures API test runner (LIVE account)");

  const adapterRaw = (process.env.EXCHANGE_ADAPTER || "kraken").toLowerCase();
  const adapter = adapterRaw === "2" ? "kraken" : adapterRaw;
  if (!process.env.EXCHANGE_ADAPTER) {
    process.env.EXCHANGE_ADAPTER = "kraken";
    log("EXCHANGE_ADAPTER not set, defaulting to kraken");
  }
  if (adapter !== "kraken") {
    throw new Error(`This script is Futures-only. Set EXCHANGE_ADAPTER=kraken (got ${adapterRaw}).`);
  }

  assertEnv();

  const apiKey = process.env.API_KEY!;
  const apiSecret = process.env.API_SECRET!;
  const symbols = normalizeSymbolList(process.env.SYMBOL);
  if (symbols.length === 0) {
    throw new Error("SYMBOL env var is empty");
  }

  const mainSymbol = symbols[0];

  logJson("Env summary (Futures only)", {
    EXCHANGE_ADAPTER: process.env.EXCHANGE_ADAPTER,
    API_KEY: maskSecret(apiKey),
    API_SECRET: maskSecret(apiSecret),
    SYMBOLS: symbols,
  });
  logJson("Kraken Futures endpoints", {
    restBase: "https://futures.kraken.com",
    restPrefix: "/derivatives/api/v3",
    wsUrl: "wss://futures.kraken.com/ws/v1",
  });

  log(`Configuring ExchangeService for symbol: ${mainSymbol}`);
  await ExchangeService.configure(apiKey, apiSecret, symbols);
  log("ExchangeService configured");

  // const priceLogEveryN = Math.max(1, parseNumber(process.env.PRICE_LOG_EVERY_N, 1));
  // let priceTick = 0;
  // const unhookPrice = ExchangeService.hookPriceListenerWithTimestamp(
  //   mainSymbol,
  //   (price, timestamp) => {
  //     priceTick += 1;
  //     if (priceTick % priceLogEveryN === 0) {
  //       logJson("WS price update", { symbol: mainSymbol, price, timestamp });
  //     }
  //   },
  // );

  // const unhookOrder = ExchangeService.hookOrderListener((update) => {
  //   logJson("WS order update", update);
  // });

  const balances = await ExchangeService.getBalances();
  const balancesOfUSDT = balances.find((item) => item.coin === 'USDT');
  logJson("Futures balances", balancesOfUSDT);

  const setLeverage = await ExchangeService.setLeverage(mainSymbol, 12);
  logJson("Set leverage", {
    symbol: mainSymbol,
    leverage: 12,
    setLeverage,
  });

  // const symbolInfo = await ExchangeService.getSymbolInfo(mainSymbol);
  // logJson("Symbol info", symbolInfo);

  // const markPrice = await ExchangeService.getMarkPrice(mainSymbol);
  // logJson("Current mark price", { symbol: mainSymbol, markPrice });

  // const openedPositions = await ExchangeService.getOpenedPositions();
  // logJson("Opened positions", openedPositions ?? []);

  // log("Preparing to place a test order (live account)");
  // const clientOrderId = await ExchangeService.generateClientOrderId();
  // const orderParams = buildOrderParams(mainSymbol, markPrice, symbolInfo.pricePrecision);
  // logJson("Order params", { symbol: mainSymbol, clientOrderId, ...orderParams });

  // const placeResponse = await ExchangeService.placeOrder({
  //   symbol: mainSymbol,
  //   clientOrderId,
  //   orderType: orderParams.orderType,
  //   orderSide: orderParams.orderSide,
  //   baseAmt: orderParams.baseAmt,
  //   orderPrice: orderParams.orderPrice,
  // });
  // logJson("Place order response", placeResponse);

  // await sleep(parseNumber(process.env.WAIT_AFTER_PLACE_MS, 3000));

  // const orderDetail = await ExchangeService.getOrderDetail(mainSymbol, clientOrderId);
  // logJson("Order detail", orderDetail ?? { note: "Order detail not found" });

  // const tradeList = await ExchangeService.getTradeList(mainSymbol, clientOrderId);
  // logJson("Trade list", tradeList);

  // const activeOrders = await ExchangeService.getActiveOrders(mainSymbol);
  // logJson("Active orders", activeOrders);

  // if (orderParams.orderType === "limit") {
  //   log("Attempting to cancel test order (limit order)");
  //   const cancelResponse = await ExchangeService.cancelOrder(mainSymbol, clientOrderId);
  //   logJson("Cancel order response", cancelResponse);
  //   await sleep(parseNumber(process.env.WAIT_AFTER_CANCEL_MS, 2000));
  // }

  // const position = await ExchangeService.getPosition(mainSymbol);
  // logJson("Position for symbol", position ?? { note: "No open position" });

  // const positionsHistory = await ExchangeService.getPositionsHistory({});
  // logJson("Positions history", positionsHistory);

  // log("Waiting briefly for websocket events...");
  // await sleep(parseNumber(process.env.WS_LISTEN_MS, 5000));

  // unhookOrder();
  // unhookPrice();

  log("Kraken Futures API test completed");
};

main().catch((error) => {
  log("Kraken Futures API test failed");
  if (error instanceof Error) {
    logJson("Error details", { message: error.message, stack: error.stack });
  } else {
    logJson("Error details", error);
  }
  process.exitCode = 1;
});