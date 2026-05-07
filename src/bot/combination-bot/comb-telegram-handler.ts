import ExchangeService from "@/services/exchange-service/exchange-service";
import BigNumber from "bignumber.js";
import { getRunDuration } from "@/utils/maths.util";
import { formatFeeAwarePnLLine, getPositionDetailMsg } from "@/utils/strings.util";
import { generatePnLProgressionChart } from "@/utils/image-generator.util";
import { withRetries, isTransientError } from "./comb-retry";
import { EEventBusEventType } from "@/utils/event-bus.util";
import type CombBotInstance from "./comb-bot-instance";
import { formatDurationAsHoursMinutes, getCombNextOptimizationRemainingMs } from "./comb-utils";
import { formatCombJustManuallyClosedIndicator } from "./comb-candle-watcher";

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

class CombTelegramHandler {
  constructor(private bot: CombBotInstance) { }

  private getFeeSummary() {
    const m = this.bot.getLastTradeMetrics();
    const net = m.netPnl;
    if ([m.grossPnl, m.feeEstimate, net].every((v) => typeof v !== "number" || !Number.isFinite(v))) return undefined;
    return { grossPnl: m.grossPnl, feeEstimate: m.feeEstimate, netPnl: net };
  }

  private formatLastTradeSummary(): string {
    const m = this.bot.getLastTradeMetrics();
    const fee = this.getFeeSummary();
    const feeLine = fee ? formatFeeAwarePnLLine(fee) : formatFeeAwarePnLLine();
    return `Last closed position ID: ${m.closedPositionId ?? "N/A"}\n${feeLine}`;
  }

  async getFullUpdateDetailsMsg(): Promise<string> {
    if (this.bot.currentState === this.bot.startingState) return "Bot in starting state.";
    if (this.bot.currentState === this.bot.waitForSignalState) return "Waiting for entry signal.";
    if (this.bot.currentState === this.bot.waitForResolveState) {
      const position = await withRetries(() => ExchangeService.getPosition(this.bot.symbol), { label: "[COMB] getPosition", retries: 3, minDelayMs: 2000, isTransientError, onRetry: (o) => console.warn(o.label, o.error) }) || this.bot.currActivePosition;
      return `Waiting for resolve.\n${position ? getPositionDetailMsg(position, { feeSummary: this.getFeeSummary() }) : ""}`;
    }
    return "State details unavailable.";
  }

  async getFullUpdateMessage(): Promise<string> {
    const nowMs = Date.now();
    const totalProfit = new BigNumber(this.bot.totalActualCalculatedProfit);
    const runStart = this.bot.runStartTs ?? new Date();
    const { runDurationDisplay } = getRunDuration(runStart);
    const avgSlippage = this.bot.numberOfTrades > 0 ? new BigNumber(this.bot.slippageAccumulation).div(this.bot.numberOfTrades).toFixed(5) : "0";

    return `
=== GENERAL ===
Run ID: ${this.bot.runId}
Symbol: ${this.bot.symbol}
Leverage: X${this.bot.leverage}
Margin: ${this.bot.margin} USDT
Buffer: ${this.bot.triggerBufferPercentage}%
Trail confirm bars: ${this.bot.trailConfirmBars}

=== PARAMS ===
Optimization window: ${this.bot.optimizationWindowMinutes} min
Update interval: ${this.bot.updateIntervalMinutes} min
Trail ATR length: ${this.bot.trailingAtrLength}
Current trail multiplier: ${this.bot.currTrailMultiplier}
Last optimized: ${this.bot.lastOptimizationAtMs > 0 ? toIso(this.bot.lastOptimizationAtMs + 1000) : "N/A"}
Next reoptimization in: ${formatDurationAsHoursMinutes(Math.floor(getCombNextOptimizationRemainingMs(this.bot.lastOptimizationAtMs, this.bot.updateIntervalMinutes, nowMs) / 1000))}

=== DETAILS ===
${await this.getFullUpdateDetailsMsg()}${this.bot.justManuallyClosedBy ? "\n" + formatCombJustManuallyClosedIndicator(this.bot.justManuallyClosedBy, this.bot.lastNetPnl) : ""}

=== PnL ===
Run time: ${runDurationDisplay}
Calculated profit: ${this.bot.totalActualCalculatedProfit.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} USDT
Total profit: ${totalProfit.gte(0) ? "🟩" : "🟥"} ${totalProfit.toNumber().toLocaleString("en-US")} USDT
Note: Entry fee not yet calculated until position is closed. and also Funding/interest is ignored in calculated profit, so wallet balance can differ even with correct fees.

=== LAST TRADE ===
${this.formatLastTradeSummary()}

=== SLIPPAGE ===
Slippage accumulation: ${this.bot.slippageAccumulation} pip(s)
Number of trades: ${this.bot.numberOfTrades}
Average slippage: ~${new BigNumber(avgSlippage).gt(0) ? "🟥" : "🟩"} ${avgSlippage} pip(s)
`;
  }

  async handlePnlGraph(ctx: { text?: string }): Promise<void> {
    if (this.bot.pnlHistory.length === 0) {
      this.bot.queueMsgPriority("No PnL history recorded yet.");
      return;
    }
    const history = this.bot.pnlHistory;
    const chartHistory = history.map((e) => ({ timestamp: e.timestampMs, totalPnL: e.totalPnL }));
    try {
      const img = await generatePnLProgressionChart(chartHistory);
      this.bot.queueMsgPriority(img);
      this.bot.queueMsgPriority(`📈 Full PnL chart sent. Points used: ${history.length}/${history.length}.`);
    } catch (error) {
      this.bot.queueMsgPriority(`⚠️ Failed to generate full PnL chart: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async handleClosePositionCommand(): Promise<void> {
    try {
      if (this.bot.justManuallyClosedBy) {
        this.bot.queueMsgPriority(`Position for ${this.bot.symbol} was already closed via ${this.bot.justManuallyClosedBy}. Not doing anything..`);
        return;
      }
      if (this.bot.isStopped) {
        this.bot.queueMsgPriority(`Instance is already stopped for ${this.bot.symbol}. Use /restart to start it again.`);
        return;
      }

      await this.bot.virtualClosePosition("close_command");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("No active position")) {
        this.bot.queueMsgPriority(`No active position for ${this.bot.symbol}. State unchanged.`);
        return;
      }
      this.bot.queueMsgPriority(`❌ Failed to close position for ${this.bot.symbol}: ${msg}`);
    }
  }

  async handleRestartCommand(): Promise<void> {
    if (!this.bot.isStopped) {
      this.bot.queueMsgPriority(`Instance is already running for ${this.bot.symbol}.`);
      return;
    }

    if (this.bot.currActivePosition) {
      this.bot.queueMsgPriority(
        `Cannot restart because a cached active position exists (id=${this.bot.currActivePosition.id}). ` +
        `Use /close_pos first or clear the position state.`
      );
      return;
    }

    this.bot.isStopped = false;
    this.bot.stopReason = undefined;
    this.bot.stopAtMs = undefined;
    this.bot.queueMsgPriority(`🔄 Restarting instance for ${this.bot.symbol}...`);
    this.bot.stateBus.emit(EEventBusEventType.StateChange, this.bot.startingState);
  }
}

export default CombTelegramHandler;
