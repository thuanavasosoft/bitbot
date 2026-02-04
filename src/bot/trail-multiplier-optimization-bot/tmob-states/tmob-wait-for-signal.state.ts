import TrailMultiplierOptimizationBot, { TMOBState } from "../trail-multiplier-optimization-bot";

class TMOBWaitForSignalState implements TMOBState {
  constructor(private bot: TrailMultiplierOptimizationBot) { }

  async onEnter() {
    console.log("Starting TMOBWaitForSignalState");
  }

  async onExit() {
    console.log("Exiting TMOBWaitForSignalState");
  }
}

export default TMOBWaitForSignalState;