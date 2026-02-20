import ExchangeService from "@/services/exchange-service/exchange-service";
import { IOrder, IPosition, TPositionSide } from "@/services/exchange-service/exchange-type";
import BigNumber from "bignumber.js";
import { isTransientError, withRetries } from "../breakout-bot/bb-retry";
import TelegramService from "@/services/telegram.service";
import TrailMultiplierOptimizationBot from "./trail-multiplier-optimization-bot";

export interface IOrderFillUpdate {
  updateTime: number;
  executionPrice: number;
}

class TMOBOrderExecutor {
  constructor(private bot: TrailMultiplierOptimizationBot) { }

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
      console.warn(`[TMOB] Quote amount ${sanitized} is below min notional ${minNotional}, adjusting to min.`);
      sanitized = minNotional;
    }
    return this.formatQuoteAmount(sanitized);
  }

  private sanitizeBaseQty(rawBaseAmt: number): number {
    let sanitized = this.formatBaseAmount(rawBaseAmt);
    const maxMarketQty = this.bot.symbolInfo?.maxMktOrderQty;
    if (maxMarketQty && sanitized > maxMarketQty) {
      console.warn(`[TMOB] Base quantity ${sanitized} exceeds max market qty ${maxMarketQty}, capping value.`);
      sanitized = maxMarketQty;
    }
    return sanitized;
  }

  private calcBaseQtyFromQuote(quoteAmt: number, price: number): number {
    if (price <= 0) {
      throw new Error(`[TMOB] Invalid price (${price}) when calculating base quantity from quote ${quoteAmt}`);
    }
    const baseQty = new BigNumber(quoteAmt).div(price).toNumber();
    return this.sanitizeBaseQty(baseQty);
  }

  private formatOrderDetailMsg(order: IOrder, label: string): string {
    const created = new Date(order.createdTs).toISOString();
    const updated = new Date(order.updateTs).toISOString();
    const feeStr = order.fee ? `${order.fee.currency} ${order.fee.amt}` : "—";
    return (
      `📋 ${label}\n` +
      `Order ID: ${order.id}\n` +
      `Client Order ID: ${order.clientOrderId}\n` +
      `Symbol: ${order.symbol} | Side: ${order.side.toUpperCase()} | Type: ${order.type}\n` +
      `Status: ${order.status}\n` +
      `Avg Price: ${order.avgPrice} | Qty: ${order.orderQuantity} | Exec Qty: ${order.execQty}\n` +
      `Exec Value: ${order.execValue} | Fee: ${feeStr}\n` +
      `Created: ${created}\n` +
      `Updated: ${updated}`
    );
  }

  async triggerOpenSignal(posDir: TPositionSide, openBalanceAmt: string): Promise<IPosition> {
    await this.bot.ensureSymbolInfoLoaded();

    const quoteAmt = Number(openBalanceAmt);
    if (!Number.isFinite(quoteAmt) || quoteAmt <= 0) {
      throw new Error(`Invalid quote amount supplied for open signal: ${openBalanceAmt}`);
    }

    const sanitizedQuoteAmt = this.sanitizeQuoteAmount(quoteAmt);
    const rawMarkPrice = await withRetries(
      () => ExchangeService.getMarkPrice(this.bot.symbol),
      {
        label: "[TMOB] getMarkPrice (open)",
        retries: 5,
        minDelayMs: 5000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) => {
          console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
        },
      }
    );
    const markPrice = this.formatPrice(rawMarkPrice) ?? rawMarkPrice;
    const baseAmt = this.calcBaseQtyFromQuote(sanitizedQuoteAmt, markPrice);

    if (!Number.isFinite(baseAmt) || baseAmt <= 0) {
      throw new Error(`[TMOB] Invalid base amount (${baseAmt}) calculated from quote ${sanitizedQuoteAmt}`);
    }

    const orderSide = posDir === "long" ? "buy" : "sell";
    const clientOrderId = await ExchangeService.generateClientOrderId();
    this.bot.lastOpenClientOrderId = clientOrderId;
    const orderHandle = this.bot.orderWatcher?.preRegister(clientOrderId);
    try {
      console.log(
        `[TMOB] Placing ${orderSide.toUpperCase()} market order (quote: ${sanitizedQuoteAmt}, base: ${baseAmt}) for ${this.bot.symbol}`
      );
      const orderResp = await withRetries(
        async () => {
          try {
            const orderResp = await ExchangeService.placeOrder({
              symbol: this.bot.symbol,
              orderType: "market",
              orderSide,
              baseAmt,
              clientOrderId,
            });
            return orderResp;
          } catch (error) {
            try {
              const existing = await ExchangeService.getOrderDetail(this.bot.symbol, clientOrderId);
              if (existing) {
                console.warn(
                  `[TMOB] placeOrder failed but order exists (clientOrderId=${clientOrderId}), continuing.`
                );
                return;
              }
            } catch (lookupErr) {
              console.warn(
                `[TMOB] Failed to verify order existence (clientOrderId=${clientOrderId}):`,
                lookupErr
              );
            }
            throw error;
          }
        },
        {
          label: "[TMOB] placeOrder (open)",
          retries: 5,
          minDelayMs: 5000,
          isTransientError,
          onRetry: ({ attempt, delayMs, error, label }) => {
            console.warn(
              `${label} retrying (attempt=${attempt}, delayMs=${delayMs}, clientOrderId=${clientOrderId}):`,
              error
            );
          },
        }
      );
      console.log("orderResp: ", orderResp);

      let fillUpdate: IOrderFillUpdate | undefined;
      try {
        const fillUpdateResp = await orderHandle?.wait();
        fillUpdate = {
          updateTime: fillUpdateResp?.updateTime ?? 0,
          executionPrice: fillUpdateResp?.executionPrice ?? 0,
        };
      } catch (error) {
        console.error("Error waiting for fill update: ", error);
        console.log("Checking for order execution manually...");

        const orderDetail = await ExchangeService.getOrderDetail(this.bot.symbol, clientOrderId);
        fillUpdate = {
          updateTime: orderDetail?.updateTs ?? 0,
          executionPrice: orderDetail?.avgPrice ?? 0,
        };
      }

      console.log("fillUpdate: ", fillUpdate);
      if (!fillUpdate) {
        throw new Error("[Order fill watcher] Something went wrong No fill update found, order execution not detected, please check...");
      }

      const openedPosition = await withRetries(
        () => ExchangeService.getPosition(this.bot.symbol),
        {
          label: "[TMOB] getPosition (open)",
          retries: 5,
          minDelayMs: 5000,
          isTransientError,
          onRetry: ({ attempt, delayMs, error, label }) => {
            console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
          },
        }
      );
      if (!openedPosition || openedPosition.side !== posDir) {
        throw new Error(`[TMOB] Position not detected after ${orderSide} order submission`);
      }

      const fillPrice = fillUpdate?.executionPrice ?? openedPosition.avgPrice;
      const fillTime = fillUpdate?.updateTime ? new Date(fillUpdate.updateTime) : new Date();
      this.bot.entryWsPrice = { price: fillPrice, time: fillTime };

      const openOrderDetail = await ExchangeService.getOrderDetail(this.bot.symbol, clientOrderId);
      if (openOrderDetail) {
        TelegramService.queueMsg(this.formatOrderDetailMsg(openOrderDetail, "OPEN ORDER"));
      }

      return openedPosition;
    } catch (error) {
      orderHandle?.cancel();
      throw error;
    }
  }

  async triggerCloseSignal(position?: IPosition): Promise<IPosition> {
    await this.bot.ensureSymbolInfoLoaded();
    const targetPosition = position || this.bot.currActivePosition || (await withRetries(
      () => ExchangeService.getPosition(this.bot.symbol),
      {
        label: "[TMOB] getPosition (close)",
        retries: 5,
        minDelayMs: 5000,
        isTransientError,
        onRetry: ({ attempt, delayMs, error, label }) => {
          console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
        },
      }
    ));
    if (!targetPosition) {
      throw new Error("[TMOB] No active position found to close");
    }

    const baseAmt = this.sanitizeBaseQty(Math.abs(targetPosition.size));
    if (!Number.isFinite(baseAmt) || baseAmt <= 0) {
      throw new Error("[TMOB] Target position size is zero, cannot close position");
    }

    const orderSide = targetPosition.side === "long" ? "sell" : "buy";
    const clientOrderId = await ExchangeService.generateClientOrderId();
    this.bot.lastCloseClientOrderId = clientOrderId;
    const orderHandle = this.bot.orderWatcher?.preRegister(clientOrderId);
    this.bot.trackCloseOrderId(clientOrderId);
    try {
      console.log(
        `[TMOB] Placing ${orderSide.toUpperCase()} market order (base: ${baseAmt}) to close position ${targetPosition.id}`
      );
      await withRetries(
        async () => {
          try {
            await ExchangeService.placeOrder({
              symbol: targetPosition.symbol,
              orderType: "market",
              orderSide,
              baseAmt,
              clientOrderId,
            });
            return;
          } catch (error) {
            try {
              const existing = await ExchangeService.getOrderDetail(targetPosition.symbol, clientOrderId);
              if (existing) {
                console.warn(
                  `[TMOB] close placeOrder failed but order exists (clientOrderId=${clientOrderId}), continuing.`
                );
                return;
              }
            } catch (lookupErr) {
              console.warn(
                `[TMOB] Failed to verify close order existence (clientOrderId=${clientOrderId}):`,
                lookupErr
              );
            }
            throw error;
          }
        },
        {
          label: "[TMOB] placeOrder (close)",
          retries: 5,
          minDelayMs: 5000,
          isTransientError,
          onRetry: ({ attempt, delayMs, error, label }) => {
            console.warn(
              `${label} retrying (attempt=${attempt}, delayMs=${delayMs}, clientOrderId=${clientOrderId}):`,
              error
            );
          },
        }
      );

      let fillUpdate: IOrderFillUpdate | undefined;
      try {
        const fillUpdateResp = await orderHandle?.wait();
        fillUpdate = {
          updateTime: fillUpdateResp?.updateTime ?? 0,
          executionPrice: fillUpdateResp?.executionPrice ?? 0,
        };
      } catch (error) {
        console.error("Error waiting for fill update: ", error);
        console.log("Checking for order execution manually...");

        const orderDetail = await ExchangeService.getOrderDetail(targetPosition.symbol, clientOrderId);
        fillUpdate = {
          updateTime: orderDetail?.updateTs ?? 0,
          executionPrice: orderDetail?.avgPrice ?? 0,
        };
      }

      console.log("fillUpdate: ", fillUpdate);
      if (!fillUpdate) {
        throw new Error("[Order fill watcher] Something went wrong No fill update found, order execution not detected, please check...");
      }

      const closedPosition = await this.fetchClosedPositionSnapshot(targetPosition.id);
      if (!closedPosition || typeof closedPosition.closePrice !== "number") {
        throw new Error(`[TMOB] Failed to retrieve closed position snapshot for id ${targetPosition.id}`);
      }

      const resolvePrice = fillUpdate?.executionPrice ?? closedPosition.closePrice ?? closedPosition.avgPrice;
      const resolveTime = fillUpdate?.updateTime ? new Date(fillUpdate.updateTime) : new Date();
      this.bot.resolveWsPrice = { price: resolvePrice, time: resolveTime };

      const closeOrderDetail = await ExchangeService.getOrderDetail(targetPosition.symbol, clientOrderId);
      if (closeOrderDetail) {
        TelegramService.queueMsg(this.formatOrderDetailMsg(closeOrderDetail, "CLOSE ORDER"));
      }

      return closedPosition;
    } catch (error) {
      orderHandle?.cancel();
      throw error;
    } finally {
      this.bot.untrackCloseOrderId(clientOrderId);
    }
  }

  async fetchClosedPositionSnapshot(positionId: number, maxRetries = 5): Promise<IPosition | undefined> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const history = await ExchangeService.getPositionsHistory({ positionId });
      const position = history[0];
      if (position && typeof position.closePrice === "number") {
        return position;
      }
      if (attempt < maxRetries - 1) {
        const delayMs = 200 * Math.pow(2, attempt);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    return undefined;
  }
}

export default TMOBOrderExecutor;
