import ExchangeService from "@/services/exchange-service/exchange-service";
import TelegramService, { ETGCommand } from "@/services/telegram.service";
import { EEventBusEventType } from "@/utils/event-bus.util";
import { generatePnLProgressionChart } from "@/utils/image-generator.util";
import { calc_UnrealizedPnl, getRunDuration } from "@/utils/maths.util";
import { formatFeeAwarePnLLine } from "@/utils/strings.util";
import BigNumber from "bignumber.js";
import CombBotInstance from "./comb-bot-instance";
import type { CombInstanceConfig, CombState, CombInstanceEvent } from "./comb-types";

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function envNumRequired(key: string): number | undefined {
  const v = process.env[key];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function envStrRequired(key: string): string | undefined {
  const v = process.env[key];
  return (v !== undefined && v !== "") ? v : undefined;
}

/** Required env keys: COMB_BOT_N_<KEY>. Keys match CombInstanceConfig. */
const COMB_REQUIRED_KEYS: { env: string; type: "string" | "number" }[] = [
  { env: "SYMBOL", type: "string" },
  { env: "LEVERAGE", type: "number" },
  { env: "MARGIN", type: "number" },
  { env: "TRIGGER_BUFFER_PERCENTAGE", type: "number" },
  { env: "N_SIGNAL_AND_ATR_LENGTH", type: "number" },
  { env: "UPDATE_INTERVAL_MINUTES", type: "number" },
  { env: "OPTIMIZATION_WINDOW_MINUTES", type: "number" },
  { env: "TRAIL_CONFIRM_BARS", type: "number" },
  { env: "TRAIL_BOUND_STEP_SIZE", type: "number" },
  { env: "TRAIL_MULTIPLIER_BOUNDS_MIN", type: "number" },
  { env: "TRAIL_MULTIPLIER_BOUNDS_MAX", type: "number" },
  { env: "TELEGRAM_CHAT_ID", type: "string" },
];

/**
 * Load config for one combination-bot instance from env.
 * All COMB_BOT_N_* values above are required. If any is missing or invalid, sends message to Telegram and exits.
 * Optional: COMB_BOT_N_TELEGRAM_CHAT_ID (per-bot channel).
 */
function loadCombConfigForBot(botIndex: number): CombInstanceConfig {
  const prefix = `COMB_BOT_${botIndex}_`;
  const missing: string[] = [];
  const config = {} as Record<string, string | number | undefined>;

  for (const { env, type } of COMB_REQUIRED_KEYS) {
    const key = prefix + env;
    const val = type === "string" ? envStrRequired(key) : envNumRequired(key);
    if (val === undefined || (type === "string" && val === "")) {
      missing.push(`COMB_${env}`);
    } else {
      config[env] = val;
    }
  }

  if (missing.length > 0) {
    const message = `[COMB] Combination-bot stopped: missing or invalid config for BOT_${botIndex}. Required: ${missing.join(", ")}. Set COMB_BOT_${botIndex}_<KEY> for each.`;
    console.error(message);
    TelegramService.queueMsg(message, process.env.TELEGRAM_CHAT_ID);
    process.exit(1);
  }

  const telegramChatId = envStrRequired(prefix + "TELEGRAM_CHAT_ID") || undefined;
  return { ...config, TELEGRAM_CHAT_ID: telegramChatId } as CombInstanceConfig;
}

/**
 * Discover how many bots are configured by scanning COMB_BOT_1_SYMBOL, COMB_BOT_2_SYMBOL, ...
 */
function discoverCombBotCount(): number {
  let n = 0;
  while (process.env[`COMB_BOT_${n + 1}_SYMBOL`]) {
    n++;
  }
  return n;
}

/**
 * Combination bot: multiple instances (BOT_1, BOT_2, ...), each with own symbol, params, and Telegram channel.
 * COMB_BOT_GENERAL_CHAT_ID: optional general channel for status (e.g. how many bots running).
 * All logic lives in combination-bot folder; no imports from other bots.
 */
class CombinationBot {
  private instances: CombBotInstance[] = [];
  private chatIdToInstance: Map<string, CombBotInstance> = new Map();
  private generalChatId: string | undefined = envStrRequired("COMB_BOT_GENERAL_CHAT_ID");
  /** Account total USDT balance (free + frozen) when the general bot run started (for wallet delta). */
  private startQuoteBalanceBn?: BigNumber;

  constructor() {
    const count = discoverCombBotCount();
    if (count === 0) {
      throw new Error("At least one bot must be configured. Set COMB_BOT_1_SYMBOL (and other COMB_BOT_1_* vars).");
    }

    console.log("[COMB] Loading", count, "bot instance(s) (BOT_1, BOT_2, ...)");

    for (let i = 1; i <= count; i++) {
      const config = loadCombConfigForBot(i);
      const instance = new CombBotInstance(config);
      const botIndex = i;
      instance.onInstanceEvent = (event) => this.handleInstanceEvent(botIndex, instance, event);
      this.instances.push(instance);
      if (config.TELEGRAM_CHAT_ID) {
        this.chatIdToInstance.set(String(config.TELEGRAM_CHAT_ID), instance);
      }
    }

    this.registerTelegramHandlers();
  }

  /** Send a message to the general combination-bot channel (if COMB_BOT_GENERAL_CHAT_ID is set). Top priority in the queue. */
  queueGeneralMessage(message: string): void {
    if (this.generalChatId) {
      TelegramService.queueMsgLongPriority(message, this.generalChatId);
    }
  }

  private handleInstanceEvent(botIndex: number, inst: CombBotInstance, event: CombInstanceEvent): void {
    const prefix = `[COMB] BOT_${botIndex} (${inst.symbol})`;
    if (event.type === "position_opened") {
      const pos = event.position;
      this.queueGeneralMessage(
        `${prefix} 📈 Position opened: ${pos.side} @ ${pos.avgPrice} | Size: ${pos.size} | Liq: ${pos.liquidationPrice ?? "N/A"}`
      );
      return;
    }
    if (event.type === "position_closed") {
      const { closedPosition, exitReason, netPnl } = event;
      const pnlStr = `${netPnl >= 0 ? "🟩" : "🟥"} ${netPnl.toFixed(4)} USDT`;
      if (exitReason === "liquidation_exit") {
        this.queueGeneralMessage(
          `${prefix} 🤯 Liquidated | Close: ${closedPosition.closePrice ?? closedPosition.avgPrice} | Exit net PnL: ${pnlStr}`
        );
      } else {
        const reasonStr = exitReason === "atr_trailing" ? "Trailing stop" : exitReason === "signal_change" ? "Signal/close" : exitReason;
        this.queueGeneralMessage(
          `${prefix} ✅ Position closed (${reasonStr}) | Exit net PnL: ${pnlStr}`
        );
      }
    }
  }

  private getInstanceByChatId(chatId: string | number): CombBotInstance | undefined {
    return this.chatIdToInstance.get(String(chatId));
  }

  private getInstanceStateName(inst: CombBotInstance): string {
    if (inst.currentState === inst.startingState) return "starting";
    if (inst.currentState === inst.waitForSignalState) return "wait_for_signal";
    if (inst.currentState === inst.waitForResolveState) return "wait_for_resolve";
    if (inst.currentState === inst.stoppedState) return "stopped";
    return "unknown";
  }

  private async getGeneralFullUpdateMessage(): Promise<string> {
    const lines: string[] = ["[COMB] General – full update", ""];

    const currBalanceBn =
      this.instances.length > 0
        ? await this.instances[0].tmobUtils.getExchTotalUsdtBalance()
        : new BigNumber(0);
    const currQuoteBalance = currBalanceBn.decimalPlaces(4, BigNumber.ROUND_HALF_UP).toFixed(4);
    const startQuote = this.startQuoteBalanceBn ?? null;
    const startQuoteDisplay =
      startQuote != null ? startQuote.decimalPlaces(4, BigNumber.ROUND_HALF_UP).toFixed(4) : "N/A";
    const walletDelta = startQuote != null ? currBalanceBn.minus(startQuote) : null;

    lines.push("=== ACCOUNT ===");
    lines.push(`Start balance (100%): ${startQuoteDisplay} USDT`);
    lines.push(`Current balance (100%): ${currQuoteBalance} USDT`);
    if (walletDelta != null) {
      lines.push(
        `Wallet delta: ${walletDelta.gte(0) ? "🟩" : "🟥"} ${walletDelta.decimalPlaces(4, BigNumber.ROUND_HALF_UP).toFixed(4)} USDT`
      );
    }
    lines.push("");

    let mergedPnL = 0;
    let earliestRunStart: Date | undefined;

    for (let i = 0; i < this.instances.length; i++) {
      const inst = this.instances[i];
      const stateName = this.getInstanceStateName(inst);
      const runStart = inst.runStartTs ?? new Date();
      if (!earliestRunStart || runStart.getTime() < earliestRunStart.getTime()) earliestRunStart = runStart;
      const { runDurationDisplay } = getRunDuration(runStart);
      const pnl = inst.totalActualCalculatedProfit;
      mergedPnL += pnl;
      const avgSlippage =
        inst.numberOfTrades > 0 ? (inst.slippageAccumulation / inst.numberOfTrades).toFixed(5) : "0";
      const slippageIcon = new BigNumber(avgSlippage).gt(0) ? "🟥" : "🟩";

      lines.push(`--- BOT_${i + 1} (${inst.symbol}) ---`);
      lines.push(`Run ID: ${inst.runId}`);
      lines.push(`Run start: ${runStart.toISOString()}`);
      lines.push(`Run time: ${runDurationDisplay}`);
      lines.push(`Status: ${stateName}`);
      lines.push("");
      lines.push(`Symbol: ${inst.symbol} | Leverage: X${inst.leverage} | Margin: ${inst.margin} USDT`);
      lines.push(`Buffer: ${inst.triggerBufferPercentage}% | Trail confirm bars: ${inst.trailConfirmBars}`);
      lines.push(
        `Optimization: ${inst.optimizationWindowMinutes} min window, ${inst.updateIntervalMinutes} min interval`
      );
      lines.push(
        `Trail ATR: ${inst.trailingAtrLength} | Trail mult: ${inst.trailingStopMultiplier} | Last optimized: ${inst.lastOptimizationAtMs > 0 ? toIso(inst.lastOptimizationAtMs + 1000) : "N/A"}`
      );
      lines.push(
        `Triggers: Long ${inst.longTrigger != null ? inst.longTrigger : "N/A"} | Short ${inst.shortTrigger != null ? inst.shortTrigger : "N/A"}`
      );
      if (inst.currActivePosition) {
        const pos = inst.currActivePosition;
        lines.push("Position:");
        lines.push(`Side: ${pos.side.toUpperCase()} | Entry: ${pos.avgPrice} | Size: ${pos.size}`);
        lines.push(`Notional: ${pos.notional ?? "N/A"} USDT | Liquidation: ${pos.liquidationPrice ?? "N/A"}`);
      } else {
        lines.push("Position: No open position");
      }
      lines.push("");
      lines.push(
        `Total symbol calculated PnL: ${pnl >= 0 ? "🟩" : "🟥"} ${pnl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USDT`
      );
      lines.push(
        `Trades: ${inst.numberOfTrades} | Slippage accum: ${inst.slippageAccumulation} | Avg slippage: ${slippageIcon} ${avgSlippage}`
      );
      const lastTrade = inst.getLastTradeMetrics();
      const feeSummary =
        [lastTrade.grossPnl, lastTrade.feeEstimate, lastTrade.netPnl].some(
          (v) => typeof v === "number" && Number.isFinite(v)
        ) && (lastTrade.grossPnl != null || lastTrade.feeEstimate != null || lastTrade.netPnl != null)
          ? formatFeeAwarePnLLine({
            grossPnl: lastTrade.grossPnl,
            feeEstimate: lastTrade.feeEstimate,
            netPnl: lastTrade.netPnl,
          })
          : null;
      lines.push(`Last trade: ${lastTrade.closedPositionId ?? "N/A"}${feeSummary ? ` | ${feeSummary}` : ""}`);
      lines.push("");
    }

    lines.push("=== MERGED ===");
    if (earliestRunStart) {
      const { runDurationDisplay } = getRunDuration(earliestRunStart);
      lines.push(`Overall run time: ${runDurationDisplay}`);
    }
    lines.push(
      `Total merged calculated PnL: ${mergedPnL >= 0 ? "🟩" : "🟥"} ${mergedPnL.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USDT`
    );
    if (earliestRunStart && startQuote != null && startQuote.isFinite() && startQuote.gt(0)) {
      const elapsedMs = Date.now() - earliestRunStart.getTime();
      const msPerYear = 365 * 24 * 60 * 60 * 1000;
      const startQuoteBalance = startQuote;
      const totalProfit = new BigNumber(mergedPnL);
      const { runDurationDisplay } = getRunDuration(earliestRunStart);

      const roiPct = startQuoteBalance.lte(0) ? new BigNumber(0) : totalProfit.div(startQuoteBalance).times(100);
      const stratEstimatedYearlyProfit =
        elapsedMs > 0 ? totalProfit.div(elapsedMs).times(msPerYear) : new BigNumber(0);
      const stratEstimatedROI =
        startQuoteBalance.lte(0) ? new BigNumber(0) : stratEstimatedYearlyProfit.div(startQuoteBalance).times(100);

      lines.push("");
      lines.push("=== ROI ===");
      lines.push(`Run time: ${runDurationDisplay}`);
      lines.push(
        `Total profit till now: ${totalProfit.isGreaterThanOrEqualTo(0) ? "🟩" : "🟥"} ${totalProfit
          .toNumber()
          .toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 })} USDT (${roiPct
            .toNumber()
            .toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 })}%) / ${runDurationDisplay}`
      );
      lines.push(
        `Estimated yearly profit: ${stratEstimatedYearlyProfit
          .toNumber()
          .toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 })} USDT (${stratEstimatedROI
            .toNumber()
            .toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 })}%)`
      );
    }
    lines.push("Note: Entry fee not yet calculated until position is closed. and also Funding fees/interest are ignored, so wallet balance can differ even with correct fees.");
    return lines.join("\n");
  }

  private async handleGeneralPnlGraph(): Promise<void> {
    const allTimestamps = new Set<number>();
    for (const inst of this.instances) {
      for (const p of inst.pnlHistory) {
        allTimestamps.add(p.timestampMs);
      }
    }
    const sorted = [...allTimestamps].sort((a, b) => a - b);
    const getInstancePnLAt = (inst: CombBotInstance, t: number): number => {
      const points = inst.pnlHistory.filter((p) => p.timestampMs <= t);
      if (points.length === 0) return 0;
      const last = points.reduce((best, p) => (p.timestampMs > best.timestampMs ? p : best), points[0]);
      return last.totalPnL;
    };
    const merged = sorted.map((t) => ({
      timestamp: t,
      totalPnL: this.instances.reduce((sum, inst) => sum + getInstancePnLAt(inst, t), 0),
    }));
    if (merged.length === 0) {
      this.queueGeneralMessage("No PnL history yet from any instance.");
      return;
    }
    try {
      const img = await generatePnLProgressionChart(merged);
      if (this.generalChatId) TelegramService.queueMsgPriority(img, this.generalChatId);
      this.queueGeneralMessage(`Merged PnL chart (${merged.length} points from ${this.instances.length} instance(s)).`);
    } catch (err) {
      this.queueGeneralMessage(`Failed to generate merged chart: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private getHelpMessage(_options: { scope: "general" | "instance"; symbol?: string }): string {
    const symbolTag = _options.scope === "instance" && _options.symbol ? ` (${_options.symbol})` : "";
    const lines = [
      `[COMB] Combination bot – Telegram commands${symbolTag}`,
      "",
      "/help – Show this list of commands.",
      "/chat_id – Show current chat id (Telegram global command).",
      "",
      "/full_update – Show a full status report.",
      "/pnl_graph – Render the PnL progression chart.",
      "",
      "/stop_all – Stop all bot instances (close position then stop each).",
      "/restart_all – Restart all stopped bot instances.",
      "/un_pnl – Show current unrealized PnL for all instances (one symbol per line).",
    ];

    if (_options.scope === "general") {
      return lines.join("\n");
    }

    lines.push("", "/stop – Close the active position for this bot instance, then stop the instance.", "/restart – Restart a stopped bot instance.", "");
    lines.push(
      "Notes:",
      "- This is an instance channel. Commands act only on this symbol.",
      "- /stop stops the instance after attempting to close the position.",
      "- /restart starts the instance again."
    );

    return lines.join("\n");
  }

  private registerTelegramHandlers(): void {
    TelegramService.appendTgCmdHandler(ETGCommand.Help, async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      if (this.generalChatId && String(chatId) === String(this.generalChatId)) {
        TelegramService.queueMsgLongPriority(this.getHelpMessage({ scope: "general" }), this.generalChatId);
        return;
      }
      const bot = this.getInstanceByChatId(chatId);
      if (!bot) {
        TelegramService.queueMsg("Unknown channel. This chat is not linked to any bot.", String(chatId));
        return;
      }
      TelegramService.queueMsg(this.getHelpMessage({ scope: "instance", symbol: bot.symbol }), bot.telegramChatId);
    });

    TelegramService.appendTgCmdHandler(ETGCommand.FullUpdate, async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      if (this.generalChatId && String(chatId) === String(this.generalChatId)) {
        try {
          const msg = await this.getGeneralFullUpdateMessage();
          TelegramService.queueMsgLongPriority(msg, this.generalChatId);
        } catch (err) {
          TelegramService.queueMsgPriority(`Failed to get general update: ${err instanceof Error ? err.message : String(err)}`, this.generalChatId);
        }
        return;
      }
      const bot = this.getInstanceByChatId(chatId);
      if (!bot) {
        TelegramService.queueMsg("Unknown channel. This chat is not linked to any bot.", String(chatId));
        return;
      }
      try {
        const msg = await bot.telegramHandler.getFullUpdateMessage();
        TelegramService.queueMsgPriority(msg, bot.telegramChatId);
      } catch (err) {
        TelegramService.queueMsg(`Failed to get update: ${err instanceof Error ? err.message : String(err)}`, String(chatId));
      }
    });

    TelegramService.appendTgCmdHandler("pnl_graph", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      if (this.generalChatId && String(chatId) === String(this.generalChatId)) {
        await this.handleGeneralPnlGraph();
        return;
      }
      const bot = this.getInstanceByChatId(chatId);
      if (!bot) {
        TelegramService.queueMsg("Unknown channel.", String(chatId));
        return;
      }
      await bot.telegramHandler.handlePnlGraph(ctx);
    });

    TelegramService.appendTgCmdHandler("stop", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      if (this.generalChatId && String(chatId) === String(this.generalChatId)) {
        TelegramService.queueMsgPriority("Use /stop in the bot instance channel (not the general channel).", this.generalChatId);
        return;
      }
      const bot = this.getInstanceByChatId(chatId);
      if (!bot) {
        TelegramService.queueMsg("Unknown channel.", String(chatId));
        return;
      }
      await bot.telegramHandler.handleClosePositionCommand();
    });

    TelegramService.appendTgCmdHandler("restart", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      if (this.generalChatId && String(chatId) === String(this.generalChatId)) {
        TelegramService.queueMsgPriority("Use /restart in the bot instance channel (not the general channel).", this.generalChatId);
        return;
      }
      const bot = this.getInstanceByChatId(chatId);
      if (!bot) {
        TelegramService.queueMsg("Unknown channel.", String(chatId));
        return;
      }
      await bot.telegramHandler.handleRestartCommand();
    });

    TelegramService.appendTgCmdHandler("stop_all", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      if (!this.generalChatId || String(chatId) !== String(this.generalChatId)) {
        TelegramService.queueMsgPriority("Use /stop_all in the general channel.", String(chatId));
        return;
      }
      TelegramService.queueMsgPriority(`Sending stop command to ${this.instances.length} instance(s)...`, this.generalChatId);
      for (const inst of this.instances) {
        await inst.telegramHandler.handleClosePositionCommand();
      }
      TelegramService.queueMsgPriority("All instances have been sent the stop command.", this.generalChatId);
    });

    TelegramService.appendTgCmdHandler("restart_all", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      if (!this.generalChatId || String(chatId) !== String(this.generalChatId)) {
        TelegramService.queueMsgPriority("Use /restart_all in the general channel.", String(chatId));
        return;
      }
      TelegramService.queueMsgPriority(`Sending restart command to ${this.instances.length} instance(s)...`, this.generalChatId);
      for (const inst of this.instances) {
        await inst.telegramHandler.handleRestartCommand();
      }
      TelegramService.queueMsgPriority("All instances have been sent the restart command.", this.generalChatId);
    });

    TelegramService.appendTgCmdHandler("un_pnl", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      if (!this.generalChatId || String(chatId) !== String(this.generalChatId)) {
        TelegramService.queueMsgPriority("Use /un_pnl in the general channel.", String(chatId));
        return;
      }
      try {
        const lines: string[] = ["Current unrealized PnL (USDT):", ""];
        let totalUnrealizedPnl = 0;
        let totalBufferedUnrealizedPnl = 0;
        for (const inst of this.instances) {
          const pos = inst.currActivePosition;
          if (!pos) {
            lines.push(`${inst.symbol} - No open position`);
            continue;
          }
          const markPrice = inst.resolveWsPrice?.price ?? (await ExchangeService.getMarkPrice(inst.symbol));
          const pnl = calc_UnrealizedPnl(pos, markPrice);
          const bufferedMarkPrice =
            pos.side === "long" ? markPrice * 0.999 : markPrice * 1.001;
          const bufferedUnrealizedPnL = calc_UnrealizedPnl(pos, bufferedMarkPrice);
          totalUnrealizedPnl += pnl;
          totalBufferedUnrealizedPnl += bufferedUnrealizedPnL;
          const icon = pnl >= 0 ? "🟩" : "🟥";
          const side = pos.side.toUpperCase();
          lines.push(
            `${inst.symbol} (${side === "LONG" ? "🟢" : "🔴"} ${side}) - ${icon} ${pnl.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} USDT`
          );
        }
        if (this.instances.some((i) => i.currActivePosition)) {
          const totalIcon = totalUnrealizedPnl >= 0 ? "🟩" : "🟥";
          const bufferedIcon = totalBufferedUnrealizedPnl >= 0 ? "🟩" : "🟥";
          lines.push(
            "",
            `Total unrealized PnL: ${totalIcon} ${totalUnrealizedPnl.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} USDT`,
            `Total buffered unrealized PnL: ${bufferedIcon} ${totalBufferedUnrealizedPnl.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} USDT`
          );
        }
        TelegramService.queueMsgLongPriority(lines.join("\n"), this.generalChatId);
      } catch (err) {
        TelegramService.queueMsgPriority(`Failed to get unrealized PnL: ${err instanceof Error ? err.message : String(err)}`, this.generalChatId);
      }
    });
  }

  async startMakeMoney(): Promise<void> {
    console.log("[COMB] Starting", this.instances.length, "instance(s)");
    this.queueGeneralMessage(`🚀 Starting Combination Bot for ${this.instances.length} instance(s)`);

    if (this.instances.length > 0) {
      const startBal = await this.instances[0].tmobUtils.getExchTotalUsdtBalance();
      this.startQuoteBalanceBn = startBal;
      console.log(
        `[COMB] General bot startQuoteBalance=${startBal.decimalPlaces(8, BigNumber.ROUND_HALF_UP).toFixed(8)} USDT`
      );
      for (let i = 0; i < this.instances.length; i++) {
        const inst = this.instances[i];
        const posInfo = inst.currActivePosition
          ? `${inst.currActivePosition.side} @ ${inst.currActivePosition.avgPrice} size=${inst.currActivePosition.size} liq=${inst.currActivePosition.liquidationPrice ?? "N/A"}`
          : "no position";
        console.log(`[COMB] Bot ${i + 1} (${inst.symbol}) position: ${posInfo}`);
      }
    }

    for (const instance of this.instances) {
      instance.stateBus.addListener(EEventBusEventType.StateChange, async (nextState: CombState | null) => {
        await instance.currentState.onExit();
        if (nextState) {
          instance.currentState = nextState;
        } else if (instance.currentState === instance.startingState) {
          instance.currentState = instance.waitForSignalState;
        } else if (instance.currentState === instance.waitForSignalState) {
          instance.currentState = instance.waitForResolveState;
        } else if (instance.currentState === instance.waitForResolveState) {
          instance.currentState = instance.startingState;
        } else if (instance.currentState === instance.stoppedState) {
          instance.currentState = instance.stoppedState;
        }
        await instance.currentState.onEnter();
      });
      await instance.currentState.onEnter();
    }

    const fullMessage = await this.getGeneralFullUpdateMessage();
    const botListLines = this.instances.map((inst, i) => `Bot ${i + 1}: ${inst.symbol}`).join("\n");
    const accountEnd = fullMessage.indexOf("\n\n", fullMessage.indexOf("=== ACCOUNT ==="));
    const startupMessage =
      fullMessage.slice(0, accountEnd + 2) +
      "=== BOTS ===\n" +
      botListLines +
      "\n\n" +
      fullMessage.slice(accountEnd + 2);
    this.queueGeneralMessage(startupMessage);
  }
}

export default CombinationBot;
