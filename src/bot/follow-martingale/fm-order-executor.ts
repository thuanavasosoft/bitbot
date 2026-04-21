import BigNumber from "bignumber.js";
import ExchangeService from "@/services/exchange-service/exchange-service";
import type { IOrder, IPosition, IWSPositionUpdate, TOrderSide, TPositionSide } from "@/services/exchange-service/exchange-type";
import type FollowMartingaleBot from "./follow-martingale-bot";
import { isTransientError, withRetries } from "./fm-retry";
import { createSettleOnce } from "../trail-multiplier-optimization-bot/tmob-order-executor";

export interface IFMOrderFillUpdate {
  updateTime: number;
  executionPrice: number;
}

export interface IFMOpenOrderResult {
  position: IPosition;
  fillUpdate: IFMOrderFillUpdate;
  clientOrderId: string;
  baseQty: number;
}

class FMOrderExecutor {
  POSITION_OVERALL_TIMEOUT_MS = 60_000;
  REST_POLL_INTERVAL_MS = 5_000;
  REST_POLL_ATTEMPTS = 12;

  constructor(private bot: FollowMartingaleBot) {}

  private formatWithPrecision(value: number, precision?: number): number {
    if (!Number.isFinite(value) || precision === undefined) return value;
    return new BigNumber(value).decimalPlaces(precision, BigNumber.ROUND_DOWN).toNumber();
  }

  private formatPrice(value: number): number | undefined {
    return this.formatWithPrecision(value, this.bot.symbolInfo?.pricePrecision);
  }

  private formatBaseAmount(value: number): number {
    return this.formatWithPrecision(value, this.bot.symbolInfo?.basePrecision);
  }

  private sanitizeBaseQty(rawBaseAmt: number, orderType: "market" | "limit" = "market"): number {
    let sanitized = this.formatBaseAmount(rawBaseAmt);
    const maxQty =
      orderType === "market" ? this.bot.symbolInfo?.maxMktOrderQty : this.bot.symbolInfo?.maxLimitOrderQty;
    if (maxQty && sanitized > maxQty) {
      console.warn(`[FM] Base qty ${sanitized} exceeds max ${maxQty}, capping.`);
      sanitized = maxQty;
    }
    return sanitized;
  }

  private calcBaseQtyFromQuote(quoteAmt: number, price: number): number {
    if (price <= 0) throw new Error(`[FM] Invalid price (${price}) for quote ${quoteAmt}`);
    return this.sanitizeBaseQty(new BigNumber(quoteAmt).div(price).toNumber(), "market");
  }

  private formatOrderDetailMsg(order: Omit<IOrder, "fee">, label: string): string {
    return `📋 ${label}
Order ID: ${order.id}
Client Order ID: ${order.clientOrderId}
Symbol: ${order.symbol} | Side: ${order.side.toUpperCase()} | Type: ${order.type}
Status: ${order.status}
Avg Price: ${order.avgPrice} | Qty: ${order.orderQuantity} | Exec Qty: ${order.execQty}
Exec Value: ${order.execValue}
Created: ${new Date(order.createdTs).toISOString()}
Updated: ${new Date(order.updateTs).toISOString()}`;
  }

  private async verifyExistingOrder(clientOrderId: string): Promise<IOrder | undefined> {
    return withRetries(() => ExchangeService.getOrderDetail(this.bot.symbol, clientOrderId), {
      label: "[FM] getOrderDetail existing",
      retries: 5,
      minDelayMs: 5000,
      isTransientError,
      onRetry: ({ attempt, delayMs, error, label }) =>
        console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
    });
  }

  private async getFillUpdate(clientOrderId: string): Promise<IFMOrderFillUpdate> {
    const orderDetail = await withRetries(() => ExchangeService.getOrderDetail(this.bot.symbol, clientOrderId), {
      label: "[FM] getOrderDetail",
      retries: 5,
      minDelayMs: 5000,
      isTransientError,
      onRetry: ({ attempt, delayMs, error, label }) =>
        console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
    });
    return {
      updateTime: orderDetail?.updateTs ?? 0,
      executionPrice: orderDetail?.avgPrice ?? 0,
    };
  }

