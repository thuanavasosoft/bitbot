import TelegramService from "@/services/telegram.service";
import { IPosition } from "@/services/exchange-service/exchange-type";
import { toIso } from "../auto-adjust-bot/candle-utils";
import TMOBUtils from "./tmob-utils";

export interface ITMOBOptimizationBot {
  updateIntervalMinutes: number;
  lastOptimizationAtMs: number;
  currActivePosition?: IPosition;
  currTrailMultiplier?: number;
  trailingStopMultiplier: number;
  trailingAtrLength: number;
  tmobUtils: TMOBUtils;
  resolveWsPrice?: { price: number; time: Date };
  triggerCloseSignal(position?: IPosition): Promise<IPosition>;
  finalizeClosedPosition(
    closedPosition: IPosition,
    options: {
      activePosition?: IPosition;
      triggerTimestamp?: number;
      fillTimestamp?: number;
      isLiquidation?: boolean;
      exitReason?: "atr_trailing" | "signal_change" | "end" | "liquidation_exit";
    }
  ): Promise<void>;
}

interface ITMOBOptimizationBotWritable extends ITMOBOptimizationBot {
  lastOptimizationAtMs: number;
  trailingStopMultiplier: number;
}

class TMOBOptimizationLoop {
  private abort = false;
  private loopPromise: Promise<void> | undefined;

  constructor(private bot: ITMOBOptimizationBotWritable) { }

  start(): void {
    if (this.loopPromise) return;
    this.abort = false;
    this.loopPromise = this.runLoop();
  }

  stop(): void {
    this.abort = true;
  }

  private async runLoop(): Promise<void> {
    while (!this.abort) {
      const now = Date.now();
      const intervalMs = this.bot.updateIntervalMinutes * 60_000;
      const elapsedSinceLastMs = this.bot.lastOptimizationAtMs > 0 ? now - this.bot.lastOptimizationAtMs : Infinity;
      const shouldRunOptimization = this.bot.lastOptimizationAtMs === 0 || elapsedSinceLastMs >= intervalMs;

      if (shouldRunOptimization) {
        try {
          await this.optimizeLiveParams();
        } catch (error) {
          console.error("[TMOB] Live optimization loop error:", error);
        }
      }

      if (this.abort) break;
      const MS_PER_MINUTE = 60_000;
      const nextDueMs =
        this.bot.lastOptimizationAtMs > 0
          ? (Math.floor(this.bot.lastOptimizationAtMs / MS_PER_MINUTE) + this.bot.updateIntervalMinutes) * MS_PER_MINUTE
          : Math.ceil(now / MS_PER_MINUTE) * MS_PER_MINUTE;
      const waitMs = Math.max(200, (nextDueMs + 1000) - Date.now()); // Plus 1 second

      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    this.loopPromise = undefined;
  }

  async optimizeLiveParams(): Promise<void> {
    const intervalMs = this.bot.updateIntervalMinutes * 60_000;
    const elapsedSinceLastMs = this.bot.lastOptimizationAtMs > 0 ? Date.now() - this.bot.lastOptimizationAtMs : Infinity;
    if (elapsedSinceLastMs < intervalMs) {
      console.log(`Not optimizing live params because it's been less than the update interval: ${elapsedSinceLastMs}ms < ${intervalMs}ms`);
      return;
    }

    if (this.bot.currActivePosition) {
      const triggerTs = Date.now();
      const activePosition = this.bot.currActivePosition;
      TelegramService.queueMsg(
        `⏱️ [${toIso(triggerTs)}] Optimization update due - closing open position before re-optimizing.\n` +
        `Position ID: ${activePosition.id} (${activePosition.side})`
      );
      this.bot.triggerCloseSignal(activePosition).then(closedPosition => {
        const fillTimestamp = this.bot.resolveWsPrice?.time ? this.bot.resolveWsPrice.time.getTime() : Date.now();
        this.bot.finalizeClosedPosition(closedPosition, {
          activePosition,
          triggerTimestamp: triggerTs,
          fillTimestamp,
        });
      });
    }

    await this.bot.tmobUtils.updateCurrTrailMultiplier();

    if (this.bot.currTrailMultiplier !== undefined) {
      this.bot.trailingStopMultiplier = this.bot.currTrailMultiplier;
      // This is will be 1 second more of the minute mark handled on tmob optimization loop
      const nextOptimizationMs = this.bot.lastOptimizationAtMs + intervalMs + 1000;

      TelegramService.queueMsg(
        `✅ Optimization updated\n` +
        `Trailing ATR Length: ${this.bot.trailingAtrLength} (fixed)\n` +
        `Trailing Multiplier: ${this.bot.trailingStopMultiplier}\n` +
        `Next optimization: ${toIso(nextOptimizationMs)}`
      );
    }
  }
}

export default TMOBOptimizationLoop;
