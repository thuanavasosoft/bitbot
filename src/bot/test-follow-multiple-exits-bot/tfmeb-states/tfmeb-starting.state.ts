import TestFollowMultipleExits, { type TFMEBState } from "../test-follow-multiple-exits-bot";
import TelegramService from "@/services/telegram.service";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import moment from "moment";

class TFMEBStartingState implements TFMEBState {
  constructor(private bot: TestFollowMultipleExits) { }

  async onEnter() {
    if (!!this.bot.liquidationSleepFinishTs) {
      TelegramService.queueMsg(`Position has just liquidated waiting for ${this.bot.sleepDurationAfterLiquidation} (finished at: ${moment(this.bot.liquidationSleepFinishTs).format("YYYY-MM-DD HH:mm:ss")})`)
      await new Promise(r => setTimeout(r, this.bot.liquidationSleepFinishTs! - +new Date()));
      this.bot.liquidationSleepFinishTs = undefined;
    }

    console.log('AI Trend Bot MEXC Entering Starting State')
    TelegramService.queueMsg("⚙️ Starting Bot");

    const msg = `
🟢 TFMEB BOT STARTED
Symbol: ${this.bot.symbol}
Leverage: X${this.bot.leverage}
Bet size: ${this.bot.betSize} USDT
Sleep duration after liquiedation: ${this.bot.sleepDurationAfterLiquidation}

Regular AI trend check interval: ${this.bot.aiTrendIntervalCheckInMinutes} minutes
Regular Candles roll window: ${this.bot.candlesRollWindowInHours} hours
Regular Bet direction: ${this.bot.betDirection}

Start Quote Balance (100%): ${this.bot.startQuoteBalance} USDT
Current Quote Balance (100%): ${this.bot.currQuoteBalance} USDT
`;

    console.log(msg);
    TelegramService.queueMsg(msg);

    eventBus.emit(EEventBusEventType.StateChange);
  }

  async onExit() {
    console.log("Exiting starting state...");
  }
}

export default TFMEBStartingState;