  private async waitForPositionSize(targetSide: TPositionSide, previousSizeAbs: number): Promise<IPosition> {
    let cancelled = false;
    const { promise: winnerPromise, tryResolve, tryReject } = createSettleOnce<IPosition>();
    const unsubscribePosition = ExchangeService.hookPositionUpdateListener((update: IWSPositionUpdate) => {
      if (update.symbol !== this.bot.symbol || update.side !== targetSide || update.size <= previousSizeAbs) return;
      void (async () => {
        try {
          if (cancelled) return;
          const pos = await withRetries(() => ExchangeService.getPosition(this.bot.symbol), {
            label: "[FM] getPosition (ws open)",
            retries: 5,
            minDelayMs: 5000,
            isTransientError,
            onRetry: (o) => console.warn(`${o.label} retrying:`, o.error),
          });
          if (cancelled) return;
          if (pos && pos.side === targetSide && Math.abs(pos.size) > previousSizeAbs) {
            tryResolve(pos);
          }
        } catch (error) {
          if (!cancelled) {
            console.error("[FM] waitForPositionSize (ws follow-up):", error);
          }
        }
      })();
    });

    const overallTimeout = setTimeout(
      () => tryReject(new Error(`[FM] Position not detected within ${this.POSITION_OVERALL_TIMEOUT_MS / 1000}s`)),
      this.POSITION_OVERALL_TIMEOUT_MS
    );

    void (async () => {
      try {
        for (let i = 0; i < this.REST_POLL_ATTEMPTS; i++) {
          if (cancelled) return;
          const pos = await withRetries(() => ExchangeService.getPosition(this.bot.symbol), {
            label: "[FM] getPosition (http poll open)",
            retries: 5,
            minDelayMs: 5000,
            isTransientError,
            onRetry: (o) => console.warn(`${o.label} retrying:`, o.error),
          });
          if (cancelled) return;
          if (pos && pos.side === targetSide && Math.abs(pos.size) > previousSizeAbs) {
            tryResolve(pos);
            return;
          }
          if (i < this.REST_POLL_ATTEMPTS - 1) {
            await new Promise((r) => setTimeout(r, this.REST_POLL_INTERVAL_MS));
          }
        }
      } catch (error) {
        if (!cancelled) {
          console.error("[FM] waitForPositionSize (REST poll):", error);
        }
      }
    })();

    try {
      return await winnerPromise;
    } finally {
      cancelled = true;
      clearTimeout(overallTimeout);
      unsubscribePosition();
    }
  }

  async triggerOpenSignal(posDir: TPositionSide, quoteAmt: number): Promise<IFMOpenOrderResult> {
    await this.bot.ensureSymbolInfoLoaded();
    this.bot.lastOpenClientOrderId = undefined;

    const rawMarkPrice = await withRetries(() => ExchangeService.getMarkPrice(this.bot.symbol), {
      label: "[FM] getMarkPrice (open)",
      retries: 5,
      minDelayMs: 5000,
      isTransientError,
      onRetry: (o) => console.warn(`${o.label} retrying:`, o.error),
    });
    const markPrice = this.formatPrice(rawMarkPrice) ?? rawMarkPrice;
    const baseAmt = this.calcBaseQtyFromQuote(quoteAmt, markPrice);
    const clientOrderId = await ExchangeService.generateClientOrderId();
    const orderSide: TOrderSide = posDir === "long" ? "buy" : "sell";
    const orderHandle = this.bot.orderWatcher.preRegister(clientOrderId);

    try {
      await withRetries(
        async () => {
          try {
            return await ExchangeService.placeOrder({
              symbol: this.bot.symbol,
              orderType: "market",
              orderSide,
              baseAmt,
              clientOrderId,
            });
          } catch (error) {
            const existing = await this.verifyExistingOrder(clientOrderId);
            if (existing) return;
            throw error;
          }
        },
        {
          label: "[FM] placeOrder (open)",
          retries: 5,
          minDelayMs: 5000,
          isTransientError,
          onRetry: (o) => console.warn(`${o.label} retrying:`, o.error),
        }
      );

      this.bot.lastOpenClientOrderId = clientOrderId;

      let fillUpdate: IFMOrderFillUpdate;
      try {
        const fill = await orderHandle.wait();
        fillUpdate = {
          updateTime: fill.updateTime ?? 0,
          executionPrice: fill.executionPrice ?? 0,
        };
      } catch {
        fillUpdate = await this.getFillUpdate(clientOrderId);
      }

      const position = await this.waitForPositionSize(posDir, 0);
      this.bot.queueMsg(
        this.formatOrderDetailMsg(
          {
            id: clientOrderId,
            symbol: this.bot.symbol,
            avgPrice: fillUpdate.executionPrice,
            updateTs: fillUpdate.updateTime,
            execQty: baseAmt,
            clientOrderId,
            execValue: baseAmt,
            createdTs: fillUpdate.updateTime,
            orderQuantity: baseAmt,
            side: orderSide,
            status: "filled",
            type: "market",
          },
          "OPEN ORDER"
        )
      );
      return { position, fillUpdate, clientOrderId, baseQty: baseAmt };
    } catch (error) {
      orderHandle.cancel();
      throw error;
    }
  }

