import ExchangeService from "@/services/exchange-service/exchange-service";
import type { IWSOrderUpdate, IWSPositionUpdate } from "@/services/exchange-service/exchange-type";
import type FollowMartingaleBot from "../follow-martingale-bot";

class FMInPositionState {
  private tradeListenerRemover?: () => void;
  private orderUpdateRemover?: () => void;
  private positionUpdateRemover?: () => void;
  private refreshLoopAbort = false;
  private liquidationCheckInProgress = false;

  constructor(private bot: FollowMartingaleBot) {}

  async onEnter(): Promise<void> {
    this.refreshLoopAbort = false;
    if (!this.bot.currActivePosition) {
      throw new Error("[FM] Cannot enter in-position state without an active position");
    }
    const cycleSide = this.bot.getActiveCycleSide();
    if (!cycleSide) {
      throw new Error("[FM] Cannot enter in-position state without an active cycle side");
    }

    this.bot.queueMsg(
      `🔁 In position - monitoring ${cycleSide.toUpperCase()} cycle\nLegs: ${this.bot.legs.length}/${this.bot.maxLegs}`
    );

    this.tradeListenerRemover = ExchangeService.hookTradeListener(this.bot.symbol, (trade) => {
      void this.handleTradePrice(trade.price, trade.timestamp);
    });
    this.orderUpdateRemover = this.bot.orderWatcher.onOrderUpdate((update) => {
      void this.handleOrderUpdate(update);
    });
    this.positionUpdateRemover = ExchangeService.hookPositionUpdateListener((update) => {
      void this.handlePositionUpdate(update);
    });

    await this.bot.refreshSignalLevels();
    await this.bot.queueTakeProfitRefresh("state enter", false);
    void this.runRefreshLoop();
  }

  private async runRefreshLoop(): Promise<void> {
    while (!this.refreshLoopAbort) {
      try {
        await this.bot.refreshSignalLevels();
      } catch (error) {
        console.error("[FM] Failed to refresh signal levels (in-position):", error);
      }
      await new Promise((resolve) => setTimeout(resolve, this.bot.loopIntervalMs));
    }
  }

  private async handlePositionUpdate(update: IWSPositionUpdate): Promise<void> {
    const cycleSide = this.bot.getActiveCycleSide();
    if (!cycleSide) return;
    if (update.symbol !== this.bot.symbol || update.side !== cycleSide) return;
    if (update.size <= 0) return;

    try {
      const livePosition = await ExchangeService.getPosition(this.bot.symbol);
      if (!livePosition || livePosition.side !== cycleSide) return;

      const prevPosition = this.bot.currActivePosition;
      const avgChanged =
        !prevPosition ||
        Math.abs(prevPosition.avgPrice - livePosition.avgPrice) >= this.bot.tickSize ||
        Math.abs(Math.abs(prevPosition.size) - Math.abs(livePosition.size)) > Math.pow(10, -(this.bot.symbolInfo?.basePrecision ?? 0));

      this.bot.currActivePosition = livePosition;
      if (avgChanged) {
        await this.bot.queueTakeProfitRefresh("avg price updated", false);
      }
    } catch (error) {
      console.error("[FM] handlePositionUpdate failed:", error);
    }
  }

