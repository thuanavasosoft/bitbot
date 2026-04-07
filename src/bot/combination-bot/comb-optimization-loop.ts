import type CombBotInstance from "./comb-bot-instance";

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

class CombOptimizationLoop {
  private abort = false;
  private loopPromise: Promise<void> | undefined;
  private forceNext = false;
  private sleepWake?: () => void;
  private sleepTimeoutId: ReturnType<typeof setTimeout> | null = null;

  constructor(private bot: CombBotInstance) { }

  start(): void {
    this.abort = false;
    if (this.loopPromise) return;
    this.loopPromise = this.runLoop();
  }

  stop(): void {
    this.abort = true;
    this._wakeSleep();
  }

  /**
   * Wake the optimization loop immediately and force it to run optimizeLiveParams,
   * bypassing the normal update interval check.
   */
  forceReoptimize(): void {
    console.log(`[COMB] forceReoptimize triggered for ${this.bot.symbol} — waking optimization loop`);
    this.forceNext = true;
    this._wakeSleep();
  }

  private _wakeSleep(): void {
    if (this.sleepTimeoutId != null) {
      clearTimeout(this.sleepTimeoutId);
      this.sleepTimeoutId = null;
    }
    if (this.sleepWake) {
      const wake = this.sleepWake;
      this.sleepWake = undefined;
      wake();
    }
  }

  private async optimizeLiveParams(force = false): Promise<void> {
    if (this.abort || this.bot.isStopped) return;
    const intervalMs = this.bot.updateIntervalMinutes * 60_000;
    const elapsedSinceLastMs = this.bot.lastOptimizationAtMs > 0 ? Date.now() - this.bot.lastOptimizationAtMs : Infinity;
    if (!force && elapsedSinceLastMs < intervalMs) {
      console.log(`[COMB] optimizeLiveParams skip symbol=${this.bot.symbol} reason=intervalNotElapsed elapsedMs=${Math.round(elapsedSinceLastMs)} intervalMs=${intervalMs}`);
      return;
    }
    if (force) {
      console.log(`[COMB] optimizeLiveParams force=true symbol=${this.bot.symbol} elapsedMs=${Math.round(elapsedSinceLastMs)}`);
    }

    console.log("OptimizationLive this.bot.currActivePosition: ", this.bot.currActivePosition);

    if (this.bot.currActivePosition) {
      const triggerTs = Date.now();
      const activePosition = this.bot.currActivePosition;

      if (this.bot.isClosingPosition) {
        console.log(`[COMB] optimizeLiveParams symbol=${this.bot.symbol} close skipped: lock held by another close path`);
        this.bot.queueMsg(
          `⚠️ [${this.bot.symbol}] Optimization close order blocked: another close (trailing stop / liquidation) is already in progress — lock is held. Skipping to avoid double order.`
        );
      } else {
        this.bot.isClosingPosition = true;
        console.log(`[COMB] optimizeLiveParams symbol=${this.bot.symbol} closingPositionBeforeReoptimize positionId=${activePosition.id} side=${activePosition.side}`);
        this.bot.queueMsg(
          `⏱️ [${toIso(triggerTs)}] Optimization update due - closing open position before re-optimizing.\n` +
          `Position ID: ${activePosition.id} (${activePosition.side})`
        );
        try {
          const closedPosition = await this.bot.orderExecutor.triggerCloseSignal(activePosition);
          // Guard: another close path may have finalized the position while we were awaiting.
          if (!this.bot.currActivePosition) {
            console.log(`[COMB] optimizeLiveParams symbol=${this.bot.symbol} skipping finalizeClosedPosition: position already finalized by another path`);
            this.bot.queueMsg(`⚠️ [${this.bot.symbol}] Optimization close skipped: position already finalized by another trigger — narrow time gap detected.`);
          } else {
            const fillTimestamp = this.bot.resolveWsPrice?.time ? this.bot.resolveWsPrice.time.getTime() : Date.now();
            await this.bot.finalizeClosedPosition(closedPosition, {
              activePosition,
              triggerTimestamp: triggerTs,
              fillTimestamp,
            });
          }
        } catch (closeErr) {
          console.error(`[COMB] optimizeLiveParams symbol=${this.bot.symbol} failed to close position before reoptimize:`, closeErr);
          this.bot.queueMsg(`⚠️ Failed to close position before re-optimization: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`);
        } finally {
          this.bot.isClosingPosition = false;
        }
      }
    }

    if (this.abort || this.bot.isStopped) return;
    await this.bot.combUtils.updateCurrTrailMultiplier();

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
    while (!this.abort && !this.bot.isStopped) {
      const now = Date.now();
      const intervalMs = this.bot.updateIntervalMinutes * 60_000;
      const elapsedSinceLastMs = this.bot.lastOptimizationAtMs > 0 ? now - this.bot.lastOptimizationAtMs : Infinity;
      const shouldRunOptimization = this.bot.lastOptimizationAtMs === 0 || elapsedSinceLastMs >= intervalMs;

      const isForced = this.forceNext;
      if (isForced) this.forceNext = false;

      if (shouldRunOptimization || isForced) {
        try {
          await this.optimizeLiveParams(isForced);
        } catch (error) {
          console.error(`[COMB] Optimization loop error symbol=${this.bot.symbol}:`, error);
        }
      }

      if (this.abort || this.bot.isStopped) break;
      const MS_PER_MINUTE = 60_000;
      const nextDueMs =
        this.bot.lastOptimizationAtMs > 0
          ? (Math.floor(this.bot.lastOptimizationAtMs / MS_PER_MINUTE) + this.bot.updateIntervalMinutes) * MS_PER_MINUTE
          : Math.ceil(now / MS_PER_MINUTE) * MS_PER_MINUTE;
      const waitMs = Math.max(200, nextDueMs + 1000 - Date.now());
      await new Promise<void>((resolve) => {
        this.sleepWake = resolve;
        this.sleepTimeoutId = setTimeout(() => {
          this.sleepTimeoutId = null;
          this.sleepWake = undefined;
          resolve();
        }, waitMs);
      });
    }
    this.loopPromise = undefined;
  }
}

export default CombOptimizationLoop;
