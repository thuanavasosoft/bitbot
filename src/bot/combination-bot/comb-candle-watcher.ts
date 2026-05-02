import ExchangeService from "@/services/exchange-service/exchange-service";
import { withRetries, isTransientError } from "./comb-retry";
import { generateImageOfCandlesWithSupportResistance } from "@/utils/image-generator.util";
import { calculateBreakoutSignal } from "./comb-backtest";
import { COMB_DEFAULT_SIGNAL_PARAMS, formatCombOptimizationAgeMessage } from "./comb-utils";
import BigNumber from "bignumber.js";
import { ICandleInfo } from "@/services/exchange-service/exchange-type";
import type CombBotInstance from "./comb-bot-instance";
import type { JustManuallyClosedBy } from "./comb-types";
import { calc_UnrealizedPnl } from "@/utils/maths.util";

/** Delay in ms after the minute mark before running each candle watcher iteration (e.g. 500 => 00:01:00.500). */
const CANDLE_WATCHER_DELAY_AFTER_MINUTE_MS = 500;

function justManuallyClosedViaLabel(by: JustManuallyClosedBy): string {
  switch (by) {
    case "close_pos":
      return "/close_pos";
    case "tp_pb":
      return "TP_PB";
    case "minority_prevention":
      return "minority prevention";
  }
}

/** Telegram suffix line when the instance is in “closed but trailing context preserved” mode. */
export function formatCombJustManuallyClosedIndicator(
  justManuallyClosedBy: JustManuallyClosedBy | undefined,
  lastNetPnl: number | null | undefined
): string {
  if (!justManuallyClosedBy) return "";
  const pnl = lastNetPnl ?? 0;
  const pnlEmoji = pnl >= 0 ? "🟩" : "🟥";
  return `⚠️ [closed via ${justManuallyClosedViaLabel(justManuallyClosedBy)} at (${pnlEmoji} ${pnl.toFixed(2)} USDT)]`;
}

class CombCandleWatcher {
  isCandleWatcherStarted = false;

  constructor(private bot: CombBotInstance) { }

