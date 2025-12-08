import ExchangeService from "@/services/exchange-service/exchange-service";
import { TPositionSide } from "@/services/exchange-service/exchange-type";
import TelegramService from "@/services/telegram.service";
import { getPositionDetailMsg } from "@/utils/strings.util";
import BreakoutBot, { BBState } from "../breakout-bot";
import BigNumber from "bignumber.js";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";

class BBWaitForEntryState implements BBState {
  private priceListenerRemover?: () => void;

  constructor(private bot: BreakoutBot) { }

  async onEnter() {
    TelegramService.queueMsg(`🔜 Waiting for entry signal - monitoring price for breakout...`);
    console.log("Hooking price listener for entry...");
    this._watchForBreakout();
    console.log("Price listener for entry hooked");
  }

  private async _watchForBreakout() {
    this.priceListenerRemover = ExchangeService.hookPriceListener(this.bot.symbol, async (price) => {
      // Wait for trigger levels to be calculated
      if (this.bot.longTrigger === null && this.bot.shortTrigger === null) {
        return;
      }

      // Skip if already have a position
      if (this.bot.currActivePosition) {
        return;
      }

      // IMPORTANT: Only allow entry if S/R has been updated AFTER the last exit
      // This prevents spam entries immediately after exits
      if (this.bot.lastExitTime > 0 && this.bot.lastSRUpdateTime <= this.bot.lastExitTime) {
        // Still using old S/R levels, wait for next update
        return;
      }

      const priceNum = new BigNumber(price);
      let shouldEnter = false;
      let posDir: TPositionSide | null = null;

      // Enter long when price >= long trigger (resistance adjusted down by buffer)
      if (this.bot.longTrigger !== null && priceNum.gte(this.bot.longTrigger)) {
        shouldEnter = true;
        posDir = "long";
        TelegramService.queueMsg(`📈 Long entry trigger: Price ${price} >= Long Trigger ${this.bot.longTrigger}`);
      }
      // Enter short when price <= short trigger (support adjusted up by buffer)
      else if (this.bot.shortTrigger !== null && priceNum.lte(this.bot.shortTrigger)) {
        shouldEnter = true;
        posDir = "short";
        TelegramService.queueMsg(`📉 Short entry trigger: Price ${price} <= Short Trigger ${this.bot.shortTrigger}`);
      }

      if (shouldEnter && posDir) {
        this.priceListenerRemover && this.priceListenerRemover();
        await this._openPosition(posDir);
        eventBus.emit(EEventBusEventType.StateChange);
      }
    });
  }

  private async _openPosition(posDir: TPositionSide) {
    const budget = new BigNumber(this.bot.betSize).times(this.bot.leverage).toFixed(2, BigNumber.ROUND_DOWN);

    const msg = `✨️️️️️️️ Opening ${posDir} position`;
    TelegramService.queueMsg(msg);
    console.log(msg);
    console.log(`Triggering open-${posDir} signal`);

    const triggerTs = Date.now();

    console.log("Opening position...");
    const position = await this.bot.triggerOpenSignal(posDir, budget);

    this.bot.currActivePosition = position;
    this.bot.numberOfTrades++;
    this.bot.lastEntryTime = Date.now(); // Track when we entered

    const positionAvgPrice = position.avgPrice;
    const entryFill = this.bot.entryWsPrice;
    const positionTriggerTs = entryFill?.time ? entryFill.time.getTime() : Date.now();
    const timeDiffMs = positionTriggerTs - triggerTs;
    
    // Calculate slippage based on support/resistance levels
    // For long: compare avgPrice with resistance (lower avgPrice = better = negative slippage)
    // For short: compare avgPrice with support (lower avgPrice = better = negative slippage)
    let srLevel: number | null = null;
    if (posDir === "long") {
      srLevel = this.bot.currentResistance;
    } else {
      srLevel = this.bot.currentSupport;
    }
    
    if (srLevel === null) {
      console.warn(`⚠️ Cannot calculate slippage: ${posDir === "long" ? "resistance" : "support"} level is null`);
      TelegramService.queueMsg(`⚠️ Warning: Cannot calculate slippage - ${posDir === "long" ? "resistance" : "support"} level not available`);
    }
    
    const priceDiff = srLevel !== null 
      ? posDir === "short"
        ? new BigNumber(srLevel).minus(positionAvgPrice).toNumber()  // Flipped for short
        : new BigNumber(positionAvgPrice).minus(srLevel).toNumber()  // Keep as is for long
      : 0;

    // Negative slippage is good (better price than SR level), positive slippage is bad
    const icon = priceDiff <= 0 ? "🟩" : "🟥";
    if (icon === "🟥") {
      this.bot.slippageAccumulation += Math.abs(priceDiff);
    } else {
      this.bot.slippageAccumulation -= Math.abs(priceDiff);
    }

    console.log("Opened position: ", position);
    TelegramService.queueMsg(`
🥳️️️️️️ New position opened
${getPositionDetailMsg(position)}
--Open Slippage: --
Time Diff: ${timeDiffMs} ms
Price Diff(pips): ${icon} ${priceDiff}
`);
  }

  async onExit() {
    console.log("Exiting BB Wait For Entry State");
    this.priceListenerRemover && this.priceListenerRemover();
  }
}

export default BBWaitForEntryState;

