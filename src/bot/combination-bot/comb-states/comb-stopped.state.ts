import type CombBotInstance from "../comb-bot-instance";

class CombStoppedState {
  constructor(private bot: CombBotInstance) { }

  async onEnter(): Promise<void> {
    const reason = this.bot.stopReason ?? "unknown";
    const stoppedAtIso = this.bot.stopAtMs ? new Date(this.bot.stopAtMs).toISOString() : new Date().toISOString();
    const isPaused = this.bot.isPausedByCommand;
    // Reset derived/runtime state so restart begins cleanly.
    this.bot.currTrailMultiplier = undefined;
    this.bot.lastOptimizationAtMs = 0;

    this.bot.currentSupport = null;
    this.bot.currentResistance = null;
    this.bot.longTrigger = null;
    this.bot.shortTrigger = null;

    this.bot.resetTrailingStopTracking();
    this.bot.trailingStopBreachCount = 0;
    this.bot.resetBadEntryTracking();
    this.bot.lastSignalResult = null;

    this.bot.entryWsPrice = undefined;
    this.bot.resolveWsPrice = undefined;

    console.log(`[COMB] CombStoppedState onEnter symbol=${this.bot.symbol} reason=${reason}`);
    if (this.bot.removeRequested) {
      this.bot.queueMsg(
        `🗑️ COMB BOT INSTANCE REMOVING (symbol only)\n` +
        `Symbol: ${this.bot.symbol}\n` +
        `Stopped at: ${stoppedAtIso}\n` +
        `Reason: ${reason}\n\n` +
        `This instance is being unregistered. Other symbols keep running.`
      );
      return;
    }
    this.bot.queueMsg(
      `${isPaused ? "⏸️ COMB BOT INSTANCE PAUSED" : "🛑 COMB BOT INSTANCE STOPPED"} (symbol only)\n` +
      `Symbol: ${this.bot.symbol}\n` +
      `Stopped at: ${stoppedAtIso}\n` +
      `Reason: ${reason}\n\n` +
      `This instance will not trade further until ${isPaused ? "resumed" : "restarted"}.\n` +
      (isPaused
        ? `Use /resume_symbol ${this.bot.symbol} in the general channel to start it again.\n\n`
        : `This stop was caused by an internal/fatal condition and cannot be resumed with /resume_symbol.\n\n`) +
      `Other symbols keep running.`
    );
  }

  async onExit(): Promise<void> {
    console.log(`[COMB] CombStoppedState onExit symbol=${this.bot.symbol}`);
  }
}

export default CombStoppedState;
