import ExchangeService from "@/services/exchange-service/exchange-service";
import type { IPosition, TPositionSide } from "@/services/exchange-service/exchange-type";
import TelegramService, { ETGCommand } from "@/services/telegram.service";
import { EEventBusEventType } from "@/utils/event-bus.util";
import { generatePnLProgressionChart } from "@/utils/image-generator.util";
import { calc_UnrealizedPnl, getRunDuration } from "@/utils/maths.util";
import { formatFeeAwarePnLLine, generateRandomString } from "@/utils/strings.util";
import { AsyncMutex } from "@/utils/async-mutex.util";
import BigNumber from "bignumber.js";
import CombBotInstance from "./comb-bot-instance";
import { formatDurationAsHoursMinutes, getCombNextOptimizationRemainingMs } from "./comb-utils";
import type { CombInstanceConfig, CombState, CombInstanceEvent, IClosePositionMsgToCopyTrader, IOpenPositionMsgToCopyTrader } from "./comb-types";
import CombMsgBrokerService from "./comb-services/comb-msg-broker.service";
import CombWsServerService, { ILeverageMap, IWSMessage, IWSWelcomeMessage } from "./comb-services/comb-ws-server.service";
import { formatCombJustManuallyClosedIndicator } from "./comb-candle-watcher";

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

function envBool(key: string, fallback: boolean): boolean {
  const value = process.env[key]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1" || value === "yes";
}

/** Env percent (e.g. 0.6 = 0.6%) to fraction used by ROC checks. */
function optionalPercentThresholdToFraction(raw: number | undefined): number | undefined {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return undefined;
  return raw / 100;
}

type ActiveCombPosition = {
  inst: CombBotInstance;
  position: IPosition;
};

type CombPositionCounts = {
  long: number;
  short: number;
};

type CombClosedExitReason = Extract<CombInstanceEvent, { type: "position_closed" }>["exitReason"];
type MinorityEntryGuardResult = {
  allowed: boolean;
  release: () => void;
  blockedCounts?: CombPositionCounts;
  blockedActivePositionsText?: string;
  blockedReason?: string;
};

