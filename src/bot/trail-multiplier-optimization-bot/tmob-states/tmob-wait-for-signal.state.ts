import ExchangeService from "@/services/exchange-service/exchange-service";
import { TPositionSide } from "@/services/exchange-service/exchange-type";
import TelegramService from "@/services/telegram.service";
import { getPositionDetailMsg } from "@/utils/strings.util";
import TrailMultiplierOptimizationBot, { TMOBState } from "../trail-multiplier-optimization-bot";
import BigNumber from "bignumber.js";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";

class TMOBWaitForSignalState implements TMOBState {
  private priceListenerRemover?: () => void;

  constructor(private bot: TrailMultiplierOptimizationBot) { }

  async onEnter() {
    TelegramService.queueMsg(`🔜 Waiting for entry signal - monitoring price for breakout...`);
    this._watchForBreakout();
  }

  private async _watchForBreakout() {
    this.priceListenerRemover = ExchangeService.hookPriceListener(this.bot.symbol, (price) => {
      void this._handlePriceUpdate(price);
    });
  }

  rehookPriceListener() {
    if (this.priceListenerRemover) {
      this.priceListenerRemover();
      this.priceListenerRemover = undefined;
    }
    this._watchForBreakout();
  }

  private async _handlePriceUpdate(price: number) {
    try {
      if (this.bot.longTrigger === null && this.bot.shortTrigger === null) {
        return;
      }

      if (this.bot.currActivePosition) {
        return;
      }

      if (this.bot.lastExitTime > 0 && this.bot.lastSRUpdateTime <= this.bot.lastExitTime) {
        return;
      }

      const priceNum = new BigNumber(price);
      let shouldEnter = false;
      let posDir: TPositionSide | null = null;

      if (this.bot.longTrigger !== null && priceNum.gte(this.bot.longTrigger)) {
        shouldEnter = true;
        posDir = "long";
        TelegramService.queueMsg(`📈 Long entry trigger: Price ${price} >= Long Trigger ${this.bot.longTrigger}`);
      } else if (this.bot.shortTrigger !== null && priceNum.lte(this.bot.shortTrigger)) {
        shouldEnter = true;
        posDir = "short";
        TelegramService.queueMsg(`📉 Short entry trigger: Price ${price} <= Short Trigger ${this.bot.shortTrigger}`);
      }

      if (shouldEnter && posDir) {
        this.priceListenerRemover && this.priceListenerRemover();
        await this._openPosition(posDir);
        eventBus.emit(EEventBusEventType.StateChange);
      }
    } catch (error) {
      console.error("[TMOBWaitForSignalState] Price listener error:", error);
      TelegramService.queueMsg(
        `⚠️ Entry price listener error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async _openPosition(posDir: TPositionSide) {
    const budget = new BigNumber(this.bot.margin).times(this.bot.leverage).toFixed(2, BigNumber.ROUND_DOWN);
    const msg = `✨️ Opening ${posDir} position`;
    TelegramService.queueMsg(msg);
    console.log(msg);

    const triggerTs = Date.now();
    const position = await this.bot.triggerOpenSignal(posDir, budget);

    this.bot.currActivePosition = position;
    this.bot.resetTrailingStopTracking();
    this.bot.numberOfTrades++;
    this.bot.lastEntryTime = Date.now();

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
      TelegramService.queueMsg(
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

    TelegramService.queueMsg(`
🥳 New position opened
${getPositionDetailMsg(position)}
--Open Slippage: --
Time Diff: ${timeDiffMs} ms
Price Diff(pips): ${icon} ${priceDiff}
`);
  }

  async onExit() {
    console.log("Exiting TMOBWaitForSignalState");
    this.priceListenerRemover && this.priceListenerRemover();
  }
}

export default TMOBWaitForSignalState;