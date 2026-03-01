import type CombBotInstance from "../comb-bot-instance";

class CombStoppedState {
  constructor(private bot: CombBotInstance) { }

  async onEnter(): Promise<void> {
    const reason = this.bot.stopReason ?? "unknown";
    const stoppedAtIso = this.bot.stopAtMs ? new Date(this.bot.stopAtMs).toISOString() : new Date().toISOString();
    // Reset derived/runtime state so restart begins cleanly.
    this.bot.currTrailMultiplier = undefined;
    this.bot.lastOptimizationAtMs = 0;

    this.bot.currentSupport = null;
    this.bot.currentResistance = null;
    this.bot.longTrigger = null;
    this.bot.shortTrigger = null;
    this.bot.bufferedExitLevels = undefined;

    this.bot.resetTrailingStopTracking();
    this.bot.lastTrailingStopUpdateTime = 0;
    this.bot.trailingStopBreachCount = 0;

    this.bot.entryWsPrice = undefined;
    this.bot.resolveWsPrice = undefined;

    console.log(`[COMB] CombStoppedState onEnter symbol=${this.bot.symbol} reason=${reason}`);
    this.bot.queueMsg(
      `🛑 COMB BOT INSTANCE STOPPED (symbol only)\n` +
      `Symbol: ${this.bot.symbol}\n` +
      `Stopped at: ${stoppedAtIso}\n` +
      `Reason: ${reason}\n\n` +
      `This instance will not trade further until restarted.\n` +
      `Use /restart in this instance channel to start it again.\n\n` +
      `Other symbols keep running.`
    );
  }

  async onExit(): Promise<void> {
    console.log(`[COMB] CombStoppedState onExit symbol=${this.bot.symbol}`);
  }
}

export default CombStoppedState;
