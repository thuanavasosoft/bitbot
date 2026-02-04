import TrailMultiplierOptimizationBot, { TMOBState } from "../trail-multiplier-optimization-bot";

class TMOBWaitForResolveState implements TMOBState {
  constructor(private bot: TrailMultiplierOptimizationBot) { }

  async onEnter() {
    console.log("Starting TMOBWaitForResolveState");
  }

  async onExit() {
    console.log("Exiting TMOBWaitForResolveState");
  }
}

export default TMOBWaitForResolveState;