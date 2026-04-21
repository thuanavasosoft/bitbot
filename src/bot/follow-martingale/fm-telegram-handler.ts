import BigNumber from "bignumber.js";
import TelegramService, { ETGCommand } from "@/services/telegram.service";
import ExchangeService from "@/services/exchange-service/exchange-service";
import { getRunDuration } from "@/utils/maths.util";
import { formatFeeAwarePnLLine, getPositionDetailMsg } from "@/utils/strings.util";
import type FollowMartingaleBot from "./follow-martingale-bot";

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

class FMTelegramHandler {
  constructor(private bot: FollowMartingaleBot) {}

  private formatLastTradeSummary(): string {
    const m = this.bot.getLastTradeMetrics();
    return `Last closed position ID: ${m.closedPositionId ?? "N/A"}\n${formatFeeAwarePnLLine(m)}`;
  }

  private async getDetailsMessage(): Promise<string> {
    if (this.bot.currentState === this.bot.startingState) return "Bot in starting state.";
    if (this.bot.currentState === this.bot.waitForEntryState) {
      return `Waiting for AUTO breakout.\n` +
        `Long trigger: ${this.bot.currentLongTrigger ?? "N/A"}\nShort trigger: ${this.bot.currentShortTrigger ?? "N/A"}\n` +
        `Support: ${this.bot.currentSupport ?? "N/A"}\nResistance: ${this.bot.currentResistance ?? "N/A"}`;
    }

    const position = await ExchangeService.getPosition(this.bot.symbol).catch(() => this.bot.currActivePosition);
    const nextAddAllowedAt = this.bot.getNextAddAllowedAtMs();
    const cycleSide = this.bot.getActiveCycleSide();
    return `In position.\n${position ? getPositionDetailMsg(position, { feeSummary: this.bot.getLastTradeMetrics() }) : "Position unavailable."}\n` +
      `Cycle side: ${cycleSide ? cycleSide.toUpperCase() : "N/A"}\n` +
      `Legs: ${this.bot.legs.length}/${this.bot.maxLegs}\n` +
      `Current TP: ${this.bot.activeTpPrice ?? "N/A"}\n` +
      `Next add allowed at: ${nextAddAllowedAt ? toIso(nextAddAllowedAt) : "now"}`;
  }

  async getFullUpdateMessage(): Promise<string> {
    const { runDurationDisplay } = getRunDuration(this.bot.runStartTs ?? new Date());
    const avgSlippage = this.bot.getAverageSlippageDisplay();
    const currentTotalBalance = this.bot.currTotalBalance ?? this.bot.startTotalBalance ?? "N/A";

    return `
=== GENERAL ===
Run ID: ${this.bot.runId}
Symbol: ${this.bot.symbol}
Side mode: AUTO (long + short)
Active cycle side: ${this.bot.getActiveCycleSide()?.toUpperCase() ?? "NONE"}
Leverage: X${this.bot.leverage}
Current total balance: ${currentTotalBalance} USDT

=== PARAMS ===
Signal N: ${this.bot.signalN}
Max legs: ${this.bot.maxLegs}
Size multiplier: ${this.bot.sizeMultiplier}
Sizing mode: ${typeof this.bot.fixedMarginUsdt === "number" && this.bot.fixedMarginUsdt > 0 ? `fixed margin ${this.bot.fixedMarginUsdt} USDT` : "total balance geometric sizing"}
Take profit: ${(this.bot.takeProfitPct * 100).toFixed(4)}%
Stop loss: ${this.bot.stopLossPercent >= 100 ? "disabled" : `${this.bot.stopLossPercent}%`}
Buffer: ${(this.bot.bufferPct * 100).toFixed(4)}%
Maintenance discount: ${this.bot.maintenanceDiscountPct}%
Candle resolution: ${this.bot.candleResolution}

=== DETAILS ===
${await this.getDetailsMessage()}

=== PnL ===
Run time: ${runDurationDisplay}
Calculated profit: ${this.bot.totalActualCalculatedProfit.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} USDT

=== LAST TRADE ===
${this.formatLastTradeSummary()}

=== SLIPPAGE ===
Slippage accumulation: ${this.bot.slippageAccumulation} pip(s)
Number of tracked fills: ${this.bot.numberOfTrades}
Average slippage: ~${new BigNumber(avgSlippage).gt(0) ? "🟥" : "🟩"} ${avgSlippage} pip(s)
`;
  }

  register(): void {
    TelegramService.appendTgCmdHandler(ETGCommand.FullUpdate, async () => {
      this.bot.queueMsgPriority(await this.getFullUpdateMessage());
    });

    TelegramService.appendTgCmdHandler("close_pos", async () => {
      if (!this.bot.currActivePosition) {
        this.bot.queueMsgPriority(`No active position for ${this.bot.symbol}.`);
        return;
      }
      if (this.bot.isClosingPosition || this.bot.isFinalizingPosition) {
        this.bot.queueMsgPriority(`A close is already in progress for ${this.bot.symbol}.`);
        return;
      }

      try {
        this.bot.isClosingPosition = true;
        const triggerTimestamp = Date.now();
        this.bot.queueMsgPriority(`Closing position for ${this.bot.symbol}...`);
        await this.bot.cancelActiveTpOrder("manual close");
        const closeResult = await this.bot.orderExecutor.triggerCloseSignal(this.bot.currActivePosition);
        const fillTimestamp = closeResult.fillUpdate.updateTime || Date.now();
        const snapshot = this.bot.buildExitSnapshot(
          closeResult.closedPosition,
          "manual_close",
          triggerTimestamp,
          fillTimestamp,
          false
        );
        await this.bot.finalizeClosedPosition(snapshot);
      } catch (error) {
        this.bot.isClosingPosition = false;
        this.bot.queueMsgPriority(`❌ Failed to close position: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
}

export default FMTelegramHandler;
