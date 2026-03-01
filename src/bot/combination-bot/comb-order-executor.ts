import ExchangeService from "@/services/exchange-service/exchange-service";
import { IOrder, IPosition, IWSPositionUpdate, TPositionSide } from "@/services/exchange-service/exchange-type";
import BigNumber from "bignumber.js";
import { withRetries, isTransientError } from "./comb-retry";
import type { IOrderFillUpdate } from "./comb-types";
import type CombBotInstance from "./comb-bot-instance";
import { createSettleOnce } from "../trail-multiplier-optimization-bot/tmob-order-executor";

class CombOrderExecutor {
  constructor(private bot: CombBotInstance) { }

  POSITION_OVERALL_TIMEOUT_MS = 60_000;
  REST_POLL_INTERVAL_MS = 5000;
  REST_POLL_ATTEMPTS = 12;


  private formatWithPrecision(value: number, precision?: number): number {
    if (!Number.isFinite(value) || precision === undefined) return value;
    return new BigNumber(value).decimalPlaces(precision, BigNumber.ROUND_DOWN).toNumber();
  }

  private formatPrice(value: number): number | undefined {
    return this.formatWithPrecision(value, this.bot.symbolInfo?.pricePrecision);
  }

  private formatQuoteAmount(value: number): number {
    return this.formatWithPrecision(value, this.bot.symbolInfo?.quotePrecision);
  }

  private formatBaseAmount(value: number): number {
    return this.formatWithPrecision(value, this.bot.symbolInfo?.basePrecision);
  }

  private sanitizeQuoteAmount(rawQuoteAmt: number): number {
    const minNotional = this.bot.symbolInfo?.minNotionalValue;
    let sanitized = rawQuoteAmt;
    if (minNotional && sanitized < minNotional) {
      console.warn(`[COMB] Quote amount ${sanitized} below min notional ${minNotional}, adjusting.`);
      sanitized = minNotional;
    }
    return this.formatQuoteAmount(sanitized);
  }

  private sanitizeBaseQty(rawBaseAmt: number): number {
    let sanitized = this.formatBaseAmount(rawBaseAmt);
    const maxMarketQty = this.bot.symbolInfo?.maxMktOrderQty;
    if (maxMarketQty && sanitized > maxMarketQty) {
      console.warn(`[COMB] Base qty ${sanitized} exceeds max ${maxMarketQty}, capping.`);
      sanitized = maxMarketQty;
    }
    return sanitized;
  }

  private calcBaseQtyFromQuote(quoteAmt: number, price: number): number {
    if (price <= 0) throw new Error(`[COMB] Invalid price (${price}) for quote ${quoteAmt}`);
    return this.sanitizeBaseQty(new BigNumber(quoteAmt).div(price).toNumber());
  }

  private formatOrderDetailMsg(order: IOrder, label: string): string {
    const feeStr = order.fee ? `${order.fee.currency} ${order.fee.amt}` : "—";
    return `📋 ${label}\nOrder ID: ${order.id}\nClient Order ID: ${order.clientOrderId}\nSymbol: ${order.symbol} | Side: ${order.side.toUpperCase()} | Type: ${order.type}\nStatus: ${order.status}\nAvg Price: ${order.avgPrice} | Qty: ${order.orderQuantity} | Exec Qty: ${order.execQty}\nExec Value: ${order.execValue} | Fee: ${feeStr}\nCreated: ${new Date(order.createdTs).toISOString()}\nUpdated: ${new Date(order.updateTs).toISOString()}`;
  }