  async triggerAddSignal(posDir: TPositionSide, baseAmt: number, previousSizeAbs: number): Promise<IFMOpenOrderResult> {
    await this.bot.ensureSymbolInfoLoaded();
    this.bot.lastAddLegClientOrderId = undefined;

    const sanitizedBaseAmt = this.sanitizeBaseQty(baseAmt, "market");
    const clientOrderId = await ExchangeService.generateClientOrderId();
    const orderSide: TOrderSide = posDir === "long" ? "buy" : "sell";
    const orderHandle = this.bot.orderWatcher.preRegister(clientOrderId);

    try {
      await withRetries(
        async () => {
          try {
            return await ExchangeService.placeOrder({
              symbol: this.bot.symbol,
              orderType: "market",
              orderSide,
              baseAmt: sanitizedBaseAmt,
              clientOrderId,
            });
          } catch (error) {
            const existing = await this.verifyExistingOrder(clientOrderId);
            if (existing) return;
            throw error;
          }
        },
        {
          label: "[FM] placeOrder (add)",
          retries: 5,
          minDelayMs: 5000,
          isTransientError,
          onRetry: (o) => console.warn(`${o.label} retrying:`, o.error),
        }
      );

      this.bot.lastAddLegClientOrderId = clientOrderId;

      let fillUpdate: IFMOrderFillUpdate;
      try {
        const fill = await orderHandle.wait();
        fillUpdate = {
          updateTime: fill.updateTime ?? 0,
          executionPrice: fill.executionPrice ?? 0,
        };
      } catch {
        fillUpdate = await this.getFillUpdate(clientOrderId);
      }

      const position = await this.waitForPositionSize(posDir, previousSizeAbs);
      this.bot.lastAddLegClientOrderId = undefined;
      this.bot.queueMsg(
        this.formatOrderDetailMsg(
          {
            id: clientOrderId,
            symbol: this.bot.symbol,
            avgPrice: fillUpdate.executionPrice,
            updateTs: fillUpdate.updateTime,
            execQty: sanitizedBaseAmt,
            clientOrderId,
            execValue: sanitizedBaseAmt,
            createdTs: fillUpdate.updateTime,
            orderQuantity: sanitizedBaseAmt,
            side: orderSide,
            status: "filled",
            type: "market",
          },
          "ADD LEG ORDER"
        )
      );

      return { position, fillUpdate, clientOrderId, baseQty: sanitizedBaseAmt };
    } catch (error) {
      orderHandle.cancel();
      throw error;
    }
  }

  async placeTakeProfitLimit(side: TPositionSide, baseAmt: number, orderPrice: number): Promise<string> {
    await this.bot.ensureSymbolInfoLoaded();
    const clientOrderId = await ExchangeService.generateClientOrderId();
    const orderSide: TOrderSide = side === "long" ? "sell" : "buy";

    await withRetries(
      async () => {
        try {
          return await ExchangeService.placeOrder({
            symbol: this.bot.symbol,
            orderType: "limit",
            orderSide,
            baseAmt: this.sanitizeBaseQty(baseAmt, "limit"),
            orderPrice: this.formatPrice(orderPrice) ?? orderPrice,
            clientOrderId,
          });
        } catch (error) {
          const existing = await this.verifyExistingOrder(clientOrderId);
          if (existing) return;
          throw error;
        }
      },
      {
        label: "[FM] placeOrder (tp limit)",
        retries: 5,
        minDelayMs: 5000,
        isTransientError,
        onRetry: (o) => console.warn(`${o.label} retrying:`, o.error),
      }
    );

    return clientOrderId;
  }