  private async handleOrderUpdate(update: IWSOrderUpdate): Promise<void> {
    if (!this.bot.currActivePosition) return;
    if (!this.bot.activeTpClientOrderId) return;
    if (update.clientOrderId !== this.bot.activeTpClientOrderId) return;
    if (update.orderStatus !== "filled") return;
    if (this.bot.isFinalizingPosition) return;

    try {
      this.bot.isClosingPosition = true;
      const closedPosition = await this.bot.orderExecutor.fetchClosedPositionSnapshot(this.bot.currActivePosition.id);
      if (!closedPosition) {
        throw new Error(`[FM] Could not fetch closed position snapshot for TP fill ${this.bot.currActivePosition.id}`);
      }
      this.bot.queueMsg(
        `✅ TP limit filled\nTP: ${this.bot.activeTpPrice}\nExecution: ${update.executionPrice ?? closedPosition.closePrice ?? closedPosition.avgPrice}`
      );
      const fillTimestamp = update.updateTime ?? Date.now();
      const snapshot = this.bot.buildExitSnapshot(closedPosition, "tp_limit", fillTimestamp, fillTimestamp, false);
      await this.bot.finalizeClosedPosition(snapshot);
    } catch (error) {
      console.error("[FM] TP fill finalization failed:", error);
      this.bot.queueMsg(`⚠️ Failed to finalize TP close: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handleTradePrice(price: number, tradeTimeMs: number): Promise<void> {
    try {
      this.bot.latestTradePrice = price;
      this.bot.latestTradeTimeMs = tradeTimeMs;

      if (!this.bot.currActivePosition || this.bot.isFinalizingPosition) return;

      await this.maybeCheckLiquidation(price);
      if (!this.bot.currActivePosition || this.bot.isFinalizingPosition) return;

      if (!this.bot.isClosingPosition && this.shouldTriggerStopLoss(price)) {
        await this.triggerStopLossClose();
        return;
      }

      if (!this.bot.isClosingPosition && !this.bot.isAddInFlight && this.shouldAddLeg(price)) {
        await this.addNextLeg();
      }
    } catch (error) {
      console.error("[FM] handleTradePrice failed:", error);
      this.bot.queueMsg(`⚠️ In-position trade handler error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private shouldAddLeg(price: number): boolean {
    if (!this.bot.currActivePosition) return false;
    const cycleSide = this.bot.getActiveCycleSide();
    if (!cycleSide) return false;
    if (this.bot.legs.length >= this.bot.maxLegs) return false;

    const nextAllowedAt = this.bot.getNextAddAllowedAtMs();
    if (nextAllowedAt !== undefined && Date.now() < nextAllowedAt) return false;

    const rawTrigger = this.bot.getEntryRawTrigger(cycleSide);
    if (rawTrigger === null) return false;

    const breakout = cycleSide === "long" ? price >= rawTrigger : price <= rawTrigger;
    if (!breakout) return false;

    const theoreticalFill = this.bot.computeBufferedTrigger(cycleSide, rawTrigger);
    const lastLeg = this.bot.legs[this.bot.legs.length - 1];
    if (!lastLeg) return false;

    return cycleSide === "long"
      ? theoreticalFill < lastLeg.entryPrice
      : theoreticalFill > lastLeg.entryPrice;
  }

  private async addNextLeg(): Promise<void> {
    if (!this.bot.currActivePosition) return;
    const cycleSide = this.bot.getActiveCycleSide();
    if (!cycleSide) return;
    const rawTrigger = this.bot.getEntryRawTrigger(cycleSide);
    if (rawTrigger === null) return;

    const legIndex = this.bot.legs.length + 1;
    const firstLeg = this.bot.legs[0];
    const desiredBaseQty = this.bot.quantizeBaseQty(firstLeg.baseQty * Math.pow(this.bot.sizeMultiplier, this.bot.legs.length));
    const previousSizeAbs = Math.abs(this.bot.currActivePosition.size);
    let triggerTimestamp = 0;

    this.bot.isAddInFlight = true;
    try {
      triggerTimestamp = Date.now();
      const addResult = await this.bot.orderExecutor.triggerAddSignal(cycleSide, desiredBaseQty, previousSizeAbs);

      this.bot.currActivePosition = addResult.position;
      this.bot.currentCycleSide = cycleSide;
      this.bot.lastEntryFillWsPrice = {
        price: addResult.fillUpdate.executionPrice || addResult.position.avgPrice,
        time: new Date(addResult.fillUpdate.updateTime || Date.now()),
      };
      this.bot.legs.push({
        index: legIndex,
        baseQty: addResult.baseQty,
        entryPrice: this.bot.lastEntryFillWsPrice.price,
        enteredAtMs: this.bot.lastEntryFillWsPrice.time.getTime(),
        clientOrderId: addResult.clientOrderId,
      });
      this.bot.cycleEntryClientOrderIds.push(addResult.clientOrderId);
      this.bot.recordEntrySlippage(
        cycleSide,
        rawTrigger,
        this.bot.lastEntryFillWsPrice.price,
        `-- Add Leg ${legIndex} Slippage: --\nTime Diff: ${this.bot.lastEntryFillWsPrice.time.getTime() - triggerTimestamp} ms`
      );

      await this.bot.queueTakeProfitRefresh(`leg ${legIndex} entered`, true);
      this.bot.queueMsg(
        `➕ Added leg ${legIndex}/${this.bot.maxLegs}
Fill: ${this.bot.lastEntryFillWsPrice.price}
New avg: ${addResult.position.avgPrice}
Position size: ${Math.abs(addResult.position.size)}
TP: ${this.bot.activeTpPrice}`
      );
    } catch (error) {
      console.error("[FM] Add leg failed:", error);
      this.bot.queueMsg(`⚠️ Add leg failed: ${error instanceof Error ? error.message : String(error)}`);
      try {
        const recovered = await this.bot.tryReconcileAddLegAfterFailedSignal(
          cycleSide,
          legIndex,
          rawTrigger,
          triggerTimestamp,
          previousSizeAbs,
          desiredBaseQty
        );
        if (recovered) {
          this.bot.queueMsg(`🔧 Synced add fill from the exchange after a partial failure (avoided stacking duplicate adds).`);
        }
      } catch (reconcileErr) {
        console.error("[FM] Add-leg reconcile error:", reconcileErr);
        this.bot.queueMsg(
          `⚠️ Could not verify exchange position after add error: ${reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr)}`
        );
      }
    } finally {
      this.bot.isAddInFlight = false;
    }
  }

  private shouldTriggerStopLoss(price: number): boolean {
    if (!this.bot.currActivePosition) return false;
    const cycleSide = this.bot.getActiveCycleSide();
    if (!cycleSide) return false;
    if (this.bot.stopLossPercent >= 100) return false;
    if (this.bot.legs.length < this.bot.maxLegs) return false;
    if (!Number.isFinite(this.bot.cycleWalletAtOpenUsdt) || !this.bot.cycleWalletAtOpenUsdt) return false;

    const avg = this.bot.currActivePosition.avgPrice;
    const qty = Math.abs(this.bot.currActivePosition.size);
    const unrealized =
      cycleSide === "long" ? qty * (price - avg) : qty * (avg - price);
    const equity = this.bot.cycleWalletAtOpenUsdt + unrealized;
    if (equity >= this.bot.cycleWalletAtOpenUsdt) return false;

    const ddPct = ((this.bot.cycleWalletAtOpenUsdt - equity) / this.bot.cycleWalletAtOpenUsdt) * 100;
    return ddPct >= this.bot.stopLossPercent;
  }

  private async triggerStopLossClose(): Promise<void> {
    if (!this.bot.currActivePosition) return;

    this.bot.isClosingPosition = true;
    const triggerTimestamp = Date.now();
    this.bot.queueMsg(
      `🛑 Stop loss triggered\nPosition ID: ${this.bot.currActivePosition.id}\nAvg: ${this.bot.currActivePosition.avgPrice}\nPrice: ${this.bot.latestTradePrice}`
    );
    await this.bot.cancelActiveTpOrder("stop loss");
    const closeResult = await this.bot.orderExecutor.triggerCloseSignal(this.bot.currActivePosition);
    const fillTimestamp = closeResult.fillUpdate.updateTime || Date.now();
    const snapshot = this.bot.buildExitSnapshot(
      closeResult.closedPosition,
      "stop_loss",
      triggerTimestamp,
      fillTimestamp,
      false
    );
    await this.bot.finalizeClosedPosition(snapshot);
  }

  private async maybeCheckLiquidation(price: number): Promise<void> {
    if (!this.bot.currActivePosition || this.liquidationCheckInProgress) return;
    const cycleSide = this.bot.getActiveCycleSide();
    if (!cycleSide) return;
    const liqPrice = this.bot.currActivePosition.liquidationPrice;
    if (!Number.isFinite(liqPrice) || liqPrice <= 0) return;

    const inZone =
      (cycleSide === "long" && price <= liqPrice) ||
      (cycleSide === "short" && price >= liqPrice);
    if (!inZone) return;

    this.liquidationCheckInProgress = true;
    try {
      const livePosition = await ExchangeService.getPosition(this.bot.symbol);
      if (livePosition && livePosition.side === cycleSide) return;
      const closedPosition = await this.bot.orderExecutor.fetchClosedPositionSnapshot(this.bot.currActivePosition.id);
      if (!closedPosition) return;
      this.bot.queueMsg(
        `⚠️ Position appears liquidated\nLiquidation price: ${liqPrice}\nLast trade price: ${price}`
      );
      const fillTimestamp = closedPosition.updateTime || Date.now();
      const snapshot = this.bot.buildExitSnapshot(
        closedPosition,
        "liquidation_exit",
        Date.now(),
        fillTimestamp,
        true
      );
      await this.bot.finalizeClosedPosition(snapshot);
    } finally {
      this.liquidationCheckInProgress = false;
    }
  }

  async onExit(): Promise<void> {
    this.refreshLoopAbort = true;
    this.tradeListenerRemover?.();
    this.orderUpdateRemover?.();
    this.positionUpdateRemover?.();
    this.tradeListenerRemover = undefined;
    this.orderUpdateRemover = undefined;
    this.positionUpdateRemover = undefined;
  }
}

export default FMInPositionState;
