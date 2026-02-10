import TelegramService, { ETGCommand } from "@/services/telegram.service";
import ExchangeService from "@/services/exchange-service/exchange-service";
import { IPosition } from "@/services/exchange-service/exchange-type";
import BigNumber from "bignumber.js";
import { isTransientError, withRetries } from "../breakout-bot/bb-retry";
import { FeeAwarePnLOptions, formatFeeAwarePnLLine, getPositionDetailMsg } from "@/utils/strings.util";
import { getRunDuration } from "@/utils/maths.util";
import { generatePnLProgressionChart } from "@/utils/image-generator.util";
import { TMOBState } from "./tmob-types";
import { toIso } from "../auto-adjust-bot/candle-utils";

export interface ITMOBTelegramBot {
  symbol: string;
  leverage: number;
  margin: number;
  startQuoteBalance?: string;
  currQuoteBalance?: string;
  totalActualCalculatedProfit: number;
  slippageAccumulation: number;
  numberOfTrades: number;
  triggerBufferPercentage: number;
  trailConfirmBars: number;
  optimizationWindowMinutes: number;
  updateIntervalMinutes: number;
  trailingAtrLength: number;
  currTrailMultiplier?: number;
  lastOptimizationAtMs: number;
  runStartTs?: Date;
  currentState: TMOBState;
  startingState: TMOBState;
  waitForSignalState: TMOBState;
  waitForResolveState: TMOBState;
  currActivePosition?: IPosition;
  getLastTradeMetrics(): {
    closedPositionId?: number;
    grossPnl?: number;
    balanceDelta?: number;
    feeEstimate?: number;
    netPnl?: number;
  };
  pnlHistory: Array<{
    timestamp: string;
    timestampMs: number;
    side: "long" | "short";
    totalPnL: number;
    entryTimestamp: string | null;
    entryTimestampMs: number | null;
    entryFillPrice: number | null;
    exitTimestamp: string;
    exitTimestampMs: number;
    exitFillPrice: number;
    tradePnL: number;
    exitReason: "atr_trailing" | "signal_change" | "end" | "liquidation_exit";
  }>;
}

class TMOBTelegramHandler {
  constructor(private bot: ITMOBTelegramBot) { }

