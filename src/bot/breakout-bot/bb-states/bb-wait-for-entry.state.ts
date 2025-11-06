import ExchangeService from "@/services/exchange-service/exchange-service";
import { TPositionSide, IPosition } from "@/services/exchange-service/exchange-type";
import TelegramService from "@/services/telegram.service";
import { getPositionDetailMsg } from "@/utils/strings.util";
import BreakoutBot, { BBState } from "../breakout-bot";
import BigNumber from "bignumber.js";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";

const WAIT_INTERVAL_MS = 5000;

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
      // Wait for support/resistance levels to be calculated
      if (!this.bot.currentSupport || !this.bot.currentResistance) {
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

      // Check for breakout above resistance (enter long)
      if (priceNum.gte(this.bot.currentResistance)) {
        shouldEnter = true;
        posDir = "long";
        TelegramService.queueMsg(`📈 Breakout above resistance detected: Price ${price} >= Resistance ${this.bot.currentResistance}`);
      }
      // Check for breakdown below support (enter short)
      else if (priceNum.lte(this.bot.currentSupport)) {
        shouldEnter = true;
        posDir = "short";
        TelegramService.queueMsg(`📉 Breakdown below support detected: Price ${price} <= Support ${this.bot.currentSupport}`);
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
    console.log(`Broadcasting: open-${posDir}`);

    const currLatestMarkPrice = await ExchangeService.getMarkPrice(this.bot.symbol);
    const triggerTs = +new Date();
    this.bot.entryWsPrice = {
      price: currLatestMarkPrice,
      time: new Date(triggerTs),
    };

    console.log("Opening position...");
    let position: IPosition | undefined = undefined;
    for (let i = 0; i < 10; i++) {
      try {
        this.bot.bbWsSignaling.broadcast(`open-${posDir}`, budget);
        await new Promise(r => setTimeout(r, WAIT_INTERVAL_MS));
        position = await ExchangeService.getPosition(this.bot.symbol);
        console.log("position: ", position);

        if (!!position) {
          console.log(`[Position Check] Position found on attempt ${i + 1}, stop checking`);
          break;
        }

        const msg = `[Position Check] Attempt ${i + 1}: Position check result: ${position ? 'Found' : 'Not found. Reopening position...'} `;
        console.log(msg);
        TelegramService.queueMsg(msg);
      } catch (error) {
        console.error(`[Position Check] Error on attempt ${i + 1}: `, error);
        if (i < 9) {
          console.log(`[Position Check] Waiting 5 seconds before retry...`);
          await new Promise(r => setTimeout(r, WAIT_INTERVAL_MS));
        }
      }
    }

    if (!position) {
      console.log(`[Position Check] Position not found by symbol ${this.bot.symbol}, checking all open positions...`);
      const allPositions = await ExchangeService.getOpenedPositions();
      console.log(`[Position Check] All open positions: `, allPositions);

      const msg = "❌ Position not opened even after 60 seconds after signaling to open please check..."
      TelegramService.queueMsg(msg);
      await new Promise(r => setTimeout(r, 1000));
      throw new Error(msg);
    };

    this.bot.currActivePosition = position;
    this.bot.numberOfTrades++;
    this.bot.lastEntryTime = Date.now(); // Track when we entered

    const positionAvgPrice = position.avgPrice;
    const positionTriggerTs = +new Date(position.createTime);
    const timeDiffMs = positionTriggerTs - triggerTs;
    const priceDiff = new BigNumber(currLatestMarkPrice).minus(positionAvgPrice).toNumber();

    const icon = posDir === "long" ? priceDiff <= 0 ? "🟩" : "🟥" :
      priceDiff >= 0 ? "🟩" : "🟥";
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