const COMB_EXIT_REASON_LABELS: Partial<Record<CombClosedExitReason, string>> = {
  atr_trailing: "Trailing stop",
  signal_change: "Signal/close",
  minority_prevention: "Minority prevention",
  margin_stop_loss: "Margin stop loss",
  bad_signal: "Bad entry (consolidation)",
  hard_take_profit: "Hard take profit",
};

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
  const marginStopLossRaw = envNumRequired(prefix + "MARGIN_STOP_LOSS");
  const marginStopLoss =
    marginStopLossRaw !== undefined && Number.isFinite(marginStopLossRaw) && marginStopLossRaw > 0
      ? marginStopLossRaw
      : undefined;
  const hardTakeProfitRaw = envNumRequired(prefix + "HARD_TAKE_PROFIT_PCT");
  const hardTakeProfit =
    hardTakeProfitRaw !== undefined && Number.isFinite(hardTakeProfitRaw) && hardTakeProfitRaw > 0
      ? hardTakeProfitRaw
      : undefined;
  const badEntryLongRocHighThreshold = optionalPercentThresholdToFraction(
    envNumRequired(prefix + "BAD_ENTRY_LONG_ROC_HIGH_THRESHOLD_PCT"),
  );
  const badEntryShortRocLowThreshold = optionalPercentThresholdToFraction(
    envNumRequired(prefix + "BAD_ENTRY_SHORT_ROC_LOW_THRESHOLD_PCT"),
  );
  return {
    ...config,
    TELEGRAM_CHAT_ID: telegramChatId,
    MARGIN_STOP_LOSS: marginStopLoss,
    HARD_TAKE_PROFIT_PCT: hardTakeProfit,
    BAD_ENTRY_LONG_ROC_HIGH_THRESHOLD_PCT: badEntryLongRocHighThreshold,
    BAD_ENTRY_SHORT_ROC_LOW_THRESHOLD_PCT: badEntryShortRocLowThreshold,
  } as CombInstanceConfig;
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
  combWsServerService: CombWsServerService;
  combMsgBrokerService: CombMsgBrokerService;
  connectedCopyTraderLabels: Set<string> = new Set();
  label: string = envStrRequired("COMB_BOT_LABEL") ?? "Combination Bot " + generateRandomString(10);
  isPreventMinorityEnabled: boolean = envBool("COMBINATION_BOT_IS_PREVENT_MINORITY", true);

  /**
   * Copy-trading infrastructure: optional RabbitMQ fanout + WebSocket server. Used only when running combination bot.
   */
  async startCopyTradingServices(): Promise<void> {
    TelegramService.queueMsg("🗄 Starting copy trading services...", this.generalChatId);
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      await this.combMsgBrokerService.connect();

      this.combWsServerService.start();
      this.combWsServerService.addMsgHandler((rawMsg, client) => {
        const msg: IWSMessage = JSON.parse(rawMsg);
        if (msg.type === "halo") {
          console.log("halo message received", msg);

          const leverageMap: ILeverageMap = {};
          if (msg.data.label !== "__verify_connection__") {
            this.connectedCopyTraderLabels.add(msg.data.label);
            this.queueGeneralMessage(`🔌 [COMB] Copy trader connected ${msg.data.label} (total traders: ${this.connectedCopyTraderLabels.size})`);
            for (const inst of this.instances) {
              leverageMap[inst.symbol] = inst.leverage;
            }
          }

          client.send(JSON.stringify({
            type: "welcome",
            data: leverageMap,
            label: this.label,
          } as IWSWelcomeMessage));
        }

        if (msg.type === "bye") {
          console.log("bye message received", msg);

          this.connectedCopyTraderLabels.delete(msg.data.label);
          this.queueGeneralMessage(`🔌 [COMB] Copy trader disconnected ${msg.data.label} (total traders: ${this.connectedCopyTraderLabels.size})`);
        }
      })
    } catch (error) {
      TelegramService.queueMsg("🗄 Error starting copy trading services: " + error, this.generalChatId);
    }
  }

  private instances: CombBotInstance[] = [];
  private chatIdToInstance: Map<string, CombBotInstance> = new Map();
  private instanceTransitionMutexes: Map<CombBotInstance, AsyncMutex> = new Map();
  private minorityPreventionEntryMutex = new AsyncMutex();
  generalChatId: string | undefined = envStrRequired("COMB_BOT_GENERAL_CHAT_ID");
  /** Account total USDT balance (free + frozen) when the general bot run started (for wallet delta). */
  private startQuoteBalanceBn?: BigNumber;

  constructor() {
    const count = discoverCombBotCount();
    if (count === 0) {
      throw new Error("At least one bot must be configured. Set COMB_BOT_1_SYMBOL (and other COMB_BOT_1_* vars).");
    }

    this.combWsServerService = new CombWsServerService(this);
    this.combMsgBrokerService = new CombMsgBrokerService(this);

    console.log("[COMB] Loading", count, "bot instance(s) (BOT_1, BOT_2, ...)");

    for (let i = 1; i <= count; i++) {
      const config = loadCombConfigForBot(i);
      const instance = new CombBotInstance(config, this);
      this.registerInstance(instance);
    }

    this.registerTelegramHandlers();
  }

  /** Register all routing and lifecycle hooks shared by env-backed and runtime instances. */
  private registerInstance(instance: CombBotInstance): void {
    const botIndex = this.instances.length + 1;
    this.instances.push(instance);
    instance.onInstanceEvent = (event) => this.handleInstanceEvent(botIndex, instance, event);
    instance.onGeneralInfoMessage = (msg) =>
      this.queueGeneralMessage(`[COMB] BOT_${botIndex} (${instance.symbol}) ${msg}`);
    if (instance.telegramChatId) {
      this.chatIdToInstance.set(String(instance.telegramChatId), instance);
    }

    const mutex = new AsyncMutex();
    this.instanceTransitionMutexes.set(instance, mutex);
    instance.stateBus.addListener(EEventBusEventType.StateChange, (nextState: CombState | null) => {
      void this.transitionInstanceState(instance, nextState).catch(async (error) => {
        const reason = `state_transition_failed: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`[COMB] ${reason} symbol=${instance.symbol}`, error);
        if (!instance.isStopped) instance.stopInstance(reason);
        await mutex.acquire();
        try {
          if (instance.currentState !== instance.stoppedState) {
            await instance.currentState.onExit().catch(() => undefined);
            instance.currentState = instance.stoppedState;
            await instance.stoppedState.onEnter();
          }
        } finally {
          mutex.release();
        }
      });
    });
  }

  private async transitionInstanceState(instance: CombBotInstance, nextState: CombState | null): Promise<void> {
    const mutex = this.instanceTransitionMutexes.get(instance);
    if (!mutex || !this.instances.includes(instance)) return;
    let shouldFinishRemove = false;
    await mutex.acquire();
    try {
      if (instance.currentState === instance.stoppedState && nextState === instance.stoppedState) {
        shouldFinishRemove = this.shouldFinishRemove(instance);
        return;
      }
      await instance.currentState.onExit();
      if (nextState) {
        instance.currentState = nextState;
      } else if (instance.completeCommandRemoveIfSafe()) {
        instance.currentState = instance.stoppedState;
      } else if (instance.isStopped && instance.isPausedByCommand) {
        instance.currentState = instance.stoppedState;
      } else if (instance.completeCommandPauseIfSafe()) {
        instance.currentState = instance.stoppedState;
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
      shouldFinishRemove = this.shouldFinishRemove(instance);
    } finally {
      mutex.release();
    }
    if (shouldFinishRemove) this.finishRemoveInstance(instance);
  }

  private async startInstance(instance: CombBotInstance): Promise<void> {
    const mutex = this.instanceTransitionMutexes.get(instance);
    if (!mutex) throw new Error(`Lifecycle mutex is missing for ${instance.symbol}`);
    await mutex.acquire();
    try {
      await instance.currentState.onEnter();
    } finally {
      mutex.release();
    }
  }

  /** Send a message to the general combination-bot channel (if COMB_BOT_GENERAL_CHAT_ID is set). Top priority in the queue. */
  queueGeneralMessage(message: string): void {
    if (this.generalChatId) {
      TelegramService.queueMsgLongPriority(message, this.generalChatId);
    }
  }

  private getInstanceLabel(inst: CombBotInstance): string {
    const index = this.instances.indexOf(inst);
    return index >= 0 ? `BOT_${index + 1} (${inst.symbol})` : inst.symbol;
  }

  private getActiveCombPositions(): ActiveCombPosition[] {
    return this.instances.flatMap((inst) => {
      if (!inst.currActivePosition || inst.justManuallyClosedBy === "minority_prevention") return [];
      return [{ inst, position: inst.currActivePosition }];
    });
  }

  private countActivePositions(activePositions = this.getActiveCombPositions()): CombPositionCounts {
    return activePositions.reduce<CombPositionCounts>(
      (counts, { position }) => ({
        long: counts.long + (position.side === "long" ? 1 : 0),
        short: counts.short + (position.side === "short" ? 1 : 0),
      }),
      { long: 0, short: 0 }
    );
  }

  private formatActivePositionCounts(counts = this.countActivePositions()): string {
    return `${counts.long} long / ${counts.short} short`;
  }

  getMinorityPreventionStatusText(): string {
    return `${this.isPreventMinorityEnabled ? "ENABLED" : "DISABLED"} (COMBINATION_BOT_IS_PREVENT_MINORITY=${this.isPreventMinorityEnabled ? "true" : "false"}, strategy-active: ${this.formatActivePositionCounts()})`;
  }

  async beginMinorityProtectedEntry(
    requestedSide: TPositionSide,
  ): Promise<MinorityEntryGuardResult> {
    if (!this.isPreventMinorityEnabled) {
      return { allowed: true, release: () => { } };
    }

    await this.minorityPreventionEntryMutex.acquire();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.minorityPreventionEntryMutex.release();
    };

    const counts = this.countActivePositions();
    const oppositeSide = requestedSide === "long" ? "short" : "long";
    if (counts[oppositeSide] >= 2) {
      const oppositeSymbols = this.getActiveCombPositions()
        .filter(({ position }) => position.side === oppositeSide)
        .map(({ inst }) => inst.symbol)
        .join(", ");
      return {
        allowed: false,
        release,
        blockedCounts: counts,
        blockedActivePositionsText: this.formatActivePositionCounts(counts),
        blockedReason: `${counts[oppositeSide]} strategy-active ${oppositeSide.toUpperCase()} positions already exist (${oppositeSymbols}), so opening ${requestedSide.toUpperCase()} would create a minority hedge.`,
      };
    }

    return { allowed: true, release };
  }

  async handleMinorityPreventionAfterOpen(openedInst: CombBotInstance): Promise<void> {
    if (!this.isPreventMinorityEnabled) return;

    const activePositions = this.getActiveCombPositions();
    const counts = this.countActivePositions(activePositions);
    const majorityCount = Math.max(counts.long, counts.short);
    if (counts.long === counts.short || majorityCount < 2) return;

    const minoritySide: TPositionSide = counts.long < counts.short ? "long" : "short";
    const minorityPositions = activePositions.filter(
      ({ inst, position }) => position.side === minoritySide && !inst.justManuallyClosedBy
    );
    if (minorityPositions.length === 0) return;

    for (const { inst, position } of minorityPositions) {
      await this.closeMinorityPosition(inst, position, counts);
    }
  }

  private async closeMinorityPosition(
    inst: CombBotInstance,
    activePosition: IPosition,
    counts: CombPositionCounts
  ): Promise<void> {
    const startMessage =
      `🛡️ Minority prevention closing this ${activePosition.side.toUpperCase()} position immediately.\n` +
      `Position ID: ${activePosition.id}\n` +
      `Strategy-active comb positions before clMinority prevention closingose: ${this.formatActivePositionCounts(counts)}`;
    inst.queueMsgPriority(startMessage);
    this.queueGeneralMessage(`[COMB] ${this.getInstanceLabel(inst)} ${startMessage}`);

    try {
      await inst.virtualClosePosition("minority_prevention");
    } catch (error) {
      const message =
        `❌ Minority prevention failed to close ${this.getInstanceLabel(inst)}: ${error instanceof Error ? error.message : String(error)}`;
      inst.queueMsgPriority(message);
      this.queueGeneralMessage(`[COMB] ${message}`);
    }
  }

  private formatExitReason(exitReason: CombClosedExitReason): string {
    return COMB_EXIT_REASON_LABELS[exitReason] ?? exitReason;
  }

  private handleInstanceEvent(botIndex: number, inst: CombBotInstance, event: CombInstanceEvent): void {
    const prefix = `[COMB] BOT_${botIndex} (${inst.symbol})`;
    if (event.type === "position_opened") {
      const pos = event.position;
      const slSuffix = inst.isMarginStopLossEnabled()
        ? ` | ${inst.formatMarginStopLossStatus()}`
        : "";
      const tpSuffix = inst.isHardTakeProfitEnabled()
        ? ` | ${inst.formatHardTakeProfitStatus()}`
        : "";
      this.queueGeneralMessage(
        `${prefix} 📈 Position opened: ${pos.side} @ ${pos.avgPrice} | Size: ${pos.size} | Liq: ${pos.liquidationPrice ?? "N/A"}${slSuffix}${tpSuffix}`
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
        const reasonStr = this.formatExitReason(exitReason);
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
    if (inst.removeRequested) return inst.isStopped ? "removing" : "remove_pending";
    if (inst.isPausedByCommand) return "paused";
    if (inst.pauseRequested) return "pause_pending";
    if (inst.currentState === inst.startingState) return "starting";
    if (inst.currentState === inst.waitForSignalState) return "wait_for_signal";
    if (inst.currentState === inst.waitForResolveState) return "wait_for_resolve";
    if (inst.currentState === inst.stoppedState) return "stopped";
    return "unknown";
  }

  private async getGeneralFullUpdateMessage(): Promise<string> {
    const lines: string[] = ["[COMB] General – full update", ""];
    lines.push(`Label: ${this.label}`);
    lines.push(
      `Minority prevention: ${this.isPreventMinorityEnabled ? "ENABLED" : "DISABLED"} (COMBINATION_BOT_IS_PREVENT_MINORITY=${this.isPreventMinorityEnabled ? "true" : "false"})`
    );
    lines.push(`Strategy-active comb positions: ${this.formatActivePositionCounts()}`);
    const currBalanceBn =
      this.instances.length > 0
        ? await this.instances[0].combUtils.getExchTotalUsdtBalance()
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
    lines.push("=== COPY TRADING ===");
    lines.push(`🐰 Message broker (RabbitMQ): ${this.combMsgBrokerService.getConnectionStatusText()}`);
    lines.push(`🔌 Connected Copy traders: ${this.connectedCopyTraderLabels.size}`);
    lines.push("");
    const nowMs = Date.now();
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
        `N Signal: ${inst.nSignal} | Optimization: ${inst.optimizationWindowMinutes} min window, ${inst.updateIntervalMinutes} min interval`
      );
      lines.push(
        `Trail mult bounds: ${inst.trailMultiplierBounds.min} - ${inst.trailMultiplierBounds.max} | Step size: ${inst.trailBoundStepSize} | Current Trail mult: ${inst.trailingStopMultiplier} | Last optimized: ${inst.lastOptimizationAtMs > 0 ? toIso(inst.lastOptimizationAtMs + 1000) : "N/A"}`
      );
      lines.push(
        `Next reoptimization in: ${formatDurationAsHoursMinutes(Math.floor(getCombNextOptimizationRemainingMs(inst.lastOptimizationAtMs, inst.updateIntervalMinutes, nowMs) / 1000))}`
      );
      lines.push(
        `Triggers: Long ${inst.longTrigger != null ? inst.longTrigger : "N/A"} | Short ${inst.shortTrigger != null ? inst.shortTrigger : "N/A"}`
      );
      if (inst.currActivePosition) {
        const pos = inst.currActivePosition;
        lines.push("Position:");
        lines.push(`Side: ${pos.side.toUpperCase()} | Entry: ${pos.avgPrice} | Size: ${pos.size}`);
        lines.push(`Notional: ${pos.notional ?? "N/A"} USDT | Liquidation: ${pos.liquidationPrice ?? "N/A"}`);
        if (inst.justManuallyClosedBy) {
          const lastNetPnl = inst.lastNetPnl;
          lines.push("\n" + formatCombJustManuallyClosedIndicator(inst.justManuallyClosedBy, lastNetPnl));
        }
      } else {
        lines.push("Position: No open position");
      }
      lines.push(inst.formatMarginStopLossStatus());
      lines.push(inst.formatHardTakeProfitStatus());
      lines.push(
        `Bad entry long ROC high threshold: ${inst.badEntryLongRocHighThreshold != null ? `${inst.badEntryLongRocHighThreshold * 100}%` : "off"}`
      );
      lines.push(
        `Bad entry short ROC low threshold: ${inst.badEntryShortRocLowThreshold != null ? `-${Math.abs(inst.badEntryShortRocLowThreshold * 100)}%` : "off"}`
      );
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
    const earliestStart = this.instances.reduce<number | undefined>((min, inst) => {
      const t = inst.runStartTs?.getTime();
      if (t == null) return min;
      return min == null ? t : Math.min(min, t);
    }, undefined);
    const originTs = earliestStart != null ? Math.min(earliestStart, merged[0].timestamp) : merged[0].timestamp;
    if (merged[0].totalPnL !== 0 || merged[0].timestamp > originTs) {
      merged.unshift({ timestamp: originTs, totalPnL: 0 });
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
    const header = `[COMB] Combination bot – Telegram commands${symbolTag}`;
    const para = "\n";

    if (_options.scope === "general") {
      return [
        header,
        para,
        "/help — Show this list of commands.",
        para,
        "/chat_id — Show current chat id (Telegram global command).",
        para,
        "/full_update — Show a full status report.",
        para,
        "/pnl_graph — Render the PnL progression chart.",
        para,
        "/close_pos all|{SYMBOL} — Close position(s) \n(e.g. /close_pos all or /close_pos BTCUSDT).",
        para,
        "/temp_tm all|{SYMBOL} {value} — Set temporary trail multiplier \n(e.g. /temp_tm all 20). Cleared when position closes.",
        para,
        "/tp_pb all|{SYMBOL} {percent} — Fixed TP at % of avg–LTP gap \n(e.g. /tp_pb all 50). 0 = disabled.",
        para,
        "/set_sl all|{SYMBOL} {percent} — Margin stop loss as % of margin \n(e.g. /set_sl all 60). 0 = disabled.",
        para,
        "/set_tp all|{SYMBOL} {percent} — Hard take profit as % of margin \n(e.g. /set_tp all 40). 0 = disabled.",
        para,
        "/set_roc_filter all|{SYMBOL} {long_pct} {short_pct} — Bad-entry ROC filter \n(e.g. /set_roc_filter all 0.6 0.6). Both values required. 0 = disabled for that side.",
        para,
        "/add_symbol {symbol} {leverage} {margin} {N} {reoptimization_interval} {optimization_window} {minTrailMultiplier} {maxTrailMultiplier} {telegramChatID} [stopLoss] — Add and start a runtime-only symbol.",
        para,
        "/pause_symbol {SYMBOL} — Gracefully pause a symbol. An active position remains managed until resolved.",
        para,
        "/resume_symbol {SYMBOL} — Resume a symbol paused via /pause_symbol, or cancel a pending pause.",
        para,
        "/remove_symbol {SYMBOL} — Gracefully remove a symbol. An active position remains managed until resolved, then the instance is unregistered.",
        para,
        "/un_pnl — Show current unrealized PnL for all instances (one symbol per line).",
        para,
        "/reopt_ls — List all symbols with time until next reoptimization.",
      ].join("\n");
    }

    return [
      header,
      para,
      "/help — Show this list of commands.",
      para,
      "/chat_id — Show current chat id (Telegram global command).",
      para,
      "/full_update — Show a full status report.",
      para,
      "/pnl_graph — Render the PnL progression chart.",
      para,
      "/close_pos — Close the active position for this bot instance (instance keeps running).",
      para,
      "/temp_tm {value} — Set temporary trail multiplier \n(e.g. /temp_tm 100). Cleared when position closes.",
      para,
      "/tp_pb {percent} — Fixed TP: avg ± (gap×%) where gap = |LTP−avg| at command time \n(e.g. /tp_pb 50). 0 = disabled.",
      para,
      "Notes:",
      "",
      "• This is an instance channel. Commands act only on this symbol.",
      para,
      "• /close_pos closes the position; the instance continues running and waits for the next signal.",
    ].join("\n");
  }

  private isGeneralChat(chatId: string | number): boolean {
    return !!this.generalChatId && String(chatId) === String(this.generalChatId);
  }

  private findInstanceBySymbol(symbol: string): CombBotInstance | undefined {
    return this.instances.find((instance) => instance.symbol.toUpperCase() === symbol.trim().toUpperCase());
  }

  private async handleAddSymbolCommand(ctx: { chat?: { id: string | number }; text?: string }): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!this.isGeneralChat(chatId)) {
      TelegramService.queueMsgPriority("Use /add_symbol in the general channel.", String(chatId));
      return;
    }

    const parts = (ctx.text ?? "").trim().split(/\s+/).filter(Boolean);
    const usage =
      "Usage: /add_symbol {symbol} {leverage} {margin} {N} {reoptimization_interval} {optimization_window} " +
      "{minTrailMultiplier} {maxTrailMultiplier} {telegramChatID} [stopLoss]";
    if (parts.length < 10 || parts.length > 11) {
      TelegramService.queueMsgPriority(usage, this.generalChatId);
      return;
    }

    const symbol = parts[1].toUpperCase();
    const leverage = Number(parts[2]);
    const margin = Number(parts[3]);
    const nSignal = Number(parts[4]);
    const updateIntervalMinutes = Number(parts[5]);
    const optimizationWindowMinutes = Number(parts[6]);
    const minTrailMultiplier = Number(parts[7]);
    const maxTrailMultiplier = Number(parts[8]);
    const telegramChatId = parts[9];
    const stopLoss = parts[10] === undefined ? undefined : Number(parts[10]);
    const hardTakeProfit = parts[11] === undefined ? undefined : Number(parts[11]);

    const errors: string[] = [];
    if (!Number.isInteger(leverage) || leverage <= 0) errors.push("leverage must be a positive integer");
    if (!Number.isFinite(margin) || margin <= 0) errors.push("margin must be a positive number");
    if (!Number.isInteger(nSignal) || nSignal <= 0) errors.push("N must be a positive integer");
    if (!Number.isFinite(updateIntervalMinutes) || updateIntervalMinutes <= 0) {
      errors.push("reoptimization_interval must be a positive number");
    }
    if (!Number.isFinite(optimizationWindowMinutes) || optimizationWindowMinutes <= 0) {
      errors.push("optimization_window must be a positive number");
    }
    if (!Number.isFinite(minTrailMultiplier) || minTrailMultiplier <= 0) {
      errors.push("minTrailMultiplier must be a positive number");
    }
    if (!Number.isFinite(maxTrailMultiplier) || maxTrailMultiplier <= 0) {
      errors.push("maxTrailMultiplier must be a positive number");
    }
    if (
      Number.isFinite(minTrailMultiplier) &&
      Number.isFinite(maxTrailMultiplier) &&
      minTrailMultiplier > maxTrailMultiplier
    ) {
      errors.push("minTrailMultiplier must be less than or equal to maxTrailMultiplier");
    }
    if (!/^-?\d+$/.test(telegramChatId)) errors.push("telegramChatID must be an integer chat ID");
    if (stopLoss !== undefined && (!Number.isFinite(stopLoss) || stopLoss < 0)) {
      errors.push("stopLoss must be 0 or a positive number");
    }
    if (hardTakeProfit !== undefined && (!Number.isFinite(hardTakeProfit) || hardTakeProfit < 0)) {
      errors.push("hardTakeProfit must be 0 or a positive number");
    }
    if (errors.length > 0) {
      TelegramService.queueMsgPriority(`Invalid /add_symbol arguments:\n- ${errors.join("\n- ")}\n\n${usage}`, this.generalChatId);
      return;
    }
    if (this.findInstanceBySymbol(symbol)) {
      TelegramService.queueMsgPriority(`Symbol ${symbol} already exists.`, this.generalChatId);
      return;
    }
    if (String(telegramChatId) === String(this.generalChatId)) {
      TelegramService.queueMsgPriority("telegramChatID cannot be the general channel chat ID.", this.generalChatId);
      return;
    }
    if (this.chatIdToInstance.has(String(telegramChatId))) {
      TelegramService.queueMsgPriority("telegramChatID is already assigned to another symbol.", this.generalChatId);
      return;
    }

    try {
      const symbolInfo = await ExchangeService.getSymbolInfo(symbol);
      if (!symbolInfo) throw new Error("exchange returned no symbol information");
    } catch (error) {
      TelegramService.queueMsgPriority(
        `Cannot add ${symbol}: exchange symbol validation failed: ${error instanceof Error ? error.message : String(error)}`,
        this.generalChatId
      );
      return;
    }

    // Recheck after the asynchronous exchange lookup so concurrent commands cannot add duplicates.
    if (this.findInstanceBySymbol(symbol) || this.chatIdToInstance.has(String(telegramChatId))) {
      TelegramService.queueMsgPriority(`Cannot add ${symbol}: symbol or Telegram chat ID was registered concurrently.`, this.generalChatId);
      return;
    }

    TelegramService.queueMsgPriority(`✅ Add and starting new ${symbol}...`, this.generalChatId);

    const defaults = this.instances[0];
    const config: CombInstanceConfig = {
      SYMBOL: symbol,
      LEVERAGE: leverage,
      MARGIN: margin,
      TRIGGER_BUFFER_PERCENTAGE: defaults.triggerBufferPercentage,
      N_SIGNAL_AND_ATR_LENGTH: nSignal,
      UPDATE_INTERVAL_MINUTES: updateIntervalMinutes,
      OPTIMIZATION_WINDOW_MINUTES: optimizationWindowMinutes,
      TRAIL_CONFIRM_BARS: defaults.trailConfirmBars,
      TRAIL_BOUND_STEP_SIZE: defaults.trailBoundStepSize,
      TRAIL_MULTIPLIER_BOUNDS_MIN: minTrailMultiplier,
      TRAIL_MULTIPLIER_BOUNDS_MAX: maxTrailMultiplier,
      TELEGRAM_CHAT_ID: telegramChatId,
      MARGIN_STOP_LOSS: stopLoss && stopLoss > 0 ? stopLoss : undefined,
      HARD_TAKE_PROFIT_PCT: hardTakeProfit && hardTakeProfit > 0 ? hardTakeProfit : undefined,
      BAD_ENTRY_LONG_ROC_HIGH_THRESHOLD_PCT: defaults.badEntryLongRocHighThreshold,
      BAD_ENTRY_SHORT_ROC_LOW_THRESHOLD_PCT: defaults.badEntryShortRocLowThreshold,
    };
    const instance = new CombBotInstance(config, this);
    this.registerInstance(instance);

    try {
      await this.startInstance(instance);
      TelegramService.queueMsgPriority(
        `✅ Added and started ${symbol} (BOT_${this.instances.length}). Configuration is runtime-only and will be lost on process restart.`,
        this.generalChatId
      );
      instance.queueMsg(`✅ ${symbol} was added at runtime from the general channel.`);
    } catch (error) {
      const reason = `runtime_add_initialization_failed: ${error instanceof Error ? error.message : String(error)}`;
      instance.stopInstance(reason);
      const mutex = this.instanceTransitionMutexes.get(instance)!;
      await mutex.acquire();
      try {
        await instance.currentState.onExit().catch(() => undefined);
        instance.currentState = instance.stoppedState;
        await instance.stoppedState.onEnter();
      } finally {
        mutex.release();
      }
      TelegramService.queueMsgPriority(
        `⚠️ ${symbol} was registered but could not start and is now stopped: ${reason}`,
        this.generalChatId
      );
    }
  }

  private handlePauseSymbolCommand(ctx: { chat?: { id: string | number }; text?: string }): void {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!this.isGeneralChat(chatId)) {
      TelegramService.queueMsgPriority("Use /pause_symbol in the general channel.", String(chatId));
      return;
    }
    const parts = (ctx.text ?? "").trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 2) {
      TelegramService.queueMsgPriority("Usage: /pause_symbol {SYMBOL}", this.generalChatId);
      return;
    }
    const instance = this.findInstanceBySymbol(parts[1]);
    if (!instance) {
      TelegramService.queueMsgPriority(`Unknown symbol: ${parts[1]}. Available: ${this.instances.map((i) => i.symbol).join(", ")}`, this.generalChatId);
      return;
    }
    if (instance.removeRequested) {
      TelegramService.queueMsgPriority(`${instance.symbol} is already waiting to be removed.`, this.generalChatId);
      return;
    }
    if (instance.isPausedByCommand || instance.pauseRequested) {
      TelegramService.queueMsgPriority(`${instance.symbol} is already ${instance.isPausedByCommand ? "paused" : "waiting to pause"}.`, this.generalChatId);
      return;
    }
    if (instance.isStopped) {
      TelegramService.queueMsgPriority(`${instance.symbol} is stopped by an internal/fatal condition and cannot be paused.`, this.generalChatId);
      return;
    }

    const result = instance.requestCommandPause();
    if (result === "paused") {
      instance.stateBus.emit(EEventBusEventType.StateChange, instance.stoppedState);
      TelegramService.queueMsgPriority(`⏸️ ${instance.symbol} is pausing now.`, this.generalChatId);
      instance.queueMsg(`⏸️ Pause requested for ${instance.symbol}.`);
      return;
    }
    TelegramService.queueMsgPriority(
      `⏳ Pause pending for ${instance.symbol}. Its active/in-flight position remains managed; the instance will pause when safe.`,
      this.generalChatId
    );
    instance.queueMsg(`⏳ Pause pending for ${instance.symbol}. No new entries will be started.`);
  }

  private handleResumeSymbolCommand(ctx: { chat?: { id: string | number }; text?: string }): void {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!this.isGeneralChat(chatId)) {
      TelegramService.queueMsgPriority("Use /resume_symbol in the general channel.", String(chatId));
      return;
    }
    const parts = (ctx.text ?? "").trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 2) {
      TelegramService.queueMsgPriority("Usage: /resume_symbol {SYMBOL}", this.generalChatId);
      return;
    }
    const instance = this.findInstanceBySymbol(parts[1]);
    if (!instance) {
      TelegramService.queueMsgPriority(`Unknown symbol: ${parts[1]}. Available: ${this.instances.map((i) => i.symbol).join(", ")}`, this.generalChatId);
      return;
    }

    if (instance.removeRequested) {
      TelegramService.queueMsgPriority(
        `${instance.symbol} is being removed and cannot be resumed. Wait for removal to finish, then use /add_symbol if needed.`,
        this.generalChatId
      );
      return;
    }

    const result = instance.resumeCommandPause();
    if (result === "not_paused") {
      TelegramService.queueMsgPriority(
        instance.isStopped
          ? `${instance.symbol} is stopped by an internal/fatal condition and cannot be resumed with /resume_symbol.`
          : `${instance.symbol} is already running.`,
        this.generalChatId
      );
      return;
    }
    if (result === "cancelled_pending") {
      TelegramService.queueMsgPriority(`▶️ Pending pause cancelled; ${instance.symbol} remains running.`, this.generalChatId);
      instance.queueMsg(`▶️ Pending pause cancelled for ${instance.symbol}.`);
      return;
    }
    TelegramService.queueMsgPriority(`▶️ Resuming ${instance.symbol}...`, this.generalChatId);
    instance.queueMsg(`▶️ Resume requested for ${instance.symbol}.`);
  }

  private shouldFinishRemove(instance: CombBotInstance): boolean {
    return (
      instance.removeRequested &&
      instance.isStopped &&
      !instance.currActivePosition &&
      !instance.isOpeningPosition
    );
  }

  private detachInstance(instance: CombBotInstance): void {
    this.instances = this.instances.filter((item) => item !== instance);
    if (instance.telegramChatId) {
      this.chatIdToInstance.delete(String(instance.telegramChatId));
    }
    this.instanceTransitionMutexes.delete(instance);
    instance.disposeRuntimeResources();
  }

  private finishRemoveInstance(instance: CombBotInstance): void {
    if (!this.instances.includes(instance)) return;
    const remaining = this.instances.filter((item) => item !== instance).map((item) => item.symbol);
    instance.queueMsg(`🗑️ ${instance.symbol} was removed. This channel is no longer linked to a bot instance.`);
    TelegramService.queueMsgPriority(
      `🗑️ Removed ${instance.symbol}. Remaining: ${remaining.join(", ") || "(none)"}`,
      this.generalChatId
    );
    this.detachInstance(instance);
  }

  private handleRemoveSymbolCommand(ctx: { chat?: { id: string | number }; text?: string }): void {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (!this.isGeneralChat(chatId)) {
      TelegramService.queueMsgPriority("Use /remove_symbol in the general channel.", String(chatId));
      return;
    }
    const parts = (ctx.text ?? "").trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 2) {
      TelegramService.queueMsgPriority("Usage: /remove_symbol {SYMBOL}", this.generalChatId);
      return;
    }
    const instance = this.findInstanceBySymbol(parts[1]);
    if (!instance) {
      TelegramService.queueMsgPriority(`Unknown symbol: ${parts[1]}. Available: ${this.instances.map((i) => i.symbol).join(", ")}`, this.generalChatId);
      return;
    }
    if (instance.removeRequested) {
      TelegramService.queueMsgPriority(
        `${instance.symbol} is already ${instance.isStopped ? "being removed" : "waiting to be removed"}.`,
        this.generalChatId
      );
      return;
    }
    const remainingKeepers = this.instances.filter((item) => item !== instance && !item.removeRequested);
    if (remainingKeepers.length === 0) {
      TelegramService.queueMsgPriority(
        `Cannot remove ${instance.symbol}: at least one symbol must remain. Add another symbol first, or keep this one.`,
        this.generalChatId
      );
      return;
    }

    const result = instance.requestCommandRemove();
    if (result === "pending") {
      TelegramService.queueMsgPriority(
        `⏳ Remove pending for ${instance.symbol}. Its active/in-flight position remains managed; the instance will be unregistered when safe.`,
        this.generalChatId
      );
      instance.queueMsg(`⏳ Remove pending for ${instance.symbol}. No new entries will be started.`);
      return;
    }

    if (instance.currentState === instance.stoppedState) {
      this.finishRemoveInstance(instance);
      return;
    }
    instance.stateBus.emit(EEventBusEventType.StateChange, instance.stoppedState);
    TelegramService.queueMsgPriority(`🗑️ ${instance.symbol} is being removed.`, this.generalChatId);
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

    TelegramService.appendTgCmdHandler("add_symbol", async (ctx) => {
      await this.handleAddSymbolCommand(ctx);
    });

    TelegramService.appendTgCmdHandler("pause_symbol", async (ctx) => {
      this.handlePauseSymbolCommand(ctx);
    });

    TelegramService.appendTgCmdHandler("resume_symbol", async (ctx) => {
      this.handleResumeSymbolCommand(ctx);
    });

    TelegramService.appendTgCmdHandler("remove_symbol", async (ctx) => {
      this.handleRemoveSymbolCommand(ctx);
    });

    TelegramService.appendTgCmdHandler("broadcast_open_position", async (ctx) => {
      const rawText = ctx.text || "";
      const parts = rawText.trim().split(/\s+/).filter(Boolean);
      const symbol = parts[1];
      const side = parts[2];

      const msg: IOpenPositionMsgToCopyTrader = {
        id: generateRandomString(10),
        symbol,
        side: side ?? "BUY",
        msgType: "OPEN_POSITION",
        timestamp: Date.now(),
      }

      console.log("broadcast_open_position", msg);
      this.combWsServerService.broadcastMsg(JSON.stringify(msg));
      this.combMsgBrokerService.publishFanout(JSON.stringify(msg));
    });

    TelegramService.appendTgCmdHandler("broadcast_close_position", async (ctx) => {
      const rawText = ctx.text || "";
      const parts = rawText.trim().split(/\s+/).filter(Boolean);
      const symbol = parts[1];

      const msg: IClosePositionMsgToCopyTrader = {
        id: generateRandomString(10),
        symbol,
        msgType: "CLOSE_POSITION",
        timestamp: Date.now(),
      }

      console.log("broadcast_close_position", msg);
      this.combWsServerService.broadcastMsg(JSON.stringify(msg));
      this.combMsgBrokerService.publishFanout(JSON.stringify(msg));
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

    TelegramService.appendTgCmdHandler("restart", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      TelegramService.queueMsg("Restart command is disabled.", String(chatId));
    });

    TelegramService.appendTgCmdHandler("temp_tm", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      const rawText = ctx.text || "";
      const parts = rawText.trim().split(/\s+/).filter(Boolean);

      if (this.generalChatId && String(chatId) === String(this.generalChatId)) {
        // General channel: /temp_tm all|{SYMBOL} {value}
        const target = parts[1];
        const valueStr = parts[2];
        if (!target || !valueStr) {
          TelegramService.queueMsgPriority("Usage: /temp_tm all {value} or /temp_tm {SYMBOL} {value} (e.g. /temp_tm all 20 or /temp_tm BTCUSDT 20)", this.generalChatId);
          return;
        }
        const value = Number(valueStr);
        if (!Number.isFinite(value) || value < 0) {
          TelegramService.queueMsgPriority("Value must be a non-negative number.", this.generalChatId);
          return;
        }
        if (target.toLowerCase() === "all") {
          const instancesWithPosition = this.instances.filter((i) => i.currActivePosition && !i.justManuallyClosedBy);
          if (instancesWithPosition.length === 0) {
            TelegramService.queueMsgPriority("No instances with live open position.", this.generalChatId);
            return;
          }
          for (const inst of instancesWithPosition) {
            inst.temporaryTrailMultiplier = value;
          }
          const symbolsStr = instancesWithPosition.map((i) => i.symbol).join(", ");
          const instanceWord = instancesWithPosition.length === 1 ? "instance" : "instances";
          TelegramService.queueMsgPriority(
            `Temporary trail multiplier set to ${value} for ${symbolsStr} (${instancesWithPosition.length} ${instanceWord}). Will be cleared when each position closes.`,
            this.generalChatId
          );
          for (const inst of instancesWithPosition) {
            if (inst.telegramChatId) {
              TelegramService.queueMsg(
                `Temporary trail multiplier set to ${value}. Will be cleared when position closes.`,
                inst.telegramChatId
              );
            }
            await inst.refreshChartAndTrailingLevels();
          }
          return;
        }
        const inst = this.instances.find((i) => i.symbol.toUpperCase() === target.toUpperCase());
        if (!inst) {
          TelegramService.queueMsgPriority(
            `Unknown symbol: ${target}. Available: ${this.instances.map((i) => i.symbol).join(", ")}`,
            this.generalChatId
          );
          return;
        }
        if (!inst.currActivePosition) {
          TelegramService.queueMsgPriority(`${inst.symbol} has no open position, abort....`, this.generalChatId);
          return;
        }
        inst.temporaryTrailMultiplier = value;
        TelegramService.queueMsgPriority(
          `Temporary trail multiplier set to ${value} for ${inst.symbol}. Will be cleared when position closes.`,
          this.generalChatId
        );
        if (inst.telegramChatId) {
          TelegramService.queueMsg(
            `Temporary trail multiplier set to ${value}. Will be cleared when position closes.`,
            inst.telegramChatId
          );
        }
        await inst.refreshChartAndTrailingLevels();
        return;
      }

      // Instance channel: /temp_tm {value}
      const bot = this.getInstanceByChatId(chatId);
      if (!bot) {
        TelegramService.queueMsg("Unknown channel.", String(chatId));
        return;
      }
      const valueStr = parts[1];
      if (!valueStr) {
        TelegramService.queueMsg("Usage: /temp_tm {value} (e.g. /temp_tm 100)", bot.telegramChatId);
        return;
      }
      const value = Number(valueStr);
      if (!Number.isFinite(value) || value < 0) {
        TelegramService.queueMsg("Value must be a non-negative number.", bot.telegramChatId);
        return;
      }
      if (!bot.currActivePosition) {
        TelegramService.queueMsg("No open position for this symbol. abort...", bot.telegramChatId);
        return;
      }
      bot.temporaryTrailMultiplier = value;
      TelegramService.queueMsg(
        `Temporary trail multiplier set to ${value}. Will be cleared when position closes.`,
        bot.telegramChatId
      );
      await bot.refreshChartAndTrailingLevels();
    });

    TelegramService.appendTgCmdHandler("tp_pb", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      const rawText = ctx.text || "";
      const parts = rawText.trim().split(/\s+/).filter(Boolean);

      if (this.generalChatId && String(chatId) === String(this.generalChatId)) {
        const target = parts[1];
        const valueStr = parts[2];
        if (!target || !valueStr) {
          TelegramService.queueMsgPriority(
            "Usage: /tp_pb all {percent} or /tp_pb {SYMBOL} {percent} (e.g. /tp_pb all 50 or /tp_pb BTCUSDT 50). 0 = disabled.",
            this.generalChatId
          );
          return;
        }
        const value = Number(valueStr);
        if (!Number.isFinite(value) || value < 0) {
          TelegramService.queueMsgPriority("Percent must be a non-negative number.", this.generalChatId);
          return;
        }
        if (target.toLowerCase() === "all") {
          const symbolsStr = this.instances.map((i) => i.symbol).join(", ");
          TelegramService.queueMsgPriority(
            value === 0
              ? `TP_PB disabled on all instances (${symbolsStr}).`
              : `Applying TP_PB (${value}% of avg–LTP gap) on all instances (${symbolsStr}). See each channel for result.`,
            this.generalChatId
          );
          for (const inst of this.instances) {
            await inst.applyTpPbFromTelegram(value);
          }
          return;
        }
        const inst = this.instances.find((i) => i.symbol.toUpperCase() === target.toUpperCase());
        if (!inst) {
          TelegramService.queueMsgPriority(
            `Unknown symbol: ${target}. Available: ${this.instances.map((i) => i.symbol).join(", ")}`,
            this.generalChatId
          );
          return;
        }
        TelegramService.queueMsgPriority(
          value === 0
            ? `TP_PB disabled for ${inst.symbol}.`
            : `TP_PB (${value}%) requested for ${inst.symbol}. See instance channel for details.`,
          this.generalChatId
        );
        await inst.applyTpPbFromTelegram(value);
        return;
      }

      const bot = this.getInstanceByChatId(chatId);
      if (!bot) {
        TelegramService.queueMsg("Unknown channel.", String(chatId));
        return;
      }
      const valueStr = parts[1];
      if (!valueStr) {
        const cur =
          bot.tpPbPercent > 0 && bot.tpPbFixedPrice != null
            ? `${bot.tpPbPercent}% → fixed TP ${bot.tpPbFixedPrice}`
            : `${bot.tpPbPercent}% (0 = disabled)`;
        TelegramService.queueMsg(
          `Usage: /tp_pb {percent} (e.g. /tp_pb 50 for 50% of gap between avg and LTP). Current: ${cur}.`,
          bot.telegramChatId
        );
        return;
      }
      const value = Number(valueStr);
      if (!Number.isFinite(value) || value < 0) {
        TelegramService.queueMsg("Value must be a non-negative number.", bot.telegramChatId);
        return;
      }
      await bot.applyTpPbFromTelegram(value);
    });

    TelegramService.appendTgCmdHandler("set_sl", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      const rawText = ctx.text || "";
      const parts = rawText.trim().split(/\s+/).filter(Boolean);

      if (!this.generalChatId || String(chatId) !== String(this.generalChatId)) {
        TelegramService.queueMsgPriority("Use /set_sl in the general channel.", String(chatId));
        return;
      }

      const target = parts[1];
      const valueStr = parts[2];
      if (!target || valueStr === undefined) {
        TelegramService.queueMsgPriority(
          "Usage: /set_sl all {percent} or /set_sl {SYMBOL} {percent} (e.g. /set_sl all 60). 0 = disabled.",
          this.generalChatId
        );
        return;
      }
      const value = Number(valueStr);
      if (!Number.isFinite(value) || value < 0) {
        TelegramService.queueMsgPriority("Percent must be a non-negative number.", this.generalChatId);
        return;
      }

      const applyToInstance = async (inst: CombBotInstance): Promise<void> => {
        inst.applyMarginStopLossPercent(value);
        const status = inst.formatMarginStopLossStatus();
        if (inst.telegramChatId) {
          TelegramService.queueMsg(
            value === 0
              ? `Margin stop loss disabled for ${inst.symbol}.`
              : `${status} for ${inst.symbol}.${inst.currActivePosition ? " Recalculated for open position." : ""}`,
            inst.telegramChatId
          );
        }
        if (inst.currActivePosition) {
          await inst.refreshChartAndTrailingLevels();
        }
      };

      if (target.toLowerCase() === "all") {
        const symbolsStr = this.instances.map((i) => i.symbol).join(", ");
        TelegramService.queueMsgPriority(
          value === 0
            ? `Margin stop loss disabled on all instances (${symbolsStr}).`
            : `Setting margin stop loss to ${value}% of margin on all instances (${symbolsStr}).`,
          this.generalChatId
        );
        for (const inst of this.instances) {
          await applyToInstance(inst);
        }
        return;
      }

      const inst = this.instances.find((i) => i.symbol.toUpperCase() === target.toUpperCase());
      if (!inst) {
        TelegramService.queueMsgPriority(
          `Unknown symbol: ${target}. Available: ${this.instances.map((i) => i.symbol).join(", ")}`,
          this.generalChatId
        );
        return;
      }
      await applyToInstance(inst);
      TelegramService.queueMsgPriority(
        value === 0
          ? `Margin stop loss disabled for ${inst.symbol}.`
          : `${inst.formatMarginStopLossStatus()} for ${inst.symbol}.`,
        this.generalChatId
      );
    });

    const handleSetTp = async (ctx: { chat?: { id: string | number }; text?: string }) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      const rawText = ctx.text || "";
      const parts = rawText.trim().split(/\s+/).filter(Boolean);
      const cmd = (parts[0] || "/set_tp").replace(/^\//, "").toLowerCase();

      if (!this.generalChatId || String(chatId) !== String(this.generalChatId)) {
        TelegramService.queueMsgPriority(`Use /${cmd} in the general channel.`, String(chatId));
        return;
      }

      const target = parts[1];
      const valueStr = parts[2];
      if (!target || valueStr === undefined) {
        TelegramService.queueMsgPriority(
          `Usage: /${cmd} all {percent} or /${cmd} {SYMBOL} {percent} (e.g. /set_tp all 40). 0 = disabled.`,
          this.generalChatId
        );
        return;
      }
      const value = Number(valueStr);
      if (!Number.isFinite(value) || value < 0) {
        TelegramService.queueMsgPriority("Percent must be a non-negative number.", this.generalChatId);
        return;
      }

      const applyToInstance = async (inst: CombBotInstance): Promise<void> => {
        inst.applyHardTakeProfitPercent(value);
        const status = inst.formatHardTakeProfitStatus();
        if (inst.telegramChatId) {
          TelegramService.queueMsg(
            value === 0
              ? `Hard take profit disabled for ${inst.symbol}.`
              : `${status} for ${inst.symbol}.${inst.currActivePosition ? " Recalculated for open position." : ""}`,
            inst.telegramChatId
          );
        }
        if (inst.currActivePosition) {
          await inst.refreshChartAndTrailingLevels();
        }
      };

      if (target.toLowerCase() === "all") {
        const symbolsStr = this.instances.map((i) => i.symbol).join(", ");
        TelegramService.queueMsgPriority(
          value === 0
            ? `Hard take profit disabled on all instances (${symbolsStr}).`
            : `Setting hard take profit to ${value}% of margin on all instances (${symbolsStr}).`,
          this.generalChatId
        );
        for (const inst of this.instances) {
          await applyToInstance(inst);
        }
        return;
      }

      const inst = this.instances.find((i) => i.symbol.toUpperCase() === target.toUpperCase());
      if (!inst) {
        TelegramService.queueMsgPriority(
          `Unknown symbol: ${target}. Available: ${this.instances.map((i) => i.symbol).join(", ")}`,
          this.generalChatId
        );
        return;
      }
      await applyToInstance(inst);
      TelegramService.queueMsgPriority(
        value === 0
          ? `Hard take profit disabled for ${inst.symbol}.`
          : `${inst.formatHardTakeProfitStatus()} for ${inst.symbol}.`,
        this.generalChatId
      );
    };
    TelegramService.appendTgCmdHandler("set_tp", handleSetTp);
    TelegramService.appendTgCmdHandler("set_htp", handleSetTp);

    TelegramService.appendTgCmdHandler("set_roc_filter", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      const rawText = ctx.text || "";
      const parts = rawText.trim().split(/\s+/).filter(Boolean);

      if (!this.generalChatId || String(chatId) !== String(this.generalChatId)) {
        TelegramService.queueMsgPriority("Use /set_roc_filter in the general channel.", String(chatId));
        return;
      }

      const target = parts[1];
      const longStr = parts[2];
      const shortStr = parts[3];
      if (!target || longStr === undefined || shortStr === undefined) {
        TelegramService.queueMsgPriority(
          "Usage: /set_roc_filter all {long_pct} {short_pct} or /set_roc_filter {SYMBOL} {long_pct} {short_pct} (e.g. /set_roc_filter all 0.6 0.6). Both values required. 0 = disabled for that side.",
          this.generalChatId
        );
        return;
      }
      const longPct = Number(longStr);
      const shortPct = Number(shortStr);
      if (!Number.isFinite(longPct) || longPct < 0 || !Number.isFinite(shortPct) || shortPct < 0) {
        TelegramService.queueMsgPriority("Both long_pct and short_pct must be non-negative numbers.", this.generalChatId);
        return;
      }

      const applyToInstance = (inst: CombBotInstance): void => {
        inst.applyBadEntryRocFilter(longPct, shortPct);
        const status = inst.formatBadEntryStatus();
        if (inst.telegramChatId) {
          TelegramService.queueMsg(`${status} for ${inst.symbol}.`, inst.telegramChatId);
        }
      };

      if (target.toLowerCase() === "all") {
        const symbolsStr = this.instances.map((i) => i.symbol).join(", ");
        TelegramService.queueMsgPriority(
          longPct === 0 && shortPct === 0
            ? `ROC filter disabled on all instances (${symbolsStr}).`
            : `Setting ROC filter (long ${longPct}%, short ${shortPct}%) on all instances (${symbolsStr}).`,
          this.generalChatId
        );
        for (const inst of this.instances) {
          applyToInstance(inst);
        }
        return;
      }

      const inst = this.instances.find((i) => i.symbol.toUpperCase() === target.toUpperCase());
      if (!inst) {
        TelegramService.queueMsgPriority(
          `Unknown symbol: ${target}. Available: ${this.instances.map((i) => i.symbol).join(", ")}`,
          this.generalChatId
        );
        return;
      }
      applyToInstance(inst);
      TelegramService.queueMsgPriority(`${inst.formatBadEntryStatus()} for ${inst.symbol}.`, this.generalChatId);
    });

    TelegramService.appendTgCmdHandler("close_pos", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      const rawText = ctx.text || "";
      const parts = rawText.trim().split(/\s+/).filter(Boolean);
      const target = parts[1];

      // Instance channel: /close_pos (no args) closes this instance
      if (!this.generalChatId || String(chatId) !== String(this.generalChatId)) {
        const bot = this.getInstanceByChatId(chatId);
        if (!bot) {
          TelegramService.queueMsg("Unknown channel.", String(chatId));
          return;
        }
        await bot.telegramHandler.handleClosePositionCommand();
        return;
      }

      // General channel: /close_pos all or /close_pos {SYMBOL}
      if (!target) {
        TelegramService.queueMsgPriority("Usage: /close_pos all or /close_pos {SYMBOL} (e.g. /close_pos BTCUSDT)", this.generalChatId);
        return;
      }
      if (target.toLowerCase() === "all") {
        TelegramService.queueMsgPriority(`Sending close command to all (${this.instances.length}) instances...`, this.generalChatId);
        for (const inst of this.instances) {
          inst.telegramHandler.handleClosePositionCommand();
        }
        TelegramService.queueMsgPriority("All positions closed. Instances continue running.", this.generalChatId);
        return;
      }
      const inst = this.instances.find((i) => i.symbol.toUpperCase() === target.toUpperCase());
      if (!inst) {
        TelegramService.queueMsgPriority(
          `Unknown symbol: ${target}. Available: ${this.instances.map((i) => i.symbol).join(", ")}`,
          this.generalChatId
        );
        return;
      }
      TelegramService.queueMsgPriority(`Sending close command to ${inst.symbol}...`, this.generalChatId);
      await inst.telegramHandler.handleClosePositionCommand();
      TelegramService.queueMsgPriority(`Close command sent for ${inst.symbol}.`, this.generalChatId);
    });

    TelegramService.appendTgCmdHandler("restart_all", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      TelegramService.queueMsg("Restart command is disabled.", String(chatId));
    });

    TelegramService.appendTgCmdHandler("un_pnl", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      if (!this.generalChatId || String(chatId) !== String(this.generalChatId)) {
        TelegramService.queueMsgPriority("Use /un_pnl in the general channel.", String(chatId));
        return;
      }
      try {
        const lines: string[] = ["Current strategy unrealized PnL (USDT):", ""];
        let totalUnrealizedPnl = 0;
        let totalBufferedUnrealizedPnl = 0;
        for (const inst of this.instances) {
          const pos = inst.currActivePosition;
          if (!pos) {
            lines.push(`${inst.symbol} - No open position\n`);
            continue;
          }
          const ltpPrice = await ExchangeService.getLTPPrice(inst.symbol);
          const pnl = calc_UnrealizedPnl(pos, ltpPrice);
          const bufferedLtpPrice =
            pos.side === "long" ? ltpPrice * 0.999 : ltpPrice * 1.001;
          const bufferedUnrealizedPnL = calc_UnrealizedPnl(pos, bufferedLtpPrice);
          if (!inst.justManuallyClosedBy) {
            totalUnrealizedPnl += pnl;
            totalBufferedUnrealizedPnl += bufferedUnrealizedPnL;
          }
          const icon = pnl >= 0 ? "🟩" : "🟥";
          const side = pos.side.toUpperCase();
          const lastNetPnl = inst.lastNetPnl;
          const closingIndicator = inst.justManuallyClosedBy ? formatCombJustManuallyClosedIndicator(inst.justManuallyClosedBy, lastNetPnl) + "\n" : "";
          lines.push(
            `${inst.symbol} (${side === "LONG" ? "🟢" : "🔴"} ${side}) - ${icon} ${pnl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT\n${closingIndicator}\n`
          );
        }
        const instancesWithOpenPosition = this.instances.filter(
          (i) => i.currActivePosition && !i.justManuallyClosedBy
        );
        if (instancesWithOpenPosition.length > 0) {
          const totalIcon = totalUnrealizedPnl >= 0 ? "🟩" : "🟥";
          const bufferedIcon = totalBufferedUnrealizedPnl >= 0 ? "🟩" : "🟥";
          const symbolsStr = instancesWithOpenPosition.map((i) => i.symbol).join(", ");
          lines.push(
            "",
            `--- Total (open positions only: ${symbolsStr}) ---`,
            `Total unrealized PnL: ${totalIcon} ${totalUnrealizedPnl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`,
            `Total buffered unrealized PnL: ${bufferedIcon} ${totalBufferedUnrealizedPnl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`,
            "",
            `Note: Closed positions are not included in the total unrealized PnL.`
          );
        }
        TelegramService.queueMsgLongPriority(lines.join("\n"), this.generalChatId);
      } catch (err) {
        TelegramService.queueMsgPriority(`Failed to get unrealized PnL: ${err instanceof Error ? err.message : String(err)}`, this.generalChatId);
      }
    });

    TelegramService.appendTgCmdHandler("reopt_ls", async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined) return;
      if (!this.generalChatId || String(chatId) !== String(this.generalChatId)) {
        TelegramService.queueMsgPriority("Use /reopt_ls in the general channel.", String(chatId));
        return;
      }
      const now = Date.now();
      const lines: string[] = ["[COMB] Reoptimization due in:", ""];
      for (const inst of this.instances) {
        const remainingMs = getCombNextOptimizationRemainingMs(
          inst.lastOptimizationAtMs,
          inst.updateIntervalMinutes,
          now
        );
        const nextStr = formatDurationAsHoursMinutes(Math.floor(remainingMs / 1000));
        lines.push(`${inst.symbol} – ${nextStr}`);
      }
      TelegramService.queueMsgLongPriority(lines.join("\n"), this.generalChatId);
    });
  }

  async startMakeMoney(): Promise<void> {
    this.queueGeneralMessage(`🚀 Starting Combination Bot for ${this.instances.length} instance(s)`);
    await this.startCopyTradingServices();

    console.log("[COMB] Starting", this.instances.length, "instance(s)");

    if (this.instances.length > 0) {
      const startBal = await this.instances[0].combUtils.getExchTotalUsdtBalance();
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
      await this.startInstance(instance);
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
