import type CombBotInstance from "./comb-bot-instance";

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

class CombOptimizationLoop {
  private abort = false;
  private loopPromise: Promise<void> | undefined;

  constructor(private bot: CombBotInstance) { }

  start(): void {
    if (this.loopPromise) return;
    this.abort = false;
    this.loopPromise = this.runLoop();
  }

  stop(): void {
    this.abort = true;
  }

  private async optimizeLiveParams(): Promise<void> {
    const intervalMs = this.bot.updateIntervalMinutes * 60_000;
    const elapsedSinceLastMs = this.bot.lastOptimizationAtMs > 0 ? Date.now() - this.bot.lastOptimizationAtMs : Infinity;
    if (elapsedSinceLastMs < intervalMs) {
      console.log(`[COMB] optimizeLiveParams skip symbol=${this.bot.symbol} reason=intervalNotElapsed elapsedMs=${Math.round(elapsedSinceLastMs)} intervalMs=${intervalMs}`);
      return;
    }

    if (this.bot.currActivePosition) {
      const triggerTs = Date.now();
      const activePosition = this.bot.currActivePosition;
      console.log(`[COMB] optimizeLiveParams symbol=${this.bot.symbol} closingPositionBeforeReoptimize positionId=${activePosition.id} side=${activePosition.side}`);
      this.bot.queueMsg(
        `⏱️ [${toIso(triggerTs)}] Optimization update due - closing open position before re-optimizing.\n` +
        `Position ID: ${activePosition.id} (${activePosition.side})`
      );
      this.bot.orderExecutor.triggerCloseSignal(activePosition).then((closedPosition) => {
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
      const nextOptimizationMs = this.bot.lastOptimizationAtMs + intervalMs + 1000;
      console.log(
        `[COMB] optimizeLiveParams done symbol=${this.bot.symbol} newTrailMult=${this.bot.trailingStopMultiplier} nextDue=${toIso(nextOptimizationMs)}`
      );
      this.bot.queueMsg(
        `✅ Optimization updated\n` +
        `Trailing ATR Length: ${this.bot.trailingAtrLength} (fixed)\n` +
        `Trailing Multiplier: ${this.bot.trailingStopMultiplier}\n` +
        `Next optimization: ${toIso(nextOptimizationMs)}`
      );
    }
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
          console.error(`[COMB] Optimization loop error symbol=${this.bot.symbol}:`, error);
        }
      }

      if (this.abort) break;
      const MS_PER_MINUTE = 60_000;
      const nextDueMs =
        this.bot.lastOptimizationAtMs > 0
          ? (Math.floor(this.bot.lastOptimizationAtMs / MS_PER_MINUTE) + this.bot.updateIntervalMinutes) * MS_PER_MINUTE
          : Math.ceil(now / MS_PER_MINUTE) * MS_PER_MINUTE;
      const waitMs = Math.max(200, nextDueMs + 1000 - Date.now());
      await new Promise((r) => setTimeout(r, waitMs));
    }
    this.loopPromise = undefined;
  }
}

export default CombOptimizationLoop;
