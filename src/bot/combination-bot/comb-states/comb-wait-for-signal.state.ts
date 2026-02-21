import ExchangeService from "@/services/exchange-service/exchange-service";
import { TPositionSide } from "@/services/exchange-service/exchange-type";
import { getPositionDetailMsg } from "@/utils/strings.util";
import BigNumber from "bignumber.js";
import { EEventBusEventType } from "@/utils/event-bus.util";
import type CombBotInstance from "../comb-bot-instance";

class CombWaitForSignalState {
  private priceListenerRemover?: () => void;

  constructor(private bot: CombBotInstance) { }

  async onEnter() {
    this.bot.queueMsg(`🔜 Waiting for entry signal - monitoring price for breakout...`);
    this.priceListenerRemover = ExchangeService.hookPriceListener(this.bot.symbol, (price) => {
      void this._handlePriceUpdate(price);
    });
  }

  private async _handlePriceUpdate(price: number) {
    try {
      if ((this.bot.longTrigger === null && this.bot.shortTrigger === null) || this.bot.currActivePosition) return;
      if (this.bot.lastExitTime > 0 && this.bot.lastSRUpdateTime <= this.bot.lastExitTime) return;
      const priceNum = new BigNumber(price);
      let shouldEnter = false;
      let posDir: TPositionSide | null = null;
      if (this.bot.longTrigger !== null && priceNum.gte(this.bot.longTrigger)) {
        shouldEnter = true;
        posDir = "long";
        this.bot.queueMsg(`📈 Long entry trigger: Price ${price} >= Long Trigger ${this.bot.longTrigger}`);
      } else if (this.bot.shortTrigger !== null && priceNum.lte(this.bot.shortTrigger)) {
        shouldEnter = true;
        posDir = "short";
        this.bot.queueMsg(`📉 Short entry trigger: Price ${price} <= Short Trigger ${this.bot.shortTrigger}`);
      }
      if (shouldEnter && posDir) {
        this.priceListenerRemover?.();
        const budget = new BigNumber(this.bot.margin).times(this.bot.leverage).toFixed(2, BigNumber.ROUND_DOWN);
        const triggerTs = Date.now();
        console.log(`[COMB] waitForSignal entryTrigger symbol=${this.bot.symbol} side=${posDir} price=${price} trigger=${posDir === "long" ? this.bot.longTrigger : this.bot.shortTrigger}`);
        this.bot.queueMsg(`✨️ Opening ${posDir} position`);
        const position = await this.bot.orderExecutor.triggerOpenSignal(posDir, budget);
        this.bot.currActivePosition = position;
        this.bot.resetTrailingStopTracking();
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
        this.bot.stateBus.emit(EEventBusEventType.StateChange);
      }
    } catch (error) {
      console.error("[COMB] WaitForSignal price listener error:", error);
      this.bot.queueMsg(`⚠️ Entry price listener error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async onExit() {
    console.log(`[COMB] CombWaitForSignalState onExit symbol=${this.bot.symbol}`);
    this.priceListenerRemover?.();
  }
}

export default CombWaitForSignalState;
