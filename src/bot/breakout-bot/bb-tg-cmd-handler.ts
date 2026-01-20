import BigNumber from "bignumber.js";
import BreakoutBot, { BBConfigUpdate } from "./breakout-bot";
import ExchangeService from "@/services/exchange-service/exchange-service";
import { FeeAwarePnLOptions, formatFeeAwarePnLLine, getPositionDetailMsg } from "@/utils/strings.util";
import TelegramService, { ETGCommand } from "@/services/telegram.service";
import { getRunDuration } from "@/utils/maths.util";
import { generatePnLProgressionChart } from "@/utils/image-generator.util";
import { isTransientError, withRetries } from "./bb-retry";

enum EBBotCommand {
  UPDATE_BET_SIZE = "update_bet_size",
  SET_SYMBOL = "set_symbol",
  SET_SIGNAL_N = "set_signal_n",
  SET_BET_SIZE = "set_bet_size",
  SET_LEVERAGE = "set_leverage",
  SET_TRAIL_ATR_LENGTH = "set_trailing_atr_length",
  SET_TRAIL_LOOKBACK = "set_trailing_lookback",
  SET_TRAIL_MULTIPLIER = "set_trailing_multiplier",
  SET_TRAIL_CONFIRM_TICKS = "set_trailing_confirm_ticks",
  OPEN_LONG = "open_long",
  OPEN_SHORT = "open_short",
  CLOSE_POSITION = "close_position",
  SHOW_PNL_GRAPH = "pnl_graph",
}

class BBTgCmdHandler {
  constructor(private bot: BreakoutBot) { }

  private _getFeeSummaryForDisplay(): FeeAwarePnLOptions | undefined {
    const metrics = this.bot.getLastTradeMetrics();
    const net = typeof metrics.netPnl === "number" ? metrics.netPnl : metrics.balanceDelta;
    const hasValue = [metrics.grossPnl, metrics.feeEstimate, net].some(
      (value) => typeof value === "number" && Number.isFinite(value),
    );

    if (!hasValue) return undefined;

    return {
      grossPnl: metrics.grossPnl,
      feeEstimate: metrics.feeEstimate,
      netPnl: net,
    };
  }

  private _formatLastTradeSummaryBlock() {
    const metrics = this.bot.getLastTradeMetrics();
    const feeSummary = this._getFeeSummaryForDisplay();
    const feeLine = feeSummary
      ? formatFeeAwarePnLLine(feeSummary)
      : formatFeeAwarePnLLine();
    const walletDelta = typeof metrics.balanceDelta === "number" && Number.isFinite(metrics.balanceDelta)
      ? metrics.balanceDelta.toFixed(4)
      : "N/A";

    return `Last closed position ID: ${metrics.closedPositionId ?? "N/A"}
${feeLine}
Wallet delta: ${walletDelta} USDT`;
  }

  private async _getFullUpdateDetailsMsg() {
    let details = "";
    if (this.bot.currentState === this.bot.startingState) {
      details = `Bot in starting state, preparing bot balances, symbols, leverage`;
    } else if (this.bot.currentState === this.bot.waitForEntryState) {
      details = `
Bot are in wait for entry state, waiting for breakout signal (Up/Down)`.trim();
    } else if (this.bot.currentState === this.bot.waitForResolveState) {
      let position = await withRetries(
        () => ExchangeService.getPosition(this.bot.symbol),
        {
          label: "[BBTgCmdHandler] getPosition",
          retries: 5,
          minDelayMs: 5000,
          isTransientError,
          onRetry: ({ attempt, delayMs, error, label }) => {
            console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
          },
        }
      );
      if (!position) {
        const closedPositions = await withRetries(
          () => ExchangeService.getPositionsHistory({ positionId: this.bot.currActivePosition?.id! }),
          {
            label: "[BBTgCmdHandler] getPositionsHistory",
            retries: 5,
            minDelayMs: 5000,
            isTransientError,
            onRetry: ({ attempt, delayMs, error, label }) => {
              console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
            },
          }
        );
        if (closedPositions?.length > 1) position = closedPositions[0];
      }
      details = `
Bot are in wait for resolve state, monitoring price for exit

${!!position && getPositionDetailMsg(position, { feeSummary: this._getFeeSummaryForDisplay() })}`.trim();
    }

    if (!details) {
      details = `Bot state details unavailable`;
    }

    const lastTradeSummary = this._formatLastTradeSummaryBlock();
    return `${details}

${lastTradeSummary}`;
  }

  private _extractSingleArg(ctx: { text?: string | undefined }): string | undefined {
    const rawText = ctx.text || "";
    const parts = rawText.trim().split(/\s+/);
    if (parts.length < 2) return undefined;
    return parts[1];
  }

