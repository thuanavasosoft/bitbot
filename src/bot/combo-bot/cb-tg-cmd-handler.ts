import BigNumber from "bignumber.js";
import ComboBot, { IBetRule, TBetRuleVal } from "./combo-bot";
import ExchangeService from "@/services/exchange-service/exchange-service";
import { getPositionDetailMsg } from "@/utils/strings.util";
import TelegramService, { ETGCommand } from "@/services/telegram.service";
import { getRunDuration } from "@/utils/maths.util";
import { TAiCandleTrendDirection } from "@/services/grok-ai.service";

enum EBBotCommand {
  UPDATE_BET_SIZE = "update_bet_size",

  UPDATE_BIG_AI_TREND_CHECK_INTERVAL_IN_MINUTES = "update_big_ai_trend_check_interval_in_minutes",
  UPDATE_BIG_CANDLES_ROLL_WINDOW_IN_HOURS = "update_big_candles_roll_window_in_hours",

  UPDATE_SMALL_AI_TREND_CHECK_INTERVAL_IN_MINUTES = "update_small_ai_trend_check_interval_in_minutes",
  UPDATE_SMALL_CANDLES_ROLL_WINDOW_IN_HOURS = "update_small_candles_roll_window_in_hours",

  UPDATE_BET_RULE = "update_bet_rule",
  UPDATE_BET_RULES = "update_bet_rules",

  OPEN_LONG = "open_long",
  OPEN_SHORT = "open_short",
  CLOSE_POSITION = "close_position",
}

class CBTgCmdHandler {
  constructor(private bot: ComboBot) { }

