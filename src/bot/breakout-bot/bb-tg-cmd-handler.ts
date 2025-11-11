import BigNumber from "bignumber.js";
import BreakoutBot from "./breakout-bot";
import ExchangeService from "@/services/exchange-service/exchange-service";
import { getPositionDetailMsg } from "@/utils/strings.util";
import TelegramService, { ETGCommand } from "@/services/telegram.service";
import { getRunDuration } from "@/utils/maths.util";

enum EBBotCommand {
  UPDATE_BET_SIZE = "update_bet_size",
  OPEN_LONG = "open_long",
  OPEN_SHORT = "open_short",
  CLOSE_POSITION = "close_position",
  FLIP = "flip",
}

class BBTgCmdHandler {
  constructor(private bot: BreakoutBot) { }

  private async _getFullUpdateDetailsMsg() {
    if (this.bot.currentState === this.bot.startingState) {
      return `Bot in starting state, preparing bot balances, symbols, leverage`
    }

    if (this.bot.currentState === this.bot.waitForEntryState) {
      return `
Bot are in wait for entry state, waiting for breakout signal (Up/Down)`;
    }

    if (this.bot.currentState === this.bot.waitForResolveState) {
      let position = await ExchangeService.getPosition(this.bot.symbol);
      if (!position) {
        const closedPositions = await ExchangeService.getPositionsHistory({ positionId: this.bot.currActivePosition?.id! });
        if (closedPositions?.length > 1) position = closedPositions[0];
      }
      return `
Bot are in wait for resolve state, monitoring price for exit

${!!position && getPositionDetailMsg(position)}`
    }
  }

  handleTgMsgs() {
    TelegramService.appendTgCmdHandler(ETGCommand.Help, async () => {
      const cmds: Pick<Record<ETGCommand | EBBotCommand, string>,
        | ETGCommand.FullUpdate
        | ETGCommand.Help
        | EBBotCommand.UPDATE_BET_SIZE
        | EBBotCommand.FLIP
      > = {
        [ETGCommand.FullUpdate]: "To get full updated bot information",
        [ETGCommand.Help]: "To get command list information",
        [EBBotCommand.UPDATE_BET_SIZE]: `To update the bet size /${EBBotCommand.UPDATE_BET_SIZE} 1000`,
        [EBBotCommand.FLIP]: "To manually flip trading mode (against ↔ follow)",
      }

      let msg = ``;

      for (const cmd in cmds) {
        const commandDesc = `\n\n - /${cmd} => ${(cmds as any)[cmd]}`
        msg += commandDesc
      }

      TelegramService.queueMsg(msg);
    });

    TelegramService.appendTgCmdHandler(ETGCommand.FullUpdate, async () => {
      const startQuoteBalance = new BigNumber(this.bot.startQuoteBalance);
      const currQuoteBalance = new BigNumber(this.bot.currQuoteBalance);

      const totalProfit = new BigNumber(this.bot.totalActualCalculatedProfit);

      const { runDurationInDays, runDurationDisplay } = getRunDuration(new Date(this.bot.runStartTs))
      const stratDaysWindows = new BigNumber(365).div(runDurationInDays);
      const stratEstimatedYearlyProfit = totalProfit.times(stratDaysWindows);
      const stratEstimatedROI = startQuoteBalance.lte(0) ? new BigNumber(0) : stratEstimatedYearlyProfit.div(startQuoteBalance).times(100);

      const avgSlippage = this.bot.numberOfTrades > 0 ? new BigNumber(this.bot.slippageAccumulation).div(this.bot.numberOfTrades) : "0";

      const msg = `
=== GENERAL ===
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

=== DETAILS ===
${await this._getFullUpdateDetailsMsg()}

=== BUDGET ===
Start Quote Balance (100%): ${startQuoteBalance.toNumber().toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} USDT
Current Quote Balance (100%): ${currQuoteBalance.toNumber().toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} USDT

Balance current and start diff: ${new BigNumber(currQuoteBalance).minus(startQuoteBalance).toNumber().toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} USDT
Calculated actual profit: ${this.bot.totalActualCalculatedProfit.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} USDT

=== ROI ===
Run time: ${runDurationDisplay}
Total profit till now: ${totalProfit.isGreaterThanOrEqualTo(0) ? "🟩" : "🟥"} ${totalProfit.toNumber().toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} USDT (${totalProfit.div(startQuoteBalance).times(100).toNumber().toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%) / ${runDurationDisplay}
Estimated yearly profit: ${stratEstimatedYearlyProfit.toNumber().toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} USDT (${stratEstimatedROI.toNumber().toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%)

=== SLIPPAGE ===
Slippage accumulation: ${this.bot.slippageAccumulation} pip(s)
Number of trades: ${this.bot.numberOfTrades}
Average slippage: ${new BigNumber(avgSlippage).gt(0) ? "🟥" : "🟩"} ${avgSlippage} pip(s)
`;

      TelegramService.queueMsg(msg);
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.UPDATE_BET_SIZE, (ctx) => {
      const msg1 = `Updating bet size...`
      console.log(msg1);
      TelegramService.queueMsg(msg1)

      const splitted = ctx.text!.split(" ");
      const value = splitted[1];

      let errMsg: string | undefined = undefined
      if (!value) {
        errMsg = "No parameter specified, please specify parameter";
      }

      if (Number.isNaN(Number(value))) {
        errMsg = `Invalid parameter specified, please specify a number`
      }

      if (!!errMsg) {
        console.log(errMsg);
        TelegramService.queueMsg(errMsg);
        return
      }

      this.bot.betSize = Number(value);

      const msg = `Successfully updated bet size to ${value} USDT`
      console.log(msg);
      TelegramService.queueMsg(msg);
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.OPEN_LONG, () => {
      console.log("Broadcasting open-long");
      this.bot.bbWsSignaling.broadcast("open-long", "10");
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.OPEN_SHORT, () => {
      console.log("Broadcasting open-short");
      this.bot.bbWsSignaling.broadcast("open-short", "10");
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.CLOSE_POSITION, () => {
      console.log("Broadcasting close-position");
      this.bot.bbWsSignaling.broadcast("close-position");
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.FLIP, () => {
      this.bot.bbUtil.flipTradingMode();
    });
  }
}

export default BBTgCmdHandler;

