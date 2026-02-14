import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import TrailMultiplierOptimizationBot, { TMOBState } from "../trail-multiplier-optimization-bot";
import { persistTMOBAction } from "../tmob-persistence";
import { TMOB_ACTION_TYPE } from "../tmob-action-types";
import { getTMOBBotStateSnapshot } from "../trail-multiplier-optimization-bot";

class TMOBOptimizeTrailMultiplierState implements TMOBState {
  constructor(private bot: TrailMultiplierOptimizationBot) { }

  async onEnter() {
    console.log("Starting TMOBOptimizeTrailMultiplierState");

    try {
      await this.bot.tmobUtils.updateCurrTrailMultiplier();
      await persistTMOBAction(this.bot.runId, TMOB_ACTION_TYPE.TRAIL_MULTIPLIER_OPTIMIZED, {
        trailingStopMultiplier: this.bot.trailingStopMultiplier,
        currTrailMultiplier: this.bot.currTrailMultiplier,
        lastOptimizationAtMs: this.bot.lastOptimizationAtMs,
      }, getTMOBBotStateSnapshot(this.bot));
      eventBus.emit(EEventBusEventType.StateChange, null);
    } catch (error) {
      console.error("[TMOBOptimizeTrailMultiplierState] Error during optimization:", error);
      await persistTMOBAction(this.bot.runId, TMOB_ACTION_TYPE.ERROR, {
        message: error instanceof Error ? error.message : String(error),
        context: "TMOBOptimizeTrailMultiplierState",
        stack: error instanceof Error ? error.stack : undefined,
      }, getTMOBBotStateSnapshot(this.bot));
      eventBus.emit(EEventBusEventType.StateChange, null);
    }
  }

  async onExit() {
    console.log("Exiting TMOBOptimizeTrailMultiplierState");
  }
}

export default TMOBOptimizeTrailMultiplierState;