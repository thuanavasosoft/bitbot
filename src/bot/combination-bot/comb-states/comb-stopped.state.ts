import type CombBotInstance from "../comb-bot-instance";

class CombStoppedState {
  constructor(private bot: CombBotInstance) { }

  async onEnter(): Promise<void> {
    const reason = this.bot.stopReason ?? "unknown";
    const stoppedAtIso = this.bot.stopAtMs ? new Date(this.bot.stopAtMs).toISOString() : new Date().toISOString();
    console.log(`[COMB] CombStoppedState onEnter symbol=${this.bot.symbol} reason=${reason}`);
    this.bot.queueMsg(
      `🛑 COMB BOT INSTANCE STOPPED (symbol only)\n` +
      `Symbol: ${this.bot.symbol}\n` +
      `Stopped at: ${stoppedAtIso}\n` +
      `Reason: ${reason}\n\n` +
      `This instance will not trade further. Other symbols keep running.`
    );
  }

  async onExit(): Promise<void> {
    console.log(`[COMB] CombStoppedState onExit symbol=${this.bot.symbol}`);
  }
}

export default CombStoppedState;