  private async _getFullUpdateDetailsMsg() {
    if (this.bot.currentState === this.bot.startingState) {
      return `Bot in starting state, preparing bot balances, symbols, leverage`
    }

    if (this.bot.currentState === this.bot.waitForEntryState) {
      return `
Bot are in wait for consecutive trend state, waiting for trends
Trends should be for entry: Up | Down}`;
    }

    if (this.bot.currentState === this.bot.waitForResolveState) {
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
        | EBBotCommand.UPDATE_BIG_AI_TREND_CHECK_INTERVAL_IN_MINUTES
        | EBBotCommand.UPDATE_BIG_CANDLES_ROLL_WINDOW_IN_HOURS
        | EBBotCommand.UPDATE_SMALL_AI_TREND_CHECK_INTERVAL_IN_MINUTES
        | EBBotCommand.UPDATE_SMALL_CANDLES_ROLL_WINDOW_IN_HOURS
        | EBBotCommand.UPDATE_BET_RULE
        | EBBotCommand.UPDATE_BET_RULES
      > = {
        [ETGCommand.FullUpdate]: "To get full updated bot information",
        [ETGCommand.Help]: "To get command list information",
        [EBBotCommand.UPDATE_BET_SIZE]: `To update the bet size /${EBBotCommand.UPDATE_BET_SIZE} 1000`,
        [EBBotCommand.UPDATE_BIG_AI_TREND_CHECK_INTERVAL_IN_MINUTES]: `To update big ai trend check interval in minutes /${EBBotCommand.UPDATE_BIG_AI_TREND_CHECK_INTERVAL_IN_MINUTES} 3`,
        [EBBotCommand.UPDATE_SMALL_AI_TREND_CHECK_INTERVAL_IN_MINUTES]: `To update small ai trend check interval in minutes /${EBBotCommand.UPDATE_SMALL_AI_TREND_CHECK_INTERVAL_IN_MINUTES} 1`,
        [EBBotCommand.UPDATE_BIG_CANDLES_ROLL_WINDOW_IN_HOURS]: `To update big candles roll window in hours /${EBBotCommand.UPDATE_BIG_CANDLES_ROLL_WINDOW_IN_HOURS} 6`,
        [EBBotCommand.UPDATE_SMALL_CANDLES_ROLL_WINDOW_IN_HOURS]: `To update small candles roll window in hours /${EBBotCommand.UPDATE_SMALL_CANDLES_ROLL_WINDOW_IN_HOURS} 3`,
        [EBBotCommand.UPDATE_BET_RULE]: `To update single bet rule /${EBBotCommand.UPDATE_BET_RULE} Kangaroo-Up short`,
        [EBBotCommand.UPDATE_BET_RULES]: `To update all bet rules /${EBBotCommand.UPDATE_BET_RULES} {COMBO_BOT_BET_RULES .env.example value}`,
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
      const stratEstimatedROI = startQuoteBalance.lte(0) ? new BigNumber(0) : stratEstimatedYearlyProfit.div(startQuoteBalance).times(100);

      const avgSlippage = this.bot.numberOfTrades > 0 ? new BigNumber(this.bot.slippageAccumulation).div(this.bot.numberOfTrades) : "0";

      const msg = `
=== GENERAL ===
Symbol: ${this.bot.symbol}
Leverage: X${this.bot.leverage}
Bet size: ${this.bot.betSize} USDT
Sleep duration after liquidation: ${this.bot.sleepDurationAfterLiquidation}

Big AI trend check interval: ${this.bot.bigAiTrendIntervalCheckInMinutes} minutes
Small AI trend check interval: ${this.bot.smallAiTrendIntervalCheckInMinutes} minutes

Big Candles roll window: ${this.bot.bigCandlesRollWindowInHours} hours
Small Candles roll window: ${this.bot.smallCandlesRollWindowInHours} hours

Bet Rules: ${this.bot.cbUtil.getBetRulesMsg()}

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

    TelegramService.appendTgCmdHandler(EBBotCommand.UPDATE_BIG_AI_TREND_CHECK_INTERVAL_IN_MINUTES, (ctx) => {
      const msg1 = `Updating big candles ai trend check interval in minutes...`
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

      if (Number(value) % this.bot.smallAiTrendIntervalCheckInMinutes != 0) {
        errMsg = `Invalid parameter specified, please specify a number that can interlap with small ai trend interval check in minutes`
      }

      if (!!errMsg) {
        console.log(errMsg);
        TelegramService.queueMsg(errMsg);
        return
      }

      this.bot.bigAiTrendIntervalCheckInMinutes = Number(value);

      const msg = `Successfully updated big candles ai trend check interval to ${value} minutes`
      console.log(msg);
      TelegramService.queueMsg(msg);
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.UPDATE_SMALL_AI_TREND_CHECK_INTERVAL_IN_MINUTES, (ctx) => {
      const msg1 = `Updating small ai candles trend check interval in minutes...`
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

      if (this.bot.bigAiTrendIntervalCheckInMinutes % Number(value) != 0) {
        errMsg = `Invalid parameter specified, please specify a number that can interlap with big ai trend interval check in minutes`
      }

      if (!!errMsg) {
        console.log(errMsg);
        TelegramService.queueMsg(errMsg);
        return
      }

      this.bot.smallAiTrendIntervalCheckInMinutes = Number(value);

      const msg = `Successfully updated small candles ai trend check interval to ${value} minutes`
      console.log(msg);
      TelegramService.queueMsg(msg);
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.UPDATE_BIG_CANDLES_ROLL_WINDOW_IN_HOURS, (ctx) => {
      const msg1 = `Updating big candles roll window in hours...`
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

      this.bot.bigCandlesRollWindowInHours = Number(value);

      const msg = `Successfully big candles roll window to ${value} hours`
      console.log(msg);
      TelegramService.queueMsg(msg);
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.UPDATE_SMALL_CANDLES_ROLL_WINDOW_IN_HOURS, (ctx) => {
      const msg1 = `Updating small candles roll window in hours...`
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

      this.bot.smallCandlesRollWindowInHours = Number(value);

      const msg = `Successfully small candles roll window to ${value} hours`
      console.log(msg);
      TelegramService.queueMsg(msg);
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.UPDATE_BET_RULE, (ctx) => {
      const msg1 = `Updating single bet rule...`
      console.log(msg1);
      TelegramService.queueMsg(msg1)

      const splitted = ctx.text!.split(" ");
      const rule = splitted[1];
      const ruleBigKey = rule.split("-")[0] as TAiCandleTrendDirection
      const ruleSmallKey = rule.split("-")[1] as TAiCandleTrendDirection
      const ruleValue = splitted[2].toLowerCase() as TBetRuleVal;

      let errMsg: string | undefined = undefined
      if (!ruleValue) {
        errMsg = "No parameter specified, please specify parameter";
      }

      if (!(["Kangaroo", "Up", "Down"] as TAiCandleTrendDirection[]).includes(ruleBigKey)) {
        errMsg = `Invalid big key value specified, please specify either "Kangaroo" || "Up" || "Down"`
      }

      if (!(["Kangaroo", "Up", "Down"] as TAiCandleTrendDirection[]).includes(ruleSmallKey)) {
        errMsg = `Invalid small key value specified, please specify either "Kangaroo" || "Up" || "Down"`
      }

      if (!(["skip", "long", "short"] as TBetRuleVal[]).includes(ruleValue)) {
        errMsg = `Invalid rule value specified, please specify either "skip" || "long" || "short"`
      }

      if (!!errMsg) {
        console.log(errMsg);
        TelegramService.queueMsg(errMsg);
        return
      }

      this.bot.betRules[ruleBigKey][ruleSmallKey] = ruleValue;
      this.bot.trendComboRecords[ruleBigKey][ruleSmallKey] = {
        entriesAmt: 0,
        pnl: 0,
      };

      const msg = `Successfully updated bet rules (${ruleBigKey}-${ruleSmallKey}) to ${ruleValue}
New bet rules: ${this.bot.cbUtil.getBetRulesMsg()}`;
      console.log(msg);
      TelegramService.queueMsg(msg);
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.UPDATE_BET_RULES, (ctx) => {
      const msg1 = `Updating the whole bet rules...`
      console.log(msg1);
      TelegramService.queueMsg(msg1)

      console.log("ctx.text!: ", ctx.text!);

      const splitted = ctx.text!.split(" ");
      const value = splitted[1];
      console.log("value: ", value);


      let errMsg: string | undefined = undefined
      if (!value) {
        errMsg = "No parameter specified, please specify parameter";
      }

      let parsed: IBetRule | undefined;
      try {
        const keys: TAiCandleTrendDirection[] = ["Down", "Up", "Kangaroo"];
        parsed = JSON.parse(value) as IBetRule;
        for (const key of keys) {
          for (const key2 of keys) {
            if (!(["long", "short", "skip"] as TBetRuleVal[]).includes(parsed[key]?.[key2])) errMsg = `Wrong bet rules json value please check again`;
          }
        }
      } catch (e) {
        errMsg = `Error on parsing bet rules json value ${e}`
      }

      console.log("parsed: ", parsed);

      if (!!errMsg) {
        console.log(errMsg);
        TelegramService.queueMsg(errMsg);
        return
      }

      this.bot.betRules = parsed!;
      this.bot.trendComboRecords = {
        Up: {
          Up: {
            entriesAmt: 0,
            pnl: 0
          },
          Down: {
            entriesAmt: 0,
            pnl: 0
          },
          Kangaroo: {
            entriesAmt: 0,
            pnl: 0
          }
        },
        Down: {
          Up: {
            entriesAmt: 0,
            pnl: 0
          },
          Down: {
            entriesAmt: 0,
            pnl: 0
          },
          Kangaroo: {
            entriesAmt: 0,
            pnl: 0
          }
        },
        Kangaroo: {
          Up: {
            entriesAmt: 0,
            pnl: 0
          },
          Down: {
            entriesAmt: 0,
            pnl: 0
          },
          Kangaroo: {
            entriesAmt: 0,
            pnl: 0
          }
        }
      };

      const msg = `
Successfully updated bet rules
New bet rules: ${this.bot.cbUtil.getBetRulesMsg()}`;

      console.log(msg);
      TelegramService.queueMsg(msg);
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.OPEN_LONG, () => {
      console.log("Broadcasting open-long");
      this.bot.cbWsSignaling.broadcast("open-long", "10");
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.OPEN_SHORT, () => {
      console.log("Broadcasting open-short");
      this.bot.cbWsSignaling.broadcast("open-short", "10");
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.CLOSE_POSITION, () => {
      console.log("Broadcasting close-position");
      this.bot.cbWsSignaling.broadcast("close-position");
    });
  }
}

export default CBTgCmdHandler;