import ExchangeService from "@/services/exchange-service/exchange-service";
import TelegramService from "@/services/telegram.service";
import BreakoutBot, { BBState } from "../breakout-bot";
import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import moment from "moment";
import BigNumber from "bignumber.js";

class BBStartingState implements BBState {
  constructor(private bot: BreakoutBot) { }

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
      this.bot.isSleeping = true;
      await new Promise(r => setTimeout(r, this.bot.liquidationSleepFinishTs! - +new Date()));
      this.bot.isSleeping = false;
      this.bot.liquidationSleepFinishTs = undefined;
    }

    await Promise.all([
      (!this.bot.startQuoteBalance) && this._updateBotStartBalances(),
      (!this.bot.currQuoteBalance) && this.updateBotCurrentBalances(),
      this._updateLeverage(),
    ]);

    console.log('Breakout Bot MEXC Entering Starting State')
    TelegramService.queueMsg("⚙️ Starting Bot");

    const msg = `
🟢 BREAKOUT BOT STARTED
Symbol: ${this.bot.symbol}
Leverage: X${this.bot.leverage}
Bet size: ${this.bot.betSize} USDT
Sleep duration after liquidation: ${this.bot.sleepDurationAfterLiquidation}

Signal check interval: ${this.bot.checkIntervalMinutes} minutes

Signal Parameters:
N: ${this.bot.signalParams.N}
ATR Length: ${this.bot.signalParams.atr_len}
K: ${this.bot.signalParams.K}
EPS: ${this.bot.signalParams.eps}
M ATR: ${this.bot.signalParams.m_atr}
ROC Min: ${this.bot.signalParams.roc_min}
EMA Period: ${this.bot.signalParams.ema_period}
Need Two Closes: ${this.bot.signalParams.need_two_closes}
Vol Mult: ${this.bot.signalParams.vol_mult}

Start Quote Balance (100%): ${this.bot.startQuoteBalance} USDT
Current Quote Balance (100%): ${this.bot.currQuoteBalance} USDT
`;

    console.log(msg);
    TelegramService.queueMsg(msg);

    if (!this.bot.bbTrendWatcher.isTrendWatcherStarted) this.bot.bbTrendWatcher.startWatchBreakoutSignals()

    eventBus.emit(EEventBusEventType.StateChange);
  }

  async onExit() {
    console.log("Exiting BB Starting State");
  }
}

export default BBStartingState;

