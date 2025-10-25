import BigNumber from "bignumber.js";
import BudgetingBot from "./budgeting-bot";
import { sundayDayName } from "./bb-util";
import ExchangeService from "@/services/exchange-service/exchange-service";
import { getPositionDetailMsg } from "@/utils/strings.util";
import TelegramService, { ETGCommand } from "@/services/telegram.service";
import { getRunDuration } from "@/utils/maths.util";
import { TEntryDirectionToTrend } from "@/utils/types.util";

enum EBBotCommand {

  UPDATE_BET_SIZE = "update_bet_size",

  UPDATE_AI_TREND_CHECK_INTERVAL_IN_MINUTES = "update_ai_trend_check_interval_in_minutes",
  UPDATE_CANDLES_ROLL_WINDOW_IN_HOURS = "update_candles_roll_window_in_hours",
  UPDATE_BET_DIRECTION = "update_bet_direction",

  UPDATE_SUNDAY_AI_TREND_CHECK_INTERVAL_IN_MINUTES = "update_sunday_ai_trend_check_interval_in_minutes",
  UPDATE_SUNDAY_CANDLES_ROLL_WINDOW_IN_HOURS = "update_sunday_candles_roll_window_in_hours",
  UPDATE_SUNDAY_BET_DIRECTION = "update_sunday_bet_direction",

  OPEN_LONG = "open_long",
  OPEN_SHORT = "open_short",
  CLOSE_POSITION = "close_position",
}

class BBTgCmdHandler {
  constructor(private bot: BudgetingBot) { }

  private async _getFullUpdateDetailsMsg() {
    if (this.bot.currentState === this.bot.startingState) {
      return `Bot in starting state, preparing bot balances, symbols, leverage`
    }

    if (this.bot.currentState === this.bot.waitForBetSignalState) {
      return `
Bot are in wait for consecutive trend state, waiting for trends
Trends should be for entry: Up | Down}`;
    }

    if (this.bot.currentState === this.bot.waitForResolveSignalState) {
      let position = await ExchangeService.getPosition(this.bot.symbol);
      if (!position) {
        const closedPositions = await ExchangeService.getPositionsHistory({ positionId: this.bot.currActivePosition?.id! });
        if (closedPositions?.length > 1) position = closedPositions[0];
      }
      return `
Bot are in wait for close command

${!!position && getPositionDetailMsg(position)}`
    }
  }