  async triggerOpenSignal(posDir: TPositionSide, openBalanceAmt: string): Promise<IPosition> {
    const quoteAmt = Number(openBalanceAmt);
    if (!Number.isFinite(quoteAmt) || quoteAmt <= 0) throw new Error(`[COMB] Invalid quote amount: ${openBalanceAmt}`);
    const sanitizedQuoteAmt = this.sanitizeQuoteAmount(quoteAmt);
    const rawMarkPrice = await withRetries(() => ExchangeService.getMarkPrice(this.bot.symbol), { label: "[COMB] getMarkPrice (open)", retries: 5, minDelayMs: 5000, isTransientError, onRetry: (o) => console.warn(`${o.label} retrying:`, o.error) });
    const markPrice = this.formatPrice(rawMarkPrice) ?? rawMarkPrice;
    const baseAmt = this.calcBaseQtyFromQuote(sanitizedQuoteAmt, markPrice);
    if (!Number.isFinite(baseAmt) || baseAmt <= 0) throw new Error(`[COMB] Invalid base amount from quote ${sanitizedQuoteAmt}`);
    const orderSide = posDir === "long" ? "buy" : "sell";
    const clientOrderId = await ExchangeService.generateClientOrderId();
    this.bot.lastOpenClientOrderId = clientOrderId;
    // Parallel position detection: REST poll (every 5s, 12 times) + WebSocket (60s; on update fetch via REST once). First success wins.
    const { promise: winnerPromise, tryResolve: trySettle, tryReject } = createSettleOnce<IPosition>();

    const unsubscribePosition = ExchangeService.hookPositionUpdateListener((update: IWSPositionUpdate) => {
      if (update.symbol !== this.bot.symbol || update.side !== posDir || update.size <= 0) return;
      void (async () => {
        const pos = await ExchangeService.getPosition(this.bot.symbol);
        if (pos && pos.side === posDir) trySettle(pos);
      })();
    });

    const orderHandle = this.bot.orderWatcher?.preRegister(clientOrderId);
    try {
      console.log(`[COMB] Placing ${orderSide.toUpperCase()} market order (quote: ${sanitizedQuoteAmt}, base: ${baseAmt}) for ${this.bot.symbol}`);
      const orderResp = await withRetries(
        async () => {
          try {
            return await ExchangeService.placeOrder({ symbol: this.bot.symbol, orderType: "market", orderSide, baseAmt, clientOrderId });
          } catch (err) {
            const existing = await ExchangeService.getOrderDetail(this.bot.symbol, clientOrderId);
            if (existing) { console.warn(`[COMB] placeOrder failed but order exists (clientOrderId=${clientOrderId})`); return; }
            throw err;
          }
        },
        { label: "[COMB] placeOrder (open)", retries: 5, minDelayMs: 5000, isTransientError, onRetry: (o) => console.warn(`${o.label} retrying:`, o.error) }
      );
      if (!orderResp) throw new Error("[COMB] Failed to place order");
      console.log("[COMB] orderResp: ", orderResp);

      let fillUpdate: IOrderFillUpdate | undefined;
      try {
        const fillUpdateResp = await orderHandle?.wait();
        console.log("[COMB] fillUpdateResp: ", fillUpdateResp);
        fillUpdate = { updateTime: fillUpdateResp?.updateTime ?? 0, executionPrice: fillUpdateResp?.executionPrice ?? 0 };
      } catch {
        const orderDetail = await withRetries(() => ExchangeService.getOrderDetail(this.bot.symbol, clientOrderId), { label: "[COMB] getOrderDetail (open)", retries: 5, minDelayMs: 5000, isTransientError, onRetry: ({ attempt, delayMs, error, label }) => { console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error); } });
        console.log("[COMB] Order Detail: ", orderDetail);
        fillUpdate = { updateTime: orderDetail?.updateTs ?? 0, executionPrice: orderDetail?.avgPrice ?? 0 };
      }

      // Start position detection only after order is placed and we have fill: 60s timeout + REST poll every 5s (12 times)
      const overallTimeout = setTimeout(
        () => tryReject(new Error(`[COMB] Position not detected within ${this.POSITION_OVERALL_TIMEOUT_MS / 1000}s (REST poll + WebSocket)`)),
        this.POSITION_OVERALL_TIMEOUT_MS
      );

      const openOrderDetail = await withRetries(() => ExchangeService.getOrderDetail(this.bot.symbol, clientOrderId), { label: "[COMB] getOrderDetail (open)", retries: 5, minDelayMs: 5000, isTransientError, onRetry: ({ attempt, delayMs, error, label }) => { console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error); } });
      if (openOrderDetail) this.bot.queueMsg(this.formatOrderDetailMsg(openOrderDetail, "OPEN ORDER"));

