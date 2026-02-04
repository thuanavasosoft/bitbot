import eventBus, { EEventBusEventType } from "@/utils/event-bus.util";
import TrailMultiplierOptimizationBot, { TMOBState } from "../trail-multiplier-optimization-bot";

class TMOBOptimizeTrailMultiplierState implements TMOBState {
  constructor(private bot: TrailMultiplierOptimizationBot) { }

  async onEnter() {
    console.log("Starting TMOBOptimizeTrailMultiplierState");

    try {
      await this.bot.tmobUtils.updateCurrTrailMultiplier();
      eventBus.emit(EEventBusEventType.StateChange, null);
    } catch (error) {
      console.error("[TMOBOptimizeTrailMultiplierState] Error during optimization:", error);
      eventBus.emit(EEventBusEventType.StateChange, null);
    }
  }

  async onExit() {
    console.log("Exiting TMOBOptimizeTrailMultiplierState");
  }
}

export default TMOBOptimizeTrailMultiplierState;