  handleTgMsgs() {
    TelegramService.appendTgCmdHandler(ETGCommand.Help, async () => {
      const cmds: Pick<Record<ETGCommand | EBBotCommand, string>,
        | ETGCommand.FullUpdate
        | ETGCommand.Help
        | EBBotCommand.UPDATE_BET_SIZE
        | EBBotCommand.UPDATE_AI_TREND_CHECK_INTERVAL_IN_MINUTES
        | EBBotCommand.UPDATE_CANDLES_ROLL_WINDOW_IN_HOURS
        | EBBotCommand.UPDATE_BET_DIRECTION
        | EBBotCommand.UPDATE_SUNDAY_AI_TREND_CHECK_INTERVAL_IN_MINUTES
        | EBBotCommand.UPDATE_SUNDAY_CANDLES_ROLL_WINDOW_IN_HOURS
        | EBBotCommand.UPDATE_SUNDAY_BET_DIRECTION
      > = {
        [ETGCommand.FullUpdate]: "To get full updated bot information",
        [ETGCommand.Help]: "To get command list information",
        [EBBotCommand.UPDATE_BET_SIZE]: `To update the bet size /${EBBotCommand.UPDATE_BET_SIZE} 1000`,
        [EBBotCommand.UPDATE_AI_TREND_CHECK_INTERVAL_IN_MINUTES]: `To update regular ai trend check interval in minutes/${EBBotCommand.UPDATE_AI_TREND_CHECK_INTERVAL_IN_MINUTES} 3`,
        [EBBotCommand.UPDATE_CANDLES_ROLL_WINDOW_IN_HOURS]: `To update regular candles roll window in hours /${EBBotCommand.UPDATE_CANDLES_ROLL_WINDOW_IN_HOURS} 6`,
        [EBBotCommand.UPDATE_BET_DIRECTION]: `To update the regular bet direction /${EBBotCommand.UPDATE_BET_DIRECTION} against`,
        [EBBotCommand.UPDATE_SUNDAY_AI_TREND_CHECK_INTERVAL_IN_MINUTES]: `To update sunday ai trend check interval in minutes /${EBBotCommand.UPDATE_SUNDAY_AI_TREND_CHECK_INTERVAL_IN_MINUTES} 3`,
        [EBBotCommand.UPDATE_SUNDAY_CANDLES_ROLL_WINDOW_IN_HOURS]: `To update sunday candles roll window in hours  /${EBBotCommand.UPDATE_SUNDAY_CANDLES_ROLL_WINDOW_IN_HOURS} 6`,
        [EBBotCommand.UPDATE_SUNDAY_BET_DIRECTION]: `To update the sunday bet direction /${EBBotCommand.UPDATE_SUNDAY_BET_DIRECTION} follow`,
      }

      let msg = ``;

      for (const cmd in cmds) {
        const commandDesc = `\n\n - /${cmd} => ${(cmds as any)[cmd]}`
        msg += commandDesc
      }

      TelegramService.queueMsg(msg);
    });

    TelegramService.appendTgCmdHandler(ETGCommand.FullUpdate, async () => {
      // const isTodaySunday = this.bot.bbUtil.getTodayDayName() === sundayDayName; // TODO: Uncomment this when sunday is implemented
      const startQuoteBalance = new BigNumber(this.bot.startQuoteBalance);
      const currQuoteBalance = new BigNumber(this.bot.currQuoteBalance);

      const totalProfit = new BigNumber(this.bot.totalActualCalculatedProfit);

      const { runDurationInDays, runDurationDisplay } = getRunDuration(new Date(this.bot.runStartTs))
      const stratDaysWindows = new BigNumber(365).div(runDurationInDays);
      const stratEstimatedYearlyProfit = totalProfit.times(stratDaysWindows);
      const stratEstimatedROI = startQuoteBalance.lte(0) ? 0 : stratEstimatedYearlyProfit.div(startQuoteBalance).times(100);

      const avgSlippage = this.bot.numberOfTrades > 0 ? new BigNumber(this.bot.slippageAccumulation).div(this.bot.numberOfTrades) : "0";

      const msg = `
=== GENERAL ===
Symbol: ${this.bot.symbol}
Leverage: X${this.bot.leverage}
Bet size: ${this.bot.betSize} USDT
Sleep duration after liquidation: ${this.bot.sleepDurationAfterLiquidation}

AI trend check interval: ${this.bot.aiTrendIntervalCheckInMinutes} minutes
Candles roll window: ${this.bot.candlesRollWindowInHours} hours
Bet direction: ${this.bot.betDirection}

=== DETAILS ===
${await this._getFullUpdateDetailsMsg()}

=== BUDGET ===
Start Quote Balance (100%): ${startQuoteBalance} USDT
Current Quote Balance (100%): ${currQuoteBalance} USDT

Balance current and start diff: ${new BigNumber(currQuoteBalance).minus(startQuoteBalance).toFixed(3)} USDT
Calculated actual profit: ${this.bot.totalActualCalculatedProfit} USDT

=== ROI ===
Run time: ${runDurationDisplay}
Total profit till now: ${totalProfit.isGreaterThanOrEqualTo(0) ? "🟩" : "🟥"} ${totalProfit} USDT (${totalProfit.div(startQuoteBalance).times(100)}%) / ${runDurationDisplay}
Estimated yearly profit: ${stratEstimatedYearlyProfit.toFixed(2)} USDT (${stratEstimatedROI.toFixed(2)}%)

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

    TelegramService.appendTgCmdHandler(EBBotCommand.UPDATE_AI_TREND_CHECK_INTERVAL_IN_MINUTES, (ctx) => {
      const msg1 = `Updating ai trend check interval in minutes...`
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

      this.bot.aiTrendIntervalCheckInMinutes = Number(value);

      const msg = `Successfully updated ai trend check interval to ${value} minutes`
      console.log(msg);
      TelegramService.queueMsg(msg);
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.UPDATE_CANDLES_ROLL_WINDOW_IN_HOURS, (ctx) => {
      const msg1 = `Updating candles roll window in hours...`
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

      this.bot.candlesRollWindowInHours = Number(value);

      const msg = `Successfully candles roll window to ${value} hours`
      console.log(msg);
      TelegramService.queueMsg(msg);
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.UPDATE_BET_DIRECTION, (ctx) => {
      const msg1 = `Updating bet direction...`
      console.log(msg1);
      TelegramService.queueMsg(msg1)

      const splitted = ctx.text!.split(" ");
      const value = splitted[1];

      let errMsg: string | undefined = undefined
      if (!value) {
        errMsg = "No parameter specified, please specify parameter";
      }

      if (!(["against", "follow"] as TEntryDirectionToTrend[]).includes(value as any)) {
        errMsg = `Invalid parameter specified, either (against | follow)`
      }

      if (!!errMsg) {
        console.log(errMsg);
        TelegramService.queueMsg(errMsg);
        return
      }

      this.bot.betDirection = value as TEntryDirectionToTrend;

      const msg = `Successfully updated regular bet direction to ${value}`
      console.log(msg);
      TelegramService.queueMsg(msg);
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.UPDATE_SUNDAY_AI_TREND_CHECK_INTERVAL_IN_MINUTES, (ctx) => {
      const msg1 = `Updating sunday ai trend check interval in minutes...`
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

      this.bot.sundayAiTrendIntervalCheckInMinutes = Number(value);

      const msg = `Successfully updated sunday trend check interval to ${value} minutes`
      console.log(msg);
      TelegramService.queueMsg(msg);
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.UPDATE_SUNDAY_CANDLES_ROLL_WINDOW_IN_HOURS, (ctx) => {
      const msg1 = `Updating sunday candles roll window in hours...`
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

      this.bot.sundayCandlesRollWindowInHours = Number(value);

      const msg = `Successfully updated sunday candle roll window to ${value} hours`
      console.log(msg);
      TelegramService.queueMsg(msg);
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.UPDATE_SUNDAY_BET_DIRECTION, (ctx) => {
      const msg1 = `Updating sunday bet direction...`
      console.log(msg1);
      TelegramService.queueMsg(msg1)

      const splitted = ctx.text!.split(" ");
      const value = splitted[1];

      let errMsg: string | undefined = undefined
      if (!value) {
        errMsg = "No parameter specified, please specify parameter";
      }

      if (!(["against", "follow"] as TEntryDirectionToTrend[]).includes(value as any)) {
        errMsg = `Invalid parameter specified, either (against | follow)`
      }

      if (!!errMsg) {
        console.log(errMsg);
        TelegramService.queueMsg(errMsg);
        return
      }

      this.bot.sundayBetDirection = value as TEntryDirectionToTrend;

      const msg = `Successfully updated consecutive against trend amt to ${value}`
      console.log(msg);
      TelegramService.queueMsg(msg);
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.OPEN_LONG, () => {
      console.log("Broadcasting open-long");
      this.bot.bbWSSignaling.broadcast("open-long", "10");
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.OPEN_SHORT, () => {
      console.log("Broadcasting open-short");
      this.bot.bbWSSignaling.broadcast("open-short", "10");
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.CLOSE_POSITION, () => {
      console.log("Broadcasting close-position");
      this.bot.bbWSSignaling.broadcast("close-position");
    });
  }
}

export default BBTgCmdHandler;