      void (async () => {
        for (let i = 0; i < this.REST_POLL_ATTEMPTS; i++) {
          const pos = await ExchangeService.getPosition(this.bot.symbol);
          if (pos && pos.side === posDir) {
            trySettle(pos);
            return;
          }
          this.bot.queueMsg(`🚸🚸🚸 Position not detected yet, retrying... (${i + 1}/${this.REST_POLL_ATTEMPTS})`);
          if (i < this.REST_POLL_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, this.REST_POLL_INTERVAL_MS));
        }
      })();

      // Await first success from REST poll or WebSocket (then REST); clear timeout on done
      let openedPosition: IPosition;
      try {
        openedPosition = await winnerPromise;
      } finally {
        clearTimeout(overallTimeout);
      }

      console.log(
        `[COMB] openFilled symbol=${this.bot.symbol} side=${posDir} positionId=${openedPosition.id} avgPrice=${openedPosition.avgPrice} size=${openedPosition.size} clientOrderId=${clientOrderId}`
      );
      this.bot.entryWsPrice = { price: fillUpdate?.executionPrice ?? openedPosition.avgPrice, time: fillUpdate?.updateTime ? new Date(fillUpdate.updateTime) : new Date() };
      return openedPosition;
    } catch (e) {
      orderHandle?.cancel();
      throw e;
    } finally {
      unsubscribePosition();
    }
  }

  async triggerCloseSignal(position?: IPosition): Promise<IPosition> {
    const cachedPosition = position || this.bot.currActivePosition;
    const livePosition = await withRetries(
      () => ExchangeService.getPosition(this.bot.symbol),
      { label: "[COMB] getPosition (close)", retries: 5, minDelayMs: 5000, isTransientError, onRetry: (o) => console.warn(`${o.label} retrying:`, o.error) }
    );
    if (!livePosition) {
      if (cachedPosition) {
        const closedPosition = await this.fetchClosedPositionSnapshot(cachedPosition.id);
        if (closedPosition && typeof closedPosition.closePrice === "number") {
          return closedPosition;
        }
      }
      throw new Error("[COMB] No active position to close");
    }
    const targetPosition = livePosition;
    const baseAmt = this.sanitizeBaseQty(Math.abs(targetPosition.size));
    if (!Number.isFinite(baseAmt) || baseAmt <= 0) throw new Error("[COMB] Target position size is zero");
    const orderSide = targetPosition.side === "long" ? "sell" : "buy";
    const clientOrderId = await ExchangeService.generateClientOrderId();
    this.bot.lastCloseClientOrderId = clientOrderId;
    const orderHandle = this.bot.orderWatcher?.preRegister(clientOrderId);
    this.bot.trackCloseOrderId(clientOrderId);
    try {
      console.log(`[COMB] Placing ${orderSide.toUpperCase()} market order (base: ${baseAmt}) to close position ${targetPosition.id}`);
      const orderResp = await withRetries(
        async () => {
          try {
            return await ExchangeService.placeOrder({ symbol: targetPosition.symbol, orderType: "market", orderSide, baseAmt, clientOrderId });
          } catch (err) {
            const existing = await ExchangeService.getOrderDetail(targetPosition.symbol, clientOrderId);
            if (existing) { console.warn(`[COMB] close placeOrder failed but order exists`); return; }
            throw err;
          }
        },
        { label: "[COMB] placeOrder (close)", retries: 5, minDelayMs: 5000, isTransientError, onRetry: (o) => console.warn(`${o.label} retrying:`, o.error) }
      );
      console.log("[COMB] orderResp: ", orderResp);
      let fillUpdate: IOrderFillUpdate | undefined;
      try {
        const fillUpdateResp = await orderHandle?.wait();
        console.log("[COMB] fillUpdateResp: ", fillUpdateResp);
        fillUpdate = { updateTime: fillUpdateResp?.updateTime ?? 0, executionPrice: fillUpdateResp?.executionPrice ?? 0 };
      } catch {
        const orderDetail = await ExchangeService.getOrderDetail(targetPosition.symbol, clientOrderId);
        console.log("[COMB] Order Detail: ", orderDetail);
        fillUpdate = { updateTime: orderDetail?.updateTs ?? 0, executionPrice: orderDetail?.avgPrice ?? 0 };
      }
      const closedPosition = await this.fetchClosedPositionSnapshot(targetPosition.id);
      if (!closedPosition || typeof closedPosition.closePrice !== "number") throw new Error(`[COMB] Failed to get closed position id ${targetPosition.id}`);
      const realizedPnl = typeof closedPosition.realizedPnl === "number" ? closedPosition.realizedPnl : (closedPosition as any).realizedPnl ?? 0;
      console.log(
        `[COMB] closeFilled symbol=${this.bot.symbol} positionId=${closedPosition.id} closePrice=${closedPosition.closePrice} realizedPnl=${realizedPnl.toFixed(4)} clientOrderId=${clientOrderId}`
      );
      this.bot.resolveWsPrice = { price: fillUpdate?.executionPrice ?? closedPosition.closePrice ?? closedPosition.avgPrice, time: fillUpdate?.updateTime ? new Date(fillUpdate.updateTime) : new Date() };
      const closeOrderDetail = await ExchangeService.getOrderDetail(targetPosition.symbol, clientOrderId);
      if (closeOrderDetail) this.bot.queueMsg(this.formatOrderDetailMsg(closeOrderDetail, "CLOSE ORDER"));
      return closedPosition;
    } catch (e) {
      orderHandle?.cancel();
      throw e;
    } finally {
      this.bot.untrackCloseOrderId(clientOrderId);
    }
  }

  async fetchClosedPositionSnapshot(positionId: number, maxRetries = 5): Promise<IPosition | undefined> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const history = await ExchangeService.getPositionsHistory({ positionId });
      const position = history[0];
      if (position && typeof position.closePrice === "number") return position;
      if (attempt < maxRetries - 1) await new Promise((r) => setTimeout(r, 200 * Math.pow(2, attempt)));
    }
    return undefined;
  }
}

export default CombOrderExecutor;