  private async _queueOrApplyUpdate(update: BBConfigUpdate, summary: string, successMsg: string) {
    const hasOpenPosition = !!this.bot.currActivePosition || this.bot.currentState === this.bot.waitForResolveState;
    try {
      if (hasOpenPosition) {
        this.bot.queueConfigUpdates(update);
        TelegramService.queueMsg(`⏸️ Queued update: ${summary}. Will apply after the current position closes.`);
        return;
      }

      await this.bot.applyConfigUpdates(update);
      TelegramService.queueMsg(successMsg);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error("Failed to apply config update:", error);
      TelegramService.queueMsg(`❌ Failed to apply update: ${errMsg}`);
    }
  }

  handleTgMsgs() {
    TelegramService.appendTgCmdHandler(ETGCommand.Help, async () => {
      const cmds: Pick<Record<ETGCommand | EBBotCommand, string>,
        | ETGCommand.FullUpdate
        | ETGCommand.Help
        | EBBotCommand.UPDATE_BET_SIZE
        | EBBotCommand.SET_SYMBOL
        | EBBotCommand.SET_SIGNAL_N
        | EBBotCommand.SET_BET_SIZE
        | EBBotCommand.SET_LEVERAGE
        | EBBotCommand.SET_TRAIL_ATR_LENGTH
        | EBBotCommand.SET_TRAIL_LOOKBACK
        | EBBotCommand.SET_TRAIL_MULTIPLIER
        | EBBotCommand.SET_TRAIL_CONFIRM_TICKS
        | EBBotCommand.SHOW_PNL_GRAPH
      > = {
        [ETGCommand.FullUpdate]: "To get full updated bot information",
        [ETGCommand.Help]: "To get command list information",
        [EBBotCommand.UPDATE_BET_SIZE]: `To update the bet size /${EBBotCommand.UPDATE_BET_SIZE} 1000`,
        [EBBotCommand.SET_SYMBOL]: `To update symbol /${EBBotCommand.SET_SYMBOL} BTCUSDT`,
        [EBBotCommand.SET_SIGNAL_N]: `To update signal N /${EBBotCommand.SET_SIGNAL_N} 2`,
        [EBBotCommand.SET_BET_SIZE]: `To update bet size /${EBBotCommand.SET_BET_SIZE} 1000`,
        [EBBotCommand.SET_LEVERAGE]: `To update leverage /${EBBotCommand.SET_LEVERAGE} 10`,
        [EBBotCommand.SET_TRAIL_ATR_LENGTH]: `To update trailing ATR length /${EBBotCommand.SET_TRAIL_ATR_LENGTH} 2880`,
        [EBBotCommand.SET_TRAIL_LOOKBACK]: `To update trailing lookback /${EBBotCommand.SET_TRAIL_LOOKBACK} 2880`,
        [EBBotCommand.SET_TRAIL_MULTIPLIER]: `To update trailing multiplier /${EBBotCommand.SET_TRAIL_MULTIPLIER} 25`,
        [EBBotCommand.SET_TRAIL_CONFIRM_TICKS]: `To update trailing confirm ticks /${EBBotCommand.SET_TRAIL_CONFIRM_TICKS} 2`,
        [EBBotCommand.SHOW_PNL_GRAPH]: `To render the full PnL progression chart. Optional: "/${EBBotCommand.SHOW_PNL_GRAPH} dilute 10" to thin data`,
      }

      let msg = ``;

      for (const cmd in cmds) {
        const commandDesc = `\n\n - /${cmd} => ${(cmds as any)[cmd]}`
        msg += commandDesc
      }

      TelegramService.queueMsg(`${msg}\n\nNote: If a position is open, updates are queued and applied after close.`);
    });

    TelegramService.appendTgCmdHandler(ETGCommand.FullUpdate, async () => {
      const startQuoteBalance = new BigNumber(this.bot.startQuoteBalance);
      const currQuoteBalance = new BigNumber(this.bot.currQuoteBalance);

      const totalProfit = new BigNumber(this.bot.totalActualCalculatedProfit);

      const { runDurationInDays, runDurationDisplay } = getRunDuration(new Date(this.bot.runStartTs))
      const stratDaysWindows = new BigNumber(365).div(runDurationInDays);
      const stratEstimatedYearlyProfit = totalProfit.times(stratDaysWindows);
      const stratEstimatedROI = startQuoteBalance.lte(0) ? new BigNumber(0) : stratEstimatedYearlyProfit.div(startQuoteBalance).times(100);

      const avgSlippage = this.bot.numberOfTrades > 0 
        ? new BigNumber(this.bot.slippageAccumulation).div(this.bot.numberOfTrades).toFixed(5)
        : "0";

      const lastTradeSummary = this._formatLastTradeSummaryBlock();

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

=== LAST TRADE ===
${lastTradeSummary}

=== SLIPPAGE ===
Slippage accumulation: ${this.bot.slippageAccumulation} pip(s)
Number of trades: ${this.bot.numberOfTrades}
Average slippage: ~${new BigNumber(avgSlippage).gt(0) ? "🟥" : "🟩"} ${avgSlippage} pip(s)
`;

      TelegramService.queueMsg(msg);
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.UPDATE_BET_SIZE, async (ctx) => {
      const msg1 = `Updating bet size...`
      console.log(msg1);
      TelegramService.queueMsg(msg1)

      const value = this._extractSingleArg(ctx);

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

      await this._queueOrApplyUpdate(
        { betSize: Number(value) },
        `betSize -> ${value}`,
        `✅ Bet size updated to ${value} USDT`
      );
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.SET_SYMBOL, async (ctx) => {
      const value = this._extractSingleArg(ctx);
      if (!value) {
        TelegramService.queueMsg("No symbol specified, please provide a symbol (e.g., BTCUSDT).");
        return;
      }
      const normalized = value.toUpperCase();
      await this._queueOrApplyUpdate(
        { symbol: normalized },
        `symbol -> ${normalized}`,
        `✅ Symbol updated to ${normalized}`
      );
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.SET_SIGNAL_N, async (ctx) => {
      const value = this._extractSingleArg(ctx);
      const parsed = Number(value);
      if (!value || !Number.isFinite(parsed) || parsed < 1) {
        TelegramService.queueMsg("Invalid N. Please provide a positive number (e.g., /set_signal_n 2).");
        return;
      }
      const finalValue = Math.floor(parsed);
      await this._queueOrApplyUpdate(
        { signalN: finalValue },
        `signalParams.N -> ${finalValue}`,
        `✅ Signal N updated to ${finalValue}`
      );
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.SET_BET_SIZE, async (ctx) => {
      const value = this._extractSingleArg(ctx);
      const parsed = Number(value);
      if (!value || !Number.isFinite(parsed) || parsed <= 0) {
        TelegramService.queueMsg("Invalid bet size. Please provide a positive number.");
        return;
      }
      await this._queueOrApplyUpdate(
        { betSize: parsed },
        `betSize -> ${parsed}`,
        `✅ Bet size updated to ${parsed} USDT`
      );
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.SET_LEVERAGE, async (ctx) => {
      const value = this._extractSingleArg(ctx);
      const parsed = Number(value);
      if (!value || !Number.isFinite(parsed) || parsed <= 0) {
        TelegramService.queueMsg("Invalid leverage. Please provide a positive number.");
        return;
      }
      await this._queueOrApplyUpdate(
        { leverage: parsed },
        `leverage -> ${parsed}`,
        `✅ Leverage updated to X${parsed}`
      );
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.SET_TRAIL_ATR_LENGTH, async (ctx) => {
      const value = this._extractSingleArg(ctx);
      const parsed = Number(value);
      if (!value || !Number.isFinite(parsed) || parsed <= 0) {
        TelegramService.queueMsg("Invalid trailing ATR length. Please provide a positive number.");
        return;
      }
      await this._queueOrApplyUpdate(
        { trailingAtrLength: Math.floor(parsed) },
        `trailingAtrLength -> ${Math.floor(parsed)}`,
        `✅ Trailing ATR length updated to ${Math.floor(parsed)}`
      );
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.SET_TRAIL_LOOKBACK, async (ctx) => {
      const value = this._extractSingleArg(ctx);
      const parsed = Number(value);
      if (!value || !Number.isFinite(parsed) || parsed <= 0) {
        TelegramService.queueMsg("Invalid trailing lookback. Please provide a positive number.");
        return;
      }
      await this._queueOrApplyUpdate(
        { trailingHighestLookback: Math.floor(parsed) },
        `trailingHighestLookback -> ${Math.floor(parsed)}`,
        `✅ Trailing lookback updated to ${Math.floor(parsed)}`
      );
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.SET_TRAIL_MULTIPLIER, async (ctx) => {
      const value = this._extractSingleArg(ctx);
      const parsed = Number(value);
      if (!value || !Number.isFinite(parsed) || parsed <= 0) {
        TelegramService.queueMsg("Invalid trailing multiplier. Please provide a positive number.");
        return;
      }
      await this._queueOrApplyUpdate(
        { trailingStopMultiplier: parsed },
        `trailingStopMultiplier -> ${parsed}`,
        `✅ Trailing multiplier updated to ${parsed}`
      );
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.SET_TRAIL_CONFIRM_TICKS, async (ctx) => {
      const value = this._extractSingleArg(ctx);
      const parsed = Number(value);
      if (!value || !Number.isFinite(parsed) || parsed < 1) {
        TelegramService.queueMsg("Invalid trailing confirm ticks. Please provide a positive integer.");
        return;
      }
      const finalValue = Math.max(1, Math.floor(parsed));
      await this._queueOrApplyUpdate(
        { trailingStopConfirmTicks: finalValue },
        `trailingStopConfirmTicks -> ${finalValue}`,
        `✅ Trailing confirm ticks updated to ${finalValue}`
      );
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.SHOW_PNL_GRAPH, async (ctx) => {
      if (this.bot.pnlHistory.length === 0) {
        const msg = `No PnL history recorded yet.`;
        console.log(msg);
        TelegramService.queueMsg(msg);
        return;
      }

      const rawText = ctx.text || "";
      const argsText = rawText.replace(/^\/\S+\s*/, "").trim();
      const args = argsText.length > 0 ? argsText.split(/\s+/) : [];

      let dilute = 1;
      let errorMsg: string | undefined;

      if (args.length > 0) {
        const diluteIdx = args.findIndex(arg => arg.toLowerCase() === "dilute");
        if (diluteIdx !== -1) {
          const value = args[diluteIdx + 1];
          if (!value) {
            errorMsg = `Please provide a positive number after "dilute".`;
          } else {
            const parsed = Number(value);
            if (!Number.isFinite(parsed) || parsed <= 0) {
              errorMsg = `"${value}" is not a valid positive number for dilute.`;
            } else {
              dilute = Math.max(1, Math.floor(parsed));
            }
          }
        } else {
          const maybeNumber = Number(args[0]);
          if (Number.isFinite(maybeNumber) && maybeNumber > 0) {
            dilute = Math.max(1, Math.floor(maybeNumber));
          } else {
            errorMsg = `Unsupported parameter(s). Use "/${EBBotCommand.SHOW_PNL_GRAPH} dilute <positive_number>".`;
          }
        }
      }

      if (!!errorMsg) {
        console.log(errorMsg);
        TelegramService.queueMsg(errorMsg);
        return;
      }

      const history = this.bot.pnlHistory;
      const filteredHistory = history.filter((_, idx) => {
        if (history.length <= 2) return true;
        if (idx === 0 || idx === history.length - 1) return true;
        return idx % dilute === 0;
      });

      try {
        const pnlChartImage = await generatePnLProgressionChart(filteredHistory);
        TelegramService.queueMsg(pnlChartImage);
        TelegramService.queueMsg(
          `📈 Full PnL chart sent. Points used: ${filteredHistory.length}/${history.length}. Dilute factor: ${dilute}.`
        );
      } catch (error) {
        console.error("Error generating full PnL chart:", error);
        TelegramService.queueMsg(`⚠️ Failed to generate full PnL chart: ${error}`);
      }
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.OPEN_LONG, async () => {
      console.log("Triggering manual open-long");
      await this.bot.triggerOpenSignal("long", "10");
      TelegramService.queueMsg("✅ Manual long order filled.");
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.OPEN_SHORT, async () => {
      console.log("Triggering manual open-short");
      await this.bot.triggerOpenSignal("short", "10");
      TelegramService.queueMsg("✅ Manual short order filled.");
    });

    TelegramService.appendTgCmdHandler(EBBotCommand.CLOSE_POSITION, async () => {
      console.log("Triggering manual close-position");
      TelegramService.queueMsg(`⏳ Received /${EBBotCommand.CLOSE_POSITION}, attempting to close position...`);

      try {
        if (this.bot.currentState === this.bot.waitForResolveState) {
          if (!this.bot.currActivePosition) {
            const msg = `⚠️ Bot is in resolve state but no active position is tracked. Please check exchange manually.`;
            console.warn(msg);
            TelegramService.queueMsg(msg);
            return;
          }

          await this.bot.waitForResolveState.handleManualCloseRequest();
          TelegramService.queueMsg(`✅ Manual close completed. Recording PnL and returning to starting cycle.`);
          return;
        }

        await this.bot.triggerCloseSignal();
        TelegramService.queueMsg(`✅ Close order filled. Position snapshot updated.`);
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : `${error}`;
        console.error("Failed to process /close_position command:", error);
        TelegramService.queueMsg(`❌ Failed to close position: ${errMsg}`);
      }
    });
  }
}

export default BBTgCmdHandler;

