import ExchangeService from "@/services/exchange-service/exchange-service";
import { TPositionSide } from "@/services/exchange-service/exchange-type";
import { getPositionDetailMsg } from "@/utils/strings.util";
import BigNumber from "bignumber.js";
import { EEventBusEventType } from "@/utils/event-bus.util";
import type CombBotInstance from "../comb-bot-instance";

type EntryGuardResult = {
  allowed: boolean;
  release: () => void;
  blockedCounts?: { long: number; short: number };
  blockedActivePositionsText?: string;
  blockedReason?: string;
};

class CombWaitForSignalState {
  private ltpListenerRemover?: () => void;
  private entryCooldownNoticeBoundaryMs?: number;

  constructor(private bot: CombBotInstance) { }

  private isPositionNotDetectedError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const msg = error.message || "";
    return msg.includes("Position not detected within") || msg.includes("Position not detected");
  }

  async onEnter() {
    this.bot.queueMsg(`🔜 Waiting for entry signal - monitoring price for breakout...`);
    this.entryCooldownNoticeBoundaryMs = undefined;
    this.ltpListenerRemover = ExchangeService.hookTradeListener(this.bot.symbol, (trade) => {
      void this._handlePriceUpdate(trade.price);
    });
  }

  private async _handlePriceUpdate(price: number) {
    try {
      if (
        (this.bot.longTrigger === null && this.bot.shortTrigger === null) ||
        this.bot.currActivePosition ||
        this.bot.isOpeningPosition ||
        this.bot.isStopped
      ) return;
      const nowMs = Date.now();
      const priceNum = new BigNumber(price);

      const longCross = this.bot.longTrigger !== null && priceNum.gte(this.bot.longTrigger);
      const shortCross = this.bot.shortTrigger !== null && priceNum.lte(this.bot.shortTrigger);

      const entryAllowedAt = this.bot.nextEntryAllowedAtMs;
      if (entryAllowedAt != null && nowMs < entryAllowedAt) {
        if ((longCross || shortCross) && this.entryCooldownNoticeBoundaryMs !== entryAllowedAt) {
          this.entryCooldownNoticeBoundaryMs = entryAllowedAt;
          const side = longCross ? "LONG" : "SHORT";
          const trigger = longCross ? this.bot.longTrigger : this.bot.shortTrigger;
          this.bot.queueMsg(
            `⏳ Entry blocked until the next minute (:00) after the last position closed\n` +
            `Symbol: ${this.bot.symbol}\n` +
            `Side: ${side}\n` +
            `Price: ${price}\n` +
            `Trigger: ${trigger}\n` +
            `Entry allowed at: ${new Date(entryAllowedAt).toISOString()}`
          );
        }
        return;
      }
      if (this.bot.lastExitTime > 0 && this.bot.lastSRUpdateTime <= this.bot.lastExitTime) return;
      let shouldEnter = false;
      let posDir: TPositionSide | null = null;
      if (this.bot.longTrigger !== null && priceNum.gte(this.bot.longTrigger)) {
        shouldEnter = true;
        posDir = "long";
      } else if (this.bot.shortTrigger !== null && priceNum.lte(this.bot.shortTrigger)) {
        shouldEnter = true;
        posDir = "short";
      }
      if (shouldEnter && posDir) {
        this.ltpListenerRemover?.();
        this.bot.isOpeningPosition = true;
        const triggerLevel = posDir === "long" ? this.bot.longTrigger : this.bot.shortTrigger;
        let entryGuard: EntryGuardResult | undefined;
        try {
          entryGuard = await this.bot.combinationBot.beginMinorityProtectedEntry(posDir);
          if (!entryGuard.allowed) {
            this.bot.activateDummyPosition({
              requestedSide: posDir,
              price,
              trigger: triggerLevel,
              activePositionsText: entryGuard.blockedActivePositionsText,
              blockedReason: entryGuard.blockedReason,
            });
            this.bot.stateBus.emit(EEventBusEventType.StateChange);
            return;
          }

          const budget = new BigNumber(this.bot.margin).times(this.bot.leverage).toFixed(2, BigNumber.ROUND_DOWN);
          const triggerTs = Date.now();
          console.log(`[COMB] waitForSignal entryTrigger symbol=${this.bot.symbol} side=${posDir} price=${price} trigger=${triggerLevel}`);
          this.bot.queueMsg(
            posDir === "long"
              ? `📈 Long entry trigger: Price ${price} >= Long Trigger ${triggerLevel}`
              : `📉 Short entry trigger: Price ${price} <= Short Trigger ${triggerLevel}`
          );
          this.bot.queueMsg(`✨️ Opening ${posDir} position`);
          let position;
          try {
            position = await this.bot.orderExecutor.triggerOpenSignal(posDir, budget);
          } catch (error) {
            if (this.isPositionNotDetectedError(error)) {
              const errMsg = error instanceof Error ? error.message : String(error);
              const clientOrderId = this.bot.lastOpenClientOrderId ?? "N/A";
              const reason = `no_position_detected: ${errMsg}`;
              this.bot.stopInstance(reason);
              for (let i = 0; i < 3; i++) {
                this.bot.queueMsg(
                  `🚨🚨🚨 NO POSITION DETECTED AFTER OPEN\n` +
                  `Symbol: ${this.bot.symbol}\n` +
                  `Side: ${posDir}\n` +
                  `Client Order ID: ${clientOrderId}\n` +
                  `Budget (quote): ${budget}\n` +
                  `Trigger time: ${new Date(triggerTs).toISOString()}\n` +
                  `Error: ${errMsg}\n\n` +
                  `Stopping this symbol instance (other symbols keep running).`
                );
              }
              this.bot.stateBus.emit(EEventBusEventType.StateChange, this.bot.stoppedState);
              return;
            }
            throw error;
          }

          if (this.bot.isStopped) {
            this.bot.queueMsg(
              `Instance was stopped while opening position for ${this.bot.symbol}. Closing the newly opened position...`
            );
            try {
              const closedPosition = await this.bot.orderExecutor.triggerCloseSignal(position);
              const fillTimestamp = this.bot.resolveWsPrice?.time?.getTime() ?? closedPosition.updateTime ?? Date.now();
              await this.bot.finalizeClosedPosition(closedPosition, {
                activePosition: position,
                triggerTimestamp: triggerTs,
                fillTimestamp,
                isLiquidation: false,
                exitReason: "end",
                suppressStateChange: true,
              });
              this.bot.currActivePosition = undefined;
              this.bot.queueMsg(`Position closed. Instance remains stopped.`);
            } catch (closeErr) {
              const closeMsg = closeErr instanceof Error ? closeErr.message : String(closeErr);
              this.bot.queueMsg(
                `Failed to close the position opened during stop: ${closeMsg}. Instance is stopped; close manually or use /close_pos.`
              );
            }
            return;
          }

          this.bot.currActivePosition = position;
          this.bot.isClosingPosition = false;
          this.bot.isFinalizingPosition = false;
          this.bot.isPnlRecorded = false;
          this.bot.nextEntryAllowedAtMs = undefined;
          this.bot.resetTrailingStopTracking();
          this.bot.tpPbPercent = 0;
          this.bot.tpPbFixedPrice = undefined;
          this.bot.lastEntryTime = Date.now();
          this.bot.numberOfTrades++;

          const positionAvgPrice = position.avgPrice;
          const entryFill = this.bot.entryWsPrice;
          const positionTriggerTs = entryFill?.time ? entryFill.time.getTime() : Date.now();
          const timeDiffMs = positionTriggerTs - triggerTs;

          let srLevel: number | null = null;
          if (posDir === "long") {
            srLevel = this.bot.currentResistance;
          } else {
            srLevel = this.bot.currentSupport;
          }

          if (srLevel === null) {
            console.warn(`⚠️ Cannot calculate slippage: ${posDir === "long" ? "resistance" : "support"} level is null`);
            this.bot.queueMsg(
              `⚠️ Warning: Cannot calculate slippage - ${posDir === "long" ? "resistance" : "support"} level not available`
            );
          }

          const priceDiff = srLevel !== null
            ? posDir === "short"
              ? new BigNumber(srLevel).minus(positionAvgPrice).toNumber()
              : new BigNumber(positionAvgPrice).minus(srLevel).toNumber()
            : 0;

          const icon = priceDiff <= 0 ? "🟩" : "🟥";
          if (icon === "🟥") {
            this.bot.slippageAccumulation += Math.abs(priceDiff);
          } else {
            this.bot.slippageAccumulation -= Math.abs(priceDiff);
          }

          this.bot.queueMsg(`
-- Open Slippage: --
Time Diff: ${timeDiffMs} ms
Price Diff(pips): ${icon} ${priceDiff}
`);
          console.log(`[COMB] waitForSignal positionOpened symbol=${this.bot.symbol} positionId=${position.id} side=${position.side} avgPrice=${position.avgPrice} size=${position.size}`);
          this.bot.notifyInstanceEvent({ type: "position_opened", position, symbol: this.bot.symbol });
          this.bot.queueMsg(`🥳 New position opened\n${getPositionDetailMsg(position)}`);
          await this.bot.combinationBot.handleMinorityPreventionAfterOpen(this.bot);
          this.bot.stateBus.emit(EEventBusEventType.StateChange);
        } finally {
          entryGuard?.release();
          this.bot.isOpeningPosition = false;
        }
      }
    } catch (error) {
      console.error("[COMB] WaitForSignal price listener error:", error);
      this.bot.queueMsg(`⚠️ Entry price listener error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async onExit() {
    console.log(`[COMB] CombWaitForSignalState onExit symbol=${this.bot.symbol}`);
    this.ltpListenerRemover?.();
  }
}

export default CombWaitForSignalState;