  async triggerCloseSignal(position?: IPosition): Promise<{ closedPosition: IPosition; fillUpdate: IFMOrderFillUpdate; clientOrderId: string }> {
    const cachedPosition = position || this.bot.currActivePosition;
    const livePosition = await withRetries(() => ExchangeService.getPosition(this.bot.symbol), {
      label: "[FM] getPosition (close)",
      retries: 5,
      minDelayMs: 5000,
      isTransientError,
      onRetry: (o) => console.warn(`${o.label} retrying:`, o.error),
    });

    if (!livePosition) {
      if (cachedPosition) {
        const closedPosition = await this.fetchClosedPositionSnapshot(cachedPosition.id);
        if (closedPosition && typeof closedPosition.closePrice === "number") {
          return {
            closedPosition,
            fillUpdate: {
              updateTime: closedPosition.updateTime,
              executionPrice: closedPosition.closePrice,
            },
            clientOrderId: this.bot.lastCloseClientOrderId ?? "unknown",
          };
        }
      }
      throw new Error("[FM] No active position to close");
    }

    const targetPosition = livePosition;
    const baseAmt = this.sanitizeBaseQty(Math.abs(targetPosition.size), "market");
    if (!Number.isFinite(baseAmt) || baseAmt <= 0) throw new Error("[FM] Target position size is zero");

    const orderSide: TOrderSide = targetPosition.side === "long" ? "sell" : "buy";
    const clientOrderId = await ExchangeService.generateClientOrderId();
    this.bot.lastCloseClientOrderId = clientOrderId;
    const orderHandle = this.bot.orderWatcher.preRegister(clientOrderId);

    try {
      await withRetries(
        async () => {
          try {
            return await ExchangeService.placeOrder({
              symbol: targetPosition.symbol,
              orderType: "market",
              orderSide,
              baseAmt,
              clientOrderId,
            });
          } catch (error) {
            const existing = await this.verifyExistingOrder(clientOrderId);
            if (existing) return;
            throw error;
          }
        },
        {
          label: "[FM] placeOrder (close)",
          retries: 5,
          minDelayMs: 5000,
          isTransientError,
          onRetry: (o) => console.warn(`${o.label} retrying:`, o.error),
        }
      );

      let fillUpdate: IFMOrderFillUpdate;
      try {
        const fill = await orderHandle.wait();
        fillUpdate = {
          updateTime: fill.updateTime ?? 0,
          executionPrice: fill.executionPrice ?? 0,
        };
      } catch {
        fillUpdate = await this.getFillUpdate(clientOrderId);
      }

      const closedPosition = await this.fetchClosedPositionSnapshot(targetPosition.id);
      if (!closedPosition || typeof closedPosition.closePrice !== "number") {
        throw new Error(`[FM] Failed to get closed position id ${targetPosition.id}`);
      }

      this.bot.queueMsg(
        this.formatOrderDetailMsg(
          {
            id: clientOrderId,
            symbol: this.bot.symbol,
            avgPrice: fillUpdate.executionPrice,
            updateTs: fillUpdate.updateTime,
            execQty: baseAmt,
            clientOrderId,
            execValue: baseAmt,
            createdTs: fillUpdate.updateTime,
            orderQuantity: baseAmt,
            side: orderSide,
            status: "filled",
            type: "market",
          },
          "CLOSE ORDER"
        )
      );

      return { closedPosition, fillUpdate, clientOrderId };
    } catch (error) {
      orderHandle.cancel();
      throw error;
    }
  }

  async fetchClosedPositionSnapshot(positionId: number, maxRetries = 5): Promise<IPosition | undefined> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const history = await withRetries(() => ExchangeService.getPositionsHistory({ positionId }), {
        label: "[FM] getPositionsHistory",
        retries: 5,
        minDelayMs: 5000,
        isTransientError,
        onRetry: (o) => console.warn(`${o.label} retrying:`, o.error),
      });
      const position = history[0];
      if (position && typeof position.closePrice === "number") return position;
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 200 * Math.pow(2, attempt)));
      }
    }
    return undefined;
  }
}

export default FMOrderExecutor;