  private getFeeSummaryForDisplay(): FeeAwarePnLOptions | undefined {
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

  private formatLastTradeSummaryBlock(): string {
    const metrics = this.bot.getLastTradeMetrics();
    const feeSummary = this.getFeeSummaryForDisplay();
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

  async getFullUpdateDetailsMsg(): Promise<string> {
    let details = "";
    if (this.bot.currentState === this.bot.startingState) {
      details = `Bot in starting state, preparing bot balances, symbols, leverage`;
    } else if (this.bot.currentState === this.bot.waitForSignalState) {
      details = `
Bot are in wait for entry state, waiting for breakout signal (Up/Down)`.trim();
    } else if (this.bot.currentState === this.bot.waitForResolveState) {
      let position = await withRetries(
        () => ExchangeService.getPosition(this.bot.symbol),
        {
          label: "[TMOB] getPosition",
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
            label: "[TMOB] getPositionsHistory",
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

${!!position && getPositionDetailMsg(position, { feeSummary: this.getFeeSummaryForDisplay() })}`.trim();
    }

    if (!details) {
      details = `Bot state details unavailable`;
    }

    const lastTradeSummary = this.formatLastTradeSummaryBlock();
    return `${details}

${lastTradeSummary}`;
  }

  register(): void {
    TelegramService.appendTgCmdHandler(ETGCommand.FullUpdate, async () => {
      const startQuoteBalance = new BigNumber(this.bot.startQuoteBalance ?? 0);
      const currQuoteBalance = new BigNumber(this.bot.currQuoteBalance ?? 0);
      const hasBalances = !!this.bot.startQuoteBalance && !!this.bot.currQuoteBalance;

      const totalProfit = new BigNumber(this.bot.totalActualCalculatedProfit);

      const { runDurationInDays, runDurationDisplay } = getRunDuration(new Date(this.bot.runStartTs!));
      const stratDaysWindows = new BigNumber(365).div(runDurationInDays);
      const stratEstimatedYearlyProfit = totalProfit.times(stratDaysWindows);
      const stratEstimatedROI = startQuoteBalance.lte(0) ? new BigNumber(0) : stratEstimatedYearlyProfit.div(startQuoteBalance).times(100);

      const avgSlippage = this.bot.numberOfTrades > 0
        ? new BigNumber(this.bot.slippageAccumulation).div(this.bot.numberOfTrades).toFixed(5)
        : "0";

      const lastTradeSummary = this.formatLastTradeSummaryBlock();

      const startBalanceDisplay = hasBalances
        ? startQuoteBalance.toNumber().toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
        : "N/A";
      const currBalanceDisplay = hasBalances
        ? currQuoteBalance.toNumber().toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
        : "N/A";
      const balanceDiffDisplay = hasBalances
        ? new BigNumber(currQuoteBalance).minus(this.bot.startQuoteBalance!).toNumber().toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })
        : "N/A";

      const msg = `
=== GENERAL ===
Symbol: ${this.bot.symbol}
Leverage: X${this.bot.leverage}
Margin size: ${this.bot.margin} USDT
Buffer percentage: ${this.bot.triggerBufferPercentage}%
Trail confirm bars: ${this.bot.trailConfirmBars}

=== OPTIMIZED PARAMS ===
Optimization window: ${this.bot.optimizationWindowMinutes} minutes
Update interval: ${this.bot.updateIntervalMinutes} minutes
Current trailing ATR Length: ${this.bot.trailingAtrLength} (fixed)
Current trailing multiplier: ${this.bot.currTrailMultiplier}
Last optimized at: ${this.bot.lastOptimizationAtMs > 0 ? toIso(this.bot.lastOptimizationAtMs + 1000) : "N/A"}
Next optimization at: ${this.bot.lastOptimizationAtMs > 0 ? toIso(this.bot.lastOptimizationAtMs + 1000 + this.bot.updateIntervalMinutes * 60_000) : "N/A"}

=== DETAILS ===
${await this.getFullUpdateDetailsMsg()}

=== BUDGET ===
Start Quote Balance (100%): ${startBalanceDisplay} USDT
Current Quote Balance (100%): ${currBalanceDisplay} USDT

Balance current and start diff: ${balanceDiffDisplay} USDT
Calculated actual profit: ${this.bot.totalActualCalculatedProfit.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} USDT

=== ROI ===
Run time: ${runDurationDisplay}
Total profit till now: ${totalProfit.isGreaterThanOrEqualTo(0) ? "🟩" : "🟥"} ${totalProfit.toNumber().toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} USDT (${startQuoteBalance.lte(0) ? 0 : totalProfit.div(startQuoteBalance).times(100).toNumber().toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%) / ${runDurationDisplay}
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

    TelegramService.appendTgCmdHandler("pnl_graph", async (ctx) => {
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
            errorMsg = `Unsupported parameter(s). Use "/pnl_graph dilute <positive_number>".`;
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
      const chartHistory = filteredHistory.map((entry) => ({
        timestamp: Number.isFinite(entry.timestampMs) ? entry.timestampMs : new Date(entry.timestamp).getTime(),
        totalPnL: entry.totalPnL,
      }));

      try {
        const pnlChartImage = await generatePnLProgressionChart(chartHistory);
        TelegramService.queueMsg(pnlChartImage);
        TelegramService.queueMsg(
          `📈 Full PnL chart sent. Points used: ${filteredHistory.length}/${history.length}. Dilute factor: ${dilute}.`
        );
      } catch (error) {
        console.error("Error generating full PnL chart:", error);
        TelegramService.queueMsg(`⚠️ Failed to generate full PnL chart: ${error}`);
      }
    });
  }
}

export default TMOBTelegramHandler;
