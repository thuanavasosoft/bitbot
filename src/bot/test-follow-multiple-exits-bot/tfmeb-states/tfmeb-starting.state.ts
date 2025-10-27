import ExchangeService from "@/services/exchange-service/exchange-service";
import TestFollowMultipleExits, { type TFMEBState } from "../test-follow-multiple-exits-bot";
import TelegramService from "@/services/telegram.service";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import { BigNumber } from "bignumber.js";
import { sundayDayName } from "../tfmeb-util";
import moment from "moment";

class TFMEBStartingState implements TFMEBState {
  constructor(private bot: TestFollowMultipleExits) { }

  private async _updateBotStartBalances() {
    const exchFreeUsdtBalance = await this.bot.bbUtil.getExchFreeUsdtBalance()

    if (exchFreeUsdtBalance.lt(this.bot.betSize)) {
      const msg = `😔️️️️️️ Exchange free balance (${exchFreeUsdtBalance}) is less than the bet size: ${this.bot.betSize} stopping bot`;
      console.error(msg);
      throw new Error(msg)
    }

    this.bot.startQuoteBalance = exchFreeUsdtBalance.decimalPlaces(4, BigNumber.ROUND_DOWN).toString();
  }

  async updateBotCurrentBalances() {
    const exchFreeUsdtBalance = await this.bot.bbUtil.getExchFreeUsdtBalance()

    if (exchFreeUsdtBalance.lt(this.bot.betSize)) {
      const msg = `😔️️️️️️ Exchange free balance (${exchFreeUsdtBalance}) is less than the bet size: ${this.bot.betSize} stopping bot`;
      console.error(msg);
      throw new Error(msg)
    }

    this.bot.currQuoteBalance = exchFreeUsdtBalance.decimalPlaces(4, BigNumber.ROUND_DOWN).toString();
  }

  private async _updateLeverage() {
    const msg = `Updating leverage of ${this.bot.symbol} to X${this.bot.leverage}...`
    console.log(msg)
    TelegramService.queueMsg(msg)

    const resp = await ExchangeService.setLeverage(this.bot.symbol, this.bot.leverage)

    const msg1 = `Leverage updated successfully`
    console.log(msg, resp)
    TelegramService.queueMsg(msg1)
  }

  async onEnter() {
    if (!!this.bot.liquidationSleepFinishTs) {
      TelegramService.queueMsg(`Position has just liquidated waiting for ${this.bot.sleepDurationAfterLiquidation} (finished at: ${moment(this.bot.liquidationSleepFinishTs).format("YYYY-MM-DD HH:mm:ss")})`)
      await new Promise(r => setTimeout(r, this.bot.liquidationSleepFinishTs! - +new Date()));
      this.bot.liquidationSleepFinishTs = undefined;
    }

    // Validate sunday start and end gmt make sure they are not overlapping making it not working
    // Validate sunday start and end GMT, make sure they are not overlapping
    if (
      typeof this.bot.sundayStartGMTTimezone === "number" &&
      typeof this.bot.sundayEndGMTTimezone === "number"
    ) {
      if (this.bot.sundayStartGMTTimezone > this.bot.sundayEndGMTTimezone) {
        const warnMsg = `⚠️ sundayStartGMTTimezone (${this.bot.sundayStartGMTTimezone}) is after sundayEndGMTTimezone (${this.bot.sundayEndGMTTimezone}). This will cause the Sunday trading window to not work properly. Please ensure start < end.`
        console.warn(warnMsg);
        throw warnMsg
      }
    }

    await Promise.all([
      (!this.bot.startQuoteBalance) && this._updateBotStartBalances(),
      (!this.bot.currQuoteBalance) && this.updateBotCurrentBalances(),
      this._updateLeverage(),
    ]);

    console.log('AI Trend Bot MEXC Entering Starting State')
    TelegramService.queueMsg("⚙️ Starting Bot");
    const isTodaySunday = this.bot.bbUtil.getTodayDayName() === sundayDayName;

    const msg = `
🟢 BUDGETING BOT STARTED
Symbol: ${this.bot.symbol}
Leverage: X${this.bot.leverage}
Bet size: ${this.bot.betSize} USDT
Sleep duration after liquiedation: ${this.bot.sleepDurationAfterLiquidation}

Regular AI trend check interval: ${this.bot.aiTrendIntervalCheckInMinutes} minutes
Regular Candles roll window: ${this.bot.candlesRollWindowInHours} hours
Regular Bet direction: ${this.bot.betDirection}

Is today sunday: ${isTodaySunday}
Sunday AI trend check interval: ${this.bot.sundayAiTrendIntervalCheckInMinutes} minutes
Sunday Candles roll window: ${this.bot.sundayCandlesRollWindowInHours} hours
Sunday Bet direction: ${this.bot.sundayBetDirection}
Sunday start gmt timezone: ${this.bot.sundayStartGMTTimezone > 0 ? "+" : ""}${this.bot.sundayStartGMTTimezone}
Sunday end gmt timezone: ${this.bot.sundayEndGMTTimezone > 0 ? "+" : ""}${this.bot.sundayEndGMTTimezone}

Start Quote Balance (100%): ${this.bot.startQuoteBalance} USDT
Current Quote Balance (100%): ${this.bot.currQuoteBalance} USDT
`;

    console.log(msg);
    TelegramService.queueMsg(msg);

    if (this.bot.connectedClientsAmt === 0) {
      TelegramService.queueMsg("❗ No clients connected yet, waiting for client to be connected to continue...");

      while (true) {
        if (this.bot.connectedClientsAmt > 0) {
          TelegramService.queueMsg("✅ Client connected, continuing to wait for signal...");
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before checking again
      }
    }

    eventBus.emit(EEventBusEventType.StateChange);
  }

  async onExit() {
    console.log("Exiting starting state...");
  }
}

export default TFMEBStartingState;