  /** Generate and send the price chart (support/resistance, trail stop, etc.) to the instance channel. */
  async refreshChart(): Promise<void> {
    try {
      const now = new Date();
      await this.bot.combCandles.ensurePopulated();
      now.setSeconds(0);
      now.setMilliseconds(0);
      let currCandles = await this.bot.combCandles.getCandles(
        new Date(now.getTime() - (this.bot.nSignal + 1) * 60 * 1000),
        now
      );
      if (currCandles.length <= this.bot.nSignal) {
        const markPrice = await ExchangeService.getMarkPrice(this.bot.symbol);
        currCandles.push({
          timestamp: now.getTime(),
          openTime: now.getTime(),
          closeTime: now.getTime(),
          openPrice: markPrice,
          highPrice: markPrice,
          lowPrice: markPrice,
          closePrice: markPrice,
          volume: 0,
        } as ICandleInfo);
      }
      const signalParams = { ...COMB_DEFAULT_SIGNAL_PARAMS, N: this.bot.nSignal };
      const signalResult = calculateBreakoutSignal(currCandles, signalParams);
      const rawSupport = signalResult.support;
      const rawResistance = signalResult.resistance;
      this.bot.currentSupport = rawSupport;
      this.bot.currentResistance = rawResistance;

      let trailingStopRaw: number | null = null;
      let trailingStopBuffered: number | null = null;
      const trailingTargets = this.bot.trailingStopTargets;
      if (
        trailingTargets &&
        this.bot.currActivePosition &&
        trailingTargets.side === this.bot.currActivePosition.side
      ) {
        trailingStopRaw = trailingTargets.rawLevel;
        trailingStopBuffered = trailingTargets.bufferedLevel;
      }

      let tpPbLevel: number | null = null;
      if (this.bot.tpPbPercent > 0 && this.bot.tpPbFixedPrice != null && this.bot.currActivePosition) {
        tpPbLevel = this.bot.tpPbFixedPrice;
      }

      if (rawResistance !== null) {
        const bufferMultiplier = new BigNumber(1).minus(this.bot.triggerBufferPercentage / 100);
        this.bot.longTrigger = new BigNumber(rawResistance)
          .times(bufferMultiplier)
          .decimalPlaces(this.bot.pricePrecision, BigNumber.ROUND_DOWN)
          .toNumber();
      } else {
        this.bot.longTrigger = null;
      }
      if (rawSupport !== null) {
        const bufferMultiplier = new BigNumber(1).plus(this.bot.triggerBufferPercentage / 100);
        this.bot.shortTrigger = new BigNumber(rawSupport)
          .times(bufferMultiplier)
          .decimalPlaces(this.bot.pricePrecision, BigNumber.ROUND_UP)
          .toNumber();
      } else {
        this.bot.shortTrigger = null;
      }

      const signalImageData = await withRetries(
        () =>
          generateImageOfCandlesWithSupportResistance(
            this.bot.symbol,
            currCandles,
            rawSupport,
            rawResistance,
            false,
            now,
            this.bot.currActivePosition ?? undefined,
            this.bot.longTrigger ?? undefined,
            this.bot.shortTrigger ?? undefined,
            trailingStopRaw ?? undefined,
            trailingStopBuffered ?? undefined,
            tpPbLevel ?? undefined,
          ),
        {
          label: "[CombCandleWatcher] refreshChart generateImage",
          retries: 3,
          minDelayMs: 2000,
          isTransientError,
          onRetry: ({ attempt, delayMs, error, label }) =>
            console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error),
        }
      );
      this.bot.queueMsg(signalImageData);

      const effectiveMult = this.bot.temporaryTrailMultiplier ?? this.bot.trailingStopMultiplier;
      const trailingMsg =
        trailingStopRaw !== null || trailingStopBuffered !== null
          ? `\nTrail Stop (raw): ${trailingStopRaw !== null ? trailingStopRaw : "N/A"}\nTrail Stop (buffered): ${trailingStopBuffered !== null ? trailingStopBuffered : "N/A"}`
          : "";
      const tpPbMsg =
        tpPbLevel !== null ? `\nTP_PB fixed (${this.bot.tpPbPercent}% of gap): ${tpPbLevel}` : "";
      const paramsMsg =
        `\nTrailing ATR Length: ${this.bot.trailingAtrLength} (fixed)` +
        `\nTrailing Multiplier: ${effectiveMult}${this.bot.temporaryTrailMultiplier != null ? " (temp)" : ""}`;
      const optimizationAgeMsg = formatCombOptimizationAgeMessage(this.bot, now.getTime());
      const closedIndicator = formatCombJustManuallyClosedIndicator(this.bot.justManuallyClosedBy, this.bot.lastNetPnl);

      const rocVal = signalResult.roc != null ? `${(signalResult.roc * 100).toFixed(4)}%` : "N/A";

      const currLtpPrice = await ExchangeService.getLTPPrice(this.bot.symbol);
      const currPnl = !!this.bot.currActivePosition ? calc_UnrealizedPnl(this.bot.currActivePosition, currLtpPrice) : 0;
      const pnlIndicator = currPnl >= 0 ? "🟩" : "🟥";

      this.bot.queueMsg(
        `ℹ️ Curr LTP Price: ${currLtpPrice.toFixed(this.bot.pricePrecision)} ${!!this.bot.currActivePosition ? `(${pnlIndicator} ${currPnl.toFixed(2)} USDT)` : ""}\n` +
        `ROC Val: ${rocVal}\n` +
        `Resistance: ${rawResistance !== null ? rawResistance : "N/A"}\nLong Trigger: ${this.bot.longTrigger !== null ? this.bot.longTrigger : "N/A"}\n` +
        `Support: ${rawSupport !== null ? rawSupport : "N/A"}\nShort Trigger: ${this.bot.shortTrigger !== null ? this.bot.shortTrigger : "N/A"}${trailingMsg}${tpPbMsg}${paramsMsg}${optimizationAgeMsg}\n${closedIndicator}`
      );
      this.bot.lastSRUpdateTime = Date.now();
    } catch (err) {
      this.bot.queueMsg(
        `⚠️ Failed to refresh chart: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async startWatchingCandles() {
    if (this.isCandleWatcherStarted) return;
    this.isCandleWatcherStarted = true;
    this.bot.queueMsg("🔍 Starting CombCandleWatcher");
    try {
      while (!this.bot.isStopped) {
        try {
          const now = new Date();
          await this.bot.combCandles.ensurePopulated();
          now.setSeconds(0);
          now.setMilliseconds(0);
          let currCandles = await this.bot.combCandles.getCandles(new Date(now.getTime() - (this.bot.nSignal + 1) * 60 * 1000), now);
          if (currCandles.length <= this.bot.nSignal) {
            const markPrice = await ExchangeService.getMarkPrice(this.bot.symbol);
            currCandles.push({
              timestamp: now.getTime(),
              openTime: now.getTime(),
              closeTime: now.getTime(),
              openPrice: markPrice,
              highPrice: markPrice,
              lowPrice: markPrice,
              closePrice: markPrice,
              volume: 0,
            } as ICandleInfo);
          }
          const signalParams = { ...COMB_DEFAULT_SIGNAL_PARAMS, N: this.bot.nSignal };
          const signalResult = calculateBreakoutSignal(currCandles, signalParams);
          const rawSupport = signalResult.support;
          const rawResistance = signalResult.resistance;
          this.bot.currentSupport = rawSupport;
          this.bot.currentResistance = rawResistance;

          let trailingStopRaw: number | null = null;
          let trailingStopBuffered: number | null = null;
          const trailingTargets = this.bot.trailingStopTargets;
          if (
            trailingTargets &&
            this.bot.currActivePosition &&
            trailingTargets.side === this.bot.currActivePosition.side
          ) {
            trailingStopRaw = trailingTargets.rawLevel;
            trailingStopBuffered = trailingTargets.bufferedLevel;
          }

          let tpPbLevel: number | null = null;
          if (this.bot.tpPbPercent > 0 && this.bot.tpPbFixedPrice != null && this.bot.currActivePosition) {
            tpPbLevel = this.bot.tpPbFixedPrice;
          }

          if (rawResistance !== null) {
            const bufferMultiplier = new BigNumber(1).minus(this.bot.triggerBufferPercentage / 100);
            const longTriggerRaw = new BigNumber(rawResistance).times(bufferMultiplier);
            this.bot.longTrigger = longTriggerRaw
              .decimalPlaces(this.bot.pricePrecision, BigNumber.ROUND_DOWN)
              .toNumber();
          } else {
            this.bot.longTrigger = null;
          }
          if (rawSupport !== null) {
            const bufferMultiplier = new BigNumber(1).plus(this.bot.triggerBufferPercentage / 100);
            const shortTriggerRaw = new BigNumber(rawSupport).times(bufferMultiplier);
            this.bot.shortTrigger = shortTriggerRaw
              .decimalPlaces(this.bot.pricePrecision, BigNumber.ROUND_UP)
              .toNumber();
          } else {
            this.bot.shortTrigger = null;
          }

          const signalImageData = await withRetries(
            () =>
              generateImageOfCandlesWithSupportResistance(
                this.bot.symbol,
                currCandles,
                rawSupport,
                rawResistance,
                false,
                now,
                this.bot.currActivePosition ?? undefined,
                this.bot.longTrigger ?? undefined,
                this.bot.shortTrigger ?? undefined,
                trailingStopRaw ?? undefined,
                trailingStopBuffered ?? undefined,
                tpPbLevel ?? undefined,
              ),
            {
              label: "[CombCandleWatcher] generateImageOfCandlesWithSupportResistance",
              retries: 5,
              minDelayMs: 5000,
              isTransientError,
              onRetry: ({ attempt, delayMs, error, label }) => {
                console.warn(`${label} retrying (attempt=${attempt}, delayMs=${delayMs}):`, error);
              },
            }
          );
          this.bot.queueMsg(signalImageData);

          const trailingMsg =
            trailingStopRaw !== null || trailingStopBuffered !== null
              ? `\nTrail Stop (raw): ${trailingStopRaw !== null ? trailingStopRaw : "N/A"}\nTrail Stop (buffered): ${trailingStopBuffered !== null ? trailingStopBuffered : "N/A"}`
              : "";
          const tpPbMsg =
            tpPbLevel !== null ? `\nTP_PB fixed (${this.bot.tpPbPercent}% of gap): ${tpPbLevel}` : "";
          const optimizationAgeMsg = formatCombOptimizationAgeMessage(this.bot, now.getTime());
          const effectiveMult = this.bot.temporaryTrailMultiplier ?? this.bot.trailingStopMultiplier;
          const paramsMsg =
            `\nTrailing ATR Length: ${this.bot.trailingAtrLength} (fixed)` +
            `\nTrailing Multiplier: ${effectiveMult}${this.bot.temporaryTrailMultiplier != null ? " (temp)" : ""}`;
          const closedIndicator = formatCombJustManuallyClosedIndicator(this.bot.justManuallyClosedBy, this.bot.lastNetPnl);
          const rocVal = signalResult.roc != null ? `${(signalResult.roc * 100).toFixed(2)}%` : "N/A";

          const currLtpPrice = await ExchangeService.getLTPPrice(this.bot.symbol);
          const currPnl = !!this.bot.currActivePosition ? calc_UnrealizedPnl(this.bot.currActivePosition, currLtpPrice) : 0;
          const pnlIndicator = currPnl >= 0 ? "🟩" : "🟥";

          this.bot.queueMsg(
            `ℹ️ Curr LTP Price: ${currLtpPrice.toFixed(this.bot.pricePrecision)} ${!!this.bot.currActivePosition ? `(${pnlIndicator} ${currPnl.toFixed(2)} USDT)` : ""}\n` +
            `ROC Val: ${rocVal}\n` +
            `Resistance: ${rawResistance !== null ? rawResistance : "N/A"}\nLong Trigger: ${this.bot.longTrigger !== null ? this.bot.longTrigger : "N/A"}\n` +
            `Support: ${rawSupport !== null ? rawSupport : "N/A"}\nShort Trigger: ${this.bot.shortTrigger !== null ? this.bot.shortTrigger : "N/A"}${trailingMsg}${tpPbMsg}${paramsMsg}${optimizationAgeMsg}\n${closedIndicator}`
          );

          this.bot.lastSRUpdateTime = Date.now();

          const nowMs = Date.now();
          const nextMinuteStartMs = (Math.floor(nowMs / 60_000) + 1) * 60_000;
          const targetMs = nextMinuteStartMs + CANDLE_WATCHER_DELAY_AFTER_MINUTE_MS;
          const delayMs = targetMs - nowMs;
          if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        } catch (error) {
          if (this.bot.isStopped) break;
          console.error("[COMB] Candle watcher iteration error:", error);
          this.bot.queueMsg(
            `⚠️ Comb candle watcher error (will retry next interval): ${error instanceof Error ? error.message : String(error)}`
          );
          await new Promise((r) => setTimeout(r, 60_000));
        }
      }
    } finally {
      this.isCandleWatcherStarted = false;
    }
  }
}

export default CombCandleWatcher;
