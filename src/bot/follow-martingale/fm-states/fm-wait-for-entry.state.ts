import ExchangeService from "@/services/exchange-service/exchange-service";
import { EEventBusEventType } from "@/utils/event-bus.util";
import type FollowMartingaleBot from "../follow-martingale-bot";

class FMWaitForEntryState {
  private tradeListenerRemover?: () => void;
  private refreshLoopAbort = false;
  private openingInProgress = false;
  private addCooldownTelegramSent = false;

  constructor(private bot: FollowMartingaleBot) { }

  async onEnter(): Promise<void> {
    this.refreshLoopAbort = false;
    this.openingInProgress = false;
    this.addCooldownTelegramSent = false;
    this.bot.queueMsg(`🔜 Waiting for AUTO entry signal (long or short breakout)...`);
    await this.bot.refreshSignalLevels();
    this.tradeListenerRemover = ExchangeService.hookTradeListener(this.bot.symbol, (trade) => {
      void this.handleTradePrice(trade.price, trade.timestamp);
    });
    void this.runRefreshLoop();
  }

  private async runRefreshLoop(): Promise<void> {
    while (!this.refreshLoopAbort) {
      try {
        await this.bot.refreshSignalLevels();
      } catch (error) {
        console.error("[FM] Failed to refresh signal levels (entry state):", error);
      }
      await new Promise((resolve) => setTimeout(resolve, this.bot.loopIntervalMs));
    }
  }

  private async handleTradePrice(price: number, tradeTimeMs: number): Promise<void> {
    let targetSide: "long" | "short" | undefined;
    let rawTrigger: number | undefined;
    let triggerTimestamp = 0;
    try {
      await this.bot.lockSignalRefresh();

      this.bot.latestTradePrice = price;
      this.bot.latestTradeTimeMs = tradeTimeMs;
      if (this.openingInProgress || this.bot.currActivePosition) return;

      const now = Date.now();
      const nextAddAllowedAt = this.bot.getNextAddAllowedAtMs();
      const inAddCooldown = nextAddAllowedAt !== undefined && now < nextAddAllowedAt;
      if (!inAddCooldown) {
        this.addCooldownTelegramSent = false;
      }
      if (inAddCooldown) {
        if (!this.addCooldownTelegramSent) {
          this.bot.queueMsg(
            `⏳ AUTO entry paused until ${new Date(nextAddAllowedAt!).toISOString()} (add cooldown).`
          );
          this.addCooldownTelegramSent = true;
        }
        return;
      }

      const longTrigger = this.bot.getEntryRawTrigger("long");
      const shortTrigger = this.bot.getEntryRawTrigger("short");
      const longBreakout = longTrigger !== null && price >= longTrigger;
      const shortBreakout = shortTrigger !== null && price <= shortTrigger;
      if (!longBreakout && !shortBreakout) return;

      if (longBreakout && !shortBreakout) {
        targetSide = "long";
        rawTrigger = longTrigger!;
      } else if (shortBreakout && !longBreakout) {
        targetSide = "short";
        rawTrigger = shortTrigger!;
      } else {
        // Ambiguous edge case only when support/resistance collapse; prefer no-op over guessing.
        this.bot.queueMsg(`⚠️ Both long and short breakouts appeared simultaneously. Skipping entry until the next tick.`);
        return;
      }

      this.openingInProgress = true;
      triggerTimestamp = Date.now();
      const quoteBudget = await this.bot.getLeg1QuoteBudget();
      this.bot.queueMsg(
        `✨ Opening ${targetSide!.toUpperCase()} position\nPrice: ${price}\nTrigger: ${rawTrigger}\nBudget: ${quoteBudget.toFixed(4)} USDT`
      );

      const openResult = await this.bot.orderExecutor.triggerOpenSignal(targetSide!, quoteBudget);
      this.bot.lastOpenClientOrderId = openResult.clientOrderId;
      this.bot.currActivePosition = openResult.position;
      this.bot.currentCycleSide = targetSide!;
      this.bot.entryWsPrice = {
        price: openResult.fillUpdate.executionPrice || openResult.position.avgPrice,
        time: new Date(openResult.fillUpdate.updateTime || Date.now()),
      };
      this.bot.lastEntryFillWsPrice = this.bot.entryWsPrice;
      const leg1EnteredAtMs = this.bot.entryWsPrice.time.getTime();
      this.bot.legs = [
        {
          index: 1,
          baseQty: openResult.baseQty,
          entryPrice: this.bot.entryWsPrice.price,
          enteredAtMs: leg1EnteredAtMs,
          clientOrderId: openResult.clientOrderId,
        },
      ];
      this.bot.recordLastEntryOrAdd(leg1EnteredAtMs);
      this.bot.cycleEntryClientOrderIds = [openResult.clientOrderId];
      this.bot.cycleWalletAtOpenUsdt = (await this.bot.getExchTotalUsdtBalance()).toNumber();
      this.bot.recordEntrySlippage(
        targetSide!,
        rawTrigger!,
        this.bot.entryWsPrice.price,
        `-- Open Slippage: --\nTime Diff: ${this.bot.entryWsPrice.time.getTime() - triggerTimestamp} ms`
      );
      this.bot.queueMsg(
        `🥳 Leg 1 entered (${targetSide!.toUpperCase()})\nAvg Price: ${openResult.position.avgPrice}\nQty: ${Math.abs(openResult.position.size)}\n` +
        `Cycle wallet at open: ${this.bot.cycleWalletAtOpenUsdt.toFixed(4)} USDT`
      );
      await this.bot.queueTakeProfitRefresh("initial entry", true);
      this.bot.stateBus.emit(EEventBusEventType.StateChange);
    } catch (error) {
      console.error("[FM] Entry flow failed:", error);
      this.bot.queueMsg(`⚠️ Entry flow failed: ${error instanceof Error ? error.message : String(error)}`);
      if (targetSide !== undefined && rawTrigger !== undefined) {
        try {
          const recovered = await this.bot.tryReconcileLeg1AfterFailedOpen(targetSide, rawTrigger, triggerTimestamp);
          if (recovered) {
            this.bot.queueMsg(`🔧 Synced open position from the exchange after a partial failure (avoided stacking duplicate entries).`);
          }
        } catch (reconcileErr) {
          console.error("[FM] Leg1 reconcile error:", reconcileErr);
          this.bot.queueMsg(
            `⚠️ Could not verify exchange position after entry error: ${reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr)}`
          );
        }
      }
    } finally {
      this.openingInProgress = false;
      this.bot.releaseSignalRefresh();
    }
  }

  async onExit(): Promise<void> {
    console.log("Exiting FMWaitForEntryState");
    this.refreshLoopAbort = true;
    this.tradeListenerRemover?.();
    this.tradeListenerRemover = undefined;
    console.log("Exiting FMWaitForEntryState done");
  }
}

export default FMWaitForEntryState;
