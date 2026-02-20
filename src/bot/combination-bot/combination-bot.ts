import TelegramService, { ETGCommand } from "@/services/telegram.service";
import { EEventBusEventType } from "@/utils/event-bus.util";
import { generatePnLProgressionChart } from "@/utils/image-generator.util";
import { getRunDuration } from "@/utils/maths.util";
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
  /** Account free USDT balance when the general bot run started (for wallet delta). */
  private startQuoteBalance: string | undefined;

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

  /** Send a message to the general combination-bot channel (if COMB_BOT_GENERAL_CHAT_ID is set). */
  queueGeneralMessage(message: string): void {
    if (this.generalChatId) {
      TelegramService.queueMsg(message, this.generalChatId);
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
          `${prefix} 🤯 Liquidated | Close: ${closedPosition.closePrice ?? closedPosition.avgPrice} | Net PnL: ${pnlStr}`
        );
      } else {
        const reasonStr = exitReason === "atr_trailing" ? "Trailing stop" : exitReason === "signal_change" ? "Signal/close" : exitReason;
        this.queueGeneralMessage(
          `${prefix} ✅ Position closed (${reasonStr}) | Net PnL: ${pnlStr}`
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
    return "unknown";
  }

  private async getGeneralFullUpdateMessage(): Promise<string> {
    const lines: string[] = ["[COMB] General – full update", ""];

    const currBalanceBn =
      this.instances.length > 0
        ? await this.instances[0].tmobUtils.getExchTotalUsdtBalance()
        : new BigNumber(0);
    const currQuoteBalance = currBalanceBn.toFixed(4);
    const startQuote = this.startQuoteBalance != null ? new BigNumber(this.startQuoteBalance) : null;
    const walletDelta = startQuote != null ? currBalanceBn.minus(startQuote) : null;

    lines.push("=== ACCOUNT ===");
    lines.push(`Start balance (100%): ${this.startQuoteBalance ?? "N/A"} USDT`);
    lines.push(`Current balance (100%): ${currQuoteBalance} USDT`);
    if (walletDelta != null) {
      lines.push(`Wallet delta: ${walletDelta.gte(0) ? "🟩" : "🟥"} ${walletDelta.toFixed(4)} USDT`);
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
        `Triggers: Long ${inst.longTrigger != null ? inst.longTrigger.toFixed(4) : "N/A"} | Short ${inst.shortTrigger != null ? inst.shortTrigger.toFixed(4) : "N/A"}`
      );
      if (inst.currActivePosition) {
        const pos = inst.currActivePosition;
        lines.push(
          `Position: ${pos.side} @ ${pos.avgPrice} | Size: ${pos.size} | Liq: ${pos.liquidationPrice ?? "N/A"}`
        );
      } else {
        lines.push("Position: No position");
      }
      lines.push("");
      lines.push(
        `Calculated PnL: ${pnl >= 0 ? "🟩" : "🟥"} ${pnl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USDT`
      );
      lines.push(`Trades: ${inst.numberOfTrades} | Slippage accum: ${inst.slippageAccumulation} | Avg slippage: ${avgSlippage}`);
      const lastTrade = inst.getLastTradeMetrics();
      const feeSummary =
        [lastTrade.grossPnl, lastTrade.feeEstimate, lastTrade.netPnl].some(
          (v) => typeof v === "number" && Number.isFinite(v)
        ) && (lastTrade.grossPnl != null || lastTrade.feeEstimate != null || lastTrade.netPnl != null)
          ? formatFeeAwarePnLLine({
            grossPnl: lastTrade.grossPnl,
            feeEstimate: lastTrade.feeEstimate,
            netPnl: lastTrade.netPnl ?? lastTrade.balanceDelta,
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
      `Total calculated PnL: ${mergedPnL >= 0 ? "🟩" : "🟥"} ${mergedPnL.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USDT`
    );

    if (walletDelta != null) {
      const pnlVsWalletGap = walletDelta.toNumber() - mergedPnL;
      lines.push(
        `PnL vs Wallet gap: ${pnlVsWalletGap >= 0 ? "🟩" : "🟥"} ${pnlVsWalletGap.toFixed(4)} USDT (Wallet delta − Calculated PnL)`
      );
    }
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
      if (this.generalChatId) TelegramService.queueMsg(img, this.generalChatId);
      this.queueGeneralMessage(`Merged PnL chart (${merged.length} points from ${this.instances.length} instance(s)).`);
    } catch (err) {
      this.queueGeneralMessage(`Failed to generate merged chart: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private getHelpMessage(): string {
    const lines = [
      "[COMB] Combination bot – Telegram commands",
      "",
      "/help – Show this list of commands (general channel only).",
      "",
      "/full_update – In general channel: overview of all instances (status, balance, position, PnL + merged total). In per-bot channel: full details for that instance.",
      "",
      "/pnl_graph – In general channel: merged PnL chart across all instances. In per-bot channel: PnL chart for that instance.",
      "",
      "This is the general channel. Per-bot commands (/full_update, /pnl_graph) must be used in each instance’s own Telegram channel.",
    ];
    return lines.join("\n");
  }

  private registerTelegramHandlers(): void {
    TelegramService.appendTgCmdHandler(ETGCommand.Help, async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined || !this.generalChatId || String(chatId) !== String(this.generalChatId)) {
        return;
      }
      TelegramService.queueMsg(this.getHelpMessage(), this.generalChatId);
    });

    TelegramService.appendTgCmdHandler(ETGCommand.FullUpdate, async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      if (this.generalChatId && String(chatId) === String(this.generalChatId)) {
        try {
          const msg = await this.getGeneralFullUpdateMessage();
          TelegramService.queueMsg(msg, this.generalChatId);
        } catch (err) {
          TelegramService.queueMsg(`Failed to get general update: ${err instanceof Error ? err.message : String(err)}`, this.generalChatId);
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
        TelegramService.queueMsg(msg, bot.telegramChatId);
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
  }

  async startMakeMoney(): Promise<void> {
    console.log("[COMB] Starting", this.instances.length, "instance(s)");
    this.queueGeneralMessage(`🚀 Starting Combination Bot for ${this.instances.length} instance(s)`);

    if (this.instances.length > 0) {
      const startBal = await this.instances[0].tmobUtils.getExchTotalUsdtBalance();
      this.startQuoteBalance = startBal.decimalPlaces(4, BigNumber.ROUND_DOWN).toString();
      console.log(`[COMB] General bot startQuoteBalance=${this.startQuoteBalance} USDT`);
    }

    for (const instance of this.instances) {
      instance.stateBus.addListener(EEventBusEventType.StateChange, async (nextState: CombState | null) => {
        await instance.currentState.onExit();
        if (instance.currentState === instance.startingState) {
          instance.currentState = instance.waitForSignalState;
        } else if (instance.currentState === instance.waitForSignalState) {
          instance.currentState = instance.waitForResolveState;
        } else if (instance.currentState === instance.waitForResolveState) {
          instance.currentState = nextState ?? instance.startingState;
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
